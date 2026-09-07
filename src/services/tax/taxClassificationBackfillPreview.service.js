import { listUnclassifiedPostedTransactions } from "./taxPostedTransaction.repository.js";
import { listUnresolvedFallbackClassifications } from "./taxClassification.repository.js";
import { evaluateDeductionRules, listDeductionRules } from "./taxDeductionRule.repository.js";
import { normalizeTaxYear } from "./taxDomain.js";
import { validationError } from "./taxErrors.js";

const DEFAULT_LIMIT = 1000;
const PAGE_SIZE = 250;
const PREVIEW_RULE_VERSION = "tax-classification-preview-v1";

export async function previewTaxClassificationBackfill({ supabase, businessId, taxYear, limit = DEFAULT_LIMIT } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const year = normalizeTaxYear(taxYear);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  const boundedLimit = Math.min(Math.max(Number(limit || DEFAULT_LIMIT), 1), DEFAULT_LIMIT);
  const rules = await listDeductionRules({ supabase, businessId, taxYear: year, includeInactive: false });
  const fallbackRows = await listUnresolvedFallbackClassifications({
    supabase,
    businessId,
    taxYear: year,
    limit: boundedLimit,
    offset: 0,
  });
  if ((fallbackRows.rows || []).length > 0) {
    return summarizeTaxClassificationBackfillPreviewRows(fallbackRows.rows.map(mapFallbackClassificationToPreviewInput), {
      businessId,
      taxYear: year,
      rules,
      capped: (fallbackRows.rows || []).length >= boundedLimit,
      limit: boundedLimit,
      target: "unresolved_fallback_rows",
      sourceRows: fallbackRows.pagination?.total ?? fallbackRows.rows.length,
    });
  }

  const rows = [];
  for (let offset = 0; rows.length < boundedLimit; offset += PAGE_SIZE) {
    const page = await listUnclassifiedPostedTransactions({
      supabase,
      businessId,
      taxYear: year,
      limit: Math.min(PAGE_SIZE, boundedLimit - rows.length),
      offset,
    });
    rows.push(...(page.rows || []));
    if (!page.pagination?.hasMore || !page.rows?.length) break;
  }

  return summarizeTaxClassificationBackfillPreviewRows(rows, {
    businessId,
    taxYear: year,
    rules,
    capped: rows.length >= boundedLimit,
    limit: boundedLimit,
    target: "missing_evaluation_rows",
    sourceRows: rows.length,
  });
}

export function summarizeTaxClassificationBackfillPreviewRows(rows = [], context = {}) {
  const rules = Array.isArray(context.rules) ? context.rules : [];
  const summaries = rows.map((row) => classifyTaxBackfillPreviewRow(row, { rules, businessId: context.businessId }));
  const counts = summaries.reduce((acc, item) => {
    acc.previewed += 1;
    acc[item.bucket] = (acc[item.bucket] || 0) + 1;
    return acc;
  }, {
    previewed: 0,
    estimatedAutomaticClassifications: 0,
    estimatedExclusions: 0,
    estimatedReviewRequired: 0,
    unresolved: 0,
    ruleConflicts: 0,
    invalidRules: 0,
  });
  counts.estimatedAutomaticClassifications = summaries.filter((row) => row.bucket === "estimatedAutomaticClassifications").length;
  counts.estimatedExclusions = summaries.filter((row) => row.bucket === "estimatedExclusions").length;
  counts.estimatedReviewRequired = summaries.filter((row) => row.bucket === "estimatedReviewRequired").length;
  counts.unresolved = summaries.filter((row) => row.bucket === "unresolved").length;
  counts.ruleConflicts = summaries.filter((row) => row.bucket === "ruleConflicts").length;
  counts.invalidRules = summaries.filter((row) => row.bucket === "invalidRules").length;

  return {
    meta: {
      businessId: context.businessId || null,
      taxYear: context.taxYear || null,
      rulesVersion: PREVIEW_RULE_VERSION,
      generatedAt: new Date().toISOString(),
      readOnly: true,
      capped: context.capped === true,
      limit: context.limit ?? DEFAULT_LIMIT,
      target: context.target || "missing_evaluation_rows",
      sourceRows: context.sourceRows ?? summaries.length,
      repairStrategy: context.target === "unresolved_fallback_rows"
        ? "dry_run_only_supersede_unresolved_fallback_rows_after_explicit_authorization"
        : "dry_run_only_no_mutation",
    },
    counts: {
      eligible: summaries.length,
      previewed: summaries.length,
      estimatedAutomaticClassifications: counts.estimatedAutomaticClassifications,
      estimatedExclusions: counts.estimatedExclusions,
      estimatedReviewRequired: counts.estimatedReviewRequired,
      unresolved: counts.unresolved,
      ruleConflicts: counts.ruleConflicts,
      invalidRules: counts.invalidRules,
      preservedRows: 0,
      targetedRows: summaries.length,
    },
    totalsByTaxCategory: rollup(summaries, "taxCategory"),
    totalsByGlAccount: rollup(summaries, "qboAccountName"),
    warnings: previewWarnings(summaries),
  };
}

export function classifyTaxBackfillPreviewRow(row = {}, { rules = [], businessId = null } = {}) {
  const account = displayText(row.qboAccountName || row.source_qbo_account_name || row.metadata?.source_qbo_account_name || row.bookAccount || row.qboAccount || "Unmapped QuickBooks account");
  const amount = Math.abs(Number(row.absoluteAmount ?? row.amount ?? row.signedAmount ?? 0)) || 0;
  const evaluation = evaluateDeductionRules({
    rules,
    businessId,
    transactionContext: {
      date: row.date || row.transactionDate || row.transaction_date,
      direction: row.direction,
      taxonomy_type: row.taxonomyType || row.taxonomy_type,
      transaction_type: row.qboTxnType || row.transactionType || row.type,
      bookkeeping_category: account,
      qbo_account_id: row.qboAccountId || row.source_qbo_account_id,
      qbo_account_name: account,
      qbo_account_type: row.qboAccountType || row.source_qbo_account_type,
      qbo_account_subtype: row.qboAccountSubtype || row.source_qbo_account_subtype,
      normalized_qbo_account_name: row.normalizedQboAccountName || row.normalized_qbo_account_name,
      normalized_qbo_account_type: row.normalizedQboAccountType || row.normalized_qbo_account_type,
      normalized_qbo_account_subtype: row.normalizedQboAccountSubtype || row.normalized_qbo_account_subtype,
    },
  });
  if (evaluation.conflict) {
    return previewRow(row, "ruleConflicts", "unclassified", "needs_review", null, "Conflicting approved deduction rules matched.", amount, {
      ruleCodes: evaluation.conflict.ruleCodes || [],
    });
  }
  const rule = evaluation.selected;
  if (!rule) {
    return previewRow(row, "unresolved", "unclassified", "needs_review", null, "No approved deterministic tax rule matched.", amount);
  }
  if (rule.requires_review === true || rule.deductibility_status === "needs_review") {
    return previewRow(row, "estimatedReviewRequired", rule.tax_category, rule.deductibility_status, rule.default_deductible_percent, "Approved rule proposes treatment but requires review.", amount, {
      ruleCode: rule.rule_code,
    });
  }
  if (rule.deductibility_status === "balance_sheet" || rule.tax_category === "excluded") {
    return previewRow(row, "estimatedExclusions", rule.tax_category, rule.deductibility_status, rule.default_deductible_percent, "Approved exclusion or balance-sheet rule matched.", amount, {
      ruleCode: rule.rule_code,
    });
  }
  return previewRow(row, "estimatedAutomaticClassifications", rule.tax_category, rule.deductibility_status, rule.default_deductible_percent, "Approved deterministic tax rule matched.", amount, {
    ruleCode: rule.rule_code,
  });
}

function previewRow(row, bucket, taxCategory, deductibilityStatus, deductiblePercent, reason, amount, extras = {}) {
  return {
    transactionId: row.transactionId || row.transaction_id || row.id || null,
    bucket,
    taxCategory,
    deductibilityStatus,
    deductiblePercent,
    reason,
    amount,
    qboAccountName: displayText(row.qboAccountName || row.source_qbo_account_name || row.metadata?.source_qbo_account_name || row.bookAccount || "Unmapped QuickBooks account"),
    ...extras,
  };
}

function mapFallbackClassificationToPreviewInput(row = {}) {
  return {
    transactionId: row.transaction_id || row.transactionId || null,
    qboAccountName: row.source_qbo_account_name || row.metadata?.source_qbo_account_name || null,
    qboTxnType: row.source_qbo_txn_type || row.metadata?.source_qbo_txn_type || null,
    absoluteAmount: Math.abs(Number(row.book_amount || 0)) || 0,
    direction: row.metadata?.source_direction || row.metadata?.direction || null,
  };
}

function rollup(rows, field) {
  const map = new Map();
  for (const row of rows) {
    const key = displayText(row[field] || "Unmapped");
    const current = map.get(key) || { key, count: 0, bookAmount: 0 };
    current.count += 1;
    current.bookAmount = round2(current.bookAmount + Number(row.amount || 0));
    map.set(key, current);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function previewWarnings(rows) {
  const categories = new Set(rows.map((row) => row.taxCategory));
  const warnings = [];
  if (categories.has("meals")) warnings.push({ code: "meals_require_review", message: "Meals require substantiation and are not auto-approved as fully deductible." });
  if (categories.has("vehicle")) warnings.push({ code: "vehicle_requires_business_use", message: "Vehicle and gas expenses require business-use context." });
  if (categories.has("equipment_asset")) warnings.push({ code: "assets_require_review", message: "Equipment may require capitalization or depreciation review." });
  if (rows.some((row) => row.bucket === "unresolved")) warnings.push({ code: "unmapped_requires_approved_rules", message: "Rows without an approved matching rule remain unresolved." });
  if (rows.some((row) => row.bucket === "ruleConflicts")) warnings.push({ code: "rule_conflicts_require_review", message: "Conflicting approved rules require review before repair can run." });
  return warnings;
}

function displayText(value) {
  return String(value ?? "").trim();
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
