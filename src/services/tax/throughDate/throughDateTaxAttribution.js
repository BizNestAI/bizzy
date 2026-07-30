// /src/services/tax/throughDate/throughDateTaxAttribution.js

export const THROUGH_DATE_TAX_METHODS = {
  ANNUALIZED_ACTUAL_YTD: "annualized_actual_ytd_tax_calculation",
  TAXABLE_INCOME_SHARE: "projected_annual_tax_allocated_by_taxable_income_share",
  ELAPSED_TIME: "elapsed_time_allocation",
  UNAVAILABLE: "unavailable",
};

export const THROUGH_DATE_TAX_METHOD_VERSION = "through-date-tax-v1";

export const THROUGH_DATE_RULE_TREATMENT_REGISTRY = Object.freeze({
  progressive_brackets: {
    treatment: "annualized_using_projected_annual_income",
    explanation: "Annual projected tax is calculated under full-year progressive brackets, then the attributable regular-income component is allocated by actual YTD taxable-income share.",
  },
  standard_deductions: {
    treatment: "applied_fully",
    explanation: "Standard deductions are annual rules in the projected annual tax calculation; they are not mechanically prorated for the through-date allocation.",
  },
  personal_exemptions: {
    treatment: "applied_fully",
    explanation: "Personal exemptions are annual rules where supported and are reflected in the projected annual state or federal tax before allocation.",
  },
  qbi: {
    treatment: "unavailable",
    explanation: "QBI remains deferred in the current canonical calculation and is not included in through-date attribution.",
  },
  self_employment_tax: {
    treatment: "threshold_tested_against_annualized_income",
    explanation: "Self-employment tax is directly estimated from actual YTD business income when SE inputs are available, including wage-base treatment.",
  },
  social_security_wage_base: {
    treatment: "threshold_tested_against_annualized_income",
    explanation: "The Social Security wage base is applied as an annual cap to YTD net earnings rather than prorated universally.",
  },
  additional_medicare_threshold: {
    treatment: "threshold_tested_against_annualized_income",
    explanation: "Additional Medicare thresholds are annual thresholds tested against annualized income where inputs are available.",
  },
  tax_credits: {
    treatment: "allocated_by_actual_ytd_share",
    explanation: "Credits in the annual tax calculation are allocated by actual YTD taxable-income share unless a direct source is available.",
  },
  state_standard_deductions: {
    treatment: "applied_fully",
    explanation: "State standard deductions are annual rules in the projected annual state calculation before allocation.",
  },
  state_exemptions: {
    treatment: "applied_fully",
    explanation: "State exemptions are annual rules in the projected annual state calculation before allocation.",
  },
  entity_minimum_taxes: {
    treatment: "allocated_by_actual_ytd_share",
    explanation: "Entity minimum taxes are allocated to recorded YTD activity by actual YTD taxable-income share.",
  },
  ptet: {
    treatment: "allocated_by_actual_ytd_share",
    explanation: "PTET is allocated by actual YTD taxable-income share where it is included in projected annual tax.",
  },
  local_taxes: {
    treatment: "allocated_by_actual_ytd_share",
    explanation: "Local taxes are allocated by actual YTD taxable-income share where supported.",
  },
  business_excises: {
    treatment: "allocated_by_actual_ytd_share",
    explanation: "Supported business excises are allocated by actual YTD taxable-income share unless direct period data exists.",
  },
});

export function computeTaxAttributableThroughDate({
  taxYear,
  asOfDate,
  projection = {},
  taxableIncome = {},
  federal = {},
  selfEmploymentTax = null,
  sCorp = null,
  state = {},
  projectedTotalTax,
  totalFederalTax,
  totalStateTax,
  knownStateComponentsAmount,
  confidenceLevel = null,
} = {}) {
  const actualYtdTaxableIncomeBase = money(
    projection.actual?.taxableBusinessIncome ??
    taxableIncome.businessTaxableIncome?.finalBusinessTaxableIncome
  );
  const projectedAnnualTaxableIncomeBase = money(
    projection.projectedAnnual?.taxableBusinessIncome ??
    taxableIncome.businessTaxableIncome?.projectedAnnualTaxableIncome
  );
  const annualTax = money(projectedTotalTax);
  const limitations = [];
  const assumptions = [
    "Tax attributable through today is a reserve-planning attribution of annual projected tax to recorded YTD activity, not a legal partial-year liability.",
    "Annual deductions, brackets, exemptions, thresholds, and credits follow the explicit through-date rule treatment registry.",
  ];

  if (annualTax == null) limitations.push("Projected annual tax is unavailable.");
  if (actualYtdTaxableIncomeBase == null) limitations.push("Actual YTD taxable-income base is unavailable.");
  if (projectedAnnualTaxableIncomeBase == null) limitations.push("Projected annual taxable-income base is unavailable.");
  if (projectedAnnualTaxableIncomeBase != null && projectedAnnualTaxableIncomeBase <= 0) limitations.push("Projected annual taxable-income base is zero or negative.");

  if (limitations.length) {
    return unavailableResult({
      taxYear,
      asOfDate,
      annualTax,
      actualYtdTaxableIncomeBase,
      projectedAnnualTaxableIncomeBase,
      limitations,
      assumptions,
      confidenceLevel,
    });
  }

  const allocationPercentage = clamp(actualYtdTaxableIncomeBase / projectedAnnualTaxableIncomeBase, 0, 1);
  const directComponents = [];
  const allocatedComponents = [];
  const excludedComponents = [];

  const seDirect = selfEmploymentAttribution({ actualTaxableIncomeBase: actualYtdTaxableIncomeBase, selfEmploymentTax });
  if (seDirect.available) {
    directComponents.push(seDirect.component);
  } else if (money(selfEmploymentTax?.result?.totalSelfEmploymentTax) != null) {
    allocatedComponents.push(component({
      code: "self_employment_tax",
      label: "Self-employment tax",
      annualAmount: selfEmploymentTax.result.totalSelfEmploymentTax,
      amount: money(Number(selfEmploymentTax.result.totalSelfEmploymentTax) * allocationPercentage),
      method: THROUGH_DATE_TAX_METHODS.TAXABLE_INCOME_SHARE,
      treatment: "allocated_by_actual_ytd_share",
    }));
    limitations.push(...seDirect.limitations);
  }

  addAllocated(allocatedComponents, {
    code: "federal_income_tax",
    label: "Federal income tax",
    annualAmount: federal.incomeTax?.tax?.federalIncomeTax,
    allocationPercentage,
    treatment: "annualized_using_projected_annual_income",
  });
  addAllocated(allocatedComponents, {
    code: "state_individual_income_tax",
    label: "State individual income tax",
    annualAmount: state.incomeTax?.tax?.regularStateIncomeTax ?? state.individualIncomeTax?.amount,
    allocationPercentage,
    treatment: state.incomeTax?.tax?.kind === "progressive" ? "annualized_using_projected_annual_income" : "allocated_by_actual_ytd_share",
  });
  for (const row of entityAndLocalTaxComponents({ state, sCorp })) {
    addAllocated(allocatedComponents, { ...row, allocationPercentage });
  }

  if (federal.incomeTax?.income?.qbiDeduction == null || Number(federal.incomeTax?.income?.qbiDeduction || 0) === 0) {
    excludedComponents.push({
      code: "qbi",
      label: "QBI deduction",
      annualAmount: money(federal.incomeTax?.income?.qbiDeduction),
      amount: null,
      treatment: "unavailable",
      reason: "QBI is not supported in the current canonical calculation.",
    });
  }

  const componentTotal = sum([...directComponents, ...allocatedComponents].map((row) => row.amount));
  const fallbackAmount = money(annualTax * allocationPercentage);
  const methodCode = directComponents.length
    ? THROUGH_DATE_TAX_METHODS.ANNUALIZED_ACTUAL_YTD
    : THROUGH_DATE_TAX_METHODS.TAXABLE_INCOME_SHARE;
  const amount = componentTotal != null && componentTotal > 0 ? componentTotal : fallbackAmount;
  if (!directComponents.length) limitations.push("No directly calculated YTD tax components were available; annual tax was allocated by actual taxable-income share.");

  return {
    amount: money(amount),
    methodCode,
    methodVersion: THROUGH_DATE_TAX_METHOD_VERSION,
    formula: directComponents.length
      ? "sum(directly calculated YTD components) + sum(projected annual components * actual YTD taxable-income share)"
      : "projected annual tax * (actual YTD taxable-income base / projected annual taxable-income base)",
    actualYtdTaxableIncomeBase,
    projectedAnnualTaxableIncomeBase,
    allocationPercentage: money(allocationPercentage),
    directlyCalculatedComponents: directComponents,
    allocatedComponents,
    excludedComponents,
    assumptions,
    confidence: confidence({ confidenceLevel, limitations, methodCode }),
    limitations: [...new Set(limitations)],
    ruleTreatmentRegistry: THROUGH_DATE_RULE_TREATMENT_REGISTRY,
    source: {
      actualYtdTaxableIncomeBase: "projection.actual.taxableBusinessIncome",
      projectedAnnualTaxableIncomeBase: "projection.projectedAnnual.taxableBusinessIncome",
      projectedAnnualTax: "liability.projectedTotalTax",
    },
  };
}

export function buildTaxTrajectoryPoints({ canonical } = {}) {
  const c = canonical || {};
  const taxYear = c.meta?.taxYear;
  const annualTax = money(c.liability?.projectedTotalTax);
  const through = c.liability?.taxAttributableThroughToday || null;
  if (!taxYear || annualTax == null) return [];
  const asOfDate = c.meta?.asOfDate || `${taxYear}-12-31`;
  const currentMonth = String(asOfDate).slice(0, 7);
  const months = Array.from({ length: 12 }, (_, index) => `${taxYear}-${String(index + 1).padStart(2, "0")}`);
  const monthly = c.projection?.projectedAnnual?.monthly || c.projection?.actual?.monthly || {};
  const weights = monthlyTaxableIncomeWeights({ monthly, months });
  const throughAmount = money(through?.amount ?? c.liability?.ytdTaxGeneratedEstimate);
  const reserveTarget = money(c.reserve?.reserve?.recommendedReserve ?? c.reserveInput?.recommendedReserveBeforeCashComparison);
  const paymentsApplied = money(c.liability?.paymentsAndWithholdingYtd);
  const currentIndex = Math.max(0, months.indexOf(currentMonth));
  const ytdWeight = weights.slice(0, currentIndex + 1).reduce((total, value) => total + value, 0) || elapsedMonthShare(currentIndex);
  let cumulativeWeight = 0;
  return months.map((month, index) => {
    cumulativeWeight += weights[index];
    const isCurrent = month === currentMonth;
    const isPast = month < currentMonth;
    const isFuture = month > currentMonth;
    const pointType = isCurrent ? "current_partial_period" : isFuture ? "projected_future_period" : "modeled_reconstructed_period";
    const sourceType = pointType;
    const amount = isFuture
      ? money(throughAmount + Math.max(0, annualTax - throughAmount) * futureShare({ index, currentIndex, totalMonths: 12 }))
      : money(throughAmount * (ytdWeight > 0 ? Math.min(cumulativeWeight / ytdWeight, 1) : elapsedMonthShare(index)));
    return {
      month,
      period: month,
      pointType,
      sourceType,
      periodType: isCurrent ? "current_partial" : isFuture ? "projected" : "modeled_reconstructed",
      amount,
      actualTax: null,
      projectedTax: isFuture ? amount : null,
      modeledTax: !isFuture ? amount : null,
      estTax: amount,
      cumulativeActualTax: isCurrent ? amount : null,
      projectedYearEndTax: annualTax,
      paymentsApplied,
      reserveTarget,
      isCurrent,
      method: isFuture ? "projected_future_period_from_annual_projection" : through?.methodCode || THROUGH_DATE_TAX_METHODS.UNAVAILABLE,
      runId: c.meta?.runId || null,
      runReference: c.meta?.runId || null,
      snapshotReference: null,
      graphNodeCode: "through_date_tax:tax_attributable_through_date",
      graphNodeId: through?.graphNodeId || null,
      confidence: through?.confidence || null,
      confidenceLevel: c.confidence?.level || through?.confidence?.level || "unavailable",
      sourceFreshness: c.meta?.sourceFreshness || {},
      sourcePeriod: {
        startDate: taxYear ? `${taxYear}-01-01` : null,
        throughDate: asOfDate,
      },
      workpaperDeepLink: c.meta?.runId ? `/api/tax/calculations/${c.meta.runId}/workpaper?section=through_date_tax` : null,
      warnings: isCurrent ? (c.warnings || []).slice(0, 2) : [],
    };
  });
}

function selfEmploymentAttribution({ actualTaxableIncomeBase, selfEmploymentTax }) {
  const limitations = [];
  const detail = selfEmploymentTax?.detail || {};
  const annualSe = money(selfEmploymentTax?.result?.totalSelfEmploymentTax);
  if (annualSe == null) return { available: false, limitations: ["Self-employment tax component is unavailable."] };
  const factor = number(detail.netEarningsFactor ?? selfEmploymentTax?.metadata?.netEarningsFactor ?? 0.9235);
  const ssRate = number(detail.socialSecurity?.rate ?? 0.124);
  const medicareRate = number(detail.medicare?.rate ?? 0.029);
  const additionalRate = number(detail.additionalMedicare?.rate ?? 0);
  const wageBase = number(detail.socialSecurity?.wageBase ?? detail.socialSecurity?.taxableBase ?? 160200);
  const additionalThreshold = number(detail.additionalMedicare?.threshold ?? null);
  if (factor == null || ssRate == null || medicareRate == null || wageBase == null) {
    return { available: false, limitations: ["Self-employment wage-base inputs are incomplete."] };
  }
  const netEarnings = money(Math.max(0, actualTaxableIncomeBase) * factor);
  const socialSecurityTax = money(Math.min(netEarnings, wageBase) * ssRate);
  const medicareTax = money(netEarnings * medicareRate);
  const additionalMedicareTax = additionalThreshold == null
    ? 0
    : money(Math.max(0, netEarnings - additionalThreshold) * (additionalRate || 0));
  const amount = money(socialSecurityTax + medicareTax + additionalMedicareTax);
  return {
    available: true,
    component: component({
      code: "self_employment_tax",
      label: "Self-employment tax",
      annualAmount: annualSe,
      amount,
      method: THROUGH_DATE_TAX_METHODS.ANNUALIZED_ACTUAL_YTD,
      treatment: "threshold_tested_against_annualized_income",
      metadata: { netEarnings, socialSecurityTax, medicareTax, additionalMedicareTax, wageBase, additionalThreshold },
    }),
    limitations,
  };
}

function entityAndLocalTaxComponents({ state, sCorp }) {
  const tax = state.incomeTax?.tax || {};
  return [
    { code: "entity_minimum_tax", label: "Entity minimum tax", annualAmount: tax.sCorpMinimumTax, treatment: "allocated_by_actual_ytd_share" },
    { code: "entity_level_tax", label: "Entity-level tax", annualAmount: tax.sCorpEntityTax ?? sCorp?.payroll?.payrollTaxAmount, treatment: "allocated_by_actual_ytd_share" },
    { code: "ptet", label: "Pass-through entity tax", annualAmount: tax.passThroughEntityTax, treatment: "allocated_by_actual_ytd_share" },
    { code: "local_tax", label: "Local tax", annualAmount: tax.localIncomeTax, treatment: "allocated_by_actual_ytd_share" },
    { code: "business_excises", label: "Supported business excises", annualAmount: sum([tax.replacementTax, tax.grossReceiptsTax, tax.payrollExciseTax]), treatment: "allocated_by_actual_ytd_share" },
  ];
}

function addAllocated(out, { code, label, annualAmount, allocationPercentage, treatment }) {
  const annual = money(annualAmount);
  if (annual == null || annual === 0) return;
  out.push(component({
    code,
    label,
    annualAmount: annual,
    amount: money(annual * allocationPercentage),
    method: THROUGH_DATE_TAX_METHODS.TAXABLE_INCOME_SHARE,
    treatment,
  }));
}

function component({ code, label, annualAmount, amount, method, treatment, metadata = {} }) {
  return { code, label, annualAmount: money(annualAmount), amount: money(amount), method, treatment, metadata };
}

function unavailableResult({ taxYear, asOfDate, annualTax, actualYtdTaxableIncomeBase, projectedAnnualTaxableIncomeBase, limitations, assumptions, confidenceLevel }) {
  return {
    amount: null,
    methodCode: THROUGH_DATE_TAX_METHODS.UNAVAILABLE,
    methodVersion: THROUGH_DATE_TAX_METHOD_VERSION,
    formula: null,
    actualYtdTaxableIncomeBase,
    projectedAnnualTaxableIncomeBase,
    allocationPercentage: null,
    directlyCalculatedComponents: [],
    allocatedComponents: [],
    excludedComponents: [],
    assumptions,
    confidence: confidence({ confidenceLevel, limitations, methodCode: THROUGH_DATE_TAX_METHODS.UNAVAILABLE }),
    limitations: [...new Set(limitations)],
    ruleTreatmentRegistry: THROUGH_DATE_RULE_TREATMENT_REGISTRY,
    metadata: { taxYear, asOfDate, projectedAnnualTax: annualTax },
  };
}

function monthlyTaxableIncomeWeights({ monthly, months }) {
  const raw = months.map((month) => Math.max(0, number(monthly?.[month]?.taxableBusinessIncome ?? monthly?.[month]?.finalBusinessTaxableIncome ?? monthly?.[month]?.businessTaxableIncome) ?? 0));
  const total = raw.reduce((sumValue, value) => sumValue + value, 0);
  if (total > 0) return raw.map((value) => value / total);
  return months.map(() => 1 / 12);
}

function confidence({ confidenceLevel, limitations, methodCode }) {
  const base = methodCode === THROUGH_DATE_TAX_METHODS.ANNUALIZED_ACTUAL_YTD ? 0.78
    : methodCode === THROUGH_DATE_TAX_METHODS.TAXABLE_INCOME_SHARE ? 0.62
      : 0.25;
  const penalty = Math.min(0.4, (limitations || []).length * 0.08);
  return {
    score: money(Math.max(0, base - penalty)),
    level: confidenceLevel || (base - penalty >= 0.7 ? "medium" : "low"),
    status: methodCode === THROUGH_DATE_TAX_METHODS.UNAVAILABLE ? "unavailable" : "planning_estimate",
  };
}

function futureShare({ index, currentIndex, totalMonths }) {
  const remainingPeriods = Math.max(1, totalMonths - currentIndex - 1);
  return Math.min(1, Math.max(0, index - currentIndex) / remainingPeriods);
}

function elapsedMonthShare(index) {
  return Math.min(1, Math.max(0, index + 1) / 12);
}

function number(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return null;
  return Number(value);
}

function money(value) {
  const n = number(value);
  if (n == null) return null;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function sum(values) {
  const present = values.map(money).filter((value) => value != null);
  if (!present.length) return null;
  return money(present.reduce((total, value) => total + value, 0));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value || 0)));
}
