import { createHash, randomUUID } from "node:crypto";
import { listTaxClassifications } from "./taxClassification.repository.js";
import { buildTaxDecisionIdentity, taxDecisionTypeForRow } from "./taxDeductionsLifecycleProjection.js";
import { buildGroupedDeductionDecisionFingerprint } from "./taxGroupedDeductionDecisionFingerprint.js";
import { applyGroupedTaxDeductionDecision, getGroupedTaxDeductionDecisionOperation } from "./taxGroupedDeductionDecision.service.js";
import { buildGroupedDecisionManifest, compareGroupedDecisionManifests, fingerprintGroupedDecisionManifest } from "./taxGroupedDecisionManifest.js";
import { conflictError, forbiddenBusinessError, notFoundError, validationError } from "./taxErrors.js";
import { buildTaxQuestionIdentity } from "./taxQuestionSemanticIdentity.js";

const DEFAULT_PREVIEW_TTL_SECONDS = 10 * 60;

export async function createGroupedDecisionPreview({ supabase, businessId, taxYear, groupId, actor = {}, now = new Date() } = {}) {
  requireCustomerActor(actor);
  const rows = await decisionGroupRows({ supabase, businessId, taxYear, groupId });
  if (!rows.length) throw notFoundError("grouped_decision_group_not_found", "This Tax question is no longer available.");
  const manifest = buildGroupedDecisionManifest({ businessId, taxYear, rows });
  const actionable = rows.filter(isActionable);
  const first = actionable[0] || rows[0];
  const previewId = randomUUID();
  const expiresAt = new Date(now.getTime() + previewTtlSeconds() * 1000).toISOString();
  const record = {
    id: previewId,
    business_id: businessId,
    tax_year: Number(taxYear),
    actor_user_id: actor.userId,
    group_id: groupId,
    decision_type: taxDecisionTypeForClassification(first),
    scope: {
      tax_category: first.tax_category,
      qbo_account_id: accountId(first),
      semantic_fingerprint: questionIdentity({ businessId, taxYear, row: first }).semanticFingerprint,
      rule_versions: [...new Set(rows.map(ruleVersion).filter(Boolean))].sort(),
    },
    semantic_manifest: manifest,
    semantic_fingerprint: fingerprintGroupedDecisionManifest(manifest),
    actionable_transaction_ids: actionable.map((row) => String(row.transaction_id)).sort(),
    protected_transaction_ids: rows.filter((row) => !isActionable(row)).map((row) => String(row.transaction_id)).sort(),
    expires_at: expiresAt,
  };
  const { error } = await supabase.from("tax_grouped_deduction_decision_previews").insert(record);
  if (error) throw error;
  return customerPreview(record, rows);
}

export async function confirmGroupedDecisionPreview({ supabase, businessId, taxYear, input = {}, actor = {}, now = new Date() } = {}) {
  requireCustomerActor(actor);
  const previewId = text(input.previewId);
  if (!previewId) throw validationError("missing_grouped_decision_preview", "A current decision preview is required.");
  const { data: preview, error } = await supabase.from("tax_grouped_deduction_decision_previews").select("*")
    .eq("id", previewId).eq("business_id", businessId).eq("tax_year", Number(taxYear)).maybeSingle();
  if (error) throw error;
  if (!preview || String(preview.actor_user_id) !== String(actor.userId)) throw forbiddenBusinessError("This decision preview does not belong to the current customer.");
  const confirmationFingerprint = fingerprintConfirmation(input);
  if (preview.consumed_at) {
    if (preview.idempotency_key === input.idempotencyKey && preview.confirmation_fingerprint === confirmationFingerprint) {
      const operation = await getGroupedTaxDeductionDecisionOperation({ supabase, businessId, taxYear, idempotencyKey: input.idempotencyKey });
      if (operation.status === "not_found") throw conflictError("grouped_decision_outcome_unknown", "The saved decision outcome is not available yet.");
      return operation.result;
    }
    if (preview.idempotency_key === input.idempotencyKey) throw conflictError("idempotency_payload_conflict", "This request key was already used for a different decision.");
    throw conflictError("preview_already_consumed", "This preview has already been used. Refresh before trying again.");
  }
  if (Date.parse(preview.expires_at) <= now.getTime()) throw conflictError("preview_expired", "This preview expired. Refresh before trying again.");
  const rows = await decisionGroupRows({ supabase, businessId, taxYear, groupId: preview.group_id });
  const currentManifest = buildGroupedDecisionManifest({ businessId, taxYear, rows });
  const difference = compareGroupedDecisionManifests(preview.semantic_manifest, currentManifest);
  if (difference) throw conflictError(difference.code, "These transactions changed while you were reviewing them.", {
    action: "refresh_tax_deductions", previewId, previousCount: preview.semantic_manifest?.entries?.length || 0,
    currentCount: currentManifest.entries.length, addedCount: difference.addedCount, removedCount: difference.removedCount,
    changedFields: difference.changedFields,
  });
  return applyFromPreview({ supabase, businessId, taxYear, preview, input, actor, rows, confirmationFingerprint });
}

async function applyFromPreview({ supabase, businessId, taxYear, preview, input, actor, rows = null, confirmationFingerprint = fingerprintConfirmation(input) }) {
  const currentRows = rows || await decisionGroupRows({ supabase, businessId, taxYear, groupId: preview.group_id });
  const actionableIds = new Set(preview.actionable_transaction_ids || []);
  const exceptions = new Set((input.personalExceptionIds || []).map(String));
  if ([...exceptions].some((id) => !actionableIds.has(id))) throw validationError("invalid_grouped_decision_exceptions", "A selected exception is outside this preview.");
  const businessIds = [...actionableIds].filter((id) => !exceptions.has(id)).sort();
  if (!businessIds.length) throw validationError("invalid_grouped_decision_targets", "At least one business expense is required.");
  const targetIds = businessIds;
  const first = currentRows.find((row) => businessIds.includes(String(row.transaction_id)));
  const changes = treatmentForAnswer(first, input);
  const reason = "Customer confirmed a grouped Tax question from a server preview.";
  const scope = { taxCategory: first.tax_category, qboAccountId: accountId(first), decisionType: preview.decision_type, semanticFingerprint: preview.scope?.semantic_fingerprint };
  const scopeFingerprint = buildGroupedDeductionDecisionFingerprint({ businessId, taxYear, ...scope, transactionIds: targetIds, expectedPopulationTransactionIds: [...actionableIds], personalExceptionIds: [...exceptions], changes, reason });
  return applyGroupedTaxDeductionDecision({ supabase, businessId, taxYear, actor, input: {
    idempotencyKey: input.idempotencyKey, previewId: preview.id, confirmationFingerprint, scope, scopeFingerprint, targetTransactionIds: targetIds,
    expectedPopulationTransactionIds: [...actionableIds], personalExceptionIds: [...exceptions], changes, reason,
  } });
}

async function decisionGroupRows({ supabase, businessId, taxYear, groupId }) {
  const { rows } = await listTaxClassifications({ supabase, businessId, taxYear, limit: 10_000 });
  return (rows || []).filter((row) => decisionIdentity({ businessId, taxYear, row }) === groupId);
}

function decisionIdentity({ businessId, taxYear, row }) {
  const decisionType = taxDecisionTypeForClassification(row);
  if (!decisionType) return null;
  return buildTaxDecisionIdentity({ businessId, taxYear, decisionType, row: classificationQuestionRow(row) });
}

function questionIdentity({ businessId, taxYear, row }) {
  const decisionType = taxDecisionTypeForClassification(row);
  return buildTaxQuestionIdentity({ businessId, taxYear, decisionType, row: classificationQuestionRow(row) });
}

function classificationQuestionRow(row) {
  return {
    transactionId: row.transaction_id, taxScopeDisposition: "expense_cogs_in_matrix",
    qboAccountId: accountId(row), qboAccountName: row.source_qbo_account_name || row.metadata?.source_qbo_account_name,
    taxCategory: row.tax_category, taxTreatment: row.tax_treatment?.type || row.tax_treatment,
    deductiblePercent: row.deductible_percent, deductibilityStatus: row.deductibility_status,
    metadata: row.metadata, ruleVersion: ruleVersion(row), ruleCode: row.rule_code,
  };
}

function taxDecisionTypeForClassification(row) {
  return taxDecisionTypeForRow({ taxScopeDisposition: "expense_cogs_in_matrix", taxCategory: row.tax_category,
    qboAccountName: row.source_qbo_account_name || row.metadata?.source_qbo_account_name,
    ruleCode: row.rule_code, taxTreatment: row.tax_treatment?.type || row.tax_treatment });
}

function treatmentForAnswer(row, input) {
  if (input.answer === "business_use_percent") {
    const percent = Number(input.businessUsePercent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw validationError("invalid_business_use_percent", "Business use must be between 0 and 100.");
    return { taxCategory: row.tax_category, deductibilityStatus: percent === 100 ? "fully_deductible" : percent === 0 ? "nondeductible" : "partially_deductible", deductiblePercent: percent, taxTreatment: "business_use_allocation" };
  }
  const percent = Number(row.deductible_percent ?? (String(row.tax_category).includes("meal") ? 50 : 100));
  return { taxCategory: row.tax_category, deductibilityStatus: row.deductibility_status || (percent === 100 ? "fully_deductible" : "partially_deductible"), deductiblePercent: percent, taxTreatment: row.tax_treatment || (String(row.tax_category).includes("meal") ? "business_meals_business_purpose_confirmed" : "business_purpose_confirmed") };
}

function customerPreview(record, rows) {
  const actionable = rows.filter(isActionable);
  return { previewVersion: "tax-grouped-decision-preview-v1", previewId: record.id, canonicalBusinessId: record.business_id,
    taxYear: Number(record.tax_year), groupId: record.group_id, decisionType: record.decision_type, expiresAt: record.expires_at,
    totalGroupCount: rows.length, actionableCount: actionable.length, previouslyReviewedCount: rows.length - actionable.length,
    grossAmountCents: actionable.reduce((sum, row) => sum + Math.abs(Math.round(Number(row.book_amount || 0) * 100)), 0),
    estimatedDeductionCents: actionable.reduce((sum, row) => sum + Math.round(Math.abs(Number(row.book_amount || 0) * 100) * Number(row.deductible_percent || 0) / 100), 0),
    transactions: actionable.map((row) => ({ transactionId: String(row.transaction_id), grossAmountCents: Math.abs(Math.round(Number(row.book_amount || 0) * 100)) })),
    proposedTreatment: actionable[0] ? {
      taxCategory: actionable[0].tax_category,
      taxTreatment: actionable[0].tax_treatment,
      deductibilityStatus: actionable[0].deductibility_status,
      deductiblePercent: Number(actionable[0].deductible_percent || 0),
    } : null,
    authorityBreakdown: {
      actionable: actionable.length,
      protected: rows.length - actionable.length,
    },
    futureDefaultScope: { accountScoped: true, taxYear: record.tax_year },
  };
}

function requireCustomerActor(actor) { if (!actor.userId || actor.source !== "user" || actor.tenantMode === "admin_view") throw forbiddenBusinessError("Customer authorization is required for this decision."); }
function isActionable(row) { return row.classification_status === "needs_review" && row.requires_review === true && !row.user_override && !row.cpa_override; }
function accountId(row) { return text(row.source_qbo_account_id || row.metadata?.source_qbo_account_id); }
function ruleVersion(row) { return text(row.rule_version || row.metadata?.rule_version || row.rule_code || row.tax_treatment?.type || row.tax_treatment); }
function previewTtlSeconds() { const value = Number(globalThis.process?.env?.TAX_GROUPED_DECISION_PREVIEW_TTL_SECONDS || DEFAULT_PREVIEW_TTL_SECONDS); return Number.isFinite(value) && value >= 60 && value <= 3600 ? value : DEFAULT_PREVIEW_TTL_SECONDS; }
function fingerprintConfirmation(input = {}) {
  const payload = JSON.stringify({
    answer: text(input.answer),
    businessUsePercent: input.businessUsePercent == null ? null : Number(input.businessUsePercent),
    personalExceptionIds: [...new Set((input.personalExceptionIds || []).map(String))].sort(),
  });
  return `gdc-v1-${createHash("sha256").update(payload).digest("hex")}`;
}
function text(value) { return value == null ? "" : String(value).trim(); }

export const __testables = { decisionIdentity, taxDecisionTypeForClassification, treatmentForAnswer, customerPreview, fingerprintConfirmation };
