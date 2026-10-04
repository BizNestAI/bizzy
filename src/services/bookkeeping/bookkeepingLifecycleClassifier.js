import { deriveCreditCardPaymentStatus, isConfirmedCreditCardPaymentPairStatus } from "./creditCardPaymentStatus.js";
export const PRIMARY_BOOKKEEPING_BUCKETS = Object.freeze([
  "needs_review", "handled", "posted", "matched", "pending", "excluded",
]);

const POSTING_FAILURE_STATUSES = new Set(["failed", "failed_post", "post_failed", "posting_failed"]);
const POSTING_BLOCK_REASONS = new Set([
  "weak_memo_evidence", "probable_requires_review", "low_classifier_confidence",
  "merchant_ambiguous", "no_matching_vendor_rule", "credit_card_inflow_requires_review",
]);

export function derivePostingOutcome(row = {}, nowMs = Date.now()) {
  const meta = row.meta || {};
  const status = String(row.posting_status || "").toLowerCase();
  const legacyStatus = String(row.status || row.categorization_status || "").toLowerCase();
  const reason = String(row.post_error || meta.post_error || meta.post_block_reason || "").toLowerCase();
  const lastOperationId = row.last_operation_id || meta.merchant_group_operation_id ||
    meta.post_intent_id || meta.manual_approval?.operation_id || null;
  const hasReceipt = Boolean(
    row.posted_at ||
    status === "posted" ||
    legacyStatus === "posted" ||
    ((row.qbo_txn_id || row.qbo_entity_id) && (meta.qbo_posting_receipt_id || lastOperationId))
  );

  let key = "not_requested";
  if (hasReceipt || status === "posted") key = "succeeded";
  else if (status === "posting" || meta.posting_in_progress === true) key = "processing";
  else if (status === "scheduled" || row.post_after) {
    const dueAt = Date.parse(row.post_after || "");
    key = Number.isFinite(dueAt) && dueAt <= nowMs ? "delayed" : "queued";
  }
  else if (status === "posting_failed" || POSTING_FAILURE_STATUSES.has(legacyStatus)) key = "failed";
  else if (reason === "credit_card_inflow_resolution_required" || reason === "credit_card_inflow_requires_review") key = "needs_credit_type";
  else if (reason) key = POSTING_BLOCK_REASONS.has(reason) || !row.last_post_attempt_at ? "blocked" : "failed";

  const labels = {
    not_requested: "Not requested",
    queued: "Waiting to post",
    delayed: "Posting delayed",
    processing: "Posting",
    blocked: "Posting needs review",
    needs_credit_type: "Needs credit type",
    failed: "Posting failed",
    succeeded: "Posted to QuickBooks",
  };
  return {
    key,
    label: labels[key],
    reason: reason || null,
    lastAttemptAt: row.last_post_attempt_at || meta.last_post_attempt_at || null,
    lastOperationId,
  };
}

export function classifyBookkeepingLifecycle(row = {}) {
  row = row || {};
  const meta = row.meta || {};
  const status = String(row.status || "needs_review").toLowerCase();
  const pending = row.pending === true || row.bank_pending === true || meta.pending === true;
  const excluded = Boolean(row.excluded_at || meta.excluded_at || status === "excluded");
  const matchedExisting = status === "matched_existing_qbo" || meta.matched_existing_qbo === true || meta.incoming_deposit_match_status === "confirmed";
  const matchedPair = Boolean(meta.cc_payment_pair_id || row.cc_payment_pair_id) &&
    isConfirmedCreditCardPaymentPairStatus(meta.cc_payment_pair_status || row.cc_payment_pair_status);
  const postingOperationId = row.last_operation_id || meta.merchant_group_operation_id ||
    meta.post_intent_id || meta.manual_approval?.operation_id || null;
  const posted = status === "posted" || Boolean(
    row.posted_at ||
    String(row.posting_status || "").toLowerCase() === "posted" ||
    ((row.qbo_txn_id || row.qbo_entity_id) && (meta.qbo_posting_receipt_id || postingOperationId))
  );
  const postingOutcome = derivePostingOutcome(row);
  const failed = postingOutcome.key === "failed";
  const creditCardPayment = deriveCreditCardPaymentStatus(row);
  const accountType = String(row.account_type || row.account_subtype || meta.account_type || "").replace(/[\s_-]+/g, "").toLowerCase();
  const signedAmount = Number(row.signed_amount ?? row.amount ?? 0);
  const unresolvedCreditCardInflow = accountType.includes("creditcard") && signedAmount > 0 && !meta.credit_card_inflow_resolution?.resolution_type;

  let bucket;
  if (excluded) bucket = "excluded";
  else if (pending) bucket = "pending";
  // A card-payment workflow is Matched only when its pair reached a confirmed
  // terminal state. A legacy/raw `matched` status can survive a resolution-mode
  // flip or a partially completed old flow; it must not hide an unresolved leg
  // from Needs Review.
  else if (matchedPair || (!creditCardPayment && matchedExisting)) bucket = "matched";
  else if (posted) bucket = "posted";
  // An unresolved card payment is not an ordinary categorized transaction.
  // Payment matching must complete before it can leave Needs Review.
  else if (creditCardPayment && !creditCardPayment.matched) bucket = "needs_review";
  else if (unresolvedCreditCardInflow) bucket = "needs_review";
  else if (
    ["approved", "auto_approved", "handled", "failed", "failed_post", "post_failed", "ignored"].includes(status) ||
    String(row.review_status || "").toLowerCase() === "handled"
  ) bucket = "handled";
  else bucket = "needs_review";

  return {
    bucket,
    matchedExisting,
    matchedPair,
    pending,
    excluded,
    posted,
    failed,
    postingOutcome,
    creditCardPayment,
    orphaned: !PRIMARY_BOOKKEEPING_BUCKETS.includes(bucket),
  };
}

export function diagnoseBookkeepingLifecycle(row = {}) {
  const classification = classifyBookkeepingLifecycle(row);
  return {
    transactionId: row.transaction_id || row.id || null,
    ...classification,
    status: row.status || null,
    reviewStatus: row.review_status || null,
    postingStatus: row.posting_status || null,
  };
}
