import { deriveCreditCardPaymentStatus, isConfirmedCreditCardPaymentPairStatus } from "./creditCardPaymentStatus.js";
import { hasProvenPostingFailure } from "./reconciliationPipelineStatus.js";

export const PRIMARY_BOOKKEEPING_BUCKETS = Object.freeze([
  "needs_review", "handled", "posted", "matched", "pending", "failed", "reconciled",
]);

export function classifyBookkeepingLifecycle(row = {}) {
  const meta = row.meta || {};
  const status = String(row.status || "needs_review").toLowerCase();
  const pending = row.pending === true || row.bank_pending === true || meta.pending === true;
  const matchedExisting = status === "matched_existing_qbo" || meta.matched_existing_qbo === true || meta.incoming_deposit_match_status === "confirmed";
  const matchedPair = Boolean(meta.cc_payment_pair_id || row.cc_payment_pair_id) &&
    isConfirmedCreditCardPaymentPairStatus(meta.cc_payment_pair_status || row.cc_payment_pair_status);
  const posted = status === "posted" || Boolean(row.qbo_txn_id || row.qbo_entity_id || row.posted_at);
  const failed = hasProvenPostingFailure(row);
  const creditCardPayment = deriveCreditCardPaymentStatus(row);

  let bucket;
  if (pending) bucket = "pending";
  else if (posted) bucket = "posted";
  // A card-payment workflow is Matched only when its pair reached a confirmed
  // terminal state. A legacy/raw `matched` status can survive a resolution-mode
  // flip or a partially completed old flow; it must not hide an unresolved leg
  // from Needs Review.
  else if (matchedPair || (!creditCardPayment && (matchedExisting || status === "matched"))) bucket = "matched";
  else if (failed) bucket = "failed";
  else if (row.reconciled_at) bucket = "reconciled";
  // An unresolved card payment is not an ordinary categorized transaction.
  // Payment matching must complete before it can leave Needs Review.
  else if (creditCardPayment && !creditCardPayment.matched) bucket = "needs_review";
  else if (["approved", "auto_approved", "handled", "ignored"].includes(status)) bucket = "handled";
  else bucket = "needs_review";

  return {
    bucket,
    matchedExisting,
    matchedPair,
    pending,
    posted,
    failed,
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
