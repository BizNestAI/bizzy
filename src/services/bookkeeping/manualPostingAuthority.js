const MONTHLY_REVIEW_SOURCE = "monthly_review_posting_review";

const SOFT_REVIEW_REASONS = new Set([
  "probable_requires_review",
  "weak_memo_evidence",
  "low_classifier_confidence",
  "low_classification_confidence",
  "classifier_low_confidence",
  "merchant_ambiguous",
  "ambiguous",
  "display_name_conflict",
  "unclear_or_non_vendor_name",
  "no_matching_vendor_rule",
  "vendor_mapping_required",
]);

function normalizeReason(value) {
  return String(value || "").trim().toLowerCase();
}

export function originalManualReviewReason(item = {}) {
  const meta = item.meta || {};
  return (
    meta.manual_approval?.original_review_reason ||
    meta.merchant_group_original_review_reason ||
    item.reason ||
    meta.review_reason ||
    meta.auto_handled_reason ||
    meta.classification_reason ||
    item.post_error ||
    null
  );
}

export function buildMonthlyReviewManualApproval({
  item = {},
  businessId,
  transactionId,
  actorId = null,
  selectedQboAccountId,
  selectedQboAccountName = null,
  operationId,
  idempotencyKey = null,
  approvedAt = new Date().toISOString(),
} = {}) {
  return {
    source: MONTHLY_REVIEW_SOURCE,
    authority: "admin_manual_approval",
    business_id: businessId || item.business_id || null,
    transaction_id: transactionId || item.transaction_id || null,
    approved_by: actorId || null,
    approved_at: approvedAt,
    selected_qbo_account_id: selectedQboAccountId ? String(selectedQboAccountId) : null,
    selected_qbo_account_name: selectedQboAccountName || null,
    original_review_reason: originalManualReviewReason(item),
    operation_id: operationId || null,
    idempotency_key: idempotencyKey || null,
  };
}

export function hasAuthorizedMonthlyReviewApproval(item = {}) {
  const approval = item?.meta?.manual_approval;
  return Boolean(
    approval &&
      approval.source === MONTHLY_REVIEW_SOURCE &&
      approval.authority === "admin_manual_approval" &&
      approval.business_id &&
      approval.transaction_id &&
      approval.approved_at &&
      approval.selected_qbo_account_id &&
      approval.operation_id
  );
}

export function isSoftReviewPolicyReason(reason) {
  const normalized = normalizeReason(reason);
  return SOFT_REVIEW_REASONS.has(normalized) ||
    /(^|_)(low|weak)_(classifier_|classification_)?confidence$/.test(normalized) ||
    /merchant.*ambig|ambig.*merchant/.test(normalized);
}

export function decideManualPostingGate({ item = {}, reason, gate = "review_policy" } = {}) {
  const authorized = hasAuthorizedMonthlyReviewApproval(item);
  const soft = isSoftReviewPolicyReason(reason);
  if (authorized && soft) {
    return {
      allowed: true,
      bypassed: true,
      gate,
      reason: normalizeReason(reason),
      authority: "admin_manual_approval",
    };
  }
  return {
    allowed: !reason,
    bypassed: false,
    gate,
    reason: normalizeReason(reason) || null,
    authority: authorized ? "admin_manual_approval" : null,
  };
}

export const MANUAL_POSTING_APPROVAL_SOURCE = MONTHLY_REVIEW_SOURCE;
