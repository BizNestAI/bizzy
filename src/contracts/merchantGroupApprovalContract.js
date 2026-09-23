export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeTransactionUuids(values = []) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter((value) => UUID_PATTERN.test(value))));
}

export function postingReviewGroupStateKey(group = {}) {
  const transactionIds = Array.from(new Set([
    ...(Array.isArray(group.transaction_ids) ? group.transaction_ids : []),
    ...(Array.isArray(group.transactions) ? group.transactions.map((txn) => txn?.transaction_id) : []),
  ].filter(Boolean))).sort();
  return transactionIds.length ? `transactions:${transactionIds.join("|")}` : `group:${group.group_id || "missing"}`;
}

export function buildMerchantGroupApprovalRequest({
  businessId,
  group = {},
  transactionIds = [],
  exclusionIds = [],
  selectedQboAccountId,
  rememberForFuture = true,
  idempotencyKey = null,
} = {}) {
  return {
    business_id: String(businessId || "").trim(),
    group_id: group.group_id || null,
    group_snapshot_token: group.snapshot_token || null,
    selected_qbo_account_id: selectedQboAccountId ? String(selectedQboAccountId) : null,
    remember_for_future: rememberForFuture === true,
    action: "approve_and_post",
    transaction_ids: normalizeTransactionUuids(transactionIds),
    exclusion_ids: normalizeTransactionUuids(exclusionIds),
    expected_row_versions: group.row_versions || {},
    idempotency_key: idempotencyKey || `monthly-review-posting-group-${group.snapshot_token || group.group_id || "unknown"}`,
  };
}

export function normalizeMerchantGroupApprovalRequest(body = {}) {
  return {
    businessId: String(body.business_id || body.businessId || "").trim() || null,
    groupId: body.group_id || body.groupId || null,
    groupSnapshotToken: body.group_snapshot_token || body.snapshot_token || null,
    selectedQboAccountId: body.selected_qbo_account_id || body.qbo_account_id || null,
    rememberForFuture: body.remember_for_future !== false,
    action: body.action || "approve_and_post",
    suppliedTransactionCount: Array.isArray(body.transaction_ids) ? body.transaction_ids.length : 0,
    transactionIds: normalizeTransactionUuids(body.transaction_ids),
    exclusionIds: normalizeTransactionUuids(body.exclusion_ids),
    expectedRowVersions: body.expected_row_versions || {},
    idempotencyKey: body.idempotency_key || null,
  };
}
