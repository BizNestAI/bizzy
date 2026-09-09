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
import { computeTaxTransactionFingerprint, getPostedTransactionForTax, listUnclassifiedPostedTransactions } from "./taxPostedTransaction.repository.js";
import { getTaxProfile } from "./taxProfile.service.js";
import { getActiveTaxMemories } from "./taxProfileMemory.service.js";
import { evaluateDeductionRules, findMatchingDeductionRules, explainDeductionRuleMatch, listDeductionRules } from "./taxDeductionRule.repository.js";
import { getTaxClassification, isConfirmed, upsertTaxClassification } from "./taxClassification.repository.js";
import { scoreTaxClassification, shouldAutoClassify } from "./taxClassificationConfidence.js";
import { TAX_CLASSIFICATION_ENGINE_VERSION } from "./taxEngineVersions.js";
import { computeClassificationAmounts, normalizeDeductiblePercent } from "./taxClassificationAmounts.js";

const SAFE_BATCH_LIMIT = 100;
const NON_BLOCKING_EXACT_GL_ALIAS_WARNINGS = new Set(["missing_taxonomy_hint"]);

export async function classifyPostedTransaction({
  supabase,
  businessId,
  taxYear,
  transactionId,
  force = false,
  source = TAX_CLASSIFICATION_SOURCES.RULE_ENGINE,
  actorUserId = null,
  profile: providedProfile = null,
  memories: providedMemories = null,
  rules: providedRules = null,
} = {}) {
  const year = requireTaxYear(taxYear);
  const [transaction, loadedProfile, loadedMemories] = await Promise.all([
    getPostedTransactionForTax({ supabase, businessId, transactionId }),
    providedProfile ? Promise.resolve(providedProfile) : getTaxProfile({ supabase, businessId, taxYear: year, includeBusinessDefaults: false }),
    providedMemories ? Promise.resolve(providedMemories) : getActiveTaxMemories({ supabase, businessId }),
  ]);
  const profile = loadedProfile;
  const memories = loadedMemories;
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
    rules: providedRules,
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
  if (match.conflict) {
    return buildClassification({
      businessId,
      taxYear: year,
      transaction,
      profile,
      source,
      taxCategory: "rule_conflict",
      deductibilityStatus: DEDUCTIBILITY_STATUSES.NEEDS_REVIEW,
      deductiblePercent: 0,
      taxTreatment: { type: "rule_conflict", ordinaryExpense: false },
      rule: null,
      reason: `Conflicting deduction rules matched: ${(match.conflict.ruleCodes || []).join(", ")}.`,
      explanationSteps: [
        "Evaluated active verified deduction rules.",
        "Multiple equally ranked rules matched with conflicting tax treatment.",
        "Review is required before tax treatment can be determined.",
      ],
      requiresReview: true,
      matchDiagnostics: match,
      confidenceOverride: { score: 20, level: TAX_CONFIDENCE_LEVELS.LOW, factors: [], penalties: ["conflicting_deduction_rules"] },
    });
  }
  const rule = match.selected || null;
  if (!rule) {
    return buildFallbackClassification({ businessId, taxYear: year, transaction, profile, memories, source, match });
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
  const [profile, memories] = await Promise.all([
    getTaxProfile({ supabase, businessId, taxYear: requireTaxYear(taxYear), includeBusinessDefaults: false }),
    getActiveTaxMemories({ supabase, businessId }),
  ]);
  const rules = await listDeductionRules({
    supabase,
    businessId,
    taxYear: requireTaxYear(taxYear),
    entityType: profile?.entity_type,
  });
  for (const transactionId of ids) {
    try {
      summary.attempted += 1;
      const out = await classifyPostedTransaction({ supabase, businessId, taxYear, transactionId, force, source, actorUserId, profile, memories, rules });
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

function buildFallbackClassification({ businessId, taxYear, transaction, profile, memories, source, match = null }) {
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
    matchDiagnostics: match?.diagnostics || null,
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
  matchDiagnostics = null,
  confidenceOverride = null,
  memoryKeysUsed = [],
}) {
  void memories;
  const warnings = [...(transaction.sourceWarnings || [])];
  const autoBlockingWarnings = sourceWarningsBlockingAutoClassification({ warnings, rule });
  const normalizedPercent = normalizeDeductiblePercent({ deductibilityStatus, deductiblePercent });
  const confidence = confidenceOverride || scoreTaxClassification({
    source,
    rule,
    structural,
    fallback,
    businessRule: Boolean(rule?.business_id),
    exactQboAccount: Boolean(rule?.qbo_account_type || rule?.bookkeeping_category || rule?.__match?.exactGlAliasRank || rule?.__match?.reasons?.includes("qbo_account_name_key matched")),
    exactQboSubtype: Boolean(rule?.qbo_account_subtype),
    broadCategory: Boolean(rule?.bookkeeping_category),
    partialDeduction: normalizedPercent > 0 && normalizedPercent < 100,
    warnings: autoBlockingWarnings,
  });
  const auto = shouldAutoClassify({
    score: confidence.score,
    rule,
    structural,
    warnings: autoBlockingWarnings,
    partialDeduction: normalizedPercent > 0 && normalizedPercent < 100,
  });
  const excluded = !requiresReview && isExcludedTaxTreatment({ taxTreatment, deductibilityStatus, taxCategory });
  const classificationStatus = excluded
    ? TAX_CLASSIFICATION_STATUSES.EXCLUDED
    : requiresReview || !auto
      ? TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW
      : TAX_CLASSIFICATION_STATUSES.AUTO_CLASSIFIED;
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
      fallback,
      fallback_reason: fallback ? "no_matching_deduction_rule" : null,
      match_diagnostics: matchDiagnostics,
      explanation_steps: explanationSteps,
      warnings,
      auto_blocking_warnings: autoBlockingWarnings,
      confidence_factors: confidence.factors,
      confidence_penalties: confidence.penalties,
      source_truth: transaction.sourceTruth,
      source_warnings: transaction.sourceWarnings,
      transaction_source_fingerprint: transaction.sourceFingerprint || computeTaxTransactionFingerprint(transaction),
      profile_id: profile?.id || null,
      profile_status: profile?.profile_status || null,
      memory_keys_used: memoryKeysUsed,
      classified_at: new Date().toISOString(),
      tax_classification_stale: false,
      source_qbo_txn_id: transaction.qboTxnId,
      source_qbo_txn_type: transaction.qboTxnType,
      source_qbo_account_id: transaction.qboAccountId,
      source_qbo_account_name: transaction.qboAccountName,
      source_qbo_account_type: transaction.qboAccountType || transaction.metadata?.qbo_account_type || null,
      source_qbo_account_subtype: transaction.qboAccountSubtype || transaction.metadata?.qbo_account_subtype || null,
      normalized_qbo_account_name: transaction.normalizedQboAccountName || transaction.metadata?.normalized_qbo_account_name || null,
      normalized_qbo_account_type: transaction.normalizedQboAccountType || transaction.metadata?.normalized_qbo_account_type || null,
      normalized_qbo_account_subtype: transaction.normalizedQboAccountSubtype || transaction.metadata?.normalized_qbo_account_subtype || null,
      merchant_name: transaction.merchantName,
      description: transaction.description,
      book_amount_signed: transaction.signedAmount,
    },
  };
}

function sourceWarningsBlockingAutoClassification({ warnings = [], rule = null } = {}) {
  const list = [...(warnings || [])]
    .map((warning) => String(warning || "").trim())
    .filter(Boolean);
  if (!isExactGlAliasRuleMatch(rule)) return list;
  return list.filter((warning) => !NON_BLOCKING_EXACT_GL_ALIAS_WARNINGS.has(warning));
}

function isExactGlAliasRuleMatch(rule = null) {
  if (!rule) return false;
  if (Number(rule.__match?.exactGlAliasRank || 0) > 0) return true;
  if (rule.exact_gl_alias_match === true) return true;
  return Array.isArray(rule.__match?.reasons) && rule.__match.reasons.includes("qbo_account_name_key matched");
}

function isExcludedTaxTreatment({ taxTreatment, deductibilityStatus, taxCategory }) {
  const type = String(taxTreatment?.type || "").toLowerCase();
  return type === "balance_sheet" ||
    deductibilityStatus === DEDUCTIBILITY_STATUSES.BALANCE_SHEET ||
    ["transfer", "credit_card_payment", "owner_draw", "owner_contribution", "loan_principal"].includes(String(taxCategory || ""));
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
  let deductiblePercent = normalizeDeductiblePercent({
    deductibilityStatus: rule.deductibility_status,
    deductiblePercent: rule.default_deductible_percent,
  });
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
    qbo_account_type: transaction.qboAccountType || transaction.metadata?.qbo_account_type || null,
    qbo_account_subtype: transaction.qboAccountSubtype || transaction.metadata?.qbo_account_subtype || null,
    normalized_qbo_account_name: transaction.normalizedQboAccountName || transaction.metadata?.normalized_qbo_account_name || null,
    normalized_qbo_account_type: transaction.normalizedQboAccountType || transaction.metadata?.normalized_qbo_account_type || null,
    normalized_qbo_account_subtype: transaction.normalizedQboAccountSubtype || transaction.metadata?.normalized_qbo_account_subtype || null,
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
