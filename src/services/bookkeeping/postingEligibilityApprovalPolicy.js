export const BULK_APPROVABLE_POSTING_REASON_CODES = new Set([
  "no_active_authoritative_business_rule",
  "suggestion_only_categorization",
  "insufficient_reusable_merchant_evidence",
  "weak_memo_evidence",
  "missing_safe_to_auto_post_attestation",
  "categorization_provenance_requires_confirmation",
  "automatic_posting_safety_not_established",
]);

export function isBulkApprovablePostingReason(reason) {
  return BULK_APPROVABLE_POSTING_REASON_CODES.has(String(reason || ""));
}
