import { deriveQboPostingLifecycle } from "./qboPostingLifecycle.js";
import { hasManualAccountAuthority } from "./postingDecisionAuthority.js";
import { classifyPostingFailure } from "./postingFailureClassification.js";
import { hasFinalCategorizeAsNewResolution, isPreProviderIncomingDepositMatchFailure } from "./incomingDepositResolution.js";
import { deriveCreditCardPaymentStatus } from "./creditCardPaymentStatus.js";

const COMPLETED_KEYS = new Set(["posted", "matched_existing_qbo", "credit_card_payment_matched"]);
const CREDIT_TYPE_CODES = new Set([
  "credit_card_inflow_resolution_required",
  "cc_charge_post_not_supported",
  "merchant_refund_review_required",
  "statement_credit_review_required",
]);

const ACTION_DEFINITIONS = Object.freeze({
  completed: [null, false, false, false, "finalized"],
  waiting_for_settlement: [null, false, false, false, "settled"],
  resolve_issue: ["Resolve issue", true, true, false, "resolution_saved"],
  recheck_schedule: ["Recheck & schedule", true, false, false, "scheduled_or_ready"],
  post_now: ["Post now", true, true, true, "posted_or_reconciliation_required"],
  retry_posting: ["Retry posting", true, true, true, "posted_or_retry_scheduled"],
  retry_duplicate_check: ["Retry duplicate check", true, false, true, "duplicate_check_complete"],
  review_possible_match: ["Review possible match", true, false, false, "match_resolved"],
  reconcile_qbo: ["Reconcile with QuickBooks", true, false, true, "reconciled"],
  finalize_posting: ["Finalize posting", true, false, false, "posted"],
  map_account: ["Map account", true, false, false, "source_account_mapped"],
  select_valid_account: ["Select valid account", true, false, false, "valid_account_selected"],
  match_payment: ["Match payment", true, false, false, "payment_matched"],
  confirm_statement_credit: ["Confirm statement credit", true, true, false, "resolution_saved"],
  complete_refund_details: ["Complete refund details", true, true, false, "refund_details_saved"],
  inspect_blocker: ["Review blocker", true, false, false, "blocker_reviewed"],
  posting: ["Posting…", false, false, false, "posted_or_failed"],
  review: [null, false, false, false, "operator_prerequisite"],
});

function result(lifecycle, action, { enabled = false, reason = null, failure = null, confirmation = false, actionCode = null } = {}) {
  const code = actionCode || action;
  const definition = ACTION_DEFINITIONS[code] || [null, enabled, confirmation, false, null];
  return {
    canonical_lifecycle_state: lifecycle.key,
    posting_eligible: enabled && ["post_now", "retry_posting"].includes(action),
    permitted_action: action,
    disabled_reason: enabled ? null : reason || lifecycle.detail || null,
    safe_failure_classification: failure || lifecycle.code || null,
    confirmation_required: confirmation,
    action_code: code,
    label: definition[0],
    enabled: enabled || definition[1],
    reason: reason || lifecycle.detail || null,
    requires_confirmation: confirmation || definition[2],
    requires_provider_call: definition[3],
    next_expected_state: definition[4],
  };
}

export function deriveBookkeepingPostingAction(row = {}, { nowMs = Date.now() } = {}) {
  const lifecycle = deriveQboPostingLifecycle(row, { nowMs });
  const meta = row.meta || {};
  const status = String(row.status || "").toLowerCase();
  const code = lifecycle.code || lifecycle.technical?.blocking_code || row.posting_job?.blocking_code || row.post_error || meta.post_block_reason || meta.auto_post_block_reason || null;
  const failure = code ? classifyPostingFailure(code) : null;
  const weakOnly = ["weak_memo_evidence", "probable_requires_review", "low_classifier_confidence"].includes(String(code || ""));
  const supersededDepositMatchFailure = hasFinalCategorizeAsNewResolution(row) && isPreProviderIncomingDepositMatchFailure(row);
  const creditCardPayment = deriveCreditCardPaymentStatus(row);
  const hasSavedInflowType = hasFinalCategorizeAsNewResolution(row);
  const protectedDecision = meta.credit_card_inflow_resolution || null;
  const merchantRefundDetailsComplete = protectedDecision?.resolution_type !== "merchant_refund" || Boolean(
    protectedDecision?.linked_original_transaction_id || protectedDecision?.standalone_refund_acknowledged === true
  );
  const preflight = row.provider_free_preflight || null;

  if (COMPLETED_KEYS.has(lifecycle.key) || row.qbo_txn_id) return result(lifecycle, "completed", { actionCode: "completed" });
  if (row.pending === true || meta.pending === true || lifecycle.key === "pending") {
    return result(lifecycle, "review", { reason: "Waiting for settlement", actionCode: "waiting_for_settlement" });
  }
  if (lifecycle.key === "posting" || meta.posting_in_progress === true) return result({ ...lifecycle, key: "posting" }, "posting", { reason: "A posting operation is already in progress." });
  if (code === "qbo_succeeded_local_finalize_pending") {
    return result(lifecycle, "reconciling", { enabled: true, reason: "QuickBooks accepted the write; Bizzi must finalize its saved receipt.", actionCode: "finalize_posting" });
  }
  if (lifecycle.key === "reconciling" || ["qbo_outcome_ambiguous", "qbo_posting_receipt_update_failed"].includes(String(code || ""))) {
    return result(lifecycle, "reconciling", { enabled: true, reason: "QuickBooks outcome must be reconciled before another write.", actionCode: "reconcile_qbo" });
  }
  if (lifecycle.key === "qbo_match_check_unavailable" || ["match_check_unavailable", "duplicate_check_unavailable"].includes(String(code || ""))) {
    return result(lifecycle, "refresh_match_check", { enabled: true, failure: "match_check_unavailable", actionCode: "retry_duplicate_check" });
  }
  if (["possible_existing_qbo_match", "incoming_deposit_needs_match"].includes(lifecycle.key) && !supersededDepositMatchFailure) {
    return result(lifecycle, "review", { enabled: true, reason: "Review the possible existing QuickBooks match before creating a new transaction.", failure: lifecycle.key, actionCode: "review_possible_match" });
  }
  if (creditCardPayment && !creditCardPayment.matched) return result(lifecycle, "review", { enabled: true, actionCode: "match_payment", reason: "Confirm the opposite-side credit-card payment." });
  if (
    CREDIT_TYPE_CODES.has(String(code || "")) ||
    (Number((row.signed_amount ?? row.signedAmount ?? row.amount) || 0) > 0 &&
      String(row.plaid_account_type || row.account_type || "").toLowerCase().includes("credit") &&
      !meta.credit_card_inflow_resolution)
  ) {
    return result(lifecycle, "confirm_type", { enabled: true, failure: code || "credit_card_inflow_resolution_required", actionCode: "resolve_issue" });
  }
  if (["missing_source_qbo_account", "missing_qbo_account_mapping", "inactive_source_qbo_account"].includes(String(code || ""))) {
    return result(lifecycle, "fix_issue", { enabled: true, failure: code, actionCode: "map_account" });
  }
  if (["missing_destination_qbo_account", "missing_final_qbo_account", "inactive_destination_qbo_account", "qbo_account_incompatible"].includes(String(code || "")) || lifecycle.key === "blocked_missing_final_account") {
    return result(lifecycle, "fix_issue", { enabled: true, failure: code, actionCode: "select_valid_account" });
  }
  if (hasSavedInflowType && !merchantRefundDetailsComplete) {
    return result(lifecycle, "fix_issue", { enabled: true, actionCode: "complete_refund_details", reason: "Link the original charge or acknowledge that this is a standalone merchant refund." });
  }
  if (preflight?.preview_ready === false && ["map_account", "select_valid_account"].includes(preflight.next_action)) {
    return result(lifecycle, "fix_issue", { enabled: true, actionCode: preflight.next_action, failure: preflight.blocker_code, reason: preflight.blocker_reason });
  }
  if (preflight?.preview_ready === false) {
    const preflightAction = preflight.next_action === "resolve_issue" ? "resolve_issue" : "inspect_blocker";
    return result(lifecycle, "fix_issue", {
      enabled: true,
      actionCode: preflightAction,
      failure: preflight.blocker_code || "posting_preview_unavailable",
      reason: preflight.blocker_reason || "Provider-free posting preview is not ready.",
    });
  }
  if (hasSavedInflowType && (supersededDepositMatchFailure || code === "missing_posting_schedule" || lifecycle.key === "handled_not_posted")) {
    return result(lifecycle, "fix_issue", { enabled: true, actionCode: "recheck_schedule", reason: "The saved resolution is complete; recheck eligibility and assign the posting schedule." });
  }
  const manual = hasManualAccountAuthority(row);
  if (weakOnly && !manual) return result(lifecycle, "review", { enabled: true, actionCode: "inspect_blocker", reason: "Weak evidence requires durable manual approval before posting.", failure: code });
  if (!weakOnly && (lifecycle.key === "failed" || String(row.status || "").toLowerCase() === "failed") && failure?.retryable === true) {
    return result(lifecycle, "retry_posting", { enabled: true, failure: code || "retryable_posting_failure", actionCode: "retry_posting" });
  }
  if (!weakOnly && (lifecycle.key === "failed" || String(row.status || "").toLowerCase() === "failed" || lifecycle.key === "configuration_blocked" || lifecycle.key.startsWith("blocked_"))) {
    return result(lifecycle, "fix_issue", { enabled: true, actionCode: "inspect_blocker", reason: lifecycle.detail, failure: code || "terminal_posting_blocker" });
  }

  const handled = ["approved", "auto_approved", "handled", "failed"].includes(status);
  if (handled && !row.final_qbo_account_id) return result(lifecycle, "review", { enabled: true, actionCode: "select_valid_account", reason: "Confirm a valid QuickBooks account before posting." });
  if (handled && meta.safe_to_auto_post === false && !manual) return result(lifecycle, "review", { enabled: true, actionCode: "inspect_blocker", reason: "A reviewer must confirm the account before posting." });
  if (handled && (manual || meta.safe_to_auto_post === true)) {
    if (preflight && preflight.preview_ready !== true) {
      return result(lifecycle, "review", {
        enabled: true,
        actionCode: preflight?.next_action || "inspect_blocker",
        failure: preflight?.blocker_code || code || "posting_preview_unavailable",
        reason: preflight?.blocker_reason || "Provider-free posting preview is not ready.",
      });
    }
    const scheduledAt = Date.parse(row.post_after || "");
    return result(lifecycle, "post_now", { enabled: true, confirmation: Number.isFinite(scheduledAt) && scheduledAt > nowMs });
  }
  return result(lifecycle, "review", { enabled: true, actionCode: "inspect_blocker", reason: lifecycle.detail || "Review this transaction before posting." });
}

const NEXT_ACTION_CODES = Object.freeze({
  resolve_issue: "confirm_type",
  confirm_statement_credit: "confirm_type",
  complete_refund_details: "complete_resolution",
  select_valid_account: "select_gl_account",
  map_account: "repair_account_mapping",
  retry_duplicate_check: "retry_duplicate_check",
  review_possible_match: "acknowledge_duplicate_risk",
  recheck_schedule: "recheck_posting_eligibility",
  post_now: "preview_and_post",
  retry_posting: "preview_and_post",
  posting: "wait_for_active_posting",
  reconcile_qbo: "reconcile_provider_outcome",
  finalize_posting: "reconcile_provider_outcome",
  inspect_blocker: "review_hard_blocker",
  waiting_for_settlement: "wait_for_active_posting",
  completed: null,
});

export function toBookkeepingNextAction(action = {}) {
  const actionCode = Object.prototype.hasOwnProperty.call(NEXT_ACTION_CODES, action.action_code)
    ? NEXT_ACTION_CODES[action.action_code]
    : "review_hard_blocker";
  return {
    ...action,
    legacy_action_code: action.action_code || null,
    action_code: actionCode,
    enabled: actionCode ? action.enabled === true : false,
    explanation: action.reason || action.disabled_reason || null,
    missing_prerequisites: action.safe_failure_classification ? [action.safe_failure_classification] : [],
    preview_compilable: action.posting_eligible === true || action.action_code === "post_now",
    posting_allowed: action.posting_eligible === true,
    blocker_code: action.safe_failure_classification || null,
  };
}

export default deriveBookkeepingPostingAction;
