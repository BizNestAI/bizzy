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

export const BOOKKEEPING_ACTION_GROUPS = Object.freeze([
  Object.freeze({ key: "classification", label: "Classification", actions: Object.freeze(["confirm_type", "edit_type", "select_gl_account", "change_gl_account"]) }),
  Object.freeze({ key: "resolution", label: "Resolution", actions: Object.freeze(["edit_resolution", "find_qbo_match", "confirm_qbo_match", "retry_duplicate_check", "acknowledge_duplicate_risk"]) }),
  Object.freeze({ key: "posting", label: "Posting", actions: Object.freeze(["repair_account_mapping", "recheck_posting_eligibility", "recover_posting_state", "preview_and_post", "retry_posting", "wait_for_posting", "reconcile_provider_outcome"]) }),
  Object.freeze({ key: "history", label: "History", actions: Object.freeze(["undo", "view_blocker"]) }),
]);

const MATRIX_DEFINITIONS = Object.freeze({
  confirm_type: ["Confirm type", false, "/api/bookkeeping/transactions/:transactionId/credit-card-inflow-resolution"],
  edit_type: ["Edit type", false, "/api/bookkeeping/transactions/:transactionId/credit-card-inflow-resolution"],
  select_gl_account: ["Select GL account", false, "/api/bookkeeping/transactions/:transactionId/account"],
  change_gl_account: ["Change GL account", false, "/api/bookkeeping/transactions/:transactionId/account"],
  edit_resolution: ["Categorize as new", false, "/api/bookkeeping/transactions/:transactionId/resolution"],
  find_qbo_match: ["Find QuickBooks match", true, "/api/bookkeeping/transactions/:transactionId/qbo-match"],
  confirm_qbo_match: ["Confirm QuickBooks match", true, "/api/bookkeeping/transactions/:transactionId/qbo-match/confirm"],
  retry_duplicate_check: ["Retry duplicate check", true, "/api/bookkeeping/transactions/:transactionId/qbo-match"],
  acknowledge_duplicate_risk: ["Review duplicate risk", false, "/api/bookkeeping/transactions/:transactionId/duplicate-risk"],
  repair_account_mapping: ["Repair account mapping", false, "/api/bookkeeping/accounts/:plaidAccountId/qbo-mapping"],
  recheck_posting_eligibility: ["Recheck eligibility", false, "/api/bookkeeping/transactions/:transactionId/posting-eligibility"],
  recover_posting_state: ["Recover posting state", false, "/api/bookkeeping/transactions/:transactionId/posting-recovery"],
  preview_and_post: ["Preview & post", true, "/api/bookkeeping/posting/transactions/:transactionId"],
  retry_posting: ["Retry posting", true, "/api/bookkeeping/posting/transactions/:transactionId"],
  wait_for_posting: ["Posting…", false, null],
  reconcile_provider_outcome: ["Reconcile QuickBooks outcome", true, "/api/bookkeeping/posting/transactions/:transactionId/reconcile"],
  undo: ["Undo", true, "/api/bookkeeping/transactions/:transactionId/undo"],
  view_blocker: ["View blocker/details", false, null],
});

export const BOOKKEEPING_ACTION_ORDER = Object.freeze(BOOKKEEPING_ACTION_GROUPS.flatMap((group) => group.actions));

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
  const ordinaryPersistedAuthority =
    Boolean(row.final_qbo_account_id) &&
    String(row.direction || "").toUpperCase() === "OUTFLOW" &&
    !String(meta.taxonomy_type || "").trim();
  if (weakOnly && !manual && !ordinaryPersistedAuthority) return result(lifecycle, "review", { enabled: true, actionCode: "inspect_blocker", reason: "Weak evidence requires durable manual approval before posting.", failure: code });
  if (!weakOnly && (lifecycle.key === "failed" || String(row.status || "").toLowerCase() === "failed") && failure?.retryable === true) {
    return result(lifecycle, "retry_posting", { enabled: true, failure: code || "retryable_posting_failure", actionCode: "retry_posting" });
  }
  if (!weakOnly && (lifecycle.key === "failed" || String(row.status || "").toLowerCase() === "failed" || lifecycle.key === "configuration_blocked" || lifecycle.key.startsWith("blocked_"))) {
    return result(lifecycle, "fix_issue", { enabled: true, actionCode: "inspect_blocker", reason: lifecycle.detail, failure: code || "terminal_posting_blocker" });
  }

  const handled = ["approved", "auto_approved", "handled", "failed"].includes(status);
  if (handled && !row.final_qbo_account_id) return result(lifecycle, "review", { enabled: true, actionCode: "select_valid_account", reason: "Confirm a valid QuickBooks account before posting." });
  if (handled && meta.safe_to_auto_post === false && !manual && !ordinaryPersistedAuthority) return result(lifecycle, "review", { enabled: true, actionCode: "inspect_blocker", reason: "A reviewer must confirm the account before posting." });
  if (handled && (manual || meta.safe_to_auto_post === true || ordinaryPersistedAuthority)) {
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
  complete_refund_details: "edit_resolution",
  select_valid_account: "select_gl_account",
  map_account: "repair_account_mapping",
  retry_duplicate_check: "retry_duplicate_check",
  review_possible_match: "acknowledge_duplicate_risk",
  recheck_schedule: "recheck_posting_eligibility",
  post_now: "preview_and_post",
  retry_posting: "retry_posting",
  posting: "wait_for_posting",
  reconcile_qbo: "reconcile_provider_outcome",
  finalize_posting: "reconcile_provider_outcome",
  match_payment: "edit_resolution",
  inspect_blocker: "view_blocker",
  waiting_for_settlement: "wait_for_posting",
  completed: null,
});

export function toBookkeepingNextAction(action = {}) {
  const actionCode = Object.prototype.hasOwnProperty.call(NEXT_ACTION_CODES, action.action_code)
    ? NEXT_ACTION_CODES[action.action_code]
    : "view_blocker";
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

const SAFE_BLOCKER_PATTERN = /^[a-z][a-z0-9_]{1,79}$/;

function sanitizedBlockerCode(value) {
  const code = String(value || "").toLowerCase();
  return SAFE_BLOCKER_PATTERN.test(code) ? code : null;
}

function disabledReason(code, context) {
  if (context.final) return "Final posted or matched transactions cannot be changed here.";
  if (context.pending) return "Available after the bank transaction settles.";
  if (context.active) return "A posting request is already processing.";
  if (context.ambiguous) return "Reconcile the QuickBooks outcome before making another change.";
  if (code === "confirm_type" && context.savedType) return `Already confirmed as ${context.savedTypeLabel}.`;
  if (code === "edit_type" && !context.savedType) return "Confirm the credit type first.";
  if (code === "select_gl_account" && context.hasGl) return "A GL account is already selected.";
  if (code === "change_gl_account" && !context.hasGl) return "Select a GL account first.";
  if (["preview_and_post", "retry_posting", "recheck_posting_eligibility"].includes(code) && !context.hasGl) return "Available after selecting a GL account.";
  if (["preview_and_post", "retry_posting"].includes(code) && !context.previewReady) return "QuickBooks preview must compile first.";
  if (code === "retry_duplicate_check" && !context.duplicateUnavailable) return "Duplicate verification is currently available.";
  if (code === "acknowledge_duplicate_risk" && !context.possibleDuplicate) return "No unresolved duplicate risk was found.";
  if (code === "repair_account_mapping" && !context.mappingBlocked) return "The source account is already mapped to QuickBooks.";
  if (code === "reconcile_provider_outcome" && !context.ambiguous) return "No uncertain QuickBooks outcome needs reconciliation.";
  if (code === "wait_for_posting" && !context.active) return "No posting request is currently processing.";
  if (code === "confirm_qbo_match" && !context.matchCandidate) return "Find and select a QuickBooks match first.";
  if (code === "view_blocker" && !context.blocker) return "No blocker details are available.";
  return "Not available for the transaction's current bookkeeping state.";
}

/**
 * Complete, stable action contract for MRP and Admin View. This function is the
 * only place that promotes an action to primary or enables a provider write.
 */
export function deriveBookkeepingActionMatrix(row = {}, { nowMs = Date.now() } = {}) {
  const legacy = deriveBookkeepingPostingAction(row, { nowMs });
  const next = toBookkeepingNextAction(legacy);
  const meta = row.meta || {};
  const lifecycle = deriveQboPostingLifecycle(row, { nowMs });
  const final = COMPLETED_KEYS.has(lifecycle.key) || Boolean(row.qbo_txn_id || row.posted_at);
  const pending = row.pending === true || meta.pending === true || lifecycle.key === "pending";
  const active = lifecycle.key === "posting" || meta.posting_in_progress === true;
  const ambiguous = lifecycle.key === "reconciling" || ["qbo_outcome_ambiguous", "qbo_posting_receipt_update_failed", "qbo_succeeded_local_finalize_pending"].includes(String(legacy.safe_failure_classification || ""));
  const savedResolution = meta.credit_card_inflow_resolution || null;
  const savedType = savedResolution?.resolution_type || null;
  const savedTypeLabel = savedType === "merchant_refund" ? "Merchant refund" : savedType ? "Cash back or statement credit" : null;
  const hasGl = Boolean(row.final_qbo_account_id || savedResolution?.destination_qbo_account_id);
  const previewReady = row.provider_free_preflight?.preview_ready === true && legacy.posting_eligible === true;
  const blocker = sanitizedBlockerCode(legacy.safe_failure_classification || row.provider_free_preflight?.blocker_code || lifecycle.code);
  const duplicateUnavailable = ["match_check_unavailable", "duplicate_check_unavailable"].includes(blocker);
  const possibleDuplicate = ["possible_existing_qbo_match", "incoming_deposit_needs_match"].includes(blocker) || meta.possible_qbo_duplicate === true;
  const mappingBlocked = ["missing_source_qbo_account", "missing_qbo_account_mapping", "inactive_source_qbo_account"].includes(blocker);
  const matchCandidate = Boolean(meta.incoming_deposit_match_id || meta.qbo_match_id || row.qbo_match_id);
  const mutable = !final && !pending && !active && !ambiguous;
  const isHandled = ["approved", "auto_approved", "handled", "failed"].includes(String(row.status || "").toLowerCase());
  const primaryCode = final ? null : next.action_code;
  const context = { final, pending, active, ambiguous, savedType, savedTypeLabel, hasGl, previewReady, blocker, duplicateUnavailable, possibleDuplicate, mappingBlocked, matchCandidate };

  const enabledCodes = new Set();
  if (primaryCode && next.enabled) enabledCodes.add(primaryCode);
  if (mutable && savedType) enabledCodes.add("edit_type");
  if (mutable && hasGl) enabledCodes.add("change_gl_account");
  if (mutable && !hasGl) enabledCodes.add("select_gl_account");
  if (mutable) enabledCodes.add("edit_resolution");
  if (mutable && isHandled) enabledCodes.add("find_qbo_match");
  if (mutable && matchCandidate) enabledCodes.add("confirm_qbo_match");
  if (mutable && blocker) enabledCodes.add("view_blocker");
  if (mutable && isHandled && !row.qbo_txn_id && !row.posted_at) enabledCodes.add("undo");
  if (!previewReady) {
    enabledCodes.delete("preview_and_post");
    enabledCodes.delete("retry_posting");
  }
  if (active || ambiguous || pending || final) {
    enabledCodes.delete("preview_and_post");
    enabledCodes.delete("retry_posting");
  }

  const actions = BOOKKEEPING_ACTION_ORDER.map((actionCode) => {
    const definition = MATRIX_DEFINITIONS[actionCode];
    const enabled = enabledCodes.has(actionCode);
    return {
      action_code: actionCode,
      label: definition[0],
      enabled,
      disabled_reason: enabled ? null : disabledReason(actionCode, context),
      is_primary: actionCode === primaryCode,
      requires_confirmation: ["preview_and_post", "retry_posting"].includes(actionCode) ? legacy.requires_confirmation === true : ["confirm_qbo_match", "acknowledge_duplicate_risk", "undo"].includes(actionCode),
      provider_call_possible: definition[1],
      endpoint: definition[2],
      blocker_code: actionCode === primaryCode || actionCode === "view_blocker" ? blocker : null,
    };
  });

  return {
    version: 1,
    state: final ? "final" : active ? "waiting" : pending ? "pending" : ambiguous ? "provider_outcome_uncertain" : "actionable",
    status_label: final ? "Final" : active ? "Posting" : pending ? "Pending settlement" : ambiguous ? "QuickBooks outcome requires reconciliation" : primaryCode === "retry_posting" ? "Ready to retry" : primaryCode === "preview_and_post" ? "Ready to preview" : "Action required",
    primary_action_code: primaryCode,
    actions,
    groups: BOOKKEEPING_ACTION_GROUPS,
  };
}

export default deriveBookkeepingPostingAction;
