export const REVIEW_HANDLED_STATUSES = new Set([
  "approved",
  "auto_approved",
  "handled",
  "failed",
  "posted",
  "matched_existing_qbo",
  "ignored",
]);

export const REVIEW_OPEN_STATUSES = new Set(["needs_review", "uncategorized"]);

export function isHandledReviewStatus(status) {
  return REVIEW_HANDLED_STATUSES.has(String(status || "").toLowerCase());
}

export function isOpenReviewStatus(status) {
  return REVIEW_OPEN_STATUSES.has(String(status || "needs_review").toLowerCase());
}

export function mayReopenReview({ previousStatus, explicitUndo = false, documentedReviewRequired = false } = {}) {
  if (!isHandledReviewStatus(previousStatus)) return true;
  return explicitUndo === true || documentedReviewRequired === true;
}

export function postingFailureStatus(previousStatus) {
  return isHandledReviewStatus(previousStatus) ? "failed" : String(previousStatus || "failed").toLowerCase();
}

export function shouldSkipSuggestionRefresh(row = {}) {
  return isHandledReviewStatus(row.status) || Boolean(row.final_qbo_account_id || row.qbo_txn_id || row.posted_at);
}

function withoutIdentity(row = {}) {
  const { business_id: _businessId, transaction_id: _transactionId, ...patch } = row;
  return patch;
}

export async function persistUnresolvedCategorizationRows({ db, businessId, rows = [], knownExistingIds = [] } = {}) {
  const existing = new Set((knownExistingIds || []).map(String));
  const persisted = [];
  for (const row of rows || []) {
    if (!row?.transaction_id) continue;
    if (!existing.has(String(row.transaction_id))) {
      const { data, error } = await db
        .from("transaction_categorizations")
        .insert(row)
        .select("transaction_id,suggested_qbo_account_id,suggested_qbo_account_name,confidence,status,reason,meta");
      if (error && error.code !== "23505") throw error;
      persisted.push(...(data || []));
      continue;
    }
    const { data, error } = await db
      .from("transaction_categorizations")
      .update(withoutIdentity(row))
      .eq("business_id", businessId)
      .eq("transaction_id", row.transaction_id)
      .in("status", ["needs_review", "uncategorized"])
      .is("qbo_txn_id", null)
      .select("transaction_id,suggested_qbo_account_id,suggested_qbo_account_name,confidence,status,reason,meta");
    if (error) throw error;
    persisted.push(...(data || []));
  }
  return persisted;
}

export default {
  isHandledReviewStatus,
  isOpenReviewStatus,
  mayReopenReview,
  postingFailureStatus,
  shouldSkipSuggestionRefresh,
  persistUnresolvedCategorizationRows,
};
