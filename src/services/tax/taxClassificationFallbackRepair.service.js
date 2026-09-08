import { evaluateDeductionRules, listDeductionRules } from "./taxDeductionRule.repository.js";
import { classifyNormalizedTransaction } from "./taxClassificationEngine.js";
import {
  getTaxClassification,
  isConfirmed,
  isReviewWithProposal,
  isUnresolvedFallbackClassification,
  listUnresolvedFallbackClassifications,
} from "./taxClassification.repository.js";
import { computeClassificationAmounts } from "./taxClassificationAmounts.js";
import { getPostedTransactionForTax } from "./taxPostedTransaction.repository.js";
import { getTaxProfile } from "./taxProfile.service.js";
import { getActiveTaxMemories } from "./taxProfileMemory.service.js";
import {
  DEDUCTIBILITY_STATUSES,
  TAX_CLASSIFICATION_SOURCES,
  TAX_CLASSIFICATION_STATUSES,
  normalizeTaxYear,
} from "./taxDomain.js";
import { validationError } from "./taxErrors.js";

const DEFAULT_LIMIT = 100;

export async function repairUnresolvedFallbackClassifications({
  supabase,
  businessId,
  taxYear,
  limit = DEFAULT_LIMIT,
  actorUserId = null,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const year = requireTaxYear(taxYear);
  const boundedLimit = Math.min(Math.max(Number(limit || DEFAULT_LIMIT), 1), DEFAULT_LIMIT);
  const targets = await listUnresolvedFallbackClassifications({ supabase, businessId, taxYear: year, limit: boundedLimit, offset: 0 });
  const [profile, memories, rules] = await Promise.all([
    getTaxProfile({ supabase, businessId, taxYear: year, includeBusinessDefaults: false }),
    getActiveTaxMemories({ supabase, businessId }),
    listDeductionRules({ supabase, businessId, taxYear: year, includeInactive: false }),
  ]);
  const summary = emptySummary(targets.pagination?.total ?? targets.rows.length);

  for (const current of targets.rows || []) {
    summary.attempted += 1;
    try {
      const fresh = await getTaxClassification({ supabase, businessId, taxYear: year, transactionId: current.transaction_id });
      if (!isRepairTarget(fresh)) {
        summary.preserved += 1;
        continue;
      }
      const transaction = await getPostedTransactionForTax({ supabase, businessId, transactionId: fresh.transaction_id });
      const next = await classifyNormalizedTransaction({
        supabase,
        businessId,
        taxYear: year,
        transaction,
        profile,
        memories,
        rules,
        force: true,
        source: TAX_CLASSIFICATION_SOURCES.RULE_ENGINE,
      });
      if (isUnresolvedResult(next)) {
        summary.unresolved += 1;
        addPreviewTotals(summary, { current, transaction, next, ruleCode: null });
        continue;
      }
      const updated = await applyRepairAtomically({
        supabase,
        businessId,
        taxYear: year,
        current: fresh,
        next,
        actorUserId,
      });
      countUpdated(summary, updated);
      addPreviewTotals(summary, { current, transaction, next: updated, ruleCode: updated.rule_code });
    } catch (err) {
      summary.failures += 1;
      summary.errors.push({
        transactionId: current.transaction_id || null,
        code: err?.code || "fallback_repair_failed",
        message: err?.message || "Fallback repair failed.",
      });
    }
  }

  return summary;
}

export function isRepairTarget(row = {}) {
  if (!row) return false;
  if (isConfirmed(row)) return false;
  if (row.user_override === true || row.cpa_override === true) return false;
  if (row.classification_status === TAX_CLASSIFICATION_STATUSES.EXCLUDED) return false;
  if (isReviewWithProposal(row)) return false;
  return isUnresolvedFallbackClassification(row);
}

export function summarizeFallbackRepairPreviewRows(rows = [], { rules = [], businessId = null } = {}) {
  const summary = emptySummary(rows.length);
  for (const row of rows) {
    if (!isRepairTarget(row)) {
      summary.preserved += 1;
      continue;
    }
    const context = contextFromFallback(row);
    const evaluation = evaluateDeductionRules({ rules, transactionContext: context, businessId });
    const amount = Math.abs(Number(row.book_amount || 0)) || 0;
    summary.grossAmount = round2(summary.grossAmount + amount);
    if (evaluation.conflict) {
      summary.conflicts += 1;
      addGroup(summary, context, amount, null);
      continue;
    }
    const rule = evaluation.selected;
    if (!rule) {
      summary.unresolved += 1;
      addGroup(summary, context, amount, null);
      continue;
    }
    const amounts = computeClassificationAmounts({
      signedAmount: row.book_amount,
      direction: row.metadata?.direction || row.metadata?.source_direction,
      deductibilityStatus: rule.deductibility_status,
      deductiblePercent: rule.default_deductible_percent,
      taxCategory: rule.tax_category,
    });
    if (rule.deductibility_status === DEDUCTIBILITY_STATUSES.BALANCE_SHEET || rule.tax_category === "excluded") summary.excluded += 1;
    else if (rule.requires_review === true || rule.deductibility_status === DEDUCTIBILITY_STATUSES.NEEDS_REVIEW) summary.meaningfulNeedsReview += 1;
    else summary.calculated += 1;
    summary.proposedDeductibleAmount = round2(summary.proposedDeductibleAmount + Number(amounts.deductibleAmount || 0));
    addGroup(summary, context, amount, rule.rule_code);
  }
  summary.groupedByNormalizedQboGlAccount = [...summary._groups.values()].sort((a, b) => b.count - a.count || a.normalizedQboGlAccountKey.localeCompare(b.normalizedQboGlAccountKey));
  delete summary._groups;
  return summary;
}

function contextFromFallback(row = {}) {
  const name = row.source_qbo_account_name || row.metadata?.source_qbo_account_name || row.metadata?.bookkeeping_category || null;
  return {
    date: row.transaction_date,
    direction: row.metadata?.direction || row.metadata?.source_direction || null,
    bookkeeping_category: name,
    qbo_account_id: row.source_qbo_account_id || row.metadata?.source_qbo_account_id || null,
    qbo_account_name: name,
    qbo_account_type: row.metadata?.source_qbo_account_type || null,
    qbo_account_subtype: row.metadata?.source_qbo_account_subtype || null,
    normalized_qbo_account_name: row.metadata?.normalized_qbo_account_name || null,
    normalized_qbo_account_type: row.metadata?.normalized_qbo_account_type || null,
    normalized_qbo_account_subtype: row.metadata?.normalized_qbo_account_subtype || null,
    taxonomy_type: row.metadata?.taxonomy_type || null,
    transaction_type: row.source_qbo_txn_type || row.metadata?.source_qbo_txn_type || null,
  };
}

async function applyRepairAtomically({ supabase, businessId, taxYear, current, next, actorUserId }) {
  const row = repairResultToDbPatch(next, current);
  if (typeof supabase.rpc !== "function") throw validationError("classification_repair_rpc_missing", "Tax classification repair requires the repair RPC.");
  const repaired = await supabase.rpc("apply_tax_classification_repair", {
    p_business_id: businessId,
    p_tax_year: taxYear,
    p_transaction_id: current.transaction_id,
    p_actor_user_id: actorUserId,
    p_repair_reason: "Targeted unresolved fallback repair from approved GL alias rules.",
    p_expected_updated_at: current.updated_at || null,
    p_rule_id: row.rule_id,
    p_rule_code: row.rule_code,
    p_rule_version: row.rule_version,
    p_rule_priority: row.rule_priority,
    p_tax_category: row.tax_category,
    p_deductibility_status: row.deductibility_status,
    p_deductible_percent: row.deductible_percent,
    p_tax_treatment: row.tax_treatment,
    p_classification_status: row.classification_status,
    p_metadata: row.metadata,
    p_book_amount: row.book_amount,
    p_deductible_amount: row.deductible_amount,
    p_nondeductible_amount: row.nondeductible_amount,
    p_capitalizable_amount: row.capitalizable_amount,
    p_confidence_score: row.confidence_score,
    p_confidence_level: row.confidence_level,
    p_source: row.source,
    p_requires_review: row.requires_review,
    p_reason: row.reason,
  });
  if (!repaired.error) return repaired.data || row;
  throw repaired.error;
}

function repairResultToDbPatch(next, current) {
  return {
    tax_category: next.taxCategory,
    deductibility_status: next.deductibilityStatus,
    deductible_percent: next.deductiblePercent,
    book_amount: next.bookAmount,
    deductible_amount: next.deductibleAmount,
    nondeductible_amount: next.nondeductibleAmount,
    capitalizable_amount: next.capitalizableAmount,
    tax_treatment: next.taxTreatment,
    classification_status: next.classificationStatus,
    confidence_score: next.confidenceScore,
    confidence_level: next.confidenceLevel,
    rule_id: next.ruleId,
    rule_code: next.ruleCode,
    rule_version: next.metadata?.rule_version || null,
    rule_priority: next.metadata?.rule_priority ?? null,
    reason: next.reason,
    source: next.source,
    requires_review: next.requiresReview,
    metadata: {
      ...(next.metadata || {}),
      fallback_repaired_at: new Date().toISOString(),
      fallback_repaired_from_classification_id: current.id || null,
      previous_fallback_reason: current.metadata?.fallback_reason || current.reason || null,
    },
  };
}

function isUnresolvedResult(row = {}) {
  return String(row.taxCategory || row.tax_category || "").toLowerCase() === "unclassified" &&
    String(row.classificationStatus || row.classification_status || "").toLowerCase() === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW;
}

function countUpdated(summary, row) {
  const status = row.classification_status || row.classificationStatus;
  const taxCategory = row.tax_category || row.taxCategory;
  const deductibility = row.deductibility_status || row.deductibilityStatus;
  if (status === TAX_CLASSIFICATION_STATUSES.EXCLUDED || deductibility === DEDUCTIBILITY_STATUSES.BALANCE_SHEET || ["transfer", "owner_activity", "liability_payment", "revenue", "balance_sheet_movement"].includes(taxCategory)) {
    summary.excluded += 1;
  } else if (status === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW || row.requires_review === true || row.requiresReview === true) {
    summary.meaningfulNeedsReview += 1;
  } else {
    summary.calculated += 1;
  }
}

function addPreviewTotals(summary, { current, transaction, next, ruleCode }) {
  const amount = Math.abs(Number(next.book_amount ?? next.bookAmount ?? current.book_amount ?? transaction.signedAmount ?? 0)) || 0;
  summary.grossAmount = round2(summary.grossAmount + amount);
  summary.proposedDeductibleAmount = round2(summary.proposedDeductibleAmount + Number(next.deductible_amount ?? next.deductibleAmount ?? 0));
  addGroup(summary, {
    qbo_account_name: transaction.qboAccountName || current.source_qbo_account_name || current.metadata?.source_qbo_account_name || null,
    normalized_qbo_account_name: transaction.normalizedQboAccountName || current.metadata?.normalized_qbo_account_name || null,
  }, amount, ruleCode);
}

function addGroup(summary, context, amount, ruleCode) {
  const key = context.normalized_qbo_account_name || context.normalizedQboAccountName || "unmapped";
  const group = summary._groups.get(key) || {
    normalizedQboGlAccountKey: key,
    qboGlAccountName: context.qbo_account_name || context.qboAccountName || null,
    matchedRuleCode: ruleCode || null,
    count: 0,
    grossAmount: 0,
  };
  group.count += 1;
  group.grossAmount = round2(group.grossAmount + amount);
  if (ruleCode) group.matchedRuleCode = ruleCode;
  summary._groups.set(key, group);
}

function emptySummary(targetCount) {
  return {
    targetCount,
    attempted: 0,
    preserved: 0,
    calculated: 0,
    meaningfulNeedsReview: 0,
    unresolved: 0,
    excluded: 0,
    conflicts: 0,
    failures: 0,
    grossAmount: 0,
    proposedDeductibleAmount: 0,
    groupedByNormalizedQboGlAccount: [],
    errors: [],
    _groups: new Map(),
  };
}

function requireTaxYear(value) {
  const year = normalizeTaxYear(value);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  return year;
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
