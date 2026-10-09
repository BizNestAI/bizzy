import { hasProvenPostingFailure } from "./reconciliationPipelineStatus.js";
import { deriveCreditCardPaymentStatus } from "./creditCardPaymentStatus.js";
import { classifyPostingFailure, formatPostingFailureLabel } from "./postingFailureClassification.js";
import { hasFinalCategorizeAsNewResolution, isPreProviderIncomingDepositMatchFailure } from "./incomingDepositResolution.js";

function formatShortDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function toTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function isHandledStatus(status) {
  return ["approved", "auto_approved", "handled"].includes(String(status || "").toLowerCase());
}

function isPostingInProgress(row = {}) {
  const meta = row.meta || {};
  return meta.posting_in_progress === true;
}

const BLOCK_REASON_COPY = {
  missing_source_qbo_account: ["Source account needs attention", "Connect this bank or card account to its QuickBooks account."],
  missing_qbo_account_mapping: ["Source account needs attention", "Connect this bank or card account to its QuickBooks account."],
  inactive_source_qbo_account: ["Source account is inactive", "Reactivate or remap the source account in QuickBooks."],
  missing_destination_qbo_account: ["QuickBooks category needs attention", "Choose an active QuickBooks category before posting."],
  missing_final_qbo_account: ["QuickBooks category needs attention", "Choose an active QuickBooks category before posting."],
  inactive_destination_qbo_account: ["QuickBooks category is inactive", "Choose an active QuickBooks category before posting."],
  qbo_authorization_expired: ["Reconnect QuickBooks", "The QuickBooks connection must be renewed before posting."],
  missing_posting_schedule: ["Not scheduled", "This handled transaction has no active posting schedule."],
};

function structuredBlockReason(row = {}) {
  const meta = row.meta || {};
  const job = row.posting_job || row.bookkeeping_posting_job || {};
  const code = job.blocking_code || meta.post_block_reason || meta.auto_post_block_reason || row.post_block_reason || null;
  const copy = BLOCK_REASON_COPY[code];
  return code ? { code, label: copy?.[0] || "Posting needs attention", detail: copy?.[1] || "Review the posting details before trying again." } : null;
}

export function deriveQboPostingLifecycle(row = {}, { nowMs = Date.now() } = {}) {
  const authoritative = row.qbo_posting_lifecycle || row.posting_lifecycle || null;
  if (authoritative?.key && authoritative?.label) return authoritative;

  const status = String(row.status || "").toLowerCase();
  const hasQboTxn = Boolean(row.qbo_txn_id);
  const meta = row.meta || {};
  const ccStatus = deriveCreditCardPaymentStatus(row);

  if (status === "matched_existing_qbo" || meta.matched_existing_qbo === true || meta.incoming_deposit_match_status === "confirmed") {
    return {
      key: "matched_existing_qbo",
      label: "Matched to existing QuickBooks",
      tone: "good",
      detail: "Confirmed against an existing QuickBooks bank/payment transaction; Bizzi did not create new income.",
    };
  }

  if (hasQboTxn) {
    return {
      key: "posted",
      label: "Posted",
      tone: "good",
      detail: `${row.qbo_txn_type || "QBO transaction"} ${row.qbo_txn_id}`,
    };
  }

  if (row.pending === true || meta.pending === true) {
    return {
      key: "pending",
      label: "Pending",
      tone: "warning",
      detail: "Plaid transaction is pending and is not ready for approval or QBO posting.",
    };
  }

  if (ccStatus && !hasQboTxn) {
    return {
      key: ccStatus.key,
      label: ccStatus.label,
      tone: ccStatus.tone,
      detail: ccStatus.matched
        ? "Matched as an internal credit-card payment; QBO Transfer posting is separate."
        : "Needs an opposite-side payment match before QBO posting.",
    };
  }

  const blockReason = meta.post_block_reason || meta.auto_post_block_reason || row.post_block_reason || null;
  const supersededDepositMatchFailure = hasFinalCategorizeAsNewResolution(row) && isPreProviderIncomingDepositMatchFailure(row);
  const postingJob = row.posting_job || row.bookkeeping_posting_job || {};
  const jobBlock = structuredBlockReason(row);

  if (["processing", "reconciling"].includes(postingJob.state)) {
    return {
      key: postingJob.state === "reconciling" ? "reconciling" : "posting",
      label: postingJob.state === "reconciling" ? "Checking QuickBooks" : "Posting",
      tone: "warning",
      detail: "Bizzi is confirming this transaction with QuickBooks.",
    };
  }

  if (postingJob.state === "retry_scheduled" && (postingJob.next_attempt_at || row?.meta?.next_post_attempt_at)) {
    const retryAt = postingJob.next_attempt_at || row.meta.next_post_attempt_at;
    return { key: "retry_scheduled", label: `Retry scheduled for ${formatShortDateTime(retryAt)}`, tone: "warning", detail: "A controlled retry is scheduled." };
  }

  if (postingJob.state === "blocked" && jobBlock && !supersededDepositMatchFailure) {
    return { key: "configuration_blocked", label: jobBlock.label, tone: "danger", detail: jobBlock.detail, code: jobBlock.code };
  }
  if (!supersededDepositMatchFailure && (
    ["possible_existing_qbo_match", "incoming_deposit_needs_match", "match_check_unavailable", "incoming_deposit_bank_account_mapping_unverified", "incoming_deposit_match_rejected_review_required"].includes(blockReason) ||
    ["needs_confirmation", "ambiguous", "match_check_unavailable"].includes(row.incoming_deposit_match_status || meta.incoming_deposit_match_status)
  )) {
    const matchStatus = row.incoming_deposit_match_status || meta.incoming_deposit_match_status;
    const unavailable = blockReason === "match_check_unavailable" || matchStatus === "match_check_unavailable";
    const ambiguous = matchStatus === "ambiguous";
    return {
      key: unavailable ? "qbo_match_check_unavailable" : ambiguous ? "incoming_deposit_needs_match" : "possible_existing_qbo_match",
      label: unavailable ? "Match check unavailable" : ambiguous ? "Needs Match" : "Possible QBO match",
      tone: "warning",
      detail: unavailable ? "A fresh QuickBooks match search is required before posting." : "Review the existing QuickBooks candidate before posting a new transaction.",
    };
  }

  const unsupportedUnpairedCcPayment =
    meta.taxonomy_type === "cc_payment" &&
    !meta.cc_payment_pair_id &&
    (row.post_error === "cc_payment_post_not_supported" || meta.post_block_reason === "cc_payment_post_not_supported");

  if (!unsupportedUnpairedCcPayment && !supersededDepositMatchFailure && hasProvenPostingFailure(row)) {
    const failure = classifyPostingFailure(postingJob.last_error_code || row.post_error || meta.post_error);
    return {
      key: "failed",
      label: formatPostingFailureLabel(failure.code),
      tone: "danger",
      detail: failure.detail,
      code: failure.code,
      retryable: failure.retryable,
      last_attempt_at: row.last_post_attempt_at || postingJob.updated_at || null,
      technical: {
        reason: failure.code,
        last_attempt_at: row.last_post_attempt_at || postingJob.updated_at || null,
        operation_id: postingJob.qbo_request_id || meta.qbo_request_id || null,
      },
    };
  }

  if (isPostingInProgress(row) && isHandledStatus(status)) {
    return {
      key: "posting",
      label: "Posting",
      tone: "warning",
      detail: "Bizzi is sending this transaction to QuickBooks.",
    };
  }

  if (blockReason === "historical_scope_review_required") {
    return {
      key: "held_historical_backlog",
      label: "Held: historical backlog review",
      tone: "warning",
      detail: "This older handled transaction needs an explicit backlog release before auto-posting.",
    };
  }
  if (blockReason === "missing_final_qbo_account" || (!row.final_qbo_account_id && status === "auto_approved")) {
    return {
      key: "blocked_missing_final_account",
      label: "Blocked · missing final account",
      tone: "danger",
      detail: "Choose a final QuickBooks account before posting.",
    };
  }
  if (blockReason === "unsupported_transaction_type" || blockReason === "cc_payment_mapping_not_safe") {
    return {
      key: "blocked_unsupported_transaction_type",
      label: "Blocked · unsupported transaction type",
      tone: "danger",
      detail: "This transaction type needs review before QuickBooks posting.",
    };
  }
  if (meta.taxonomy_type === "loan_payment" || blockReason === "loan_payment_split_required") {
    return {
      key: "loan_payment_needs_split",
      label: "Loan Payment · Needs Split",
      tone: "warning",
      detail: "Confirm principal, interest, and fee lines before posting this loan payment.",
    };
  }
  if (meta.safe_to_auto_post === false && meta.auto_approve_reason !== "manual_user" && (status === "approved" || status === "auto_approved")) {
    return {
      key: "blocked_unsafe_auto_post",
      label: "Blocked · not safe for auto-post",
      tone: "warning",
      detail: "Bizzi needs a safer posting match before auto-posting this row.",
    };
  }

  const postAfterMs = toTime(row.post_after);
  if (postAfterMs && isHandledStatus(status)) {
    if (postAfterMs <= nowMs) {
      return {
        key: "ready_to_post",
        label: "Overdue — posting delayed",
        tone: "warning",
        detail: "The review window has ended; the posting worker may pick this up shortly.",
      };
    }
    return {
      key: "queued",
      label: `Scheduled for ${formatShortDateTime(row.post_after)}`,
      tone: "warning",
      detail: `Posts after ${formatShortDateTime(row.post_after)}`,
    };
  }

  if (isHandledStatus(status)) {
    if (meta.safe_to_auto_post === true && !row.post_after) {
      return { key: "ready_auto_post_off", label: "Ready · Auto-post off", tone: "neutral", detail: "Posting eligibility is confirmed; no posting time is assigned while Auto-post is off." };
    }
    return {
      key: "handled_not_posted",
      label: "Handled · Not posted",
      tone: "neutral",
      detail: "Handled in Bizzi; no QBO transaction has been created yet.",
    };
  }

  return {
    key: "needs_review",
    label: "Needs Review",
    tone: "neutral",
    detail: "Needs review before QBO posting.",
  };
}

export function formatQboPostingSchedule(row = {}, { nowMs = Date.now() } = {}) {
  const lifecycle = deriveQboPostingLifecycle(row, { nowMs });
  if (lifecycle.key === "posted") {
    return {
      key: "posted",
      label: "Posted",
      tone: "good",
      detail: lifecycle.detail || "Posted to QuickBooks.",
    };
  }
  if (lifecycle.key === "failed") {
    return {
      key: "failed",
      label: lifecycle.label || "Posting failed",
      tone: "danger",
      detail: lifecycle.detail || "QuickBooks posting failed.",
      code: lifecycle.code || null,
      retryable: lifecycle.retryable === true,
      technical: lifecycle.technical || null,
    };
  }
  if (lifecycle.key === "posting") {
    return {
      key: "posting",
      label: "Posting",
      tone: "warning",
      detail: lifecycle.detail || "Bizzi is sending this transaction to QuickBooks.",
    };
  }
  if (lifecycle.key === "reconciling" || lifecycle.key === "retry_scheduled" || lifecycle.key === "configuration_blocked") {
    return lifecycle;
  }
  if (
    [
      "held_historical_backlog",
      "blocked_unsafe_auto_post",
      "blocked_missing_final_account",
      "blocked_unsupported_transaction_type",
      "verification_required",
      "possible_existing_qbo_match",
      "incoming_deposit_needs_match",
      "qbo_match_check_unavailable",
      "matched_existing_qbo",
    ].includes(lifecycle.key)
  ) {
    return {
      key: lifecycle.key,
      label: lifecycle.label,
      tone: lifecycle.tone || "warning",
      detail: lifecycle.detail || "This transaction is not eligible for automatic QuickBooks posting.",
    };
  }
  if (lifecycle.key === "ready_to_post") {
    return {
      key: "ready_to_post",
      label: "Overdue — posting delayed",
      tone: "warning",
      detail: lifecycle.detail || "The posting worker may pick this up shortly.",
    };
  }
  if (lifecycle.key === "queued") {
    return {
      key: "scheduled",
      label: formatShortDateTime(row.post_after),
      tone: "neutral",
      detail: "Scheduled to post to QuickBooks after the review window.",
    };
  }
  if (["pending", "needs_review"].includes(lifecycle.key) || String(row.status || "").toLowerCase() === "uncategorized") {
    return {
      key: "not_eligible",
      label: "Not scheduled",
      tone: "neutral",
      detail: lifecycle.detail || "This transaction is not eligible for QuickBooks posting yet.",
    };
  }
  return {
    key: "not_scheduled",
    label: "Not scheduled",
    tone: "neutral",
    detail: "No QuickBooks posting time is scheduled.",
  };
}

export default {
  deriveQboPostingLifecycle,
  formatQboPostingSchedule,
};
