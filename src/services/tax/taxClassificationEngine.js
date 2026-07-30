// /src/services/tax/taxClassificationEngine.js
import {
  DEDUCTIBILITY_STATUSES,
  TAX_CLASSIFICATION_SOURCES,
  TAX_CLASSIFICATION_STATUSES,
  TAX_CONFIDENCE_LEVELS,
  TAX_ENTITY_TYPES,
  normalizeTaxYear,
} from "./taxDomain.js";
import { validationError } from "./taxErrors.js";
import { getPostedTransactionForTax, listUnclassifiedPostedTransactions } from "./taxPostedTransaction.repository.js";
import { getTaxProfile } from "./taxProfile.service.js";
import { getActiveTaxMemories } from "./taxProfileMemory.service.js";
import { evaluateDeductionRules, findMatchingDeductionRules, explainDeductionRuleMatch } from "./taxDeductionRule.repository.js";
import { getTaxClassification, isConfirmed, upsertTaxClassification } from "./taxClassification.repository.js";
import { scoreTaxClassification, shouldAutoClassify } from "./taxClassificationConfidence.js";
import { TAX_CLASSIFICATION_ENGINE_VERSION } from "./taxEngineVersions.js";
import { computeClassificationAmounts } from "./taxClassificationAmounts.js";

const SAFE_BATCH_LIMIT = 100;

export async function classifyPostedTransaction({
  supabase,
  businessId,
  taxYear,
  transactionId,
  force = false,
  source = TAX_CLASSIFICATION_SOURCES.RULE_ENGINE,
  actorUserId = null,
} = {}) {
  const year = requireTaxYear(taxYear);
  const [transaction, profile, memories] = await Promise.all([
    getPostedTransactionForTax({ supabase, businessId, transactionId }),
    getTaxProfile({ supabase, businessId, taxYear: year, includeBusinessDefaults: false }),
    getActiveTaxMemories({ supabase, businessId }),
  ]);
  const existing = await getTaxClassification({ supabase, businessId, transactionId, taxYear: year });
  if (existing && isConfirmed(existing) && !force) {
    return { classification: existing, skipped: true, reason: "confirmed_classification_preserved" };
  }

  const result = await classifyNormalizedTransaction({
    supabase,
    businessId,
    taxYear: year,
    transaction,
    profile,
    memories,
    force,
    source,
  });
  result.metadata.actor_user_id = actorUserId;
  const persisted = await upsertTaxClassification({ supabase, classification: result, force });
  return { classification: persisted.row, skipped: persisted.skipped, result };
}

export async function classifyNormalizedTransaction({
  supabase,
  businessId,
  taxYear,
  transaction,
  profile,
  memories = [],
  rules,
  force = false,
  source = TAX_CLASSIFICATION_SOURCES.RULE_ENGINE,
} = {}) {
  void force;
  const year = requireTaxYear(taxYear);
  if (!transaction?.transactionId) throw validationError("missing_transaction_id", "transaction is required.");

  if (transaction.direction === "INFLOW") {
    return buildClassification({
      businessId,
      taxYear: year,
      transaction,
      profile,
      memories,
      source,
      taxCategory: "income",
      deductibilityStatus: DEDUCTIBILITY_STATUSES.NEEDS_REVIEW,
      deductiblePercent: 0,
      reason: "Inflow preserved for later taxable-income processing; not classified as a deduction.",
      explanationSteps: ["Detected INFLOW direction.", "Did not apply expense deduction logic."],
      requiresReview: true,
      confidenceOverride: { score: 45, level: TAX_CONFIDENCE_LEVELS.LOW, factors: [], penalties: [] },
      taxTreatment: { type: "income", ordinaryExpense: false },
    });
  }

  const entityType = profile?.entity_type || TAX_ENTITY_TYPES.UNKNOWN;
  const transactionContext = buildRuleTransactionContext(transaction, entityType);
  const match = rules
    ? evaluateDeductionRules({ rules, transactionContext, businessId })
    : await findMatchingDeductionRules({ supabase, businessId, taxYear: year, transactionContext, entityType });
  const rule = match.selected || null;
  if (!rule) {
    return buildFallbackClassification({ businessId, taxYear: year, transaction, profile, memories, source });
  }

  const adjusted = applyMemoryAdjustments({ rule, transaction, memories });
  return buildClassification({
    businessId,
    taxYear: year,
    transaction,
    profile,
    source,
    taxCategory: rule.tax_category || "other",
    deductibilityStatus: rule.deductibility_status,
    deductiblePercent: adjusted.deductiblePercent,
    taxTreatment: rule.treatment || { type: "ordinary_expense" },
    rule,
    reason: explainDeductionRuleMatch(rule, transactionContext),
    explanationSteps: [
      "Evaluated active verified deduction rules.",
      rule.scope === "business_override" || rule.business_id ? "Matched business override deduction rule." : "Matched global deduction rule.",
      `Rule ${rule.rule_code} version ${rule.version || "unknown"} priority ${Number(rule.priority ?? 1000)}.`,
      ...(rule.__match?.reasons || []),
      ...adjusted.explanationSteps,
    ],
    requiresReview: Boolean(rule.requires_review || adjusted.requiresReview),
    memoryKeysUsed: adjusted.memoryKeysUsed,
  });
}

export async function classifyPostedTransactionsBatch({
  supabase,
  businessId,
  taxYear,
  transactionIds = [],
  force = false,
  source = TAX_CLASSIFICATION_SOURCES.RULE_ENGINE,
  actorUserId = null,
} = {}) {
  const ids = Array.from(new Set(transactionIds)).slice(0, SAFE_BATCH_LIMIT);
  const summary = emptyBatchSummary();
  for (const transactionId of ids) {
    try {
      summary.attempted += 1;
      const out = await classifyPostedTransaction({ supabase, businessId, taxYear, transactionId, force, source, actorUserId });
      if (out.skipped) {
        summary.skippedConfirmed += 1;
        continue;
      }
      countOutcome(summary, out.result || out.classification);
    } catch (err) {
      summary.failed += 1;
      summary.errors.push({ transactionId, code: err.code || "classification_failed", message: err.message || "Classification failed." });
    }
  }
  return summary;
}

export async function classifyAllUnclassifiedPostedTransactions({ supabase, businessId, taxYear, limit = SAFE_BATCH_LIMIT, cursor, source = TAX_CLASSIFICATION_SOURCES.RULE_ENGINE } = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit || SAFE_BATCH_LIMIT), 1), SAFE_BATCH_LIMIT);
  const listed = await listUnclassifiedPostedTransactions({ supabase, businessId, taxYear, limit: boundedLimit, offset: Number(cursor || 0) });
  const summary = await classifyPostedTransactionsBatch({
    supabase,
    businessId,
    taxYear,
    transactionIds: listed.rows.map((row) => row.transactionId),
    source,
  });
  summary.nextCursor = listed.pagination.hasMore ? String(Number(cursor || 0) + boundedLimit) : null;
  return summary;
}

export async function previewTaxClassification({ supabase, businessId, taxYear, transactionId } = {}) {
  const year = requireTaxYear(taxYear);
  const [transaction, profile, memories] = await Promise.all([
    getPostedTransactionForTax({ supabase, businessId, transactionId }),
    getTaxProfile({ supabase, businessId, taxYear: year, includeBusinessDefaults: false }),
    getActiveTaxMemories({ supabase, businessId }),
  ]);
  return classifyNormalizedTransaction({ supabase, businessId, taxYear: year, transaction, profile, memories });
}

function buildFallbackClassification({ businessId, taxYear, transaction, profile, memories, source }) {
  return buildClassification({
    businessId,
    taxYear,
    transaction,
    profile,
    memories,
    source,
    taxCategory: "unclassified",
    deductibilityStatus: DEDUCTIBILITY_STATUSES.NEEDS_REVIEW,
    deductiblePercent: 0,
    taxTreatment: { type: "unclassified" },
    reason: "No reliable tax deduction rule matched this posted transaction.",
    explanationSteps: ["Evaluated active verified deduction rules.", "No matching deduction rule found.", "Marked needs_review."],
    requiresReview: true,
    fallback: true,
  });
}

function buildClassification({
  businessId,
  taxYear,
  transaction,
  profile,
  memories,
  source,
  taxCategory,
  deductibilityStatus,
  deductiblePercent,
  taxTreatment,
  rule = null,
  reason,
  explanationSteps = [],
  requiresReview = false,
  structural = false,
  fallback = false,
  confidenceOverride = null,
  memoryKeysUsed = [],
}) {
  void memories;
  const warnings = [...(transaction.sourceWarnings || [])];
  const normalizedPercent = normalizeDeductiblePercent(deductiblePercent);
  const confidence = confidenceOverride || scoreTaxClassification({
    source,
    rule,
    structural,
    fallback,
    businessRule: Boolean(rule?.business_id),
    exactQboAccount: Boolean(rule?.qbo_account_type || rule?.bookkeeping_category),
    exactQboSubtype: Boolean(rule?.qbo_account_subtype),
    broadCategory: Boolean(rule?.bookkeeping_category),
    partialDeduction: normalizedPercent > 0 && normalizedPercent < 100,
    warnings,
  });
  const auto = shouldAutoClassify({ score: confidence.score, rule, structural, warnings, partialDeduction: normalizedPercent > 0 && normalizedPercent < 100 });
  const classificationStatus = requiresReview || !auto ? TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW : TAX_CLASSIFICATION_STATUSES.AUTO_CLASSIFIED;
  const amounts = computeAmounts({ transaction, deductiblePercent: normalizedPercent, deductibilityStatus, taxTreatment, taxCategory });

  return {
    businessId,
    transactionId: transaction.transactionId,
    taxYear,
    transactionDate: transaction.transactionDate,
    taxCategory,
    deductibilityStatus,
    deductiblePercent: normalizedPercent,
    ...amounts,
    taxTreatment,
    classificationStatus,
    confidenceScore: confidence.score,
    confidenceLevel: confidence.level,
    ruleId: rule?.id || null,
    ruleCode: rule?.rule_code || null,
    reason,
    explanationSteps,
    source,
    requiresReview: classificationStatus === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW || Boolean(requiresReview),
    warnings,
    metadata: {
      classification_engine_version: TAX_CLASSIFICATION_ENGINE_VERSION,
      rule_version: rule?.version || null,
      rule_support_level: rule?.support_level || null,
      rule_priority: rule?.priority ?? null,
      rule_scope: rule?.scope || (rule?.business_id ? "business_override" : rule ? "global" : null),
      match_reason: rule?.__match?.reasons || [],
      match_specificity: rule?.__match?.specificity ?? null,
      explanation_steps: explanationSteps,
      warnings,
      confidence_factors: confidence.factors,
      confidence_penalties: confidence.penalties,
      source_truth: transaction.sourceTruth,
      source_warnings: transaction.sourceWarnings,
      profile_id: profile?.id || null,
      profile_status: profile?.profile_status || null,
      memory_keys_used: memoryKeysUsed,
      classified_at: new Date().toISOString(),
      source_qbo_txn_id: transaction.qboTxnId,
      source_qbo_txn_type: transaction.qboTxnType,
      source_qbo_account_id: transaction.qboAccountId,
      source_qbo_account_name: transaction.qboAccountName,
      merchant_name: transaction.merchantName,
      description: transaction.description,
      book_amount_signed: transaction.signedAmount,
    },
  };
}

function computeAmounts({ transaction, deductiblePercent, deductibilityStatus, taxTreatment, taxCategory }) {
  const type = taxTreatment?.type || "ordinary_expense";
  return computeClassificationAmounts({
    signedAmount: transaction.signedAmount,
    direction: transaction.direction,
    deductibilityStatus: type === "capitalizable" ? DEDUCTIBILITY_STATUSES.CAPITALIZABLE : deductibilityStatus,
    deductiblePercent,
    taxCategory,
  });
}

function applyMemoryAdjustments({ rule, memories = [] }) {
  const memoryMap = new Map((memories || []).map((m) => [m.memory_key, m.value_json]));
  const explanationSteps = [];
  const memoryKeysUsed = [];
  let deductiblePercent = normalizeDeductiblePercent(rule.default_deductible_percent);
  let requiresReview = false;

  if (["vehicle", "vehicle_fuel"].includes(rule.tax_category) && memoryMap.has("vehicle_business_use_percent")) {
    deductiblePercent = Math.min(deductiblePercent || 100, Number(memoryMap.get("vehicle_business_use_percent") || 0));
    memoryKeysUsed.push("vehicle_business_use_percent");
    explanationSteps.push("Applied vehicle business-use percentage from tax memory.");
  }
  if (rule.tax_category === "meals" && memoryMap.get("meals_default_business_purpose_required") === true) {
    requiresReview = true;
    memoryKeysUsed.push("meals_default_business_purpose_required");
    explanationSteps.push("Meals business purpose memory requires review.");
  }
  if (["equipment_asset", "depreciation_asset", "capitalizable_equipment"].includes(rule.tax_category) && memoryMap.has("equipment_capitalization_threshold")) {
    memoryKeysUsed.push("equipment_capitalization_threshold");
    explanationSteps.push("Equipment capitalization threshold is available for later depreciation logic.");
  }
  return { deductiblePercent, requiresReview, explanationSteps, memoryKeysUsed };
}

function buildRuleTransactionContext(transaction, entityType) {
  return {
    transaction_id: transaction.transactionId,
    direction: transaction.direction,
    signed_amount: transaction.signedAmount,
    absolute_amount: transaction.absoluteAmount ?? Math.abs(Number(transaction.signedAmount || 0)),
    vendor: transaction.counterpartyName,
    counterparty: transaction.counterpartyName,
    merchant: transaction.merchantName,
    qbo_account_id: transaction.qboAccountId,
    qbo_account_name: transaction.qboAccountName,
    qbo_account_type: transaction.metadata?.qbo_account_type || null,
    qbo_account_subtype: transaction.metadata?.qbo_account_subtype || null,
    bookkeeping_category: transaction.bookkeepingCategory,
    memo: transaction.description,
    description: transaction.description,
    date: transaction.transactionDate,
    taxonomy_type: transaction.taxonomyType,
    payment_channel: transaction.paymentChannel,
    entity_type: entityType,
    merchant_entity_id: transaction.merchantEntityId || transaction.metadata?.merchant_entity_id || null,
    job_id: transaction.jobId || transaction.metadata?.job_id || null,
    assigned_job_id: transaction.assignedJobId || transaction.metadata?.assigned_job_id || null,
    job_costing_tags: transaction.jobCostingTags || transaction.metadata?.job_costing_tags || [],
    employee_id: transaction.employeeId || transaction.metadata?.employee_id || null,
    has_employee: transaction.hasEmployee ?? transaction.metadata?.has_employee,
    is_reimbursement: transaction.isReimbursement ?? transaction.metadata?.is_reimbursement,
    has_inventory: transaction.hasInventory ?? transaction.metadata?.has_inventory,
    inventory_item_id: transaction.inventoryItemId || transaction.metadata?.inventory_item_id || null,
  };
}

function normalizeDeductiblePercent(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  if (n <= 1) return round2(n * 100);
  return round2(Math.max(0, Math.min(100, n)));
}

function requireTaxYear(value) {
  const year = normalizeTaxYear(value);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  return year;
}

function emptyBatchSummary() {
  return { attempted: 0, classified: 0, autoClassified: 0, needsReview: 0, skippedConfirmed: 0, failed: 0, errors: [], nextCursor: null };
}

function countOutcome(summary, classification) {
  summary.classified += 1;
  if (classification.classificationStatus === TAX_CLASSIFICATION_STATUSES.AUTO_CLASSIFIED || classification.classification_status === TAX_CLASSIFICATION_STATUSES.AUTO_CLASSIFIED) {
    summary.autoClassified += 1;
  }
  if (classification.classificationStatus === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW || classification.classification_status === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW) {
    summary.needsReview += 1;
  }
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}
