import { TAX_CLASSIFICATION_STATUSES, TAX_PAYMENT_TYPES, normalizeTaxYear } from "../taxDomain.js";
import { summarizeTaxPayments } from "../payments/taxPayment.service.js";
import { validateTaxRuleCoverage } from "./validateTaxRuleCoverage.js";
import { TAX_QA_STATUSES } from "./taxSupportedScope.js";

const CENT_TOLERANCE = 0.01;
const CONFIRMED_STATUSES = new Set([TAX_CLASSIFICATION_STATUSES.USER_CONFIRMED, TAX_CLASSIFICATION_STATUSES.CPA_CONFIRMED]);
const EXCLUDED_STATUS = TAX_CLASSIFICATION_STATUSES.EXCLUDED;

export async function runBusinessTaxQa({
  supabase,
  businessId,
  taxYear,
  asOfDate = `${taxYear || new Date().getFullYear()}-12-31`,
  includeTransactionSamples = false,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw new Error("businessId is required");
  const year = normalizeTaxYear(taxYear);
  if (!year) throw new Error("A valid taxYear is required");

  const [
    business,
    profile,
    postedTransactions,
    classifications,
    payments,
    latestRun,
    reserveAccounts,
  ] = await Promise.all([
    loadBusiness({ supabase, businessId }),
    firstRow({ supabase, table: "tax_profiles", businessId, taxYear: year }),
    listRows({ supabase, table: "qbo_posted_transactions", businessId, taxYear: year }),
    listRows({ supabase, table: "transaction_tax_classifications", businessId, taxYear: year }),
    listRows({ supabase, table: "tax_payments", businessId, taxYear: year }),
    loadLatestRun({ supabase, businessId, taxYear: year }),
    listRows({ supabase, table: "tax_reserve_accounts", businessId }),
  ]);

  const canonical = latestRun?.canonical_result || latestRun?.result || latestRun?.payload || {};
  const sourceCoverage = buildPostedSourceCoverage({ postedTransactions, classifications, businessId, taxYear: year });
  const classificationCoverage = buildClassificationCoverage({ postedTransactions, classifications });
  const classificationIntegrity = buildClassificationIntegrity({ classifications, postedTransactions, includeTransactionSamples });
  const bucketReconciliation = buildBucketReconciliation({ classifications });
  const taxableIncomeReconciliation = buildTaxableIncomeReconciliation({ canonical });
  const taxComponentReconciliation = buildTaxComponentReconciliation({ canonical });
  const paymentReconciliation = await buildPaymentReconciliation({ supabase, businessId, taxYear: year, profile, payments, canonical });
  const reserveReconciliation = buildReserveReconciliation({ canonical, reserveAccounts });
  const ruleCoverage = await validateTaxRuleCoverage({
    supabase,
    taxYear: year,
    states: profile?.primary_tax_state ? [profile.primary_tax_state] : [],
    entityPaths: profile ? [entityPathFromProfile(profile)] : [],
    filingStatuses: profile?.filing_status ? [profile.filing_status] : [],
    asOfDate,
  }).catch((err) => ({
    overallStatus: TAX_QA_STATUSES.FAIL,
    blockers: [{ code: err.code || "rule_coverage_failed", severity: "critical", message: err.message }],
    warnings: [],
  }));

  const materialIssues = rankMaterialIssues([
    ...sourceCoverage.issues,
    ...classificationCoverage.issues,
    ...classificationIntegrity.issues,
    ...bucketReconciliation.issues,
    ...taxableIncomeReconciliation.issues,
    ...taxComponentReconciliation.issues,
    ...paymentReconciliation.issues,
    ...reserveReconciliation.issues,
    ...(ruleCoverage.blockers || []),
  ], { canonical });
  const warnings = [
    ...sourceCoverage.warnings,
    ...classificationCoverage.warnings,
    ...classificationIntegrity.warnings,
    ...bucketReconciliation.warnings,
    ...taxableIncomeReconciliation.warnings,
    ...taxComponentReconciliation.warnings,
    ...paymentReconciliation.warnings,
    ...reserveReconciliation.warnings,
    ...(ruleCoverage.warnings || []),
  ];
  const scorecard = buildScorecard({
    ruleCoverage,
    sourceCoverage,
    classificationIntegrity,
    bucketReconciliation,
    taxableIncomeReconciliation,
    taxComponentReconciliation,
    paymentReconciliation,
    reserveReconciliation,
    confidence: canonical.confidence,
  });
  const passFail = scorecard.overall.status === TAX_QA_STATUSES.FAIL ? "fail" : scorecard.overall.status === TAX_QA_STATUSES.WARNING ? "warning" : "pass";

  return {
    business: business ? { id: business.id, name: business.name || business.business_name || null } : { id: businessId, missing: true },
    profile: profile ? safeProfile(profile) : null,
    sourceCoverage,
    classificationCoverage,
    classificationIntegrity,
    bucketReconciliation,
    taxableIncomeReconciliation,
    taxComponentReconciliation,
    paymentReconciliation,
    reserveReconciliation,
    ruleCoverage,
    confidence: canonical.confidence || { level: "unavailable", score: null },
    materialIssues,
    warnings,
    scorecard,
    passFail,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    rawPayloadsIncluded: false,
  };
}

function buildPostedSourceCoverage({ postedTransactions, classifications, businessId, taxYear }) {
  const eligible = postedTransactions.filter((row) => isEligiblePosted(row, taxYear));
  const classifiedIds = new Set(classifications.filter((row) => row.business_id === businessId && row.tax_year === taxYear).map((row) => String(row.transaction_id)));
  const eligibleAmount = round2(eligible.reduce((sum, row) => sum + absAmount(row), 0));
  const classifiedAmount = round2(eligible.reduce((sum, row) => sum + (classifiedIds.has(String(row.id || row.transaction_id)) ? absAmount(row) : 0), 0));
  const missing = eligible.filter((row) => !classifiedIds.has(String(row.id || row.transaction_id)));
  const mismatches = classifications.filter((row) => row.business_id !== businessId || row.tax_year !== taxYear || (row.transaction_date && !String(row.transaction_date).startsWith(`${taxYear}-`)));
  return {
    eligiblePostedCount: eligible.length,
    eligiblePostedAmount: eligibleAmount,
    classifiedPostedAmount: classifiedAmount,
    rowCountCoveragePercent: percent(classifiedIds.size, eligible.length),
    dollarWeightedCoveragePercent: percent(classifiedAmount, eligibleAmount),
    missingClassificationCount: missing.length,
    missingClassificationAmount: round2(missing.reduce((sum, row) => sum + absAmount(row), 0)),
    excludedPendingArchivedCount: postedTransactions.length - eligible.length,
    warnings: [],
    issues: [
      ...issueIf(missing.length, "missing_tax_classifications", "high", "Some eligible posted transactions have no tax classification.", { amount: round2(missing.reduce((sum, row) => sum + absAmount(row), 0)), count: missing.length }),
      ...mismatches.map((row) => issue("classification_scope_mismatch", "critical", "A classification belongs to the wrong business, year, or transaction date.", { transactionId: row.transaction_id, amount: absAmount(row) })),
    ],
  };
}

function buildClassificationCoverage({ postedTransactions, classifications }) {
  const postedMap = new Map(postedTransactions.map((row) => [String(row.id || row.transaction_id), row]));
  const visible = classifications.filter((row) => row.classification_status !== EXCLUDED_STATUS);
  const totalAmount = round2(visible.reduce((sum, row) => sum + absAmount(postedMap.get(String(row.transaction_id)) || row), 0));
  const confirmedAmount = round2(visible.reduce((sum, row) => sum + (CONFIRMED_STATUSES.has(row.classification_status) ? absAmount(postedMap.get(String(row.transaction_id)) || row) : 0), 0));
  const autoAmount = round2(visible.reduce((sum, row) => sum + (row.classification_status === TAX_CLASSIFICATION_STATUSES.AUTO_CLASSIFIED ? absAmount(postedMap.get(String(row.transaction_id)) || row) : 0), 0));
  const needsReviewRows = visible.filter((row) => row.classification_status === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW || row.requires_review === true);
  const needsReviewAmount = round2(needsReviewRows.reduce((sum, row) => sum + absAmount(postedMap.get(String(row.transaction_id)) || row), 0));
  return {
    classifiedTransactionCount: visible.length,
    classifiedAmount: totalAmount,
    confirmedCoveragePercent: percent(confirmedAmount, totalAmount),
    autoClassifiedCoveragePercent: percent(autoAmount, totalAmount),
    needsReviewExposureAmount: needsReviewAmount,
    needsReviewExposurePercent: percent(needsReviewAmount, totalAmount),
    excludedExposureAmount: round2(classifications.filter((row) => row.classification_status === EXCLUDED_STATUS).reduce((sum, row) => sum + absAmount(postedMap.get(String(row.transaction_id)) || row), 0)),
    warnings: [],
    issues: issueIf(needsReviewAmount > 10000 || percent(needsReviewAmount, totalAmount) >= 10, "material_needs_review_exposure", "high", "Needs-review exposure is material.", { amount: needsReviewAmount, percentOfBase: percent(needsReviewAmount, totalAmount), count: needsReviewRows.length }),
  };
}

function buildClassificationIntegrity({ classifications, postedTransactions, includeTransactionSamples }) {
  const postedMap = new Map(postedTransactions.map((row) => [String(row.id || row.transaction_id), row]));
  const seen = new Map();
  const issues = [];
  const warnings = [];
  for (const row of classifications) {
    const key = `${row.business_id}:${row.tax_year}:${row.transaction_id}`;
    const siblings = seen.get(key) || [];
    siblings.push(row);
    seen.set(key, siblings);
    const percentValue = Number(row.deductible_percent ?? 0);
    const basis = absAmount(postedMap.get(String(row.transaction_id)) || row);
    const deductible = money(row.deductible_amount);
    const expected = round2(basis * (Number.isFinite(percentValue) ? percentValue : 0));
    if (!Number.isFinite(percentValue) || percentValue < 0 || percentValue > 1) issues.push(issue("invalid_deductible_percent", "critical", "Deductible percent must be between 0 and 100%.", { transactionId: row.transaction_id, amount: basis }));
    if (deductible != null && Math.abs(deductible - expected) > Math.max(CENT_TOLERANCE, basis * 0.01) && !["capitalizable", "balance_sheet", "nondeductible", "needs_review"].includes(row.deductibility_status)) {
      issues.push(issue("deductible_amount_mismatch", "high", "Deductible amount does not reconcile to deductible percent.", { transactionId: row.transaction_id, amount: Math.abs(deductible - expected) }));
    }
    if (row.classification_status === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW && money(row.confirmed_deductible_amount) > 0) {
      issues.push(issue("needs_review_reduces_confirmed_income", "critical", "Needs-review classification has confirmed deductible amount.", { transactionId: row.transaction_id, amount: money(row.confirmed_deductible_amount) }));
    }
    if (row.classification_status === EXCLUDED_STATUS && money(row.deductible_amount) > 0) {
      issues.push(issue("excluded_row_has_deductible_amount", "critical", "Excluded classification has deductible amount.", { transactionId: row.transaction_id, amount: money(row.deductible_amount) }));
    }
    if (CONFIRMED_STATUSES.has(row.classification_status) && !["user", "cpa", "imported"].includes(String(row.classification_source || row.source || "").toLowerCase())) {
      warnings.push({ code: "confirmed_source_unusual", severity: "medium", transactionId: row.transaction_id, message: "Confirmed classification source should be user, CPA, or imported." });
    }
    if (row.rule_support_level && ["unverified", "unsupported", "legacy_estimate"].includes(row.rule_support_level) && CONFIRMED_STATUSES.has(row.classification_status) && row.classification_source === "rule_engine") {
      issues.push(issue("unverified_rule_auto_confirmed", "high", "Unverified rule cannot auto-confirm a classification.", { transactionId: row.transaction_id, amount: basis }));
    }
  }
  for (const [key, rows] of seen.entries()) {
    if (rows.length > 1) issues.push(issue("duplicate_tax_classification", "critical", "More than one canonical classification exists for one transaction/year.", { transactionId: key.split(":").pop(), amount: rows.reduce((sum, row) => sum + absAmount(postedMap.get(String(row.transaction_id)) || row), 0) }));
  }
  return {
    status: issues.some((item) => item.severity === "critical") ? TAX_QA_STATUSES.FAIL : issues.length ? TAX_QA_STATUSES.WARNING : TAX_QA_STATUSES.PASS,
    issueCount: issues.length,
    warningCount: warnings.length,
    samples: includeTransactionSamples ? issues.slice(0, 25).map(({ transactionId, code, severity, amount }) => ({ transactionId, code, severity, amount })) : [],
    issues,
    warnings,
  };
}

function buildBucketReconciliation({ classifications }) {
  const buckets = { deductible: 0, nondeductible: 0, capitalizable: 0, balanceSheet: 0, needsReview: 0, excluded: 0 };
  let eligible = 0;
  const issues = [];
  for (const row of classifications) {
    const amount = absAmount(row);
    eligible += amount;
    const status = row.classification_status;
    const treatment = row.deductibility_status || row.tax_treatment;
    if (status === EXCLUDED_STATUS || treatment === "excluded") buckets.excluded += amount;
    else if (status === TAX_CLASSIFICATION_STATUSES.NEEDS_REVIEW || treatment === "needs_review") buckets.needsReview += amount;
    else if (treatment === "capitalizable") buckets.capitalizable += amount;
    else if (treatment === "balance_sheet") buckets.balanceSheet += amount;
    else if (treatment === "nondeductible") buckets.nondeductible += amount;
    else {
      const deductibleAmount = money(row.deductible_amount) ?? round2(amount * Number(row.deductible_percent ?? 0));
      buckets.deductible += deductibleAmount;
      buckets.nondeductible += Math.max(0, round2(amount - deductibleAmount));
    }
  }
  Object.keys(buckets).forEach((key) => { buckets[key] = round2(buckets[key]); });
  eligible = round2(eligible);
  const bucketTotal = round2(Object.values(buckets).reduce((sum, value) => sum + value, 0));
  const difference = round2(eligible - bucketTotal);
  if (Math.abs(difference) > CENT_TOLERANCE) issues.push(issue("bucket_reconciliation_difference", "critical", "Classification buckets do not reconcile to eligible tax activity.", { amount: Math.abs(difference), difference }));
  return { eligibleTaxActivity: eligible, buckets, bucketTotal, difference, tolerance: CENT_TOLERANCE, issues, warnings: [] };
}

function buildTaxableIncomeReconciliation({ canonical }) {
  const taxable = canonical?.actuals?.taxableIncome || canonical?.taxableIncome || {};
  const revenue = taxable.revenue || canonical?.actuals?.revenue || {};
  const expenses = taxable.expenses || {};
  const adjustments = taxable.adjustments || {};
  const expected = round2(
    money(revenue.grossReceipts) +
    money(revenue.otherBusinessIncome) -
    money(revenue.returnsAndAllowances) -
    money(expenses.costOfGoodsSold) -
    money(expenses.deductibleOperatingExpenses) +
    money(adjustments.increasesToTaxableIncome) -
    money(adjustments.decreasesToTaxableIncome)
  );
  const actual = money(taxable.businessTaxableIncome?.finalBusinessTaxableIncome ?? taxable.finalBusinessTaxableIncome);
  if (actual == null) return { status: TAX_QA_STATUSES.WARNING, expected, actual: null, difference: null, issues: [], warnings: [{ code: "taxable_income_missing", severity: "medium", message: "No canonical taxable-income result was available." }] };
  const difference = round2(expected - actual);
  return { status: Math.abs(difference) > CENT_TOLERANCE ? TAX_QA_STATUSES.FAIL : TAX_QA_STATUSES.PASS, expected, actual, difference, issues: Math.abs(difference) > CENT_TOLERANCE ? [issue("taxable_income_reconciliation_difference", "critical", "Taxable income equation does not reconcile.", { amount: Math.abs(difference), difference })] : [], warnings: [] };
}

function buildTaxComponentReconciliation({ canonical }) {
  const federal = money(canonical?.federal?.totalFederalTax);
  const state = money(canonical?.state?.totalStateTax);
  const projected = money(canonical?.liability?.projectedTotalTax);
  const expected = federal == null || state == null ? null : round2(federal + state);
  const difference = expected == null || projected == null ? null : round2(expected - projected);
  const components = canonical?.federal?.incomeTax?.tax?.bracketBreakdown || canonical?.federal?.incomeTax?.tax?.brackets || [];
  const federalBracketTax = Array.isArray(components) && components.length ? round2(components.reduce((sum, row) => sum + Number(row.tax || 0), 0)) : null;
  const regularFederal = money(canonical?.federal?.incomeTax?.tax?.regularIncomeTax ?? canonical?.federal?.incomeTax?.tax?.federalIncomeTax);
  const issues = [];
  const warnings = [];
  if (difference != null && Math.abs(difference) > CENT_TOLERANCE) issues.push(issue("tax_component_total_mismatch", "critical", "Federal plus state tax does not reconcile to projected total tax.", { amount: Math.abs(difference), difference }));
  if (federalBracketTax != null && regularFederal != null && Math.abs(federalBracketTax - regularFederal) > CENT_TOLERANCE) issues.push(issue("federal_bracket_sum_mismatch", "critical", "Federal bracket rows do not sum to federal regular tax.", { amount: Math.abs(federalBracketTax - regularFederal) }));
  if (projected == null) warnings.push({ code: "projected_total_tax_missing", severity: "medium", message: "Projected total tax is unavailable." });
  return { expectedProjectedTotalTax: expected, projectedTotalTax: projected, difference, federalBracketTax, regularFederal, status: issues.length ? TAX_QA_STATUSES.FAIL : warnings.length ? TAX_QA_STATUSES.WARNING : TAX_QA_STATUSES.PASS, issues, warnings };
}

async function buildPaymentReconciliation({ supabase, businessId, taxYear, profile, payments, canonical }) {
  const summary = await summarizeTaxPayments({ supabase, businessId, taxYear, profile });
  const applied = round2(summary.federal.total + summary.state.total);
  const canonicalApplied = money(canonical?.liability?.paymentsAndWithholdingYtd);
  const projected = money(canonical?.liability?.projectedTotalTax);
  const remaining = money(canonical?.liability?.remainingProjectedLiability);
  const expectedRemaining = projected == null ? null : round2(projected - applied);
  const issues = [];
  if (canonicalApplied != null && Math.abs(canonicalApplied - applied) > CENT_TOLERANCE) issues.push(issue("payment_applied_total_mismatch", "critical", "Canonical paid/withheld total does not match supported payment rows.", { amount: Math.abs(canonicalApplied - applied) }));
  if (expectedRemaining != null && remaining != null && Math.abs(expectedRemaining - remaining) > CENT_TOLERANCE) issues.push(issue("remaining_liability_mismatch", "critical", "Remaining projected liability does not reconcile.", { amount: Math.abs(expectedRemaining - remaining) }));
  const duplicateFingerprints = duplicatePaymentFingerprints(payments);
  for (const duplicate of duplicateFingerprints) issues.push(issue("duplicate_payment_candidate", "high", "Potential duplicate tax payment candidate.", { amount: duplicate.amount, count: duplicate.count, fingerprint: duplicate.fingerprint }));
  return { summary, applied, canonicalApplied, expectedRemaining, remaining, status: issues.length ? TAX_QA_STATUSES.FAIL : TAX_QA_STATUSES.PASS, issues, warnings: summary.reconciliationWarnings || [] };
}

function buildReserveReconciliation({ canonical, reserveAccounts }) {
  const reserve = canonical?.reserve?.reserve || canonical?.reserve || {};
  const recommended = money(reserve.recommendedReserve);
  const current = reserve.currentReserve == null ? null : money(reserve.currentReserve);
  const gap = reserve.reserveGap == null ? null : money(reserve.reserveGap);
  const targetBeforeBuffer = money(reserve.targetBeforeBuffer ?? canonical?.reserve?.components?.find?.((row) => row.componentType === "target_before_buffer")?.amount);
  const bufferAmount = money(reserve.bufferAmount);
  const expectedRecommended = targetBeforeBuffer == null || bufferAmount == null ? null : round2(targetBeforeBuffer + bufferAmount);
  const expectedGap = recommended == null || current == null ? null : round2(recommended - current);
  const issues = [];
  const warnings = [];
  if (!reserveAccounts?.length && current === 0) issues.push(issue("missing_reserve_account_as_zero", "critical", "Missing reserve account appears as zero current reserve.", { amount: recommended || 0 }));
  if (expectedRecommended != null && recommended != null && Math.abs(expectedRecommended - recommended) > CENT_TOLERANCE) issues.push(issue("reserve_target_mismatch", "critical", "Reserve target plus buffer does not reconcile.", { amount: Math.abs(expectedRecommended - recommended) }));
  if (expectedGap != null && gap != null && Math.abs(expectedGap - gap) > CENT_TOLERANCE) issues.push(issue("reserve_gap_mismatch", "critical", "Reserve gap does not reconcile.", { amount: Math.abs(expectedGap - gap) }));
  if (current == null) warnings.push({ code: "reserve_current_unknown", severity: "medium", message: "Current reserve is unknown or not connected." });
  return { recommendedReserve: recommended, currentReserve: current, reserveGap: gap, expectedGap, status: issues.length ? TAX_QA_STATUSES.FAIL : warnings.length ? TAX_QA_STATUSES.WARNING : TAX_QA_STATUSES.PASS, issues, warnings };
}

function buildScorecard(parts) {
  const card = {
    rules: statusFrom(parts.ruleCoverage?.overallStatus),
    sourceCoverage: statusFromIssues(parts.sourceCoverage),
    classificationIntegrity: statusFromIssues(parts.classificationIntegrity),
    reconciliation: combineStatuses([parts.bucketReconciliation, parts.taxableIncomeReconciliation, parts.taxComponentReconciliation]),
    taxCalculation: statusFromIssues(parts.taxComponentReconciliation),
    payments: statusFromIssues(parts.paymentReconciliation),
    reserve: statusFromIssues(parts.reserveReconciliation),
    confidence: confidenceStatus(parts.confidence),
    security: { status: TAX_QA_STATUSES.PASS, label: "Raw payloads are not included in QA report." },
  };
  card.overall = combineStatuses(Object.values(card));
  return card;
}

function rankMaterialIssues(items, { canonical }) {
  const projectedTax = money(canonical?.liability?.projectedTotalTax) || 0;
  const taxableIncome = money(canonical?.actuals?.taxableIncome?.businessTaxableIncome?.finalBusinessTaxableIncome) || 0;
  return items
    .filter(Boolean)
    .map((item) => {
      const amount = Math.abs(Number(item.amount || 0));
      const severityRank = { critical: 4, high: 3, medium: 2, low: 1 }[item.severity] || 1;
      const score = severityRank * 100000000 + amount * 100 + percent(amount, projectedTax) * 10 + percent(amount, taxableIncome);
      return { ...item, amount: Number.isFinite(amount) ? round2(amount) : null, percentOfProjectedTax: percent(amount, projectedTax), percentOfTaxableIncome: percent(amount, taxableIncome), materialityScore: round2(score) };
    })
    .sort((a, b) => b.materialityScore - a.materialityScore)
    .slice(0, 50);
}

async function listRows({ supabase, table, businessId, taxYear }) {
  if (supabase.store) {
    return (supabase.store[table] || []).filter((row) =>
      (!businessId || row.business_id === businessId || row.id === businessId) &&
      (!taxYear || row.tax_year == null || row.tax_year === taxYear || String(row.date || row.transaction_date || "").startsWith(`${taxYear}-`))
    );
  }
  let query = supabase.from(table).select("*");
  if (businessId) query = query.eq(table === "business_profiles" || table === "businesses" ? "id" : "business_id", businessId);
  if (taxYear && !["tax_reserve_accounts", "business_profiles", "businesses"].includes(table)) query = query.eq("tax_year", taxYear);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function firstRow(args) {
  return (await listRows(args))[0] || null;
}

async function loadBusiness({ supabase, businessId }) {
  return (await firstRow({ supabase, table: "business_profiles", businessId })) || (await firstRow({ supabase, table: "businesses", businessId }));
}

async function loadLatestRun({ supabase, businessId, taxYear }) {
  const rows = await listRows({ supabase, table: "tax_calculation_runs", businessId, taxYear });
  return rows.filter((row) => ["completed", "partial", "imported"].includes(row.status)).sort((a, b) => Date.parse(b.generated_at || b.completed_at || b.created_at || 0) - Date.parse(a.generated_at || a.completed_at || a.created_at || 0))[0] || null;
}

function isEligiblePosted(row, taxYear) {
  const date = String(row.date || row.transaction_date || row.posted_date || "");
  return date.startsWith(`${taxYear}-`) && row.business_id && row.pending !== true && row.is_archived !== true && !["voided", "failed", "archived"].includes(row.status);
}

function entityPathFromProfile(profile) {
  if (profile.entity_type === "single_member_llc" && profile.tax_election === "s_corp") return "single_member_llc_s_corp";
  if (profile.entity_type === "single_member_llc") return "single_member_llc_disregarded";
  if (profile.entity_type === "s_corp") return "s_corporation";
  return "sole_proprietor";
}

function safeProfile(profile) {
  return {
    id: profile.id,
    entityType: profile.entity_type,
    taxElection: profile.tax_election,
    filingStatus: profile.filing_status,
    primaryTaxState: profile.primary_tax_state,
    accountingMethod: profile.accounting_method,
    profileStatus: profile.profile_status,
  };
}

function duplicatePaymentFingerprints(payments) {
  const map = new Map();
  for (const row of payments) {
    const key = [row.business_id, row.tax_year, row.jurisdiction, row.state_code || "", row.payment_date || row.date, money(row.amount), row.external_reference || row.confirmation_number || "", row.payment_type || row.type || ""].join("|");
    const group = map.get(key) || [];
    group.push(row);
    map.set(key, group);
  }
  return Array.from(map.entries()).filter(([, rows]) => rows.length > 1).map(([fingerprint, rows]) => ({ fingerprint, count: rows.length, amount: rows.reduce((sum, row) => sum + money(row.amount), 0) }));
}

function confidenceStatus(confidence) {
  if (!confidence || confidence.level === "unavailable") return { status: TAX_QA_STATUSES.WARNING, label: "Confidence unavailable" };
  if (confidence.level === "low") return { status: TAX_QA_STATUSES.WARNING, label: "Low confidence" };
  return { status: TAX_QA_STATUSES.PASS, label: `${confidence.level} confidence` };
}

function statusFrom(status) {
  return { status: status || TAX_QA_STATUSES.WARNING };
}

function statusFromIssues(part) {
  if (part?.issues?.some((item) => item.severity === "critical")) return { status: TAX_QA_STATUSES.FAIL };
  if (part?.issues?.length || part?.warnings?.length || part?.status === TAX_QA_STATUSES.WARNING) return { status: TAX_QA_STATUSES.WARNING };
  return { status: part?.status || TAX_QA_STATUSES.PASS };
}

function combineStatuses(parts) {
  const statuses = parts.map((part) => part?.status).filter(Boolean);
  if (statuses.includes(TAX_QA_STATUSES.FAIL)) return { status: TAX_QA_STATUSES.FAIL };
  if (statuses.includes(TAX_QA_STATUSES.WARNING)) return { status: TAX_QA_STATUSES.WARNING };
  if (statuses.includes(TAX_QA_STATUSES.UNSUPPORTED)) return { status: TAX_QA_STATUSES.UNSUPPORTED };
  return { status: TAX_QA_STATUSES.PASS };
}

function issue(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

function issueIf(condition, code, severity, message, extra = {}) {
  return condition ? [issue(code, severity, message, extra)] : [];
}

function absAmount(row = {}) {
  return Math.abs(money(row.signed_amount ?? row.amount ?? row.absolute_amount ?? row.book_amount) || 0);
}

function money(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? round2(n) : null;
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function percent(numerator, denominator) {
  const den = Math.abs(Number(denominator || 0));
  return den ? round2((Math.abs(Number(numerator || 0)) / den) * 100) : 0;
}
