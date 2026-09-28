const TAXONOMY_REVIEW_BLOCK_REASON = "taxonomy_requires_review";

export const TAXONOMY_TYPES_REQUIRING_SPECIAL_POSTING_REVIEW = new Set([
  "cc_payment",
  "transfer_internal",
  "bank_transfer",
  "owner_draw",
  "owner_contribution",
  "owner_distribution",
  "refund",
  "loan_payment",
  "loan_movement",
  "tax_payment",
  "payroll",
]);

const STRUCTURAL_POSTING_WORKFLOW_TAXONOMY_TYPES = new Set([
  "cc_payment",
  "transfer_internal",
  "bank_transfer",
  "loan_payment",
  "split_transaction",
]);

const MANUAL_DECISION_ACTORS = new Set([
  "user",
  "accountant",
  "user_clarification",
  "manual",
  "manual_user",
]);

function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

export function taxonomyTypeFromMeta(meta = {}) {
  return normalized(meta?.taxonomy_type);
}

export function isProtectedPostingWorkflow(meta = {}) {
  const taxonomyType = taxonomyTypeFromMeta(meta);
  if (STRUCTURAL_POSTING_WORKFLOW_TAXONOMY_TYPES.has(taxonomyType)) return true;
  if (meta?.cc_payment_pair_id || meta?.cc_payment_bank_qbo_account_id || meta?.cc_payment_cc_qbo_account_id) return true;
  if (normalized(meta?.cc_payment_pair_status) === "confirmed") return true;
  if (normalized(meta?.split_transaction_status) === "confirmed" || meta?.split_transaction_id) return true;
  if (normalized(meta?.loan_payment_split_status) === "confirmed" || meta?.loan_payment_split_id) return true;
  return false;
}

export function hasManualAccountAuthority(item = {}) {
  const meta = item?.meta || {};
  const finalAccountId = item?.final_qbo_account_id || item?.finalAccountId || item?.newAccountId || null;
  if (!finalAccountId) return false;
  if (MANUAL_DECISION_ACTORS.has(normalized(item?.decided_by || item?.decidedBy))) return true;
  if (meta?.manual_qbo_account_selection === true) return true;
  if (normalized(meta?.auto_approve_reason) === "manual_user") return true;
  const source = normalized(meta?.accounting_decision_source || meta?.taxonomy_resolved_by || meta?.taxonomy_override);
  return source.includes("manual") && (source.includes("account") || source.includes("qbo") || source.includes("income"));
}

export function resolveManualApprovalBookkeepingMeta(meta = {}, { explicitFinalAccountId = null, source = "manual_qbo_account_selection" } = {}) {
  const next = { ...(meta || {}) };
  const taxonomyType = taxonomyTypeFromMeta(next);
  if (!explicitFinalAccountId) return next;

  next.manual_qbo_account_selection = true;
  next.accounting_decision_source = next.accounting_decision_source || source;

  if (!taxonomyType || isProtectedPostingWorkflow(next)) return next;
  if (!TAXONOMY_TYPES_REQUIRING_SPECIAL_POSTING_REVIEW.has(taxonomyType)) return next;

  next.resolved_taxonomy_type = next.taxonomy_type;
  next.resolved_taxonomy_subtype = next.taxonomy_subtype || null;
  next.taxonomy_resolved_by = source;
  next.taxonomy_override = next.taxonomy_override || source;
  delete next.taxonomy_type;
  delete next.taxonomy_subtype;
  delete next.taxonomy_confidence;
  if (next.post_block_reason === TAXONOMY_REVIEW_BLOCK_REASON) delete next.post_block_reason;
  if (next.auto_post_block_reason === TAXONOMY_REVIEW_BLOCK_REASON) delete next.auto_post_block_reason;
  return next;
}

export function applyManualAccountAuthorityToPostingItem(item = {}) {
  if (!hasManualAccountAuthority(item)) return item;
  const meta = resolveManualApprovalBookkeepingMeta(item?.meta || {}, {
    explicitFinalAccountId: item?.final_qbo_account_id || null,
    source: "manual_qbo_account_selection",
  });
  return { ...item, meta };
}

export function clearResolvedPostingTaxonomyMeta(meta = {}) {
  return resolveManualApprovalBookkeepingMeta(meta, {
    explicitFinalAccountId: "posting_account_selected",
    source: meta?.taxonomy_resolved_by || "manual_qbo_account_selection",
  });
}

export function taxonomyRequiresBookkeepingPostingReview(item = {}) {
  const effective = hasManualAccountAuthority(item) ? applyManualAccountAuthorityToPostingItem(item) : item;
  const taxonomyType = taxonomyTypeFromMeta(effective?.meta || {});
  if (!taxonomyType || taxonomyType === "cc_payment") return false;
  if (!TAXONOMY_TYPES_REQUIRING_SPECIAL_POSTING_REVIEW.has(taxonomyType)) return false;
  return true;
}
