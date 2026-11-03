import { withTaxPreviewDeadline } from "./taxPreviewDeadline.js";
import { createHash, randomUUID } from "node:crypto";
import { listTaxClassifications } from "./taxClassification.repository.js";
import { buildTaxDecisionIdentity, taxDecisionTypeForRow } from "./taxDeductionsLifecycleProjection.js";
import { buildGroupedDeductionDecisionFingerprint } from "./taxGroupedDeductionDecisionFingerprint.js";
import { applyGroupedTaxDeductionDecision, getGroupedTaxDeductionDecisionOperation } from "./taxGroupedDeductionDecision.service.js";
import { buildGroupedDecisionManifest, compareGroupedDecisionManifests, fingerprintGroupedDecisionManifest } from "./taxGroupedDecisionManifest.js";
import { conflictError, forbiddenBusinessError, notFoundError, validationError } from "./taxErrors.js";
import { buildTaxQuestionIdentity } from "./taxQuestionSemanticIdentity.js";
import { calculateVehicleExpenseEstimate, vehicleTreatmentForAnswer } from "./taxVehicleQuestionContract.js";
import { listTaxQuestionBankRowsByIds } from "./taxPostedTransaction.repository.js";
import { listVehicleDeductionWorkflows } from "./taxVehicleDeduction.service.js";
import { getLatestTaxWorkspaceProjection, reconcileTaxWorkspaceProjection } from "./taxWorkspaceProjection.service.js";
import { taxDiagnosticFingerprint, taxDiagnosticIdentity, taxMembershipDiagnostics } from "./taxPreviewDiagnostics.js";

const DEFAULT_PREVIEW_TTL_SECONDS = 10 * 60;

export async function createGroupedDecisionPreview({ supabase, businessId, taxYear, groupId, projectionId = null, sourceFingerprint = null, actor = {}, now = new Date(), diagnostics = {} } = {}) {
  diagnostics.stage = "customer_authorization";
  requireCustomerActor(actor);
  let workspaceProjection = await requireCurrentWorkspaceProjection({ supabase, businessId, taxYear, projectionId, sourceFingerprint, groupId, diagnostics });
  const publishedProjection = workspaceProjection;
  if (workspaceProjection) {
    diagnostics.stage = "workspace_membership_reconciliation";
    const storedMembers = taxMembershipDiagnostics(workspaceProjection.projection_data?.identityEvidence?.questionGroups?.[groupId] || []);
    diagnostics.storedMemberCount = storedMembers.expectedMemberCount;
    diagnostics.storedMemberHash = storedMembers.expectedMemberHash;
    // Workspace GET overlays current classifications on this immutable
    // population. Compare against that same question representation, while
    // retaining the persisted ID/fingerprint and the exact membership guard.
    workspaceProjection = { ...workspaceProjection, projection_data: await reconcileTaxWorkspaceProjection({
      supabase, record: workspaceProjection, businessId, taxYear,
    }) };
  }
  diagnostics.stage = "live_group_resolution";
  const rows = await decisionGroupRows({ supabase, businessId, taxYear, groupId });
  if (!rows.length) throw notFoundError("grouped_decision_group_not_found", "This Tax question is no longer available.");
  diagnostics.resolvedGroupId = taxDiagnosticIdentity(groupId);
  const manifest = buildGroupedDecisionManifest({ businessId, taxYear, rows });
  const actionable = rows.filter(isActionable);
  // A live overlay is not a newly published concurrency identity. Require the
  // published question too, so changed membership recovers through a rebuild
  // rather than silently authorizing a different population under the old ID.
  matrixReconciliation({ record: { group_id: groupId }, actionable, workspaceProjection: publishedProjection, diagnostics });
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
      workspace_projection_id: workspaceProjection?.id || null,
      workspace_source_fingerprint: workspaceProjection?.source_fingerprint || null,
      rule_versions: [...new Set(rows.map(ruleVersion).filter(Boolean))].sort(),
    },
    semantic_manifest: manifest,
    semantic_fingerprint: fingerprintGroupedDecisionManifest(manifest),
    actionable_transaction_ids: actionable.map((row) => String(row.transaction_id)).sort(),
    protected_transaction_ids: rows.filter((row) => !isActionable(row)).map((row) => String(row.transaction_id)).sort(),
    expires_at: expiresAt,
  };
  diagnostics.stage = "preview_persistence";
  const { error } = await supabase.from("tax_grouped_deduction_decision_previews").insert(record);
  if (error) throw error;
  diagnostics.stage = "transaction_hydration";
  const sourceRows = actionable.length ? await listTaxQuestionBankRowsByIds({
    supabase, businessId, taxYear, transactionIds: record.actionable_transaction_ids,
  }) : [];
  const classificationById = new Map(actionable.map((row) => [String(row.transaction_id), row]));
  const summaries = new Map(sourceRows.map((source) => {
    const id = String(source.id);
    return [id, questionTransactionSummary(source, classificationById.get(id))];
  }));
  diagnostics.stage = "preview_construction";
  const result = customerPreview(record, rows, summaries, workspaceProjection, diagnostics);
  if (record.decision_type !== "vehicle_method") return result;
  diagnostics.stage = "optional_vehicle_context";
  return {
    ...result,
    vehicleContext: await optionalVehicleContext(() => listVehicleDeductionWorkflows({ supabase, businessId, taxYear: Number(taxYear) })),
  };
}

// Vehicle setup is optional display context, not question membership authority.
export async function optionalVehicleContext(load, timeoutMs = 1_000) {
  try {
    return await withTaxPreviewDeadline(load, { timeoutMs });
  } catch {
    return { vehicles: [], unavailable: true };
  }
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
  if (preview.decision_type === "vehicle_method" && input.answer !== "vehicle_method") throw validationError("vehicle_method_answer_required", "Choose a vehicle method and business-use allocation for this vehicle question.");
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
  const vehicleExpenseEstimate = input.answer === "vehicle_method" ? calculateVehicleExpenseEstimate({ ...input, rows: currentRows.filter((row) => businessIds.includes(String(row.transaction_id))), taxCategory: first.tax_category }) : null;
  const result = await applyGroupedTaxDeductionDecision({ supabase, businessId, taxYear, actor, input: {
    idempotencyKey: input.idempotencyKey, previewId: preview.id, confirmationFingerprint, scope, scopeFingerprint, targetTransactionIds: targetIds,
    expectedPopulationTransactionIds: [...actionableIds], personalExceptionIds: [...exceptions], changes, reason,
    vehicleElection: input.answer === "vehicle_method" ? {
      vehicleId: input.vehicleId,
      vehicleScope: input.vehicleScope,
      method: input.vehicleMethod,
      expectedActiveElectionId: input.expectedActiveElectionId,
      businessUsePercent: changes.deductiblePercent,
      eligibility: input.eligibility,
    } : null,
  } });
  return vehicleExpenseEstimate ? { ...result, vehicleExpenseEstimate } : result;
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
  if (input.answer === "vehicle_method") {
    try {
      return vehicleTreatmentForAnswer({ ...input, taxCategory: row.tax_category });
    } catch (error) {
      throw validationError(error.code || "invalid_vehicle_decision", error.message);
    }
  }
  if (input.answer === "business_use_percent") {
    const percent = Number(input.businessUsePercent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw validationError("invalid_business_use_percent", "Business use must be between 0 and 100.");
    return { taxCategory: row.tax_category, deductibilityStatus: percent === 100 ? "fully_deductible" : percent === 0 ? "nondeductible" : "partially_deductible", deductiblePercent: percent, taxTreatment: "business_use_allocation" };
  }
  if (!["all_business", "some_personal"].includes(input.answer)) {
    throw validationError("non_decisive_grouped_decision", "This answer does not complete a tax treatment.");
  }
  return completedBusinessPurposeTreatment(row);
}

// Business-purpose review answers complete the classifier's provisional
// treatment. Keep this server-owned mapping shared by preview and apply so a
// browser can never promote `needs_review` (or choose its own percentage) into
// a future automatic rule.
function completedBusinessPurposeTreatment(row = {}) {
  const taxCategory = text(row.tax_category);
  const meals = taxCategory === "business_meals";
  return {
    taxCategory,
    deductibilityStatus: meals ? "partially_deductible" : "fully_deductible",
    deductiblePercent: meals ? 50 : 100,
    taxTreatment: meals ? "business_meals_business_purpose_confirmed" : "business_purpose_confirmed",
  };
}

function customerPreview(record, rows, summaries = null, workspaceProjection = null, diagnostics = {}) {
  const actionable = rows.filter(isActionable);
  const actionableIds = actionable.map((row) => String(row.transaction_id));
  if (actionableIds.length && (!(summaries instanceof Map) || summaries.size !== actionableIds.length || actionableIds.some((id) => !summaries.has(id)))) {
    throw conflictError("grouped_decision_preview_hydration_incomplete", "These transaction details could not be loaded completely.");
  }
  const transactions = actionableIds.map((id) => summaries.get(id)).sort(compareQuestionTransactions);
  const signedGrossAmountCents = actionable.reduce((sum, row) => sum + Math.round(Number(row.book_amount || 0) * 100), 0);
  if (transactions.reduce((sum, row) => sum + Math.round(Number(row.signedAmount) * 100), 0) !== signedGrossAmountCents) {
    throw conflictError("grouped_decision_preview_amount_mismatch", "These transaction details no longer match this question.");
  }
  return { previewVersion: "tax-grouped-decision-preview-v1", previewId: record.id, canonicalBusinessId: record.business_id,
    taxYear: Number(record.tax_year), groupId: record.group_id, decisionType: record.decision_type, expiresAt: record.expires_at,
    projectionId: record.scope?.workspace_projection_id || null,
    sourceFingerprint: record.scope?.workspace_source_fingerprint || null,
    totalGroupCount: rows.length, actionableCount: actionable.length, previouslyReviewedCount: rows.length - actionable.length,
    protectedUnresolvedCount: rows.filter((row) => !isActionable(row) && (row.requires_review || row.classification_status === "needs_review")).length,
    grossAmountCents: signedGrossAmountCents,
    estimatedDeductionCents: actionable.reduce((sum, row) => sum + Math.round(Number(row.book_amount || 0) * 100 * Number(row.deductible_percent || 0) / 100), 0),
    transactions,
    proposedTreatment: actionable[0]
      ? record.decision_type === "business_use_confirmation"
        ? completedBusinessPurposeTreatment(actionable[0])
        : {
            taxCategory: actionable[0].tax_category,
            taxTreatment: actionable[0].tax_treatment,
            deductibilityStatus: actionable[0].deductibility_status,
            deductiblePercent: Number(actionable[0].deductible_percent || 0),
          }
      : null,
    authorityBreakdown: {
      actionable: actionable.length,
      protected: rows.length - actionable.length,
    },
    futureDefaultScope: { accountScoped: record.decision_type !== "vehicle_method", vehicleAttributionRequired: record.decision_type === "vehicle_method", taxYear: record.tax_year },
    matrixReconciliation: matrixReconciliation({ record, actionable, workspaceProjection, diagnostics }),
  };
}

function matrixReconciliation({ record, actionable, workspaceProjection, diagnostics = {} }) {
  diagnostics.stage = "matrix_reconciliation";
  const payload = workspaceProjection?.projection_data;
  if (!payload || !actionable.length) return null;
  const categoryKey = String(actionable[0].tax_category || "");
  const matrixRow = (payload.matrix || []).find((row) => String(row.categoryKey) === categoryKey);
  const categoryIds = (payload.identityEvidence?.categories?.[categoryKey] || []).map(String);
  const rawQuestionIds = payload.identityEvidence?.questionGroups?.[record.group_id] || [];
  const questionIds = rawQuestionIds.map(String);
  const actionableIds = actionable.map((row) => String(row.transaction_id)).sort();
  Object.assign(diagnostics, taxMembershipDiagnostics(rawQuestionIds, actionable.map((row) => row.transaction_id)));
  if (!matrixRow || !sameStringSet(questionIds, actionableIds) || questionIds.some((id) => !categoryIds.includes(id))) {
    diagnostics.failedComparison = !matrixRow ? "matrix_category_missing"
      : !sameStringSet(questionIds, actionableIds) ? "question_membership_mismatch" : "question_outside_category";
    throw conflictError("grouped_decision_projection_stale", "This Tax question changed. Refresh and try again.", { action: "refresh_tax_deductions" });
  }
  const matrixGrossExpenseCents = Object.values(matrixRow.months || {})
    .reduce((sum, month) => sum + Math.round(Number(month?.bookExpenseAmount || 0) * 100), 0);
  const questionGrossExpenseCents = Math.abs(actionable.reduce((sum, row) => sum + Math.round(Number(row.book_amount || 0) * 100), 0));
  return {
    categoryKey,
    categoryLabel: matrixRow.categoryLabel || categoryKey,
    matrixTransactionCount: categoryIds.length,
    questionTransactionCount: questionIds.length,
    otherMatrixTransactionCount: categoryIds.length - questionIds.length,
    matrixGrossExpenseCents,
    questionGrossExpenseCents,
    otherMatrixGrossExpenseCents: matrixGrossExpenseCents - questionGrossExpenseCents,
  };
}

function sameStringSet(left = [], right = []) {
  return left.length === right.length && new Set(left).size === left.length && left.every((value) => right.includes(value));
}

async function requireCurrentWorkspaceProjection({ supabase, businessId, taxYear, projectionId, sourceFingerprint, groupId, diagnostics = {} }) {
  diagnostics.stage = "current_projection_lookup";
  diagnostics.suppliedProjectionId = taxDiagnosticIdentity(projectionId);
  diagnostics.suppliedSourceFingerprintHash = taxDiagnosticFingerprint(sourceFingerprint);
  diagnostics.suppliedGroupId = taxDiagnosticIdentity(groupId);
  if (!projectionId && !sourceFingerprint) return null;
  const projection = await getLatestTaxWorkspaceProjection({ supabase, businessId, taxYear });
  diagnostics.stage = "current_projection_identity";
  diagnostics.currentProjectionId = taxDiagnosticIdentity(projection?.id);
  diagnostics.currentSourceFingerprintHash = taxDiagnosticFingerprint(projection?.source_fingerprint);
  diagnostics.currentProjectionStatus = projection?.status === "complete" ? "complete" : null;
  const projectedGroups = projection?.projection_data?.questionGroups;
  diagnostics.resolvedGroupId = taxDiagnosticIdentity(Array.isArray(projectedGroups)
    ? projectedGroups.find((group) => group?.id === groupId)?.id : null);
  if (!projection
    || (projectionId && String(projection.id) !== String(projectionId))
    || (sourceFingerprint && String(projection.source_fingerprint) !== String(sourceFingerprint))) {
    diagnostics.failedComparison = !projection ? "current_projection_missing"
      : projectionId && String(projection.id) !== String(projectionId) ? "projection_id_mismatch" : "source_fingerprint_mismatch";
    throw conflictError("grouped_decision_projection_stale", "This Tax question changed. Refresh and try again.", {
      action: "refresh_tax_deductions",
    });
  }
  return projection;
}

function questionTransactionSummary(source, classification) {
  const sourceCents = Math.round(Number(source.signed_amount ?? source.amount ?? 0) * 100);
  const classificationCents = Math.round(Number(classification?.book_amount || 0) * 100);
  if (sourceCents !== classificationCents) {
    throw conflictError("grouped_decision_preview_amount_mismatch", "These transaction details no longer match this question.");
  }
  return {
    transactionId: String(source.id),
    date: source.date,
    description: source.name || source.merchant_name || source.counterparty_name || "Transaction",
    merchantName: source.merchant_name || source.counterparty_name || source.name || "Merchant unavailable",
    counterpartyName: source.counterparty_name || null,
    signedAmount: Number(classification.book_amount),
    direction: classification.metadata?.direction || null,
    qboAccountId: accountId(classification),
    qboAccountName: classification.source_qbo_account_name || classification.metadata?.source_qbo_account_name || "Account unavailable",
    taxCategory: classification.tax_category,
    taxTreatment: classification.tax_treatment?.type || classification.tax_treatment,
    deductibilityStatus: classification.deductibility_status,
    deductiblePercent: Number(classification.deductible_percent || 0),
    classificationStatus: classification.classification_status,
    requiresReview: classification.requires_review === true,
    inclusionStatus: "included_in_question",
  };
}

function compareQuestionTransactions(a, b) {
  return String(b.date || "").localeCompare(String(a.date || "")) || String(a.transactionId).localeCompare(String(b.transactionId));
}

function requireCustomerActor(actor) { if (!actor.userId || actor.source !== "user" || actor.tenantMode === "admin_view") throw forbiddenBusinessError("Customer authorization is required for this decision."); }
function isActionable(row) { return row.classification_status === "needs_review" && row.requires_review === true && !row.user_override && !row.cpa_override; }
function accountId(row) { return text(row.source_qbo_account_id || row.metadata?.source_qbo_account_id); }
function ruleVersion(row) { return text(row.rule_version || row.metadata?.rule_version || row.rule_code || row.tax_treatment?.type || row.tax_treatment); }
function previewTtlSeconds() { const value = Number(globalThis.process?.env?.TAX_GROUPED_DECISION_PREVIEW_TTL_SECONDS || DEFAULT_PREVIEW_TTL_SECONDS); return Number.isFinite(value) && value >= 60 && value <= 3600 ? value : DEFAULT_PREVIEW_TTL_SECONDS; }
function fingerprintConfirmation(input = {}) {
  const payload = JSON.stringify({
    answer: text(input.answer),
    vehicleMethod: text(input.vehicleMethod),
    actualExpenseUse: text(input.actualExpenseUse),
    businessUsePercent: input.businessUsePercent == null ? null : Number(input.businessUsePercent),
    vehicleId: text(input.vehicleId),
    ...(text(input.vehicleScope) ? { vehicleScope: text(input.vehicleScope) } : {}),
    expectedActiveElectionId: text(input.expectedActiveElectionId),
    eligibility: input.eligibility && typeof input.eligibility === "object" ? input.eligibility : {},
    personalExceptionIds: [...new Set((input.personalExceptionIds || []).map(String))].sort(),
  });
  return `gdc-v1-${createHash("sha256").update(payload).digest("hex")}`;
}
function text(value) { return value == null ? "" : String(value).trim(); }

export const __testables = { decisionIdentity, taxDecisionTypeForClassification, treatmentForAnswer, completedBusinessPurposeTreatment, customerPreview, matrixReconciliation, fingerprintConfirmation, requireCurrentWorkspaceProjection };
