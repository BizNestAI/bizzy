import { deriveQboPostingLifecycle } from "./qboPostingLifecycle.js";
import { hasManualAccountAuthority } from "./postingDecisionAuthority.js";
import { classifyPostingFailure } from "./postingFailureClassification.js";
import { hasFinalCategorizeAsNewResolution, isPreProviderIncomingDepositMatchFailure } from "./incomingDepositResolution.js";

const COMPLETED_KEYS = new Set(["posted", "matched_existing_qbo", "credit_card_payment_matched"]);
const CREDIT_TYPE_CODES = new Set([
  "credit_card_inflow_resolution_required",
  "cc_charge_post_not_supported",
  "merchant_refund_review_required",
  "statement_credit_review_required",
]);

function result(lifecycle, action, { enabled = false, reason = null, failure = null, confirmation = false } = {}) {
  return {
    canonical_lifecycle_state: lifecycle.key,
    posting_eligible: enabled && ["post_now", "retry_posting"].includes(action),
    permitted_action: action,
    disabled_reason: enabled ? null : reason || lifecycle.detail || null,
    safe_failure_classification: failure || lifecycle.code || null,
    confirmation_required: confirmation,
  };
}

export function deriveBookkeepingPostingAction(row = {}, { nowMs = Date.now() } = {}) {
  const lifecycle = deriveQboPostingLifecycle(row, { nowMs });
  const meta = row.meta || {};
  const status = String(row.status || "").toLowerCase();
  const code = lifecycle.code || row.post_error || meta.post_block_reason || meta.auto_post_block_reason || null;
  const failure = code ? classifyPostingFailure(code) : null;
  const weakOnly = ["weak_memo_evidence", "probable_requires_review", "low_classifier_confidence"].includes(String(code || ""));
  const supersededDepositMatchFailure = hasFinalCategorizeAsNewResolution(row) && isPreProviderIncomingDepositMatchFailure(row);

  if (COMPLETED_KEYS.has(lifecycle.key) || row.qbo_txn_id) return result(lifecycle, "completed");
  if (row.pending === true || meta.pending === true || lifecycle.key === "pending") {
    return result(lifecycle, "review", { reason: "Pending bank transactions cannot be posted." });
  }
  if (lifecycle.key === "posting" || meta.posting_in_progress === true) return result({ ...lifecycle, key: "posting" }, "posting", { reason: "A posting operation is already in progress." });
  if (lifecycle.key === "reconciling" || code === "qbo_succeeded_local_finalize_pending") {
    return result(lifecycle, "reconciling", { reason: "QuickBooks accepted the write; Bizzi is reconciling the local receipt." });
  }
  if (lifecycle.key === "qbo_match_check_unavailable") {
    return result(lifecycle, "refresh_match_check", { enabled: true, failure: "match_check_unavailable" });
  }
  if (["possible_existing_qbo_match", "incoming_deposit_needs_match"].includes(lifecycle.key) && !supersededDepositMatchFailure) {
    return result(lifecycle, "review", { reason: "Review the possible existing QuickBooks match before creating a new transaction.", failure: lifecycle.key });
  }
  if (
    CREDIT_TYPE_CODES.has(String(code || "")) ||
    (Number((row.signed_amount ?? row.signedAmount ?? row.amount) || 0) > 0 &&
      String(row.plaid_account_type || row.account_type || "").toLowerCase().includes("credit") &&
      !meta.credit_card_inflow_resolution)
  ) {
    return result(lifecycle, "confirm_type", { enabled: true, failure: code || "credit_card_inflow_resolution_required" });
  }
  const manual = hasManualAccountAuthority(row);
  if (weakOnly && !manual) return result(lifecycle, "review", { reason: "Weak evidence requires durable manual approval before posting.", failure: code });
  if (!weakOnly && (lifecycle.key === "failed" || String(row.status || "").toLowerCase() === "failed") && failure?.retryable === true) {
    return result(lifecycle, "retry_posting", { enabled: true, failure: code || "retryable_posting_failure" });
  }
  if (!weakOnly && (lifecycle.key === "failed" || String(row.status || "").toLowerCase() === "failed" || lifecycle.key === "configuration_blocked" || lifecycle.key.startsWith("blocked_"))) {
    return result(lifecycle, "fix_issue", { reason: lifecycle.detail, failure: code || "terminal_posting_blocker" });
  }

  const handled = ["approved", "auto_approved", "handled", "failed"].includes(status);
  if (handled && !row.final_qbo_account_id) return result(lifecycle, "review", { reason: "Confirm a valid QuickBooks account before posting." });
  if (handled && meta.safe_to_auto_post === false && !manual) return result(lifecycle, "review", { reason: "A reviewer must confirm the account before posting." });
  if (handled && (manual || meta.safe_to_auto_post === true)) {
    const scheduledAt = Date.parse(row.post_after || "");
    return result(lifecycle, "post_now", { enabled: true, confirmation: Number.isFinite(scheduledAt) && scheduledAt > nowMs });
  }
  return result(lifecycle, "review", { reason: lifecycle.detail || "Review this transaction before posting." });
}

export default deriveBookkeepingPostingAction;
