import crypto from "node:crypto";

export const FINAL_CATEGORIZATION_SOURCES = Object.freeze({
  AUTOMATIC: "automatic_rule",
  CUSTOMER: "customer_manual",
  ADMIN: "admin_manual",
});

function stableApprovalKey({ businessId, row, approvalSource, ruleSourceId }) {
  if (row.approval_idempotency_key) return row.approval_idempotency_key;
  return crypto.createHash("sha256").update(JSON.stringify({
    action: "final_categorization",
    business_id: businessId,
    transaction_id: row.transaction_id,
    final_qbo_account_id: row.final_qbo_account_id,
    status: row.status,
    approval_source: approvalSource,
    rule_source_id: ruleSourceId || null,
  })).digest("hex");
}

export function buildAuthoritativeFinalCategorization({
  businessId,
  row,
  approvalSource,
  actorId = null,
  ruleSourceId = null,
  provenance = null,
  nowIso = new Date().toISOString(),
} = {}) {
  if (!businessId || !row?.transaction_id) throw new Error("final_categorization_identity_required");
  if (!row.final_qbo_account_id || !row.final_qbo_account_name) throw new Error("final_categorization_account_required");
  if (!Object.values(FINAL_CATEGORIZATION_SOURCES).includes(approvalSource)) throw new Error("final_categorization_source_required");
  const approvalIdempotencyKey = stableApprovalKey({ businessId, row, approvalSource, ruleSourceId });
  return {
    ...row,
    business_id: businessId,
    decided_at: row.decided_at || nowIso,
    updated_at: row.updated_at || nowIso,
    approval_idempotency_key: approvalIdempotencyKey,
    meta: {
      ...(row.meta || {}),
      approval_idempotency_key: approvalIdempotencyKey,
      approval_source: approvalSource,
      categorization_provenance: provenance || row.meta?.categorization_provenance || row.meta?.evidence_source || null,
      final_categorization: {
        source: approvalSource,
        actor_id: actorId || null,
        rule_source_id: ruleSourceId || null,
        approved_at: row.decided_at || nowIso,
        provenance: provenance || row.meta?.categorization_provenance || row.meta?.evidence_source || null,
      },
    },
  };
}

export async function persistAuthoritativeFinalCategorizations({
  db,
  businessId,
  rows,
  approvalSource,
  actorId = null,
  actorType,
  ruleSourceIdForRow = () => null,
  provenanceForRow = () => null,
  requireNeedsReview = false,
} = {}) {
  if (!db || !Array.isArray(rows) || !rows.length) throw new Error("final_categorization_rows_required");
  const nowIso = new Date().toISOString();
  const approvals = rows.map((row) => buildAuthoritativeFinalCategorization({
    businessId,
    row,
    approvalSource,
    actorId,
    ruleSourceId: ruleSourceIdForRow(row),
    provenance: provenanceForRow(row),
    nowIso,
  }));
  const { data, error } = await db.rpc("approve_bookkeeping_transactions_atomic", {
    p_business_id: businessId,
    p_actor_id: actorId,
    p_actor_type: actorType,
    p_approvals: approvals,
    p_require_needs_review: requireNeedsReview === true,
  });
  if (error) throw error;
  return Array.isArray(data) ? data : data?.rows || [];
}

export default { buildAuthoritativeFinalCategorization, persistAuthoritativeFinalCategorizations };
