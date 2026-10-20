// Tax Deductions UI projection
//
// This module deliberately works from stable posted-transaction identities.
// It is a presentation projection only: it never changes a tax
// classification, a QBO record, or a customer decision. Keeping the
// partition here prevents the Deductions page from comparing the legacy
// coverage aggregates (which overlap) with customer-facing workflow counts.

export const TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES = Object.freeze({
  REVIEWED: "reviewed",
  STANDARD_RULE_APPLIED: "standard_rule_applied",
  STANDARD_RULE_ESTIMATED_NO_ACTION: "standard_rule_estimated_no_action",
  CUSTOMER_INPUT_REQUIRED: "customer_input_required",
  BOOKKEEPING_EVIDENCE_REQUIRED: "bookkeeping_evidence_required",
  TECHNICAL_UPDATE_PENDING: "technical_update_pending",
  TAX_REVIEW_REQUIRED: "tax_review_required",
  OUTSIDE_DEDUCTIONS: "outside_deductions",
  EXCLUDED: "excluded",
  AMBIGUOUS: "ambiguous",
});

const OUTCOME_ORDER = Object.freeze(Object.values(TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES));

export function stableTaxTransactionIdentity(row = {}) {
  row = taxRow(row);
  const value = firstValue(
    row.transactionId,
    row.transaction_id,
    row.id,
    row.raw?.transactionId,
    row.raw?.transaction_id,
    row.raw?.id
  );
  return value == null || value === "" ? null : String(value);
}

export function taxScopeForDeductionsRow(row = {}) {
  row = taxRow(row);
  return firstValue(
    row.taxScopeDisposition,
    row.tax_scope_disposition,
    row.raw?.taxScopeDisposition,
    row.raw?.tax_scope_disposition
  ) || null;
}

export function isOutsideDeductionsScope(row = {}) {
  row = taxRow(row);
  const scope = taxScopeForDeductionsRow(row);
  return Boolean(scope && scope !== "expense_cogs_in_matrix" && scope !== "incomplete_or_unresolved");
}

export function taxClassificationBucketForDeductions(row = {}) {
  row = taxRow(row);
  const status = String(firstValue(row.status, row.classificationStatus, row.classification_status) || "").trim().toLowerCase();
  const treatment = String(firstValue(row.taxTreatment, row.deductibilityStatus) || "").trim().toLowerCase();
  const category = String(firstValue(row.taxCategory, row.tax_category, row.raw?.taxCategory, row.raw?.tax_category) || "").trim().toLowerCase();
  const scope = taxScopeForDeductionsRow(row);
  if (scope === "incomplete_or_unresolved") return "technical_evidence_incomplete";
  if (isOutsideDeductionsScope(row)) return "outside_deductions";
  if (status === "failed" || status === "classification_failed") return "failed";
  if (status === "needs_tax_review" || category === "tax_review_holding" || row.raw?.metadata?.is_holding === true) return "needs_tax_review";
  if (status === "unclassified" || status === "unsupported" || !status) return "unclassified";
  if (status === "user_confirmed" || row.userOverride === true || row.user_override === true) return "user_confirmed";
  if (status === "cpa_confirmed" || status === "accountant_reviewed" || row.cpaOverride === true || row.cpa_override === true) return "accountant_confirmed";
  if (status === "auto_classified" || status === "system_confirmed") return "auto_classified";
  if (status === "excluded" || treatment === "excluded") return "excluded";
  if (row.requiresReview === true || status === "needs_review" || status === "review_required" || treatment === "needs_review") return "needs_review";
  return "auto_classified";
}

export function hasStableTaxRuleEvidence(row = {}) {
  row = taxRow(row);
  const source = String(firstValue(
    row.classificationSource,
    row.classification_source,
    row.source,
    row.raw?.source,
    row.raw?.classification?.source
  ) || "").toLowerCase();
  return source === "rule_engine" || Boolean(firstValue(
    row.matchedRuleCode,
    row.matched_rule_code,
    row.ruleCode,
    row.rule_code,
    row.raw?.matched_rule_code,
    row.raw?.rule_code,
    row.raw?.classification?.rule_code
  ));
}

export function taxDecisionTypeForRow(row = {}) {
  row = taxRow(row);
  if (isOutsideDeductionsScope(row) || taxScopeForDeductionsRow(row) !== "expense_cogs_in_matrix") return null;
  const category = String(firstValue(row.taxCategory, row.tax_category) || "").toLowerCase();
  const account = String(firstValue(row.qboAccountName, row.bookAccount, row.raw?.qboAccountName, row.raw?.source_qbo_account_name) || "").toLowerCase();
  const ruleCode = String(firstValue(row.matchedRuleCode, row.ruleCode, row.raw?.matched_rule_code, row.raw?.rule_code, row.raw?.classification?.rule_code) || "").toLowerCase();
  const treatment = String(firstValue(row.taxTreatment, row.raw?.tax_treatment?.type, row.raw?.classification?.tax_treatment?.type) || "").toLowerCase();

  if (category.includes("vehicle") || ruleCode.includes("vehicle") || treatment.includes("vehicle") || /\b(gas|fuel|auto|vehicle)\b/.test(account)) {
    return "vehicle_method";
  }
  if (category.includes("utilities") || ruleCode.includes("utilities") || ruleCode.includes("rent_review") || treatment.includes("utilities_review") || treatment.includes("rent_review") || /\b(phone|telephone|cell|mobile|electric|electricity|internet|utility|rent|lease)\b/.test(account)) {
    return "business_use_percent";
  }
  if (category.includes("business_meals") || category.includes("travel_transportation") || category.includes("business_travel") || ruleCode.includes("meals") || ruleCode.includes("transportation") || ruleCode.includes("travel")) {
    return "business_use_confirmation";
  }
  return null;
}

export function requiresCustomerTaxDecision(row = {}) {
  return taxClassificationBucketForDeductions(row) === "needs_review" && Boolean(taxDecisionTypeForRow(row));
}

export function isSupportedStandardRuleEstimate(row = {}) {
  row = taxRow(row);
  if (taxClassificationBucketForDeductions(row) !== "needs_review") return false;
  if (taxScopeForDeductionsRow(row) !== "expense_cogs_in_matrix") return false;
  if (!hasStableTaxRuleEvidence(row) || requiresCustomerTaxDecision(row)) return false;
  const warnings = Array.isArray(row.warnings) ? row.warnings : Array.isArray(row.raw?.warnings) ? row.raw.warnings : [];
  const contradictory = warnings.some((warning) => ["qbo_id_mismatch", "conflicting_post_status", "source_conflict", "missing_qbo_account"].includes(String(warning || "").toLowerCase()));
  const category = String(firstValue(row.taxCategory, row.tax_category) || "").toLowerCase();
  const treatment = String(firstValue(row.taxTreatment, row.raw?.tax_treatment?.type, row.raw?.classification?.tax_treatment?.type) || "").toLowerCase();
  return !contradictory && category !== "tax_review_holding" && !treatment.includes("holding");
}

export function taxDeductionsLifecycleOutcomeForRow(row = {}) {
  const bucket = taxClassificationBucketForDeductions(row);
  if (bucket === "outside_deductions") return TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.OUTSIDE_DEDUCTIONS;
  if (bucket === "excluded") return TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.EXCLUDED;
  if (bucket === "technical_evidence_incomplete" || bucket === "unclassified") return TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.BOOKKEEPING_EVIDENCE_REQUIRED;
  if (bucket === "failed") return TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.TECHNICAL_UPDATE_PENDING;
  if (bucket === "needs_tax_review") return TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.TAX_REVIEW_REQUIRED;
  if (bucket === "user_confirmed" || bucket === "accountant_confirmed") return TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.REVIEWED;
  if (bucket === "auto_classified") return TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.STANDARD_RULE_APPLIED;
  if (isSupportedStandardRuleEstimate(row)) return TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.STANDARD_RULE_ESTIMATED_NO_ACTION;
  if (requiresCustomerTaxDecision(row)) return TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.CUSTOMER_INPUT_REQUIRED;
  return TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.AMBIGUOUS;
}

export function buildTaxDecisionIdentity({ businessId, taxYear, row = {}, decisionType = taxDecisionTypeForRow(row) } = {}) {
  row = taxRow(row);
  const qboAccountId = firstValue(row.qboAccountId, row.raw?.qboAccountId, row.raw?.source_qbo_account_id, "unmapped");
  const ruleVersion = firstValue(row.ruleVersion, row.raw?.rule_version, row.raw?.classification?.rule_version, row.matchedRuleCode, row.ruleCode, row.taxTreatment, "unversioned");
  // Vehicle identity is conservatively the authoritative GL account until a
  // separate vehicle registry exists. That makes a decision tenant/year/GL
  // scoped and avoids treating a click in one month as a decision for another.
  const subject = decisionType === "vehicle_method" ? qboAccountId : "account";
  return [
    `business:${String(businessId || "unknown")}`,
    `year:${String(taxYear || "unknown")}`,
    `gl:${String(qboAccountId)}`,
    `type:${String(decisionType || "none")}`,
    `subject:${String(subject)}`,
    `rule:${String(ruleVersion)}`,
  ].join("|");
}

export function buildTaxDeductionsLifecycleProjection({ rows = [], businessId = null, taxYear = null } = {}) {
  const canonical = new Map();
  const missingIdentityRows = [];
  const duplicateIdentityRows = [];
  for (const rawRow of rows || []) {
    const row = taxRow(rawRow);
    const id = stableTaxTransactionIdentity(row);
    if (!id) {
      missingIdentityRows.push(rawRow);
      continue;
    }
    if (canonical.has(id)) {
      duplicateIdentityRows.push({ id, row });
      continue;
    }
    canonical.set(id, row);
  }

  const entries = [];
  const counts = Object.fromEntries(OUTCOME_ORDER.map((outcome) => [outcome, 0]));
  const idsByOutcome = Object.fromEntries(OUTCOME_ORDER.map((outcome) => [outcome, []]));
  for (const [id, row] of canonical) {
    const outcome = taxDeductionsLifecycleOutcomeForRow(row);
    const decisionType = outcome === TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.CUSTOMER_INPUT_REQUIRED ||
      (outcome === TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.REVIEWED && taxDecisionTypeForRow(row))
      ? taxDecisionTypeForRow(row)
      : null;
    const decisionId = decisionType ? buildTaxDecisionIdentity({ businessId, taxYear, row, decisionType }) : null;
    const entry = { id, row, outcome, decisionType, decisionId };
    entries.push(entry);
    counts[outcome] += 1;
    idsByOutcome[outcome].push(id);
  }

  const decisionGroups = buildDecisionGroups({ entries, businessId, taxYear });
  const counted = OUTCOME_ORDER.reduce((sum, outcome) => sum + counts[outcome], 0);
  return {
    entries,
    entriesById: new Map(entries.map((entry) => [entry.id, entry])),
    counts,
    idsByOutcome,
    decisionGroups,
    activeDecisionGroups: decisionGroups.filter((group) => group.pendingCount > 0),
    completedDecisionGroups: decisionGroups.filter((group) => group.pendingCount === 0 && group.reviewedCount > 0),
    sourceRowCount: Array.isArray(rows) ? rows.length : 0,
    canonicalCount: entries.length,
    counted,
    missingIdentityRows,
    duplicateIdentityRows,
    conservation: {
      sourceRows: Array.isArray(rows) ? rows.length : 0,
      canonicalStableIds: entries.length,
      counted,
      duplicateIdentityCount: duplicateIdentityRows.length,
      missingIdentityCount: missingIdentityRows.length,
      isConserved: missingIdentityRows.length === 0 && duplicateIdentityRows.length === 0 && counted === entries.length,
    },
  };
}

function taxRow(row) {
  return row != null && typeof row === "object" && !Array.isArray(row) ? row : {};
}

// The former dashboard combined coverage counters with source-snapshot
// counters.  They are useful operational diagnostics, but they are not a
// customer lifecycle partition.  Keep the reconciliation explicit so callers
// can disclose why a legacy aggregate differs rather than masking a row.
export function reconcileLegacyTaxCoverage({
  legacyReviewRequired = 0,
  legacyUnresolved = 0,
  projection,
} = {}) {
  const counts = projection?.counts || {};
  const customerInput = Number(counts[TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.CUSTOMER_INPUT_REQUIRED] || 0);
  const bookkeeping = Number(counts[TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.BOOKKEEPING_EVIDENCE_REQUIRED] || 0);
  return {
    legacyReviewRequired: Number(legacyReviewRequired || 0),
    customerInput,
    supportedRuleEstimateNoAction: Number(counts[TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.STANDARD_RULE_ESTIMATED_NO_ACTION] || 0),
    reviewDifference: Math.max(0, Number(legacyReviewRequired || 0) - customerInput),
    legacyUnresolved: Number(legacyUnresolved || 0),
    bookkeepingEvidence: bookkeeping,
    unresolvedDifference: Math.max(0, Number(legacyUnresolved || 0) - bookkeeping),
  };
}

function buildDecisionGroups({ entries, businessId, taxYear }) {
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.decisionId) continue;
    const row = entry.row;
    const existing = groups.get(entry.decisionId) || {
      id: entry.decisionId,
      businessId,
      taxYear,
      decisionType: entry.decisionType,
      qboAccountId: firstValue(row.qboAccountId, row.raw?.qboAccountId, row.raw?.source_qbo_account_id, null),
      qboAccountName: firstValue(row.qboAccountName, row.bookAccount, row.raw?.qboAccountName, row.raw?.source_qbo_account_name, "Unmapped QuickBooks account"),
      ruleVersion: firstValue(row.ruleVersion, row.raw?.rule_version, row.raw?.classification?.rule_version, row.matchedRuleCode, row.ruleCode, row.taxTreatment, "unversioned"),
      rows: [],
      pendingRows: [],
      reviewedRows: [],
      months: new Set(),
      grossAmount: 0,
      estimatedDeductibleAmount: 0,
      latestDecisionAt: null,
      currentDeductiblePercent: null,
    };
    existing.rows.push(row);
    if (entry.outcome === TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.CUSTOMER_INPUT_REQUIRED) existing.pendingRows.push(row);
    if (entry.outcome === TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.REVIEWED) existing.reviewedRows.push(row);
    const month = String(firstValue(row.date, row.transactionDate, row.transaction_date) || "").slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(month)) existing.months.add(month);
    existing.grossAmount += Math.abs(number(row.amount ?? row.absoluteAmount ?? row.signedAmount));
    const percent = numberOrNull(row.deductiblePercent);
    if (percent != null) existing.estimatedDeductibleAmount += Math.abs(number(row.amount ?? row.absoluteAmount ?? row.signedAmount)) * (percent / 100);
    if (percent != null && existing.currentDeductiblePercent == null) existing.currentDeductiblePercent = percent;
    const changedAt = firstValue(row.override?.lastChangedAt, row.raw?.override?.lastChangedAt, row.raw?.updatedAt, row.raw?.updated_at, row.updatedAt, row.updated_at);
    if (changedAt && (!existing.latestDecisionAt || String(changedAt) > String(existing.latestDecisionAt))) existing.latestDecisionAt = changedAt;
    groups.set(entry.decisionId, existing);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      pendingCount: group.pendingRows.length,
      reviewedCount: group.reviewedRows.length,
      transactionCount: group.rows.length,
      months: [...group.months].sort(),
      grossAmount: roundMoney(group.grossAmount),
      estimatedDeductibleAmount: roundMoney(group.estimatedDeductibleAmount),
      state: group.pendingRows.length > 0 ? "needs_input" : "reviewed",
    }))
    .sort((a, b) => b.pendingCount - a.pendingCount || b.transactionCount - a.transactionCount || String(a.qboAccountName).localeCompare(String(b.qboAccountName)));
}

function firstValue(...values) {
  return values.find((value) => value != null && value !== "");
}

function number(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : 0;
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
