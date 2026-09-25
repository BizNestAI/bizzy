export function getBookkeepingExclusionEligibility(transaction = {}) {
  const meta = transaction.meta || {};
  const status = String(transaction.status || transaction.cat_status || "needs_review").toLowerCase();
  if (status === "excluded" || transaction.excluded_at || meta.excluded_at) {
    return { eligible: true, idempotent: true, reason: "already_excluded" };
  }
  const postingOperationId = transaction.last_operation_id || meta.merchant_group_operation_id ||
    meta.post_intent_id || meta.manual_approval?.operation_id || null;
  const confirmedPosted = status === "posted" || transaction.posted_at || transaction.posting_status === "posted" ||
    (transaction.qbo_txn_id && (meta.qbo_posting_receipt_id || postingOperationId));
  if (confirmedPosted) {
    return { eligible: false, idempotent: false, reason: "transaction_already_posted" };
  }
  if (status === "matched" || status === "matched_existing_qbo" || meta.incoming_deposit_match_status === "confirmed") {
    return { eligible: false, idempotent: false, reason: "transaction_already_matched" };
  }
  if (transaction.posting_status === "posting" || meta.posting_in_progress === true) {
    return { eligible: false, idempotent: false, reason: "posting_in_progress" };
  }
  return { eligible: true, idempotent: false, reason: null };
}
