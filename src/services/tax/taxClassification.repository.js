// /src/services/tax/taxClassification.repository.js
import { TAX_CLASSIFICATION_STATUSES, normalizeTaxYear } from "./taxDomain.js";
import { validationError } from "./taxErrors.js";

const CLASSIFICATION_SELECT = "*";
const AUTHORITATIVE_OUTCOME_STATUSES = new Set([
  TAX_CLASSIFICATION_STATUSES.AUTO_CLASSIFIED,
  TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW,
  TAX_CLASSIFICATION_STATUSES.USER_CONFIRMED,
  TAX_CLASSIFICATION_STATUSES.CPA_CONFIRMED,
  TAX_CLASSIFICATION_STATUSES.EXCLUDED,
]);

const MEANINGFUL_REVIEW_TAX_CATEGORY = new Set([
  TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW,
  TAX_CLASSIFICATION_STATUSES.USER_CONFIRMED,
  TAX_CLASSIFICATION_STATUSES.CPA_CONFIRMED,
]);

export async function getTaxClassification({ supabase, businessId, transactionId, taxYear } = {}) {
  const year = requireTaxYear(taxYear);
  const { data, error } = await supabase
    .from("transaction_tax_classifications")
    .select(CLASSIFICATION_SELECT)
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .eq("tax_year", year)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function listTaxClassifications({
  supabase,
  businessId,
  taxYear,
  status,
  deductibilityStatus,
  taxCategory,
  requiresReview,
  search,
  limit = 100,
  offset = 0,
} = {}) {
  const year = requireTaxYear(taxYear);
  let query = supabase
    .from("transaction_tax_classifications")
    .select(CLASSIFICATION_SELECT)
    .eq("business_id", businessId)
    .eq("tax_year", year)
    .order("transaction_date", { ascending: false })
    .order("updated_at", { ascending: false });
  if (status) query = query.eq("classification_status", status);
  if (deductibilityStatus) query = query.eq("deductibility_status", deductibilityStatus);
  if (taxCategory) query = query.eq("tax_category", taxCategory);
  if (requiresReview != null) query = query.eq("requires_review", requiresReview === true || requiresReview === "true");
  if (typeof query.range === "function") query = query.range(Number(offset || 0), Number(offset || 0) + Number(limit || 100) - 1);
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data || []).filter((row) => matchesSearch(row, search));
  return { rows, pagination: { limit: Number(limit || 100), offset: Number(offset || 0), returned: rows.length } };
}

export async function upsertTaxClassification({ supabase, classification, force = false } = {}) {
  const existing = await getTaxClassification({
    supabase,
    businessId: classification.businessId,
    transactionId: classification.transactionId,
    taxYear: classification.taxYear,
  });
  if (existing && isConfirmed(existing) && !force) {
    return { row: existing, skipped: true, reason: "confirmed_classification_preserved" };
  }

  const row = toDbRow(classification, existing);
  const { data, error } = await supabase
    .from("transaction_tax_classifications")
    .upsert(row, { onConflict: "business_id,transaction_id,tax_year" })
    .select(CLASSIFICATION_SELECT)
    .single();
  if (error) throw error;
  return { row: data || row, skipped: false };
}

export async function updateClassificationStatus({ supabase, businessId, transactionId, taxYear, status, userId } = {}) {
  const year = requireTaxYear(taxYear);
  const { data, error } = await supabase
    .from("transaction_tax_classifications")
    .update({ classification_status: status, updated_at: new Date().toISOString(), reviewed_by: userId || null })
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .eq("tax_year", year)
    .select(CLASSIFICATION_SELECT)
    .single();
  if (error) throw error;
  return data;
}

export async function markTaxClassificationStaleForTransaction({
  supabase,
  businessId,
  transactionId,
  taxYear,
  reason = "posted_transaction_changed",
  metadata = {},
  now = new Date(),
} = {}) {
  const year = requireTaxYear(taxYear);
  const existing = await getTaxClassification({ supabase, businessId, transactionId, taxYear: year });
  if (!existing) return { changed: false, reason: "classification_missing" };
  const currentMetadata = existing.metadata || {};
  const reviewed = isConfirmed(existing);
  const patch = {
    classification_status: TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW,
    requires_review: true,
    metadata: mergeMetadata(currentMetadata, {
      tax_classification_stale: true,
      stale_reason: reason,
      stale_at: now.toISOString(),
      stale_changed_fields: metadata?.changedFields || metadata?.changed_fields || [],
      previous_classification_status: existing.classification_status || null,
      reviewed_decision_requires_renewed_review: reviewed,
    }),
    updated_at: now.toISOString(),
  };
  if (isMemorySupabase(supabase)) {
    Object.assign(existing, patch);
    return { changed: true, classification: existing, reviewed };
  }
  const { data, error } = await supabase
    .from("transaction_tax_classifications")
    .update(patch)
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .eq("tax_year", year)
    .select(CLASSIFICATION_SELECT)
    .single();
  if (error) throw error;
  return { changed: true, classification: data, reviewed };
}

export async function neutralizeTaxClassificationForTransaction({
  supabase,
  businessId,
  transactionId,
  taxYear,
  reason = "qbo_transaction_voided",
  metadata = {},
  now = new Date(),
} = {}) {
  const year = requireTaxYear(taxYear);
  const existing = await getTaxClassification({ supabase, businessId, transactionId, taxYear: year });
  if (!existing) return { changed: false, reason: "classification_missing" };
  if (existing.classification_status === TAX_CLASSIFICATION_STATUSES.EXCLUDED && existing.metadata?.neutralized_at) {
    return { changed: false, reason: "already_neutralized", classification: existing };
  }
  const patch = {
    classification_status: TAX_CLASSIFICATION_STATUSES.EXCLUDED,
    deductibility_status: "nondeductible",
    deductible_percent: 0,
    deductible_amount: 0,
    nondeductible_amount: 0,
    capitalizable_amount: 0,
    requires_review: false,
    reason: "Posted transaction was voided, deleted, or reversed and no longer contributes to deductions.",
    metadata: mergeMetadata(existing.metadata, {
      neutralized_at: now.toISOString(),
      neutralized_reason: reason,
      previous_classification_status: existing.classification_status || null,
      previous_tax_category: existing.tax_category || null,
      previous_deductible_amount: existing.deductible_amount ?? null,
      source_event: metadata?.source || reason,
      tax_classification_stale: false,
    }),
    updated_at: now.toISOString(),
  };
  if (isMemorySupabase(supabase)) {
    Object.assign(existing, patch);
    return { changed: true, classification: existing };
  }
  const { data, error } = await supabase
    .from("transaction_tax_classifications")
    .update(patch)
    .eq("business_id", businessId)
    .eq("transaction_id", transactionId)
    .eq("tax_year", year)
    .select(CLASSIFICATION_SELECT)
    .single();
  if (error) throw error;
  return { changed: true, classification: data };
}

export async function markMachineTaxClassificationsStaleForBusinessYear({
  supabase,
  businessId,
  taxYear,
  reason = "classification_rules_changed",
  sourceRecordId = null,
  limit = 250,
  now = new Date(),
} = {}) {
  const year = requireTaxYear(taxYear);
  const listed = await listTaxClassifications({ supabase, businessId, taxYear: year, limit, offset: 0 });
  const machineRows = (listed.rows || []).filter((row) =>
    !isConfirmed(row) &&
    row.classification_status !== TAX_CLASSIFICATION_STATUSES.EXCLUDED &&
    !row.metadata?.neutralized_at
  );
  let changed = 0;
  for (const row of machineRows) {
    const result = await markTaxClassificationStaleForTransaction({
      supabase,
      businessId,
      taxYear: year,
      transactionId: row.transaction_id,
      reason,
      metadata: { changedFields: ["classification_rules_version"], sourceRecordId },
      now,
    });
    if (result.changed) changed += 1;
  }
  return { changed, scanned: listed.rows?.length || 0, limit };
}

export async function countClassificationsByStatus({ supabase, businessId, taxYear } = {}) {
  const listed = await listTaxClassifications({ supabase, businessId, taxYear, limit: 10000, offset: 0 });
  return listed.rows.reduce((acc, row) => {
    const status = row.classification_status || "unknown";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
}

export async function listUnresolvedFallbackClassifications({
  supabase,
  businessId,
  taxYear,
  limit = 1000,
  offset = 0,
} = {}) {
  const listed = await listTaxClassifications({ supabase, businessId, taxYear, limit: 10000, offset: 0 });
  const start = Math.max(0, Number(offset || 0));
  const boundedLimit = Math.max(1, Number(limit || 1000));
  const rows = listed.rows
    .filter(isUnresolvedFallbackClassification)
    .slice(start, start + boundedLimit);
  return {
    rows,
    pagination: {
      limit: boundedLimit,
      offset: start,
      returned: rows.length,
      total: listed.rows.filter(isUnresolvedFallbackClassification).length,
    },
  };
}

export async function getClassificationCoverage({ supabase, businessId, taxYear, eligiblePostedCount = 0 } = {}) {
  const listed = await listTaxClassifications({ supabase, businessId, taxYear, limit: 10000, offset: 0 });
  const evaluatedRows = listed.rows.filter(hasCompletedClassificationEvaluation);
  const rows = evaluatedRows.filter(hasMeaningfulClassificationOutcome);
  const confirmedCount = rows.filter(isConfirmed).length;
  const autoClassifiedCount = rows.filter((row) => row.classification_status === TAX_CLASSIFICATION_STATUSES.AUTO_CLASSIFIED).length;
  const needsReviewCount = rows.filter(isReviewWithProposal).length;
  const unresolvedCount = evaluatedRows.filter(isUnresolvedFallbackClassification).length;
  const excludedCount = rows.filter((row) => row.classification_status === TAX_CLASSIFICATION_STATUSES.EXCLUDED).length;
  const classifiedCount = autoClassifiedCount + needsReviewCount + excludedCount + confirmedCount;
  const missingEvaluationCount = Math.max(0, Number(eligiblePostedCount || 0) - evaluatedRows.length);
  const unclassifiedCount = missingEvaluationCount + unresolvedCount;
  const classificationStatus = unclassifiedCount > 0
    ? "classifications_required"
    : needsReviewCount > 0
      ? "review_required"
      : classifiedCount > 0
        ? "classifications_ready"
        : "classifications_required";
  const sum = (field) => round2(rows.reduce((acc, row) => acc + Number(row[field] || 0), 0));
  return {
    eligiblePostedCount,
    classifiedCount,
    confirmedCount,
    autoClassifiedCount,
    needsReviewCount,
    reviewRequiredWithProposalCount: needsReviewCount,
    unresolvedCount,
    evaluatedCount: evaluatedRows.length,
    excludedCount,
    unclassifiedCount,
    missingEvaluationCount,
    processingCount: 0,
    failedCount: 0,
    outcomeReconciliation: {
      eligible: Number(eligiblePostedCount || 0),
      autoClassified: autoClassifiedCount,
      needsReview: needsReviewCount,
      unresolved: unresolvedCount,
      excluded: excludedCount,
      failed: 0,
      processing: 0,
      missingEvaluation: missingEvaluationCount,
      reconciled: Number(eligiblePostedCount || 0) === autoClassifiedCount + needsReviewCount + unresolvedCount + excludedCount + confirmedCount + missingEvaluationCount,
    },
    classificationStatus,
    lastRunAt: rows.reduce((latest, row) => {
      const value = row.updated_at || row.created_at || null;
      return value && (!latest || String(value) > String(latest)) ? value : latest;
    }, null),
    coveragePercent: eligiblePostedCount ? round2((classifiedCount / eligiblePostedCount) * 100) : 0,
    deductibleAmount: sum("deductible_amount"),
    nondeductibleAmount: sum("nondeductible_amount"),
    capitalizableAmount: sum("capitalizable_amount"),
    unresolvedBookAmount: round2(evaluatedRows.filter(isUnresolvedFallbackClassification).reduce((acc, row) => acc + Math.abs(Number(row.book_amount || 0)), 0)),
    unclassifiedBookAmount: round2(evaluatedRows.filter(isUnresolvedFallbackClassification).reduce((acc, row) => acc + Math.abs(Number(row.book_amount || 0)), 0)),
    warnings: [],
  };
}

export function isConfirmed(row) {
  return [TAX_CLASSIFICATION_STATUSES.USER_CONFIRMED, TAX_CLASSIFICATION_STATUSES.CPA_CONFIRMED].includes(row?.classification_status);
}

export function hasAuthoritativeClassificationOutcome(row) {
  return hasMeaningfulClassificationOutcome(row);
}

export function hasCompletedClassificationEvaluation(row) {
  if (!row || row.metadata?.tax_classification_stale === true) return false;
  const status = String(row.classification_status || "").trim();
  if (!AUTHORITATIVE_OUTCOME_STATUSES.has(status)) return false;
  if (!row.transaction_id) return false;
  if (!nonEmpty(row.tax_category)) return false;
  if (!nonEmpty(row.deductibility_status)) return false;
  if (!finitePercent(row.deductible_percent)) return false;
  if (!finiteMoney(row.book_amount)) return false;
  if (!finiteMoney(row.deductible_amount)) return false;
  if (!finiteMoney(row.nondeductible_amount)) return false;
  if (!finiteMoney(row.capitalizable_amount)) return false;
  return true;
}

export function hasMeaningfulClassificationOutcome(row) {
  if (!hasCompletedClassificationEvaluation(row)) return false;
  return !isUnresolvedFallbackClassification(row);
}

export function isUnresolvedFallbackClassification(row) {
  if (!row) return false;
  const status = String(row.classification_status || "").trim();
  const taxCategory = String(row.tax_category || "").trim().toLowerCase();
  const treatmentType = String(row.tax_treatment?.type || row.metadata?.tax_treatment_type || "").trim().toLowerCase();
  return status === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW &&
    taxCategory === "unclassified" &&
    (row.metadata?.fallback === true || treatmentType === "unclassified" || !row.rule_id && !row.rule_code);
}

export function isReviewWithProposal(row) {
  if (!hasCompletedClassificationEvaluation(row)) return false;
  const status = String(row.classification_status || "").trim();
  const taxCategory = String(row.tax_category || "").trim().toLowerCase();
  return MEANINGFUL_REVIEW_TAX_CATEGORY.has(status) &&
    status === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW &&
    taxCategory !== "unclassified";
}

function nonEmpty(value) {
  return String(value || "").trim().length > 0;
}

function finitePercent(value) {
  if (value == null || value === "") return false;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100;
}

function finiteMoney(value) {
  if (value == null || value === "") return false;
  return Number.isFinite(Number(value));
}

function toDbRow(c, existing) {
  const now = new Date().toISOString();
  return {
    business_id: c.businessId,
    transaction_id: c.transactionId,
    tax_year: c.taxYear,
    transaction_date: c.transactionDate,
    tax_category: c.taxCategory,
    deductibility_status: c.deductibilityStatus,
    deductible_percent: c.deductiblePercent,
    book_amount: c.bookAmount,
    deductible_amount: c.deductibleAmount,
    nondeductible_amount: c.nondeductibleAmount,
    capitalizable_amount: c.capitalizableAmount,
    tax_treatment: c.taxTreatment,
    classification_status: c.classificationStatus,
    confidence_score: c.confidenceScore,
    confidence_level: c.confidenceLevel,
    rule_id: c.ruleId,
    rule_code: c.ruleCode,
    rule_version: c.metadata?.rule_version || null,
    rule_priority: c.metadata?.rule_priority ?? null,
    reason: c.reason,
    source: c.source,
    requires_review: c.requiresReview,
    source_qbo_txn_id: c.metadata?.source_qbo_txn_id || null,
    source_qbo_txn_type: c.metadata?.source_qbo_txn_type || null,
    source_qbo_account_id: c.metadata?.source_qbo_account_id || null,
    source_qbo_account_name: c.metadata?.source_qbo_account_name || null,
    user_override: c.classificationStatus === TAX_CLASSIFICATION_STATUSES.USER_CONFIRMED || existing?.user_override === true,
    cpa_override: c.classificationStatus === TAX_CLASSIFICATION_STATUSES.CPA_CONFIRMED || existing?.cpa_override === true,
    metadata: mergeMetadata(existing?.metadata, c.metadata),
    created_at: existing?.created_at || now,
    updated_at: now,
  };
}

function mergeMetadata(previous, next) {
  return { ...(previous || {}), ...(next || {}) };
}

function isMemorySupabase(supabase) {
  return Boolean(supabase?.store);
}

function requireTaxYear(value) {
  const year = normalizeTaxYear(value);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  return year;
}

function matchesSearch(row, search) {
  if (!search) return true;
  const text = String(search).toLowerCase();
  return [row.tax_category, row.reason, row.rule_code, row.metadata?.description, row.metadata?.merchant_name]
    .some((value) => String(value || "").toLowerCase().includes(text));
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}
