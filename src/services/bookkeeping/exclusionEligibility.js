export function getBookkeepingExclusionEligibility(transaction = {}) {
  const meta = transaction.meta || {};
  const status = String(transaction.status || transaction.cat_status || "needs_review").toLowerCase();
  if (status === "excluded" || transaction.excluded_at || meta.excluded_at) {
    return { eligible: true, idempotent: true, reason: "already_excluded" };
  }
  if (status === "posted" || transaction.qbo_txn_id || transaction.posted_at) {
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
