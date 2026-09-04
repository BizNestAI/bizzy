// /src/services/tax/api/taxCalculationDto.js
import { buildTaxCalculationSummary } from "../explanations/taxExplanationSummary.js";
import { TAX_API_VERSION, TAX_CANONICAL_PAYLOAD_VERSION, includeSet } from "./taxApiVersion.js";
import { buildTaxSetupState } from "./taxSetupState.js";
import { buildTaxTrajectoryPoints, THROUGH_DATE_TAX_METHODS } from "../throughDate/throughDateTaxAttribution.js";

const WARNING_LIMIT = 25;
const ASSUMPTION_LIMIT = 20;

export function toCanonicalTaxCalculationDto({ canonicalResult = null, run = null, include = [], apiVersion = TAX_API_VERSION } = {}) {
  const included = includeSet(include);
  const data = canonicalResult
    ? fromCanonical({ canonical: canonicalResult, included, apiVersion })
    : fromRun({ run, included, apiVersion });
  return { ok: true, data };
}

export function toCanonicalTaxCalculationData(args = {}) {
  return toCanonicalTaxCalculationDto(args).data;
}

function fromCanonical({ canonical: c, included, apiVersion }) {
  const components = included.has("components") || included.has("explanations") ? (c.components || []) : [];
  const explanationSummary = buildTaxCalculationSummary({ canonicalResult: c, components: components.map((component) => component.metadata || component) });
  const setupState = buildTaxSetupState({ canonicalResult: c });
  const runId = c.meta?.runId || null;
  const businessId = c.meta?.businessId || null;
  const taxYear = c.meta?.taxYear || null;
  const links = buildLinks({ businessId, taxYear, runId });

  const data = {
    meta: {
      apiVersion,
      payloadVersion: TAX_CANONICAL_PAYLOAD_VERSION,
      runId,
      businessId,
      taxYear,
      asOfDate: c.meta?.asOfDate || null,
      calculationType: c.meta?.calculationType || null,
      completionType: c.meta?.completionType || null,
      status: c.meta?.status || null,
      generatedAt: c.meta?.generatedAt || null,
      sourceFreshness: c.meta?.sourceFreshness || {},
      engineVersions: c.meta?.engineVersions || {},
      ruleVersions: collectRuleVersions(c),
      workpaperStatus: c.workpaper?.status || null,
      workpaperVersion: c.workpaper?.version || null,
      reusedExistingRun: c.meta?.reusedExistingRun === true,
      persistenceStatus: c.meta?.persistenceStatus || null,
    },
    readiness: {
      estimateReady: c.confidence?.estimateReady === true,
      reserveReady: c.confidence?.reserveReady === true,
      profileStatus: c.profile?.profile?.profile_status || null,
      setupState,
    },
    summary: summaryFromCanonical(c),
    profile: profileFromCanonical(c),
    actuals: actualsFromCanonical(c, included),
    projection: projectionFromCanonical(c),
    federal: federalFromCanonical(c),
    state: stateFromCanonical(c),
    payments: paymentsFromCanonical(c, included),
    safeHarbor: safeHarborFromCanonical(c),
    reserve: reserveFromCanonical(c),
    deadlines: included.has("deadlines") ? (c.deadlines || []) : summarizeDeadlines(c.deadlines || []),
    confidence: confidenceFromCanonical(c, included),
    warnings: capWarnings(c.warnings),
    assumptions: (c.assumptions || []).slice(0, ASSUMPTION_LIMIT),
    unsupportedItems: c.unsupportedItems || [],
    supportedButDeferred: c.supportedButDeferred || [],
    explanationSummary,
    workpaper: workpaperFromCanonical(c),
    links,
  };
  if (included.has("components")) data.components = components;
  if (included.has("explanations")) {
    data.explanations = {
      summary: explanationSummary,
      components,
      bounded: true,
      componentCount: components.length,
      link: links.explanation,
    };
  }
  if (included.has("deductions")) data.deductions = c.actuals?.deductions || null;
  if (included.has("ruleSupport")) data.ruleSupport = collectRuleSupport(c);
  if (included.has("paymentDetails")) data.paymentDetails = c.payments || null;
  if (included.has("reserveHistory")) data.reserveHistory = { link: `${links.reserve}/history`, included: false, reason: "fetch_separately" };
  if (included.has("runChanges")) data.runChanges = { link: links.changes, included: false, reason: "fetch_separately" };
  return data;
}

function fromRun({ run, included, apiVersion }) {
  const setupState = buildTaxSetupState({ run });
  const projectedFederalTax = nullableMoney(run?.estimated_federal_tax);
  const projectedStateTax = nullableMoney(run?.estimated_state_tax);
  const projectedSelfEmploymentTax = nullableMoney(run?.estimated_se_tax);
  const projectedPayrollTaxEffect = nullableMoney(run?.estimated_payroll_tax_effect);
  const projectedTotalTax = nullableMoney(run?.estimated_total_tax);
  const payments = money(run?.payments_ytd);
  const withholding = money(run?.withholding_ytd);
  const data = {
    meta: {
      apiVersion,
      payloadVersion: TAX_CANONICAL_PAYLOAD_VERSION,
      runId: run?.id || null,
      businessId: run?.business_id || null,
      taxYear: run?.tax_year || null,
      asOfDate: run?.as_of_date || null,
      calculationType: run?.calculation_type || null,
      completionType: run?.completion_type || null,
      status: run?.status || null,
      generatedAt: run?.completed_at || run?.created_at || null,
      sourceFreshness: run?.source_freshness || {},
      engineVersions: { orchestrator: run?.calculation_version || null },
      ruleVersions: run?.rule_version_map || {},
      workpaperStatus: run?.workpaper_status || "legacy_incomplete",
      workpaperVersion: run?.workpaper_version || null,
      reusedExistingRun: true,
      persistenceStatus: run?.status ? "persisted" : null,
    },
    readiness: {
      estimateReady: run?.estimate_ready === true,
      reserveReady: run?.reserve_ready === true,
      profileStatus: null,
      setupState,
    },
    summary: {
      projectedTotalTax,
      projectedFederalTax,
      projectedStateTax,
      projectedSelfEmploymentTax,
      projectedPayrollTaxEffect,
      taxableIncomeYtd: nullableMoney(run?.taxable_income_ytd),
      projectedTaxableIncome: nullableMoney(run?.projected_taxable_income),
      taxPaidAndWithheldYtd: money(payments + withholding),
      remainingProjectedLiability: nullableMoney(run?.remaining_projected_liability),
      recommendedReserve: nullableMoney(run?.recommended_reserve),
      currentReserve: nullableMoney(run?.current_reserve),
      reserveGap: nullableMoney(run?.reserve_gap),
      confidenceScore: nullableNumber(run?.confidence_score),
      confidenceLevel: run?.confidence_level || "unavailable",
    },
    profile: {
      entityType: run?.entity_type || null,
      taxElection: null,
      entityPath: run?.entity_type || null,
      filingStatus: run?.filing_status || null,
      primaryTaxState: run?.state_code || null,
      accountingMethod: null,
      completeness: null,
      missingInputs: run?.missing_inputs || [],
    },
    actuals: {
      revenue: { netBusinessRevenue: nullableMoney(run?.book_revenue_ytd) },
      expenses: { bookExpenses: nullableMoney(run?.book_expenses_ytd), deductibleExpenses: nullableMoney(run?.deductible_expenses_ytd), nondeductibleAddbacks: nullableMoney(run?.nondeductible_addbacks_ytd) },
      deductions: included.has("deductions") ? null : undefined,
      taxableIncome: { finalBusinessTaxableIncome: nullableMoney(run?.taxable_income_ytd) },
      coverage: {},
    },
    projection: {
      method: null,
      scenario: null,
      actual: {},
      projectedFuture: {},
      projectedAnnual: { taxableBusinessIncome: nullableMoney(run?.projected_taxable_income) },
      taxTrend: buildTaxTrendFromRun(run),
      range: {},
      confidence: null,
    },
    federal: {
      regularIncomeTax: projectedFederalTax == null || projectedSelfEmploymentTax == null ? projectedFederalTax : money(projectedFederalTax - projectedSelfEmploymentTax),
      selfEmploymentTax: projectedSelfEmploymentTax,
      payrollTaxContext: projectedPayrollTaxEffect,
      totalFederalTax: projectedFederalTax,
      taxableIncome: nullableMoney(run?.projected_taxable_income),
      marginalRate: null,
      effectiveRate: null,
      range: {},
    },
    state: {
      stateCode: run?.state_code || null,
      regularIncomeTax: projectedStateTax,
      entityTaxes: {},
      localTaxes: null,
      totalStateTax: projectedStateTax,
      range: {},
      supportStatus: run?.estimated_state_tax == null ? "unavailable" : "available",
    },
    payments: {
      federal: {},
      state: {},
      withholding,
      credits: {},
      totalApplied: money(payments + withholding),
    },
    safeHarbor: {
      status: run?.safe_harbor_target == null ? "unavailable" : "available",
      federal: { requiredAnnual: nullableMoney(run?.safe_harbor_target), coveredAmount: nullableMoney(run?.safe_harbor_covered), remainingAmount: nullableMoney(run?.safe_harbor_gap), quarterSchedule: [], warnings: [] },
      state: { quarterSchedule: [], warnings: [] },
      combined: { requiredAnnual: nullableMoney(run?.safe_harbor_target), coveredAmount: nullableMoney(run?.safe_harbor_covered), remainingAmount: nullableMoney(run?.safe_harbor_gap), quarterSchedule: [], warnings: [] },
    },
    reserve: {
      status: run?.current_reserve == null ? "setup_incomplete" : nullableMoney(run?.reserve_gap) > 0 ? "reserve_gap" : "on_track",
      strategy: null,
      currentReserve: nullableMoney(run?.current_reserve),
      recommendedReserve: nullableMoney(run?.recommended_reserve),
      reserveGap: nullableMoney(run?.reserve_gap),
      immediateTransferRecommended: run?.reserve_gap == null ? null : money(Math.max(0, Number(run.reserve_gap))),
      weeklySetAside: null,
      monthlySetAside: null,
      nextPaymentAmount: null,
      nextPaymentDate: null,
      confidence: null,
    },
    deadlines: [],
    confidence: confidenceFromRun(run, included),
    warnings: capWarnings(run?.warnings || []),
    assumptions: (run?.assumptions || []).slice(0, ASSUMPTION_LIMIT),
    unsupportedItems: [],
    supportedButDeferred: [],
    explanationSummary: { primarySummary: "Persisted tax calculation run.", topDrivers: [], topWarnings: capWarnings(run?.warnings || []).slice(0, 3), biggestChange: null, nextRecommendedAction: setupState.actions?.[0] || null },
    workpaper: workpaperFromRun(run),
    links: buildLinks({ businessId: run?.business_id, taxYear: run?.tax_year, runId: run?.id }),
  };
  if (included.has("components")) data.components = [];
  if (included.has("explanations")) data.explanations = { summary: data.explanationSummary, components: [], bounded: true, componentCount: 0, link: data.links.explanation };
  if (included.has("deductions")) data.deductions = null;
  if (included.has("ruleSupport")) data.ruleSupport = {};
  if (included.has("paymentDetails")) data.paymentDetails = data.payments;
  if (included.has("reserveHistory")) data.reserveHistory = { link: `${data.links.reserve}/history`, included: false, reason: "fetch_separately" };
  if (included.has("runChanges")) data.runChanges = { link: data.links.changes, included: false, reason: "fetch_separately" };
  return data;
}

function summaryFromCanonical(c) {
  const stateUnavailable = isStateUnavailable(c);
  return {
    projectedTotalTax: nullableMoney(c.liability?.projectedTotalTax),
    projectedFederalTax: nullableMoney(c.liability?.projectedFederalTax),
    projectedStateTax: stateUnavailable ? null : nullableMoney(c.liability?.projectedStateTax),
    projectedSelfEmploymentTax: nullableMoney(c.federal?.selfEmploymentTax?.result?.totalSelfEmploymentTax),
    projectedPayrollTaxEffect: nullableMoney(c.federal?.payrollTaxContext?.payrollTaxAmount),
    taxableIncomeYtd: nullableMoney(c.actuals?.taxableIncome?.businessTaxableIncome?.finalBusinessTaxableIncome),
    projectedTaxableIncome: nullableMoney(c.projection?.projectedAnnual?.taxableBusinessIncome),
    taxPaidAndWithheldYtd: nullableMoney(c.liability?.paymentsAndWithholdingYtd),
    remainingProjectedLiability: nullableMoney(c.liability?.remainingProjectedLiability),
    projectedOverpayment: nullableMoney(c.liability?.projectedOverpayment),
    recommendedReserve: nullableMoney(c.reserve?.reserve?.recommendedReserve ?? c.reserveInput?.recommendedReserveBeforeCashComparison),
    currentReserve: nullableMoney(c.reserve?.reserve?.currentReserve ?? c.reserveInput?.currentReserve),
    reserveGap: nullableMoney(c.reserve?.reserve?.reserveGap ?? c.reserveInput?.reserveGap),
    confidenceScore: nullableNumber(c.confidence?.score),
    confidenceLevel: c.confidence?.level || "unavailable",
  };
}

function profileFromCanonical(c) {
  const profile = c.profile?.profile || {};
  return {
    entityType: profile.entity_type || null,
    taxElection: profile.tax_election || null,
    entityPath: c.entity?.entityPath || c.profile?.entityContext?.entity?.entityPath || null,
    filingStatus: profile.filing_status || null,
    primaryTaxState: profile.primary_tax_state || c.state?.stateCode || null,
    accountingMethod: profile.accounting_method || null,
    completeness: c.profile?.completeness || null,
    missingInputs: c.missingInputs || [],
  };
}

function actualsFromCanonical(c, included) {
  const taxable = c.actuals?.taxableIncome || {};
  return {
    revenue: taxable.revenue || c.actuals?.revenue || {},
    expenses: taxable.expenses || {},
    deductions: included.has("deductions") ? c.actuals?.deductions || null : summarizeDeductions(c.actuals?.deductions),
    taxableIncome: taxable.businessTaxableIncome || taxable,
    coverage: c.actuals?.coverage || c.actuals?.deductions?.coverage || {},
  };
}

function projectionFromCanonical(c) {
  return {
    method: c.projection?.method || null,
    scenario: c.projection?.scenario || c.projection?.methodology?.scenario || null,
    actual: c.projection?.actual || {},
    projectedFuture: c.projection?.projectedFuture || {},
    projectedAnnual: c.projection?.projectedAnnual || {},
    taxTrend: buildTaxTrendFromCanonical(c),
    range: c.projection?.range || {},
    confidence: c.projection?.confidence || null,
  };
}

function buildTaxTrendFromCanonical(c) {
  return buildTaxTrajectoryPoints({ canonical: c });
}

function federalFromCanonical(c) {
  const incomeTax = c.federal?.incomeTax || {};
  return {
    regularIncomeTax: nullableMoney(incomeTax.tax?.federalIncomeTax),
    selfEmploymentTax: nullableMoney(c.federal?.selfEmploymentTax?.result?.totalSelfEmploymentTax),
    payrollTaxContext: c.federal?.payrollTaxContext || null,
    totalFederalTax: nullableMoney(c.federal?.totalFederalTax),
    taxableIncome: nullableMoney(incomeTax.income?.taxableIncomeAfterQbi),
    marginalRate: nullableNumber(incomeTax.tax?.marginalRate),
    effectiveRate: nullableNumber(incomeTax.tax?.effectiveRate),
    range: c.federal?.range || incomeTax.range || {},
  };
}

function stateFromCanonical(c) {
  const incomeTax = c.state?.incomeTax || {};
  const unavailable = isStateUnavailable(c);
  const individual = c.state?.individualIncomeTax || incomeTax.individualIncomeTax || null;
  const entityTax = c.state?.entityTaxes?.detail || incomeTax.entityTax || null;
  const totalStatus = c.state?.totalStateTaxStatus || incomeTax.totalStateTax?.status || incomeTax.tax?.status || null;
  return {
    stateCode: c.state?.stateCode || null,
    regularIncomeTax: unavailable && individual?.amount == null ? null : nullableMoney(incomeTax.tax?.regularStateIncomeTax ?? individual?.amount),
    individualIncomeTax: individual,
    entityTaxes: c.state?.entityTaxes || {},
    entityTax,
    ownerLevelBusinessIncomeElection: c.state?.ownerLevelBusinessIncomeElection || incomeTax.ownerLevelBusinessIncomeElection || null,
    capitalGainsExciseTax: c.state?.capitalGainsExciseTax || incomeTax.capitalGainsExciseTax || null,
    businessExcises: c.state?.businessExcises || incomeTax.businessExcises || null,
    deductions: stateDeductionsFromIncomeTax(incomeTax),
    localTaxes: c.state?.localTaxes ?? null,
    totalStateTax: totalStatus === "partial" || unavailable ? null : nullableMoney(c.state?.totalStateTax),
    totalStateTaxStatus: totalStatus,
    knownComponentsAmount: nullableMoney(c.state?.knownComponentsAmount ?? incomeTax.tax?.knownComponentsAmount),
    provisionalReserve: c.state?.provisionalReserve || incomeTax.provisionalReserve || null,
    range: c.state?.range || incomeTax.range || {},
    supportStatus: incomeTax.meta?.supportSummary?.supportLevel || incomeTax.confidence?.level || null,
  };
}

function stateDeductionsFromIncomeTax(incomeTax = {}) {
  const deductions = incomeTax.deductions || {};
  const standard = deductions.standardDeductionDetails || {};
  const personal = deductions.personalExemptionDetails || {};
  return {
    standardDeduction: nullableMoney(deductions.standardDeduction),
    standardDeductionStatus: standard.status || null,
    standardDeductionNotApplicable: standard.notApplicable === true,
    standardDeductionLabel: standard.notApplicable === true ? "Not applicable" : standard.label || null,
    personalExemption: nullableMoney(deductions.personalExemption),
    personalExemptionStatus: personal.status || null,
    personalExemptionNotApplicable: personal.notApplicable === true,
    personalExemptionLabel: personal.notApplicable === true ? "Not applicable" : personal.label || null,
    stateDeductionAdjustment: incomeTax.income?.stateDeductionAdjustment || null,
  };
}

function paymentsFromCanonical(c, included) {
  const payments = c.payments || {};
  const federal = payments.federal || {};
  const state = payments.state || {};
  return {
    federal: included.has("paymentDetails") ? federal : summarizePaymentBucket(federal),
    state: included.has("paymentDetails") ? state : summarizePaymentBucket(state),
    withholding: money(Number(federal.withholding || 0) + Number(state.withholding || 0)),
    credits: {
      priorYearCredits: money(Number(federal.priorYearCredits || 0) + Number(state.priorYearCredits || 0)),
      refundsApplied: money(Number(federal.refundApplied || 0) + Number(state.refundApplied || 0)),
    },
    totalApplied: nullableMoney(c.liability?.paymentsAndWithholdingYtd ?? payments.totals?.totalPaidAndWithheld),
  };
}

function safeHarborFromCanonical(c) {
  return {
    status: c.safeHarbor?.combined?.status || "unavailable",
    federal: c.safeHarbor?.federal || {},
    state: c.safeHarbor?.state || {},
    combined: c.safeHarbor?.combined || {},
  };
}

function reserveFromCanonical(c) {
  const reserve = c.reserve || {};
  return {
    status: reserve.status || c.reserveInput?.reserveStatus || "setup_incomplete",
    strategy: reserve.reserve?.strategyUsed || reserve.policy?.strategy || null,
    currentReserve: nullableMoney(reserve.reserve?.currentReserve ?? c.reserveInput?.currentReserve),
    recommendedReserve: nullableMoney(reserve.reserve?.recommendedReserve ?? c.reserveInput?.recommendedReserveBeforeCashComparison),
    reserveGap: nullableMoney(reserve.reserve?.reserveGap ?? c.reserveInput?.reserveGap),
    immediateTransferRecommended: nullableMoney(reserve.reserve?.immediateTransferRecommended),
    weeklySetAside: nullableMoney(reserve.cadence?.weeklySetAside),
    monthlySetAside: nullableMoney(reserve.cadence?.monthlySetAside),
    nextPaymentAmount: nullableMoney(reserve.liability?.nextPaymentAmount),
    nextPaymentDate: reserve.liability?.nextPaymentDate || null,
    provisionalStateReserve: nullableMoney(reserve.liability?.provisionalStateReserve ?? c.reserveInput?.provisionalStateReserve),
    provisionalStateReserveStatus: reserve.liability?.provisionalStateReserveStatus || c.reserveInput?.provisionalStateReserveStatus || null,
    provisionalStateReserveIsLiabilityEstimate: reserve.liability?.provisionalStateReserveIsLiabilityEstimate === true || c.reserveInput?.provisionalStateReserveIsLiabilityEstimate === true,
    confidence: reserve.confidence || null,
  };
}

function workpaperFromCanonical(c) {
  const workpaper = c.workpaper || {};
  const lineCount = Number(workpaper.lines?.length || workpaper.lineCount || 0);
  return {
    status: workpaper.status || null,
    version: workpaper.version || null,
    available: ["complete", "partial"].includes(workpaper.status),
    lineCount,
    sectionAvailability: workpaper.sectionAvailability || {},
    ruleVersionMap: workpaper.ruleVersionMap || collectRuleVersions(c),
    paymentApplicationSummary: workpaper.paymentApplicationSummary || null,
    sourceLineageSummary: workpaper.sourceLineageSummary || null,
    reconciliationStatus: workpaper.reconciliationStatus || null,
    reconciliation: summarizeReconciliation(workpaper.reconciliation),
    detailIncluded: false,
    detailEndpoint: c.meta?.runId ? `/api/tax/calculations/${c.meta.runId}/workpaper` : null,
  };
}

function workpaperFromRun(run) {
  return {
    status: run?.workpaper_status || "legacy_incomplete",
    version: run?.workpaper_version || null,
    available: ["complete", "partial"].includes(run?.workpaper_status),
    lineCount: Number(run?.workpaper_line_count || 0),
    sectionAvailability: run?.workpaper_section_availability || {},
    ruleVersionMap: run?.rule_version_map || {},
    paymentApplicationSummary: run?.payment_application_summary || null,
    sourceLineageSummary: run?.source_lineage_summary || null,
    reconciliationStatus: run?.workpaper_reconciliation_status || null,
    reconciliation: summarizeReconciliation(run?.workpaper_reconciliation),
    detailIncluded: false,
    detailEndpoint: run?.id ? `/api/tax/calculations/${run.id}/workpaper` : null,
  };
}

function summarizeReconciliation(reconciliation) {
  if (!reconciliation || typeof reconciliation !== "object") return null;
  const checks = Array.isArray(reconciliation.checks) ? reconciliation.checks : [];
  return {
    ok: reconciliation.ok === true,
    checkCount: checks.length,
    failedCount: checks.filter((check) => check.status === "out_of_balance").length,
    skippedCount: checks.filter((check) => check.status === "skipped").length,
  };
}

function confidenceFromCanonical(c, included) {
  const confidence = c.confidence || {};
  return {
    score: nullableNumber(confidence.score),
    level: confidence.level || "unavailable",
    status: confidence.status || null,
    estimateReady: confidence.estimateReady === true,
    reserveReady: confidence.reserveReady === true,
    confidenceBySection: confidence.confidenceBySection || {},
    blockers: confidence.blockers || [],
    improvementActions: confidence.improvementActions || [],
    materialUncertainty: confidence.materialUncertainty || {},
    ...(included.has("confidenceFactors") ? { factors: confidence.factors || [], penalties: confidence.penalties || [] } : {}),
  };
}

function confidenceFromRun(run, included) {
  return {
    score: nullableNumber(run?.confidence_score),
    level: run?.confidence_level || "unavailable",
    status: run?.confidence_status || null,
    estimateReady: run?.estimate_ready === true,
    reserveReady: run?.reserve_ready === true,
    confidenceBySection: {},
    blockers: run?.confidence_blockers || [],
    improvementActions: [],
    materialUncertainty: {},
    ...(included.has("confidenceFactors") ? { factors: run?.confidence_factors || [], penalties: run?.confidence_penalties || [] } : {}),
  };
}

function buildTaxTrendFromRun(run) {
  const taxYear = run?.tax_year;
  const annualTotal = nullableMoney(run?.estimated_total_tax);
  if (!taxYear || annualTotal == null) return [];
  const asOfDate = run?.as_of_date || `${taxYear}-12-31`;
  const currentMonth = String(asOfDate).slice(0, 7);
  const months = Array.from({ length: 12 }, (_, index) => `${taxYear}-${String(index + 1).padStart(2, "0")}`);
  const paymentsApplied = money(Number(run?.payments_ytd || 0) + Number(run?.withholding_ytd || 0));
  const reserveTarget = nullableMoney(run?.recommended_reserve);
  return months.map((month, index) => {
    const cumulative = money((annualTotal * (index + 1)) / 12);
    const periodType = month === currentMonth ? "current_partial" : month < currentMonth ? "modeled_reconstructed" : "projected";
    const isActualLike = periodType === "modeled_reconstructed" || periodType === "current_partial";
    return {
      month,
      periodType,
      actualTax: isActualLike ? cumulative : null,
      projectedTax: periodType === "projected" ? cumulative : null,
      estTax: cumulative,
      cumulativeActualTax: isActualLike ? cumulative : null,
      projectedYearEndTax: annualTotal,
      paymentsApplied,
      reserveTarget,
      isCurrent: month === currentMonth,
      confidenceLevel: run?.confidence_level || "unavailable",
      warnings: month === currentMonth ? capWarnings(run?.warnings || []).slice(0, 2) : [],
      amount: cumulative,
      pointType: periodType === "projected" ? "projected_future_period" : "legacy_elapsed_time_reconstruction",
      sourceType: "legacy_elapsed_time_reconstruction",
      method: periodType === "projected" ? "projected_future_period_from_persisted_run" : "persisted_run_linear_reconstruction",
      confidence: { score: null, level: "low", status: "legacy_reconstruction" },
      sourceFreshness: run?.source_freshness || {},
      workpaperDeepLink: run?.id ? `/api/tax/calculations/${run.id}/workpaper?section=through_date_tax` : null,
    };
  });
}

function buildLinks({ businessId, taxYear, runId }) {
  const query = `businessId=${encodeURIComponent(businessId || "")}&year=${encodeURIComponent(taxYear || "")}`;
  return {
    self: runId ? `/api/tax/calculations/${runId}?${query}` : `/api/tax/overview?${query}`,
    components: runId ? `/api/tax/calculations/${runId}/components?${query}` : null,
    explanation: runId ? `/api/tax/calculations/${runId}/explanation?${query}` : null,
    confidence: runId ? `/api/tax/calculations/${runId}/confidence?${query}` : `/api/tax/confidence/current?${query}`,
    deductions: `/api/tax/deductions/overview?${query}`,
    reserve: `/api/tax/reserve?${query}`,
    previousRun: runId ? `/api/tax/calculations/${runId}/changes?${query}` : null,
    changes: runId ? `/api/tax/calculations/${runId}/changes?${query}` : null,
  };
}

function summarizePaymentBucket(bucket = {}) {
  return {
    estimatedPayments: nullableMoney(bucket.estimatedPayments),
    withholding: nullableMoney(bucket.withholding),
    extensionPayments: nullableMoney(bucket.extensionPayments),
    priorYearCredits: nullableMoney(bucket.priorYearCredits),
    refundApplied: nullableMoney(bucket.refundApplied),
    total: nullableMoney(bucket.total),
  };
}

function summarizeDeductions(deductions = {}) {
  if (!deductions) return null;
  return {
    coverage: deductions.coverage,
    totals: deductions.totals,
    warnings: capWarnings(deductions.warnings),
  };
}

function summarizeDeadlines(deadlines = []) {
  return deadlines.slice(0, 6).map((deadline) => ({
    jurisdiction: deadline.jurisdiction,
    type: deadline.type,
    dueDate: deadline.dueDate || deadline.due || deadline.date,
    status: deadline.status,
  }));
}

function collectRuleVersions(c) {
  return {
    federal: c.federal?.incomeTax?.meta?.ruleVersions || {},
    state: c.state?.incomeTax?.meta?.ruleVersions || {},
    selfEmployment: c.federal?.selfEmploymentTax?.meta?.ruleVersions || {},
  };
}

function collectRuleSupport(c) {
  return {
    federal: c.federal?.incomeTax?.meta?.supportSummary || null,
    state: c.state?.incomeTax?.meta?.supportSummary || null,
    selfEmployment: c.federal?.selfEmploymentTax?.meta?.supportSummary || null,
  };
}

function isStateUnavailable(c) {
  const stateWarnings = c.state?.incomeTax?.warnings || [];
  if (c.state?.totalStateTaxStatus === "partial") return false;
  if (c.state?.individualIncomeTax?.status === "verified_zero") return false;
  return c.state?.incomeTax?.confidence?.level === "unavailable"
    || stateWarnings.some((warning) => ["state_rule_missing", "unsupported_state", "state_tax_unavailable"].includes(warning.code))
    || (c.warnings || []).some((warning) => ["state_rule_missing", "unsupported_state", "state_tax_unavailable"].includes(warning.code));
}

function capWarnings(warnings = []) {
  const seen = new Set();
  const out = [];
  for (const warning of warnings || []) {
    const key = `${warning.code}:${warning.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(warning);
    if (out.length >= WARNING_LIMIT) break;
  }
  return out;
}

function nullableMoney(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return null;
  return money(value);
}

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function nullableNumber(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return null;
  return Number(value);
}
