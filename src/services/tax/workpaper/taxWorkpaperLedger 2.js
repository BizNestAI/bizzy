// /src/services/tax/workpaper/taxWorkpaperLedger.js
import { THROUGH_DATE_TAX_METHODS } from "../throughDate/throughDateTaxAttribution.js";
import { TAX_PAYMENT_TYPES } from "../taxDomain.js";

export const TAX_WORKPAPER_VERSION = "tax-workpaper-v1";

export const WORKPAPER_STATUSES = {
  COMPLETE: "complete",
  PARTIAL: "partial",
  UNAVAILABLE: "unavailable",
  LEGACY_INCOMPLETE: "legacy_incomplete",
};

const SECTIONS = {
  SOURCE_INCOME: "source_period_income",
  PROJECTED_INCOME: "projected_remaining_year_income",
  ANNUAL_INCOME: "annual_income_bridge",
  DEDUCTIONS: "deductions",
  BUSINESS_TAXABLE_INCOME: "business_taxable_income_bridge",
  ENTITY: "entity_treatment",
  FEDERAL: "federal_bridge",
  STATE: "state_bridge",
  TOTAL_TAX: "total_tax_components",
  THROUGH_DATE: "through_date_tax",
  PAYMENTS: "payment_application_snapshot",
  REMAINING: "remaining_liability",
  RESERVE: "reserve_bridge",
};

const STATUS = {
  CALCULATED: "calculated",
  CONFIRMED: "confirmed",
  PROJECTED: "projected",
  ESTIMATED: "estimated",
  PARTIAL: "partial",
  UNAVAILABLE: "unavailable",
  NOT_APPLICABLE: "not_applicable",
  EXCLUDED: "excluded",
  REVIEW_REQUIRED: "review_required",
};

export function buildTaxWorkpaperLedger({ canonicalResult } = {}) {
  const c = canonicalResult || {};
  const ctx = createContext(c);
  const ruleVersionMap = collectRuleVersionMap(c);
  const sourceLineageSummary = collectSourceLineageSummary(c);
  const paymentApplicationSummary = buildPaymentApplicationSummary(c);

  addSourceIncome(ctx);
  addProjectedIncome(ctx);
  addAnnualIncome(ctx);
  addDeductions(ctx);
  addBusinessTaxableIncome(ctx);
  addEntityTreatment(ctx);
  addFederalBridge(ctx);
  addStateBridge(ctx);
  addTotalTax(ctx);
  addThroughDateTax(ctx);
  addPaymentApplications(ctx);
  addRemainingLiability(ctx);
  addReserveBridge(ctx);

  const reconciliation = reconcileLedger(ctx.lines);
  const lineStatuses = new Set(ctx.lines.map((line) => line.status));
  const workpaperStatus = determineWorkpaperStatus({ lines: ctx.lines, reconciliation });

  return {
    version: TAX_WORKPAPER_VERSION,
    status: workpaperStatus,
    lines: ctx.lines.map((line, index) => normalizeLine(line, ctx, index)),
    sectionAvailability: buildSectionAvailability(ctx.lines),
    ruleVersionMap,
    sourceLineageSummary,
    paymentApplicationSummary,
    reconciliation,
    reconciliationStatus: reconciliation.ok ? "reconciled" : "out_of_balance",
    hasUnavailableValues: lineStatuses.has(STATUS.UNAVAILABLE),
    generatedAt: new Date().toISOString(),
  };
}

export function reconcileLedger(lines = []) {
  const checks = [
    sumCheck(lines, "annual_income_bridge:projected_annual_income", [
      "annual_income_bridge:actual_ytd_income",
      "annual_income_bridge:projected_remaining_income",
    ]),
    sumDeductionCategoryCheck(lines),
    formulaCheck(lines, "business_taxable_income_bridge:projected_business_taxable_profit", (get) =>
      get("business_taxable_income_bridge:projected_annual_revenue")
      - get("business_taxable_income_bridge:deductible_expenses")
      + get("business_taxable_income_bridge:nondeductible_addbacks")
      + get("business_taxable_income_bridge:other_tax_adjustments")
    ),
    formulaCheck(lines, "federal_bridge:federal_taxable_income", (get) =>
      Math.max(0, get("federal_bridge:adjusted_income_before_personal_deductions")
        - get("federal_bridge:standard_or_itemized_deduction")
        - get("federal_bridge:qbi_deduction")
        + get("federal_bridge:other_adjustments"))
    ),
    formulaCheck(lines, "state_bridge:state_taxable_income", (get) =>
      Math.max(0, get("state_bridge:federal_starting_base")
        + get("state_bridge:state_additions")
        - get("state_bridge:state_subtractions")
        - get("state_bridge:state_deduction_exemption"))
    ),
    sumCheck(lines, "total_tax_components:projected_annual_tax", [
      "total_tax_components:federal_income_tax",
      "total_tax_components:self_employment_tax",
      "total_tax_components:additional_medicare_tax",
      "total_tax_components:state_individual_income_tax",
      "total_tax_components:entity_level_tax",
      "total_tax_components:local_tax",
      "total_tax_components:supported_business_excises",
      "total_tax_components:credits",
    ]),
    throughDateCheck(lines),
    formulaCheck(lines, "remaining_liability:remaining_projected_liability", (get) =>
      Math.max(0, get("remaining_liability:projected_annual_tax")
        - get("remaining_liability:confirmed_federal_payments")
        - get("remaining_liability:confirmed_state_payments")
        - get("remaining_liability:confirmed_withholding")
        - get("remaining_liability:confirmed_prior_year_credits")
        - get("remaining_liability:confirmed_ptet_entity_credits"))
    ),
    formulaCheck(lines, "reserve_bridge:recommended_reserve", (get) =>
      get("reserve_bridge:reserve_policy_adjustment") + get("reserve_bridge:uncertainty_adjustment")
    ),
  ].filter(Boolean);
  return {
    ok: checks.every((check) => check.status === "reconciled" || check.status === "skipped"),
    checks,
  };
}

function createContext(c) {
  return {
    c,
    businessId: c.meta?.businessId || null,
    taxYear: c.meta?.taxYear || null,
    lines: [],
    sort: 0,
  };
}

function addSourceIncome(ctx) {
  const c = ctx.c;
  const revenue = c.actuals?.taxableIncome?.revenue || {};
  const projectionActual = c.projection?.actual || {};
  add(ctx, {
    code: "source_period_income:actual_business_revenue_ytd",
    label: "Actual business revenue YTD",
    section: SECTIONS.SOURCE_INCOME,
    amount: value(revenue.grossReceipts ?? revenue.netBusinessRevenue),
    status: STATUS.CONFIRMED,
    isActual: true,
    formulaCode: "gross_receipts_ytd",
    formulaDescription: "Classified actual business receipts through the calculation through-date.",
    sourceType: "transaction_tax_classifications",
    sourceRefs: aggregateClassificationRefs(c, "income"),
    drillDownType: "transaction_classifications",
    drillDownParams: { taxCategory: "income" },
  });
  add(ctx, {
    code: "source_period_income:other_actual_business_income_ytd",
    label: "Other actual business income YTD",
    section: SECTIONS.SOURCE_INCOME,
    amount: value(revenue.otherBusinessIncome),
    status: STATUS.CONFIRMED,
    isActual: true,
    sourceType: "transaction_tax_classifications",
    sourceRefs: aggregateClassificationRefs(c, "other_business_income"),
  });
  add(ctx, {
    code: "source_period_income:actual_nonbusiness_income_included",
    label: "Actual nonbusiness income included",
    section: SECTIONS.SOURCE_INCOME,
    amount: value(c.federal?.incomeTax?.income?.otherIncome),
    status: c.federal?.incomeTax?.income?.otherIncome == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
    isActual: true,
    explanation: "Currently includes known owner W-2 wages or other income passed to the federal engine.",
  });
  add(ctx, {
    code: "source_period_income:actual_period_start",
    label: "Actual period start",
    section: SECTIONS.SOURCE_INCOME,
    amount: null,
    status: STATUS.CONFIRMED,
    isActual: true,
    metadata: { date: c.meta?.taxYear ? `${c.meta.taxYear}-01-01` : null },
  });
  add(ctx, {
    code: "source_period_income:actual_through_date",
    label: "Actual through-date",
    section: SECTIONS.SOURCE_INCOME,
    amount: null,
    status: STATUS.CONFIRMED,
    isActual: true,
    metadata: { date: c.meta?.asOfDate || null },
  });
}

function addProjectedIncome(ctx) {
  const c = ctx.c;
  const future = c.projection?.projectedFuture || {};
  add(ctx, {
    code: "projected_remaining_year_income:projected_remaining_business_revenue",
    label: "Projected remaining business revenue",
    section: SECTIONS.PROJECTED_INCOME,
    amount: value(future.revenue),
    status: future.revenue == null ? STATUS.UNAVAILABLE : STATUS.PROJECTED,
    isProjection: true,
    formulaCode: "projection_remaining_revenue",
    formulaDescription: "Projection engine revenue for remaining months and current-month remainder.",
    metadata: {
      method: c.projection?.method || null,
      projectedMonthly: boundedMonthly(future.monthly),
    },
  });
  add(ctx, {
    code: "projected_remaining_year_income:projected_remaining_other_business_income",
    label: "Projected remaining other business income",
    section: SECTIONS.PROJECTED_INCOME,
    amount: null,
    status: STATUS.UNAVAILABLE,
    isProjection: true,
    explanation: "Projection engine does not currently split other business income from business revenue.",
  });
  add(ctx, {
    code: "projected_remaining_year_income:projection_method",
    label: "Projection method",
    section: SECTIONS.PROJECTED_INCOME,
    amount: null,
    status: c.projection?.method ? STATUS.CONFIRMED : STATUS.UNAVAILABLE,
    formulaCode: c.projection?.method || null,
    formulaDescription: "Projection method selected for this immutable run.",
    metadata: {
      method: c.projection?.method || null,
      weights: c.projection?.methodology?.weights || c.projection?.weights || null,
    },
  });
  add(ctx, {
    code: "projected_remaining_year_income:projection_input_period",
    label: "Projection input period",
    section: SECTIONS.PROJECTED_INCOME,
    amount: null,
    status: STATUS.CONFIRMED,
    metadata: {
      throughDate: c.projection?.actual?.throughDate || c.meta?.asOfDate || null,
      monthsCompleted: c.projection?.actual?.monthsCompleted ?? null,
      partialCurrentMonth: c.projection?.actual?.partialCurrentMonth === true,
    },
  });
  add(ctx, {
    code: "projected_remaining_year_income:projection_assumptions",
    label: "Projection assumptions",
    section: SECTIONS.PROJECTED_INCOME,
    amount: null,
    status: STATUS.CONFIRMED,
    explanation: "Projection assumptions are persisted with the run and summarized here.",
    metadata: { assumptions: c.projection?.methodology?.assumptions || [] },
  });
}

function addAnnualIncome(ctx) {
  const c = ctx.c;
  add(ctx, {
    code: "annual_income_bridge:actual_ytd_income",
    label: "Actual YTD income",
    section: SECTIONS.ANNUAL_INCOME,
    parentCode: "annual_income_bridge:projected_annual_income",
    amount: value(c.projection?.actual?.revenue ?? c.actuals?.taxableIncome?.revenue?.netBusinessRevenue),
    status: STATUS.CONFIRMED,
    isActual: true,
  });
  add(ctx, {
    code: "annual_income_bridge:projected_remaining_income",
    label: "Projected remaining income",
    section: SECTIONS.ANNUAL_INCOME,
    parentCode: "annual_income_bridge:projected_annual_income",
    amount: value(c.projection?.projectedFuture?.revenue),
    status: c.projection?.projectedFuture?.revenue == null ? STATUS.UNAVAILABLE : STATUS.PROJECTED,
    isProjection: true,
  });
  add(ctx, {
    code: "annual_income_bridge:projected_annual_income",
    label: "Projected annual income",
    section: SECTIONS.ANNUAL_INCOME,
    amount: value(c.projection?.projectedAnnual?.revenue),
    status: c.projection?.projectedAnnual?.revenue == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
    formulaCode: "actual_ytd_income_plus_projected_remaining_income",
    formulaDescription: "Actual YTD income plus projected remaining-year income.",
  });
}

function addDeductions(ctx) {
  const c = ctx.c;
  const expenses = c.actuals?.taxableIncome?.expenses || {};
  const adjustments = c.actuals?.taxableIncome?.adjustments || {};
  const categories = safeArray(c.actuals?.deductions?.categories);
  add(ctx, {
    code: "deductions:confirmed_deductible_expenses",
    label: "Confirmed deductible expenses",
    section: SECTIONS.DEDUCTIONS,
    amount: value(expenses.confirmedDeductibleOperatingExpenses),
    status: STATUS.CONFIRMED,
    isActual: true,
    sourceType: "transaction_tax_classifications",
    sourceRefs: aggregateClassificationRefs(c),
  });
  add(ctx, {
    code: "deductions:estimated_deductible_expenses",
    label: "Estimated deductible expenses",
    section: SECTIONS.DEDUCTIONS,
    amount: value(expenses.estimatedDeductibleOperatingExpenses),
    status: STATUS.ESTIMATED,
    isActual: true,
    sourceType: "transaction_tax_classifications",
    sourceRefs: aggregateClassificationRefs(c),
  });
  addDeductionCategoryLines(ctx, categories);
  add(ctx, {
    code: "deductions:partially_deductible_gross_amount",
    label: "Partially deductible gross amount",
    section: SECTIONS.DEDUCTIONS,
    amount: value(sumCategoryField(c.actuals?.deductions?.categories, "partiallyDeductibleGrossAmount")),
    status: STATUS.PARTIAL,
    sourceType: "transaction_tax_classifications",
  });
  add(ctx, {
    code: "deductions:partially_deductible_allowed_amount",
    label: "Partially deductible allowed amount",
    section: SECTIONS.DEDUCTIONS,
    amount: value(sumCategoryField(c.actuals?.deductions?.categories, "partiallyDeductibleAllowedAmount")),
    status: STATUS.PARTIAL,
    sourceType: "transaction_tax_classifications",
  });
  add(ctx, {
    code: "deductions:nondeductible_portion",
    label: "Nondeductible portion",
    section: SECTIONS.DEDUCTIONS,
    amount: value(expenses.nondeductibleBookExpenses),
    status: STATUS.CALCULATED,
    sourceType: "transaction_tax_classifications",
    sourceRefs: aggregateClassificationRefs(c, null, { treatment: "nondeductible" }),
  });
  add(ctx, {
    code: "deductions:capitalized_items",
    label: "Capitalized expenses",
    section: SECTIONS.DEDUCTIONS,
    amount: value(expenses.capitalizableExpenditures),
    status: STATUS.CALCULATED,
    sourceType: "transaction_tax_classifications",
    sourceRefs: aggregateClassificationRefs(c, null, { treatment: "capitalizable" }),
  });
  add(ctx, {
    code: "deductions:items_awaiting_review",
    label: "Items awaiting review",
    section: SECTIONS.DEDUCTIONS,
    amount: value(expenses.needsReviewAmount),
    status: Number(expenses.needsReviewAmount || 0) > 0 ? STATUS.REVIEW_REQUIRED : STATUS.CALCULATED,
    sourceType: "transaction_tax_classifications",
    sourceRefs: aggregateClassificationRefs(c, null, { treatment: "needs_review" }),
  });
  add(ctx, {
    code: "deductions:excluded_transfers_owner_activity",
    label: "Excluded transfers and owner activity",
    section: SECTIONS.DEDUCTIONS,
    amount: value(expenses.balanceSheetActivityAmount ?? sumCategoryField(categories, "excludedAmount")),
    status: STATUS.EXCLUDED,
    sourceType: "transaction_tax_classifications",
    sourceRefs: aggregateClassificationRefs(c, null, { treatment: "excluded" }),
  });
  add(ctx, {
    code: "deductions:other_tax_adjustments",
    label: "Other tax adjustments",
    section: SECTIONS.DEDUCTIONS,
    amount: value(Number(adjustments.increasesToTaxableIncome || 0) - Number(adjustments.decreasesToTaxableIncome || 0)),
    status: STATUS.CALCULATED,
    sourceType: "tax_adjustments",
  });
}

function addDeductionCategoryLines(ctx, categories = []) {
  const c = ctx.c;
  for (const category of categories) {
    const categoryCode = category.taxCategory || category.categoryCode || category.code;
    if (!categoryCode) continue;
    const deductibleAmount = value(category.estimatedDeductibleAmount ?? category.deductibleAmount ?? category.allowedAmount);
    const grossAmount = value(category.bookExpenseAmount ?? category.grossAmount);
    const nondeductibleAmount = value(category.nondeductibleAmount);
    const capitalizableAmount = value(category.capitalizableAmount);
    const needsReviewAmount = value(category.needsReviewAmount);
    const transactionCount = category.transactionCount ?? category.count ?? null;
    const deductiblePercent = category.averageDeductiblePercent ?? category.deductiblePercent ?? category.defaultDeductiblePercent ?? null;
    const rule = primaryDeductionRule(category);
    const treatmentStatus = category.treatmentStatus || category.deductibilityStatus || category.status || category.classificationStatus || null;
    add(ctx, {
      code: `deductions:category:${categoryCode}`,
      label: category.displayName || category.label || labelize(categoryCode),
      section: SECTIONS.DEDUCTIONS,
      parentCode: "deductions:estimated_deductible_expenses",
      amount: deductibleAmount,
      quantity: transactionCount,
      percentage: value(deductiblePercent == null ? null : Number(deductiblePercent) / (Number(deductiblePercent) > 1 ? 100 : 1)),
      status: needsReviewAmount && needsReviewAmount > 0 ? STATUS.REVIEW_REQUIRED : STATUS.CALCULATED,
      supportLevel: category.supportLevel || rule?.supportLevel || null,
      confidence: confidenceNumber(category.confidenceScore ?? category.confidence ?? category.confidenceLevel),
      sourceType: "transaction_tax_classifications",
      sourceRefs: aggregateClassificationRefs(c, categoryCode, {}, transactionCount),
      ruleRefs: rule ? [rule] : [],
      ruleVersions: rule?.code ? { [rule.code]: rule.version || null } : {},
      explanation: category.explanation || `Deduction category total comes from persisted ${category.displayName || labelize(categoryCode)} classification results in this calculation run.`,
      drillDownType: "deductions_workspace",
      drillDownParams: deductionDrillDownParams(c, categoryCode),
      metadata: {
        categoryCode,
        grossAmount,
        deductiblePercent: deductiblePercent == null ? null : Number(deductiblePercent),
        deductibleAmount,
        nondeductibleAmount,
        capitalizableAmount,
        needsReviewAmount,
        treatmentStatus,
        transactionCount,
        confidenceLevel: category.confidenceLevel || null,
        ruleCode: rule?.code || null,
        ruleVersion: rule?.version || null,
      },
    });
  }
}

function addBusinessTaxableIncome(ctx) {
  const c = ctx.c;
  const projected = c.projection?.projectedAnnual || {};
  const expenses = c.actuals?.taxableIncome?.expenses || {};
  const adjustments = c.actuals?.taxableIncome?.adjustments || {};
  add(ctx, {
    code: "business_taxable_income_bridge:projected_annual_revenue",
    label: "Projected annual revenue",
    section: SECTIONS.BUSINESS_TAXABLE_INCOME,
    parentCode: "business_taxable_income_bridge:projected_business_taxable_profit",
    amount: value(projected.revenue),
    status: projected.revenue == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
  });
  add(ctx, {
    code: "business_taxable_income_bridge:deductible_expenses",
    label: "Deductible expenses",
    section: SECTIONS.BUSINESS_TAXABLE_INCOME,
    parentCode: "business_taxable_income_bridge:projected_business_taxable_profit",
    amount: value(Number(projected.cogs || 0) + Number(projected.deductibleExpenses ?? expenses.deductibleOperatingExpenses ?? 0)),
    status: STATUS.CALCULATED,
    displaySign: "subtract",
    metadata: {
      cogs: value(projected.cogs),
      deductibleOperatingExpenses: value(projected.deductibleExpenses ?? expenses.deductibleOperatingExpenses),
    },
  });
  add(ctx, {
    code: "business_taxable_income_bridge:nondeductible_addbacks",
    label: "Nondeductible addbacks",
    section: SECTIONS.BUSINESS_TAXABLE_INCOME,
    parentCode: "business_taxable_income_bridge:projected_business_taxable_profit",
    amount: value(expenses.nondeductibleBookExpenses),
    status: STATUS.CALCULATED,
    displaySign: "add",
  });
  add(ctx, {
    code: "business_taxable_income_bridge:other_tax_adjustments",
    label: "Other tax adjustments",
    section: SECTIONS.BUSINESS_TAXABLE_INCOME,
    parentCode: "business_taxable_income_bridge:projected_business_taxable_profit",
    amount: value(Number(adjustments.increasesToTaxableIncome || 0) - Number(adjustments.decreasesToTaxableIncome || 0)),
    status: STATUS.CALCULATED,
    displaySign: "add",
  });
  add(ctx, {
    code: "business_taxable_income_bridge:projected_business_taxable_profit",
    label: "Projected business taxable profit",
    section: SECTIONS.BUSINESS_TAXABLE_INCOME,
    amount: value(projected.taxableBusinessIncome),
    status: projected.taxableBusinessIncome == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
    formulaCode: "annual_revenue_minus_deductions_plus_addbacks_adjustments",
  });
}

function addEntityTreatment(ctx) {
  const c = ctx.c;
  const se = c.federal?.selfEmploymentTax;
  const sCorp = c.federal?.payrollTaxContext || c.profile?.entityContext?.entity?.entityPath === "s_corporation" ? c.federal?.incomeTax : null;
  const sCorpContext = c.federal?.payrollTaxContext || null;
  add(ctx, {
    code: "entity_treatment:business_profit",
    label: "Business profit",
    section: SECTIONS.ENTITY,
    amount: value(c.projection?.projectedAnnual?.taxableBusinessIncome),
    status: STATUS.CALCULATED,
  });
  add(ctx, {
    code: "entity_treatment:se_earnings_adjustment",
    label: "SE earnings adjustment",
    section: SECTIONS.ENTITY,
    amount: value(se?.result?.netEarningsFromSelfEmployment == null || se?.input?.annualNetBusinessIncome == null ? null : se.result.netEarningsFromSelfEmployment - se.input.annualNetBusinessIncome),
    status: se ? STATUS.CALCULATED : STATUS.NOT_APPLICABLE,
  });
  add(ctx, {
    code: "entity_treatment:net_earnings_from_self_employment",
    label: "Net earnings from self-employment",
    section: SECTIONS.ENTITY,
    amount: value(se?.result?.netEarningsFromSelfEmployment),
    status: se ? STATUS.CALCULATED : STATUS.NOT_APPLICABLE,
  });
  add(ctx, {
    code: "entity_treatment:se_wage_base_treatment",
    label: "SE wage-base treatment",
    section: SECTIONS.ENTITY,
    amount: value(se?.detail?.socialSecurity?.taxableBase),
    percentage: nullableNumber(se?.detail?.socialSecurity?.rate),
    status: se ? STATUS.CALCULATED : STATUS.NOT_APPLICABLE,
    metadata: { socialSecurity: se?.detail?.socialSecurity || null },
  });
  add(ctx, {
    code: "entity_treatment:se_tax_deduction",
    label: "SE tax deduction",
    section: SECTIONS.ENTITY,
    amount: value(se?.result?.deductibleHalfSelfEmploymentTax),
    status: se ? STATUS.CALCULATED : STATUS.NOT_APPLICABLE,
  });
  add(ctx, {
    code: "entity_treatment:owner_wages",
    label: "Owner wages",
    section: SECTIONS.ENTITY,
    amount: value(c.federal?.incomeTax?.income?.otherIncome),
    status: c.entity?.entityPath === "s_corporation" || sCorp ? STATUS.CALCULATED : STATUS.NOT_APPLICABLE,
  });
  add(ctx, {
    code: "entity_treatment:employer_payroll_taxes",
    label: "Employer payroll taxes",
    section: SECTIONS.ENTITY,
    amount: value(sCorpContext?.payrollTaxAmount),
    status: sCorpContext?.payrollTaxAmount == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
  });
  add(ctx, {
    code: "entity_treatment:pass_through_income",
    label: "Pass-through income",
    section: SECTIONS.ENTITY,
    amount: value(c.federal?.incomeTax?.income?.annualBusinessTaxableIncome),
    status: c.entity?.entityPath === "s_corporation" ? STATUS.CALCULATED : STATUS.NOT_APPLICABLE,
  });
  add(ctx, {
    code: "entity_treatment:entity_level_taxable_income",
    label: "Entity-level taxable income",
    section: SECTIONS.ENTITY,
    amount: value(c.state?.entityTaxes?.detail?.sCorpEntityTax?.taxBase),
    status: c.state?.entityTaxes?.detail?.sCorpEntityTax?.taxBase == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
  });
  add(ctx, {
    code: "entity_treatment:distributions_excluded",
    label: "Distributions excluded from deduction calculations",
    section: SECTIONS.ENTITY,
    amount: null,
    status: c.entity?.entityPath === "s_corporation" ? STATUS.EXCLUDED : STATUS.NOT_APPLICABLE,
  });
  add(ctx, {
    code: "entity_treatment:state_entity_taxes",
    label: "State entity taxes",
    section: SECTIONS.ENTITY,
    amount: value(Number(c.state?.entityTaxes?.sCorpEntityTax || 0) + Number(c.state?.entityTaxes?.sCorpMinimumTax || 0)),
    status: c.state?.entityTaxes ? STATUS.CALCULATED : STATUS.UNAVAILABLE,
  });
  add(ctx, {
    code: "entity_treatment:ptet",
    label: "PTET",
    section: SECTIONS.ENTITY,
    amount: value(c.state?.incomeTax?.tax?.passThroughEntityTax),
    status: c.state?.incomeTax?.tax?.passThroughEntityTax == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
  });
}

function addFederalBridge(ctx) {
  const f = ctx.c.federal?.incomeTax || {};
  add(ctx, {
    code: "federal_bridge:adjusted_income_before_personal_deductions",
    label: "Adjusted income before personal deductions",
    section: SECTIONS.FEDERAL,
    parentCode: "federal_bridge:federal_taxable_income",
    amount: value(f.income?.adjustedGrossIncome),
    status: f.income?.adjustedGrossIncome == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
  });
  add(ctx, {
    code: "federal_bridge:standard_or_itemized_deduction",
    label: "Standard or itemized deduction",
    section: SECTIONS.FEDERAL,
    parentCode: "federal_bridge:federal_taxable_income",
    amount: value(f.deductions?.standardDeduction),
    displaySign: "subtract",
    status: f.deductions?.standardDeduction == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
  });
  add(ctx, {
    code: "federal_bridge:qbi_deduction",
    label: "QBI deduction",
    section: SECTIONS.FEDERAL,
    parentCode: "federal_bridge:federal_taxable_income",
    amount: Number(f.income?.qbiDeduction || 0) === 0 ? null : value(f.income?.qbiDeduction),
    displaySign: "subtract",
    status: Number(f.income?.qbiDeduction || 0) === 0 ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
    explanation: "QBI is currently deferred unless a supported engine output is present.",
  });
  add(ctx, {
    code: "federal_bridge:other_adjustments",
    label: "Other adjustments",
    section: SECTIONS.FEDERAL,
    parentCode: "federal_bridge:federal_taxable_income",
    amount: 0,
    displaySign: "add",
    status: STATUS.CALCULATED,
  });
  add(ctx, {
    code: "federal_bridge:federal_taxable_income",
    label: "Federal taxable income",
    section: SECTIONS.FEDERAL,
    amount: value(f.income?.taxableIncomeAfterQbi),
    status: f.income?.taxableIncomeAfterQbi == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
    formulaCode: "agi_minus_deductions_qbi_plus_adjustments",
  });
  for (const [index, bracket] of (f.tax?.bracketBreakdown || []).entries()) {
    add(ctx, {
      code: `federal_bridge:tax_by_bracket:${index + 1}`,
      label: `Federal tax bracket ${index + 1}`,
      section: SECTIONS.FEDERAL,
      parentCode: "federal_bridge:federal_income_tax",
      amount: value(bracket.tax),
      quantity: value(bracket.taxableInBracket),
      percentage: nullableNumber(bracket.rate),
      status: STATUS.CALCULATED,
      formulaCode: "taxable_in_bracket_times_rate",
      metadata: bracket,
    });
  }
  add(ctx, {
    code: "federal_bridge:federal_credits",
    label: "Federal credits",
    section: SECTIONS.FEDERAL,
    parentCode: "federal_bridge:federal_income_tax",
    amount: value(f.tax?.creditsApplied),
    displaySign: "subtract",
    status: STATUS.CALCULATED,
  });
  add(ctx, {
    code: "federal_bridge:federal_income_tax",
    label: "Federal income tax",
    section: SECTIONS.FEDERAL,
    amount: value(f.tax?.federalIncomeTax),
    status: f.tax?.federalIncomeTax == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
  });
}

function addThroughDateTax(ctx) {
  const c = ctx.c;
  const attribution = c.liability?.taxAttributableThroughToday || {};
  add(ctx, {
    code: "through_date_tax:projected_annual_tax",
    label: "Projected annual tax",
    section: SECTIONS.THROUGH_DATE,
    parentCode: "through_date_tax:tax_attributable_through_date",
    amount: value(c.liability?.projectedTotalTax),
    status: c.liability?.projectedTotalTax == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
  });
  add(ctx, {
    code: "through_date_tax:actual_ytd_taxable_income_base",
    label: "Actual YTD taxable-income base",
    section: SECTIONS.THROUGH_DATE,
    parentCode: "through_date_tax:tax_attributable_through_date",
    amount: value(attribution.actualYtdTaxableIncomeBase),
    status: attribution.actualYtdTaxableIncomeBase == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
    isActual: true,
    formulaCode: "actual_ytd_taxable_income_base",
    formulaDescription: "Actual taxable-income contribution recorded through the selected through-date.",
  });
  add(ctx, {
    code: "through_date_tax:projected_annual_taxable_income_base",
    label: "Projected annual taxable-income base",
    section: SECTIONS.THROUGH_DATE,
    parentCode: "through_date_tax:tax_attributable_through_date",
    amount: value(attribution.projectedAnnualTaxableIncomeBase),
    status: attribution.projectedAnnualTaxableIncomeBase == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
    isProjection: true,
    formulaCode: "projected_annual_taxable_income_base",
    formulaDescription: "Projected annual taxable-income base used to allocate annual tax to YTD activity.",
  });
  add(ctx, {
    code: "through_date_tax:allocation_percentage",
    label: "Allocation percentage",
    section: SECTIONS.THROUGH_DATE,
    parentCode: "through_date_tax:tax_attributable_through_date",
    amount: null,
    percentage: nullableNumber(attribution.allocationPercentage),
    status: attribution.allocationPercentage == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
    formulaCode: "actual_ytd_taxable_income_divided_by_projected_annual_taxable_income",
    formulaDescription: "Actual YTD taxable-income base divided by projected annual taxable-income base.",
  });
  add(ctx, {
    code: "through_date_tax:directly_calculated_components",
    label: "Directly calculated YTD components",
    section: SECTIONS.THROUGH_DATE,
    parentCode: "through_date_tax:tax_attributable_through_date",
    amount: sumAmounts(attribution.directlyCalculatedComponents),
    status: attribution.directlyCalculatedComponents?.length ? STATUS.CALCULATED : STATUS.UNAVAILABLE,
    formulaCode: "sum_directly_calculated_ytd_components",
    metadata: { components: attribution.directlyCalculatedComponents || [] },
  });
  add(ctx, {
    code: "through_date_tax:allocated_components",
    label: "Allocated annual components",
    section: SECTIONS.THROUGH_DATE,
    parentCode: "through_date_tax:tax_attributable_through_date",
    amount: sumAmounts(attribution.allocatedComponents),
    status: attribution.allocatedComponents?.length ? STATUS.CALCULATED : STATUS.UNAVAILABLE,
    formulaCode: "sum_projected_annual_components_allocated_by_ytd_share",
    metadata: { components: attribution.allocatedComponents || [] },
  });
  add(ctx, {
    code: "through_date_tax:excluded_components",
    label: "Excluded or unavailable components",
    section: SECTIONS.THROUGH_DATE,
    parentCode: "through_date_tax:tax_attributable_through_date",
    amount: null,
    status: attribution.excludedComponents?.length ? STATUS.EXCLUDED : STATUS.NOT_APPLICABLE,
    formulaCode: "excluded_from_through_date_attribution",
    metadata: { components: attribution.excludedComponents || [] },
  });
  add(ctx, {
    code: "through_date_tax:tax_attributable_through_date",
    label: "Tax attributable through today",
    section: SECTIONS.THROUGH_DATE,
    amount: value(attribution.amount ?? c.liability?.ytdTaxGeneratedEstimate),
    status: attribution.amount == null ? STATUS.UNAVAILABLE : STATUS.PROJECTED,
    isProjection: true,
    confidence: nullableNumber(attribution.confidence?.score),
    formulaCode: attribution.methodCode || THROUGH_DATE_TAX_METHODS.UNAVAILABLE,
    formulaDescription: attribution.formula || "Through-date tax attribution is unavailable.",
    metadata: {
      asOfDate: c.meta?.asOfDate || null,
      taxYear: c.meta?.taxYear || null,
      calculationMethod: attribution.methodCode || THROUGH_DATE_TAX_METHODS.UNAVAILABLE,
      methodVersion: attribution.methodVersion || null,
      actualYtdTaxableIncomeBase: attribution.actualYtdTaxableIncomeBase ?? null,
      projectedAnnualTaxableIncomeBase: attribution.projectedAnnualTaxableIncomeBase ?? null,
      allocationPercentage: attribution.allocationPercentage ?? null,
      directlyCalculatedComponents: attribution.directlyCalculatedComponents || [],
      allocatedComponents: attribution.allocatedComponents || [],
      excludedComponents: attribution.excludedComponents || [],
      assumptions: attribution.assumptions || [],
      limitations: attribution.limitations || [],
      ruleTreatmentRegistry: attribution.ruleTreatmentRegistry || {},
      partialYearTaxEngine: attribution.methodCode === THROUGH_DATE_TAX_METHODS.ANNUALIZED_ACTUAL_YTD,
      userFacingDefinition: "An estimate of the cumulative annual tax obligation attributable to income and deductions recorded through the selected through-date.",
      disclaimer: "This is a planning estimate, not necessarily the amount currently due.",
    },
  });
}

function addStateBridge(ctx) {
  const s = ctx.c.state?.incomeTax || {};
  add(ctx, {
    code: "state_bridge:federal_starting_base",
    label: "Federal starting base",
    section: SECTIONS.STATE,
    parentCode: "state_bridge:state_taxable_income",
    amount: value(s.income?.federalAdjustedGrossIncomeInput),
    status: s.income?.federalAdjustedGrossIncomeInput == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
  });
  add(ctx, {
    code: "state_bridge:state_additions",
    label: "State additions",
    section: SECTIONS.STATE,
    parentCode: "state_bridge:state_taxable_income",
    amount: value(Math.max(0, Number(s.income?.stateAdjustments || 0))),
    displaySign: "add",
    status: STATUS.CALCULATED,
  });
  add(ctx, {
    code: "state_bridge:state_subtractions",
    label: "State subtractions",
    section: SECTIONS.STATE,
    parentCode: "state_bridge:state_taxable_income",
    amount: value(Math.max(0, -Number(s.income?.stateAdjustments || 0))),
    displaySign: "subtract",
    status: STATUS.CALCULATED,
  });
  add(ctx, {
    code: "state_bridge:state_deduction_exemption",
    label: "State deduction/exemption",
    section: SECTIONS.STATE,
    parentCode: "state_bridge:state_taxable_income",
    amount: value(Number(s.deductions?.standardDeduction || 0) + Number(s.deductions?.personalExemption || 0)),
    displaySign: "subtract",
    status: STATUS.CALCULATED,
  });
  add(ctx, {
    code: "state_bridge:state_taxable_income",
    label: "State taxable income",
    section: SECTIONS.STATE,
    amount: value(s.income?.stateTaxableIncome),
    status: s.income?.stateTaxableIncome == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
    formulaCode: "federal_base_plus_additions_minus_subtractions_deductions",
  });
  add(ctx, {
    code: "state_bridge:state_individual_tax",
    label: "State individual tax",
    section: SECTIONS.STATE,
    amount: value(ctx.c.state?.individualIncomeTax?.amount ?? s.tax?.regularStateIncomeTax),
    status: stateStatus(ctx.c.state?.individualIncomeTax),
  });
  add(ctx, {
    code: "state_bridge:state_entity_tax",
    label: "State entity tax",
    section: SECTIONS.STATE,
    amount: value(Number(s.tax?.sCorpMinimumTax || 0) + Number(s.tax?.sCorpEntityTax || 0) + Number(s.tax?.replacementTax || 0)),
    status: s.entityTax?.status === "partial" ? STATUS.PARTIAL : STATUS.CALCULATED,
  });
  add(ctx, {
    code: "state_bridge:local_county_tax",
    label: "Local/county tax",
    section: SECTIONS.STATE,
    amount: value(s.tax?.localIncomeTax),
    status: s.tax?.localIncomeTax == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
  });
  add(ctx, {
    code: "state_bridge:ptet",
    label: "PTET",
    section: SECTIONS.STATE,
    amount: value(s.tax?.passThroughEntityTax),
    status: s.tax?.passThroughEntityTax == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
  });
  add(ctx, {
    code: "state_bridge:state_credits",
    label: "State credits",
    section: SECTIONS.STATE,
    amount: null,
    status: STATUS.UNAVAILABLE,
  });
}

function addTotalTax(ctx) {
  const c = ctx.c;
  add(ctx, {
    code: "total_tax_components:federal_income_tax",
    label: "Federal income tax",
    section: SECTIONS.TOTAL_TAX,
    parentCode: "total_tax_components:projected_annual_tax",
    amount: value(c.federal?.incomeTax?.tax?.federalIncomeTax),
    status: c.federal?.incomeTax?.tax?.federalIncomeTax == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
  });
  add(ctx, {
    code: "total_tax_components:self_employment_tax",
    label: "Self-employment tax",
    section: SECTIONS.TOTAL_TAX,
    parentCode: "total_tax_components:projected_annual_tax",
    amount: value(c.federal?.selfEmploymentTax
      ? Number(c.federal.selfEmploymentTax.result?.totalSelfEmploymentTax || 0) - Number(c.federal.selfEmploymentTax.result?.additionalMedicareTax || 0)
      : null),
    status: c.federal?.selfEmploymentTax ? STATUS.CALCULATED : STATUS.NOT_APPLICABLE,
  });
  add(ctx, {
    code: "total_tax_components:additional_medicare_tax",
    label: "Additional Medicare tax",
    section: SECTIONS.TOTAL_TAX,
    parentCode: "total_tax_components:projected_annual_tax",
    amount: value(c.federal?.selfEmploymentTax?.result?.additionalMedicareTax),
    status: c.federal?.selfEmploymentTax ? STATUS.CALCULATED : STATUS.NOT_APPLICABLE,
  });
  add(ctx, {
    code: "total_tax_components:state_individual_income_tax",
    label: "State individual income tax",
    section: SECTIONS.TOTAL_TAX,
    parentCode: "total_tax_components:projected_annual_tax",
    amount: value(c.state?.individualIncomeTax?.amount ?? c.state?.incomeTax?.tax?.regularStateIncomeTax),
    status: stateStatus(c.state?.individualIncomeTax),
  });
  add(ctx, {
    code: "total_tax_components:entity_level_tax",
    label: "Entity-level tax",
    section: SECTIONS.TOTAL_TAX,
    parentCode: "total_tax_components:projected_annual_tax",
    amount: value(Number(c.state?.incomeTax?.tax?.sCorpMinimumTax || 0) + Number(c.state?.incomeTax?.tax?.sCorpEntityTax || 0) + Number(c.state?.incomeTax?.tax?.replacementTax || 0)),
    status: STATUS.CALCULATED,
  });
  add(ctx, {
    code: "total_tax_components:local_tax",
    label: "Local tax",
    section: SECTIONS.TOTAL_TAX,
    parentCode: "total_tax_components:projected_annual_tax",
    amount: value(c.state?.incomeTax?.tax?.localIncomeTax),
    status: c.state?.incomeTax?.tax?.localIncomeTax == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
  });
  add(ctx, {
    code: "total_tax_components:supported_business_excises",
    label: "Supported business excises",
    section: SECTIONS.TOTAL_TAX,
    parentCode: "total_tax_components:projected_annual_tax",
    amount: value(Number(c.state?.incomeTax?.tax?.grossReceiptsTax || 0) + Number(c.state?.incomeTax?.tax?.payrollExciseTax || 0)),
    status: STATUS.CALCULATED,
  });
  add(ctx, {
    code: "total_tax_components:credits",
    label: "Credits",
    section: SECTIONS.TOTAL_TAX,
    parentCode: "total_tax_components:projected_annual_tax",
    amount: value(-Math.abs(Number(c.federal?.incomeTax?.tax?.creditsApplied || 0))),
    displaySign: "subtract",
    status: STATUS.CALCULATED,
  });
  add(ctx, {
    code: "total_tax_components:projected_annual_tax",
    label: "Projected annual tax",
    section: SECTIONS.TOTAL_TAX,
    amount: value(c.liability?.projectedTotalTax),
    status: c.liability?.projectedTotalTax == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
    formulaCode: "sum_supported_tax_components_less_credits",
  });
}

function addPaymentApplications(ctx) {
  const c = ctx.c;
  const snapshot = buildPaymentSnapshot(c);
  add(ctx, {
    code: "payment_application_snapshot:projected_annual_tax",
    label: "Projected annual tax",
    section: SECTIONS.PAYMENTS,
    amount: value(c.liability?.projectedTotalTax),
    status: STATUS.CALCULATED,
  });
  add(ctx, {
    code: "payment_application_snapshot:confirmed_federal_payments",
    label: "Confirmed federal payments",
    section: SECTIONS.PAYMENTS,
    parentCode: "payment_application_snapshot:projected_annual_tax",
    amount: value(snapshot.confirmedFederalPayments),
    displaySign: "subtract",
    status: STATUS.CONFIRMED,
    sourceType: "tax_payments",
    sourceRefs: aggregatePaymentRefs(snapshot.appliedRows, { jurisdiction: "federal", component: "payments" }),
  });
  add(ctx, {
    code: "payment_application_snapshot:confirmed_state_payments",
    label: "Confirmed state payments",
    section: SECTIONS.PAYMENTS,
    parentCode: "payment_application_snapshot:projected_annual_tax",
    amount: value(snapshot.confirmedStatePayments),
    displaySign: "subtract",
    status: STATUS.CONFIRMED,
    sourceType: "tax_payments",
    sourceRefs: aggregatePaymentRefs(snapshot.appliedRows, { jurisdiction: "state", component: "payments" }),
  });
  add(ctx, {
    code: "payment_application_snapshot:confirmed_withholding",
    label: "Confirmed withholding",
    section: SECTIONS.PAYMENTS,
    parentCode: "payment_application_snapshot:projected_annual_tax",
    amount: value(snapshot.confirmedWithholding),
    displaySign: "subtract",
    status: STATUS.CONFIRMED,
    sourceType: "tax_payments",
    sourceRefs: aggregatePaymentRefs(snapshot.appliedRows, { component: "withholding" }),
  });
  add(ctx, {
    code: "payment_application_snapshot:confirmed_prior_year_credits",
    label: "Confirmed prior-year credits",
    section: SECTIONS.PAYMENTS,
    parentCode: "payment_application_snapshot:projected_annual_tax",
    amount: value(snapshot.confirmedPriorYearCredits),
    displaySign: "subtract",
    status: STATUS.CONFIRMED,
    sourceType: "tax_payments",
    sourceRefs: aggregatePaymentRefs(snapshot.appliedRows, { component: "prior_year_credit" }),
  });
  add(ctx, {
    code: "payment_application_snapshot:confirmed_ptet_entity_credits",
    label: "Confirmed PTET/entity credits",
    section: SECTIONS.PAYMENTS,
    parentCode: "payment_application_snapshot:projected_annual_tax",
    amount: value(snapshot.confirmedPtetEntityCredits),
    displaySign: "subtract",
    status: STATUS.CONFIRMED,
    sourceType: "tax_payments",
    sourceRefs: aggregatePaymentRefs(snapshot.appliedRows, { component: "ptet_entity_credit" }),
  });
  add(ctx, {
    code: "payment_application_snapshot:pending_unapplied_payments",
    label: "Pending/unapplied payments",
    section: SECTIONS.PAYMENTS,
    amount: value(snapshot.pendingUnappliedPayments),
    status: snapshot.pendingUnappliedPayments > 0 ? STATUS.EXCLUDED : STATUS.CALCULATED,
    sourceType: "tax_payments",
    sourceRefs: aggregatePaymentRefs(snapshot.unappliedRows),
    metadata: { paymentIds: snapshot.unappliedRows.map((row) => row.id).filter(Boolean) },
  });
  add(ctx, {
    code: "payment_application_snapshot:projected_overpayment",
    label: "Projected overpayment",
    section: SECTIONS.PAYMENTS,
    amount: value(c.liability?.projectedOverpayment ?? snapshot.projectedOverpayment),
    status: STATUS.CALCULATED,
  });
  add(ctx, {
    code: "payment_application_snapshot:remaining_projected_liability",
    label: "Remaining projected liability",
    section: SECTIONS.PAYMENTS,
    amount: value(c.liability?.remainingProjectedLiability ?? snapshot.remainingProjectedLiability),
    status: c.liability?.remainingProjectedLiability == null && snapshot.remainingProjectedLiability == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
    formulaCode: "projected_tax_minus_compatible_confirmed_payments_credits",
  });
  for (const payment of snapshot.rows) {
    const status = payment.confirmationStatus || "posted";
    const applied = payment.applied;
    add(ctx, {
      code: `payment_application_snapshot:${payment.id}`,
      label: paymentLineLabel(payment),
      section: SECTIONS.PAYMENTS,
      parentCode: applied ? "payment_application_snapshot:remaining_projected_liability" : "payment_application_snapshot:pending_unapplied_payments",
      amount: value(payment.amount),
      displaySign: applied ? "subtract" : null,
      status: applied ? STATUS.CONFIRMED : STATUS.EXCLUDED,
      sourceType: "tax_payments",
      sourceRefs: [{ type: "tax_payment", id: payment.id, field: "amount", value: payment.amount, date: payment.paymentDate || payment.payment_date || null }],
      metadata: {
        paymentId: payment.id,
        date: payment.paymentDate,
        jurisdiction: payment.jurisdiction,
        state: payment.state,
        paymentType: payment.paymentType,
        taxYear: payment.taxYear,
        period: payment.period,
        amount: value(payment.amount),
        source: payment.source,
        confirmationStatus: status,
        appliedComponent: payment.appliedComponent,
        appliedAmount: applied ? value(payment.appliedAmount) : null,
        unappliedReason: payment.unappliedReason,
      },
    });
  }
}

function addRemainingLiability(ctx) {
  const c = ctx.c;
  const snapshot = buildPaymentSnapshot(c);
  add(ctx, {
    code: "remaining_liability:projected_annual_tax",
    label: "Projected annual tax",
    section: SECTIONS.REMAINING,
    parentCode: "remaining_liability:remaining_projected_liability",
    amount: value(c.liability?.projectedTotalTax),
    status: STATUS.CALCULATED,
  });
  add(ctx, {
    code: "remaining_liability:confirmed_federal_payments",
    label: "Confirmed federal payments",
    section: SECTIONS.REMAINING,
    parentCode: "remaining_liability:remaining_projected_liability",
    amount: value(snapshot.confirmedFederalPayments),
    displaySign: "subtract",
    status: STATUS.CONFIRMED,
  });
  add(ctx, {
    code: "remaining_liability:confirmed_state_payments",
    label: "Confirmed state payments",
    section: SECTIONS.REMAINING,
    parentCode: "remaining_liability:remaining_projected_liability",
    amount: value(snapshot.confirmedStatePayments),
    displaySign: "subtract",
    status: STATUS.CONFIRMED,
  });
  add(ctx, {
    code: "remaining_liability:confirmed_withholding",
    label: "Withholding",
    section: SECTIONS.REMAINING,
    parentCode: "remaining_liability:remaining_projected_liability",
    amount: value(snapshot.confirmedWithholding),
    displaySign: "subtract",
    status: STATUS.CONFIRMED,
  });
  add(ctx, {
    code: "remaining_liability:confirmed_prior_year_credits",
    label: "Confirmed prior-year credits",
    section: SECTIONS.REMAINING,
    parentCode: "remaining_liability:remaining_projected_liability",
    amount: value(snapshot.confirmedPriorYearCredits),
    displaySign: "subtract",
    status: STATUS.CONFIRMED,
  });
  add(ctx, {
    code: "remaining_liability:confirmed_ptet_entity_credits",
    label: "Confirmed PTET/entity credits",
    section: SECTIONS.REMAINING,
    parentCode: "remaining_liability:remaining_projected_liability",
    amount: value(snapshot.confirmedPtetEntityCredits),
    displaySign: "subtract",
    status: STATUS.CONFIRMED,
  });
  add(ctx, {
    code: "remaining_liability:projected_overpayment",
    label: "Projected overpayment",
    section: SECTIONS.REMAINING,
    amount: value(c.liability?.projectedOverpayment ?? snapshot.projectedOverpayment),
    status: STATUS.CALCULATED,
  });
  add(ctx, {
    code: "remaining_liability:remaining_projected_liability",
    label: "Remaining projected liability",
    section: SECTIONS.REMAINING,
    amount: value(c.liability?.remainingProjectedLiability ?? snapshot.remainingProjectedLiability),
    status: c.liability?.remainingProjectedLiability == null && snapshot.remainingProjectedLiability == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
    formulaCode: "projected_annual_tax_minus_payments_withholding_credits",
  });
}

function addReserveBridge(ctx) {
  const c = ctx.c;
  const reserve = c.reserve || {};
  const reserveValues = reserve.reserve || {};
  const liability = reserve.liability || {};
  const cadence = reserve.cadence || {};
  const policy = reserve.policy || {};
  const cashFlow = reserve.cashFlow || {};
  const account = reserve.account || {};
  const targetBeforeBuffer = reserveValues.targetBeforeBuffer;
  const recommendedReserve = reserveValues.recommendedReserve ?? c.reserveInput?.recommendedReserveBeforeCashComparison;
  const nextPaymentAmount = liability.nextPaymentAmount;
  add(ctx, {
    code: "reserve_bridge:remaining_projected_liability",
    label: "Remaining projected liability",
    section: SECTIONS.RESERVE,
    amount: value(liability.remainingProjectedLiability ?? c.reserveInput?.remainingLiability),
    status: liability.remainingProjectedLiability == null && c.reserveInput?.remainingLiability == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
    explanation: "Projected annual tax remaining after compatible confirmed payments and credits. Current reserve balance does not reduce this liability.",
  });
  add(ctx, {
    code: "reserve_bridge:tax_expected_before_next_deadline",
    label: reserveLineLabel(c, "tax_expected_before_next_deadline", "Tax expected before next deadline"),
    section: SECTIONS.RESERVE,
    parentCode: "reserve_bridge:recommended_reserve",
    amount: value(nextPaymentAmount),
    status: nextPaymentAmount == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
    metadata: { nextDeadline: liability.nextPaymentDate || cadence.targetDate || null },
  });
  add(ctx, {
    code: "reserve_bridge:expected_later_year_liability",
    label: reserveLineLabel(c, "expected_later_year_liability", "Expected later-year liability"),
    section: SECTIONS.RESERVE,
    parentCode: "reserve_bridge:recommended_reserve",
    amount: value(targetBeforeBuffer == null || nextPaymentAmount == null ? null : Math.max(0, round2(Number(targetBeforeBuffer) - Number(nextPaymentAmount)))),
    status: targetBeforeBuffer == null || nextPaymentAmount == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
  });
  add(ctx, {
    code: "reserve_bridge:confirmed_scheduled_payments",
    label: reserveLineLabel(c, "confirmed_scheduled_payments", "Confirmed scheduled payments"),
    section: SECTIONS.RESERVE,
    amount: value(liability.confirmedScheduledPayments ?? reserveValues.confirmedScheduledPayments),
    displaySign: "subtract",
    status: liability.confirmedScheduledPayments == null && reserveValues.confirmedScheduledPayments == null ? STATUS.UNAVAILABLE : STATUS.CONFIRMED,
    sourceType: "tax_payments",
    sourceRefs: safeArray(liability.confirmedScheduledPaymentRefs || reserveValues.confirmedScheduledPaymentRefs),
  });
  add(ctx, {
    code: "reserve_bridge:timing_requirement",
    label: reserveLineLabel(c, "timing_requirement", "Timing requirement"),
    section: SECTIONS.RESERVE,
    amount: null,
    status: cadence.targetDate || liability.nextPaymentDate ? STATUS.CALCULATED : STATUS.UNAVAILABLE,
    metadata: {
      planningDate: reserve.meta?.asOfDate || c.meta?.asOfDate || null,
      targetDate: cadence.targetDate || null,
      nextDeadline: liability.nextPaymentDate || null,
      daysUntilNextDeadline: cadence.daysUntilNextDeadline ?? null,
      weeklySetAside: value(cadence.weeklySetAside),
      monthlySetAside: value(cadence.monthlySetAside),
    },
  });
  add(ctx, {
    code: "reserve_bridge:reserve_policy_adjustment",
    label: reserveLineLabel(c, "reserve_policy_adjustment", "Reserve policy adjustment"),
    section: SECTIONS.RESERVE,
    parentCode: "reserve_bridge:recommended_reserve",
    amount: value(targetBeforeBuffer),
    status: targetBeforeBuffer == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
    formulaCode: reserveValues.strategyUsed || policy.strategy || null,
    metadata: {
      strategyUsed: reserveValues.strategyUsed || policy.strategy || null,
      policySource: policy.source || null,
      policyVersion: policy.version || null,
    },
  });
  add(ctx, {
    code: "reserve_bridge:uncertainty_adjustment",
    label: reserveLineLabel(c, "uncertainty_adjustment", "Supported uncertainty adjustment"),
    section: SECTIONS.RESERVE,
    parentCode: "reserve_bridge:recommended_reserve",
    amount: value(reserveValues.bufferAmount),
    status: reserveValues.bufferAmount == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
    percentage: nullableNumber(reserveValues.bufferPercent),
    metadata: { bufferPercent: nullableNumber(reserveValues.bufferPercent) },
  });
  add(ctx, {
    code: "reserve_bridge:reserve_policy",
    label: reserveLineLabel(c, "reserve_policy", "Reserve policy"),
    section: SECTIONS.RESERVE,
    amount: null,
    status: reserve.policy ? STATUS.CONFIRMED : STATUS.UNAVAILABLE,
    explanation: policy.description || policy.summary || null,
    metadata: policy || {},
  });
  for (const warning of safeArray(reserve.warnings).slice(0, 6)) {
    add(ctx, {
      code: `reserve_bridge:unsupported:${warning.code || labelize(warning.message || "warning").toLowerCase().replaceAll(" ", "_")}`,
      label: warning.message || warning.code || "Reserve limitation",
      section: SECTIONS.RESERVE,
      amount: null,
      status: STATUS.REVIEW_REQUIRED,
      materiality: warning.severity || warning.materiality || "medium",
      explanation: warning.action || warning.recommendedAction || null,
      metadata: warning,
    });
  }
  add(ctx, {
    code: "reserve_bridge:recommended_reserve",
    label: reserveLineLabel(c, "recommended_reserve", "Recommended reserve"),
    section: SECTIONS.RESERVE,
    amount: value(recommendedReserve),
    status: reserveValues.recommendedReserve == null && c.reserveInput?.recommendedReserveBeforeCashComparison == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
    formulaCode: "target_before_buffer_plus_uncertainty_adjustment",
    explanation: reserveExplanation({ c, liability, reserveValues, cadence, policy }),
    metadata: {
      planningDate: reserve.meta?.asOfDate || c.meta?.asOfDate || null,
      nextDeadline: liability.nextPaymentDate || cadence.targetDate || null,
      confirmedPaymentsConsidered: value(liability.paymentsAndWithholding ?? c.liability?.paymentsAndWithholdingYtd),
      policyUsed: reserveValues.strategyUsed || policy.strategy || null,
      confidence: reserve.confidence?.score ?? reserve.confidence?.confidence ?? null,
      currentReserveSource: reserveValues.reserveSource || account.source || account.trackingMethod || null,
      reserveSnapshotId: reserve.snapshotId || null,
    },
  });
  add(ctx, {
    code: "reserve_bridge:current_reserve_balance",
    label: reserveLineLabel(c, "current_reserve_balance", "Current reserve balance"),
    section: SECTIONS.RESERVE,
    amount: value(reserveValues.currentReserve ?? c.reserveInput?.currentReserve),
    status: reserveValues.currentReserve == null && c.reserveInput?.currentReserve == null ? STATUS.UNAVAILABLE : STATUS.CONFIRMED,
    explanation: "Current reserve balance is shown for planning only and does not reduce projected tax liability.",
    metadata: {
      reserveSource: reserveValues.reserveSource || account.source || account.trackingMethod || null,
      reserveAccountId: account.id || null,
      lastVerifiedAt: reserveValues.lastVerifiedAt || null,
    },
  });
  add(ctx, {
    code: "reserve_bridge:reserve_gap",
    label: reserveLineLabel(c, "reserve_gap", "Reserve gap"),
    section: SECTIONS.RESERVE,
    amount: value(reserveValues.reserveGap ?? c.reserveInput?.reserveGap),
    status: reserveValues.reserveGap == null && c.reserveInput?.reserveGap == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
    formulaCode: "recommended_reserve_minus_current_reserve",
  });
  add(ctx, {
    code: "reserve_bridge:suggested_transfer",
    label: reserveLineLabel(c, "suggested_transfer", "Suggested transfer"),
    section: SECTIONS.RESERVE,
    amount: value(reserveValues.immediateTransferRecommended ?? cashFlow.transferAffordable),
    status: reserveValues.immediateTransferRecommended == null && cashFlow.transferAffordable == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
    metadata: {
      transferAffordable: value(cashFlow.transferAffordable),
      liquidityFloor: value(cashFlow.liquidityFloor),
      affordabilityWarning: cashFlow.affordabilityWarning || null,
    },
  });
  add(ctx, {
    code: "reserve_bridge:safe_harbor_payment_target",
    label: reserveLineLabel(c, "safe_harbor_payment_target", "Safe-harbor payment target"),
    section: SECTIONS.RESERVE,
    amount: value(liability.safeHarborGap ?? c.reserveInput?.safeHarborGap),
    status: liability.safeHarborGap == null && c.reserveInput?.safeHarborGap == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED,
  });
}

function add(ctx, line) {
  ctx.sort += 10;
  ctx.lines.push({
    sortOrder: ctx.sort,
    ...line,
  });
}

function normalizeLine(line, ctx, index) {
  return {
    business_id: ctx.businessId,
    tax_year: ctx.taxYear,
    code: line.code,
    label: line.label,
    section: line.section,
    parent_code: line.parentCode || null,
    sort_order: Number.isFinite(Number(line.sortOrder)) ? Number(line.sortOrder) : index * 10,
    amount: nullableNumber(line.amount),
    quantity: nullableNumber(line.quantity),
    percentage: nullableNumber(line.percentage),
    display_sign: line.displaySign || null,
    status: line.status || STATUS.CALCULATED,
    support_level: line.supportLevel || null,
    confidence: nullableNumber(line.confidence),
    formula_code: line.formulaCode || null,
    formula_description: line.formulaDescription || null,
    rule_refs: safeArray(line.ruleRefs),
    rule_versions: safeObject(line.ruleVersions),
    explanation: line.explanation || null,
    source_type: line.sourceType || null,
    source_refs: safeArray(line.sourceRefs),
    is_projection: line.isProjection === true,
    is_actual: line.isActual === true,
    materiality: line.materiality || materiality(line.amount),
    drill_down_type: line.drillDownType || null,
    drill_down_params: safeObject(line.drillDownParams),
    metadata: safeObject(line.metadata),
  };
}

function collectRuleVersionMap(c) {
  return {
    workpaper: TAX_WORKPAPER_VERSION,
    engines: c.meta?.engineVersions || {},
    federal: c.federal?.incomeTax?.meta?.ruleVersions || {},
    state: c.state?.incomeTax?.meta?.ruleVersions || {},
    selfEmployment: c.federal?.selfEmploymentTax?.meta?.ruleVersions || {},
    sCorporation: c.federal?.payrollTaxContext ? c.federal?.payrollTaxContext?.ruleVersions || {} : {},
    projection: {
      method: c.projection?.method || null,
      engineVersion: c.meta?.engineVersions?.projection || null,
    },
    reserve: {
      engineVersion: c.meta?.engineVersions?.reserve || null,
      policyVersion: c.reserve?.policy?.version || c.reserve?.policy?.source || null,
    },
    safeHarbor: {
      status: c.safeHarbor?.combined?.status || null,
      method: c.safeHarbor?.combined?.method || null,
    },
    deductionRules: collectDeductionRuleVersions(c),
  };
}

function collectDeductionRuleVersions(c) {
  const categories = c.actuals?.deductions?.categories || [];
  const out = {};
  for (const category of categories) {
    for (const rule of category.rules || category.topRules || []) {
      const code = rule.ruleCode || rule.rule_code || rule.code;
      const version = rule.ruleVersion || rule.rule_version || rule.version;
      if (code) out[code] = version || null;
    }
  }
  return out;
}

function collectSourceLineageSummary(c) {
  const deductions = c.actuals?.deductions || {};
  const coverage = c.actuals?.coverage || deductions.coverage || {};
  return {
    taxProfileId: c.profile?.profile?.id || null,
    taxProfileUpdatedAt: c.profile?.profile?.updated_at || c.profile?.profile?.created_at || null,
    transactionClassifications: {
      source: "transaction_tax_classifications",
      classifiedCount: coverage.classifiedTransactions ?? coverage.classifiedCount ?? null,
      confirmedCount: coverage.confirmedTransactions ?? coverage.confirmedCount ?? null,
      needsReviewCount: coverage.needsReviewTransactions ?? coverage.needsReviewCount ?? null,
    },
    taxPayments: {
      appliedPaymentIds: (c.payments?.rows || []).filter(isPaymentApplied).map((row) => row.id).filter(Boolean),
      source: c.payments?.source || null,
    },
    reserveSnapshotId: c.reserve?.snapshotId || null,
    sourceFreshness: c.meta?.sourceFreshness || {},
  };
}

function buildPaymentApplicationSummary(c) {
  const snapshot = buildPaymentSnapshot(c);
  return {
    totalApplied: value(snapshot.totalApplied),
    appliedCount: snapshot.appliedRows.length,
    appliedPaymentIds: snapshot.appliedRows.map((row) => row.id).filter(Boolean),
    unappliedPaymentIds: snapshot.unappliedRows.map((row) => row.id).filter(Boolean),
    federalPayments: value(snapshot.confirmedFederalPayments),
    statePayments: value(snapshot.confirmedStatePayments),
    withholding: value(snapshot.confirmedWithholding),
    priorYearCredits: value(snapshot.confirmedPriorYearCredits),
    ptetEntityCredits: value(snapshot.confirmedPtetEntityCredits),
    pendingUnappliedPayments: value(snapshot.pendingUnappliedPayments),
  };
}

function determineWorkpaperStatus({ lines, reconciliation }) {
  if (!lines.length) return WORKPAPER_STATUSES.UNAVAILABLE;
  if (!reconciliation.ok) return WORKPAPER_STATUSES.PARTIAL;
  if (lines.some((line) => line.status === STATUS.UNAVAILABLE || line.status === STATUS.PARTIAL)) return WORKPAPER_STATUSES.PARTIAL;
  return WORKPAPER_STATUSES.COMPLETE;
}

function buildSectionAvailability(lines) {
  const out = {};
  for (const line of lines) {
    out[line.section] ||= { status: "available", lineCount: 0, unavailableCount: 0, partialCount: 0 };
    out[line.section].lineCount += 1;
    if (line.status === STATUS.UNAVAILABLE) out[line.section].unavailableCount += 1;
    if (line.status === STATUS.PARTIAL) out[line.section].partialCount += 1;
  }
  for (const section of Object.keys(out)) {
    if (out[section].lineCount === out[section].unavailableCount) out[section].status = STATUS.UNAVAILABLE;
    else if (out[section].unavailableCount || out[section].partialCount) out[section].status = STATUS.PARTIAL;
  }
  return out;
}

function sumCheck(lines, parentCode, childCodes) {
  const parent = lineByCode(lines, parentCode);
  if (!parent || parent.amount == null) return { code: parentCode, status: "skipped", reason: "parent_unavailable" };
  const children = childCodes.map((code) => lineByCode(lines, code));
  if (children.some((line) => !line || line.amount == null)) return { code: parentCode, status: "skipped", reason: "child_unavailable" };
  const sum = round2(children.reduce((total, line) => total + Number(line.amount || 0), 0));
  return checkResult(parentCode, parent.amount, sum);
}

function formulaCheck(lines, code, formula) {
  const target = lineByCode(lines, code);
  if (!target || target.amount == null) return { code, status: "skipped", reason: "target_unavailable" };
  const get = (lineCode) => {
    const line = lineByCode(lines, lineCode);
    return line?.amount == null ? 0 : Number(line.amount);
  };
  return checkResult(code, target.amount, formula(get));
}

function throughDateCheck(lines) {
  const target = lineByCode(lines, "through_date_tax:tax_attributable_through_date");
  const direct = lineByCode(lines, "through_date_tax:directly_calculated_components");
  const allocated = lineByCode(lines, "through_date_tax:allocated_components");
  if (!target || target.amount == null) {
    return { code: "through_date_tax:tax_attributable_through_date", status: "skipped", reason: "input_unavailable" };
  }
  if (direct?.amount != null || allocated?.amount != null) {
    return checkResult("through_date_tax:tax_attributable_through_date", target.amount, Number(direct?.amount || 0) + Number(allocated?.amount || 0));
  }
  const annual = lineByCode(lines, "through_date_tax:projected_annual_tax");
  const allocation = lineByCode(lines, "through_date_tax:allocation_percentage");
  if (!annual || annual.amount == null || !allocation || allocation.percentage == null) {
    return { code: "through_date_tax:tax_attributable_through_date", status: "skipped", reason: "input_unavailable" };
  }
  return checkResult("through_date_tax:tax_attributable_through_date", target.amount, Number(annual.amount) * Number(allocation.percentage));
}

function sumDeductionCategoryCheck(lines) {
  const children = lines.filter((line) => line.parentCode === "deductions:estimated_deductible_expenses" && line.code.startsWith("deductions:category:"));
  if (!children.length) return { code: "deductions:category_children", status: "skipped", reason: "category_lines_unavailable" };
  const parent = lineByCode(lines, "deductions:estimated_deductible_expenses");
  if (!parent || parent.amount == null) return { code: "deductions:category_children", status: "skipped", reason: "parent_unavailable" };
  if (children.some((line) => line.amount == null)) return { code: "deductions:category_children", status: "skipped", reason: "child_unavailable" };
  const sum = round2(children.reduce((total, line) => total + Number(line.amount || 0), 0));
  return checkResult("deductions:category_children", parent.amount, sum);
}

function checkResult(code, actual, expected) {
  const roundedActual = round2(actual);
  const roundedExpected = round2(expected);
  const difference = round2(roundedActual - roundedExpected);
  return {
    code,
    status: Math.abs(difference) <= 0.02 ? "reconciled" : "out_of_balance",
    actual: roundedActual,
    expected: roundedExpected,
    difference,
  };
}

function lineByCode(lines, code) {
  return lines.find((line) => line.code === code);
}

function aggregateClassificationRefs(c, taxCategory, extraFilter = {}, countOverride = null) {
  const filter = {
    businessId: c.meta?.businessId,
    taxYear: c.meta?.taxYear,
    asOfDate: c.meta?.asOfDate || c.projection?.actual?.throughDate || null,
    taxCategory: taxCategory || null,
    ...extraFilter,
  };
  const query = new URLSearchParams();
  if (filter.businessId) query.set("businessId", filter.businessId);
  if (filter.taxYear) query.set("year", String(filter.taxYear));
  if (filter.asOfDate) query.set("asOfDate", filter.asOfDate);
  if (filter.taxCategory) query.set("taxCategory", filter.taxCategory);
  if (filter.treatment) query.set("treatment", filter.treatment);
  return [{
    type: "transaction_tax_classification",
    id: null,
    count: countOverride ?? c.actuals?.coverage?.classifiedTransactions ?? c.actuals?.deductions?.coverage?.classifiedCount ?? null,
    filter,
    drillDownEndpoint: `/api/tax/deductions/transactions?${query.toString()}`,
  }];
}

function deductionDrillDownParams(c, taxCategory) {
  const businessId = c.meta?.businessId || "";
  const taxYear = c.meta?.taxYear || "";
  const asOfDate = c.meta?.asOfDate || c.projection?.actual?.throughDate || "";
  const api = new URLSearchParams();
  const workspace = new URLSearchParams();
  if (businessId) {
    api.set("businessId", businessId);
    workspace.set("businessId", businessId);
  }
  if (taxYear) {
    api.set("year", String(taxYear));
    workspace.set("year", String(taxYear));
  }
  if (asOfDate) {
    api.set("asOfDate", asOfDate);
    workspace.set("asOfDate", asOfDate);
  }
  if (taxCategory) {
    api.set("taxCategory", taxCategory);
    workspace.set("taxCategory", taxCategory);
  }
  workspace.set("panel", "deductions");
  return {
    category: taxCategory || null,
    taxYear: taxYear || null,
    throughDate: asOfDate || null,
    apiEndpoint: `/api/tax/deductions/transactions?${api.toString()}`,
    workspacePath: `/dashboard/tax?${workspace.toString()}`,
    historicalRunId: c.meta?.runId || null,
    historicalSnapshotAvailable: Boolean(c.actuals?.deductions?.snapshotId || c.meta?.deductionSnapshotId),
  };
}

function primaryDeductionRule(category = {}) {
  const rules = safeArray(category.rules || category.topRules);
  const rule = rules[0];
  if (!rule) {
    const code = category.ruleCode || category.rule_code;
    return code ? { type: "tax_deduction_rule", code, label: code, version: category.ruleVersion || category.rule_version || null, supportLevel: category.supportLevel || null } : null;
  }
  const code = rule.ruleCode || rule.rule_code || rule.code || rule.value;
  if (!code) return null;
  return {
    type: "tax_deduction_rule",
    code,
    label: rule.label || code,
    version: rule.ruleVersion || rule.rule_version || rule.version || null,
    supportLevel: rule.supportLevel || rule.support_level || category.supportLevel || null,
  };
}

function confidenceNumber(value) {
  if (value == null) return null;
  if (Number.isFinite(Number(value))) {
    const n = Number(value);
    return n > 1 ? round2(n / 100) : round2(n);
  }
  const level = String(value).toLowerCase();
  if (level === "high") return 0.9;
  if (level === "medium") return 0.7;
  if (level === "low") return 0.45;
  return null;
}

function labelize(value) {
  return String(value || "")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "Uncategorized";
}

function buildPaymentSnapshot(c = {}) {
  const rows = safeArray(c.payments?.rows).map((payment) => normalizeSnapshotPayment(payment, c)).sort((a, b) =>
    String(a.paymentDate || "").localeCompare(String(b.paymentDate || "")) || String(a.id || "").localeCompare(String(b.id || ""))
  );
  const appliedRows = rows.filter((row) => row.applied);
  const unappliedRows = rows.filter((row) => !row.applied);
  const sum = (predicate) => round2(appliedRows.filter(predicate).reduce((total, row) => total + Number(row.appliedAmount || 0), 0));
  const confirmedFederalPayments = sum((row) => row.jurisdiction === "federal" && row.appliedComponent === "payments");
  const confirmedStatePayments = sum((row) => row.jurisdiction === "state" && row.appliedComponent === "payments");
  const confirmedWithholding = sum((row) => row.appliedComponent === "withholding");
  const confirmedPriorYearCredits = sum((row) => row.appliedComponent === "prior_year_credit");
  const confirmedPtetEntityCredits = sum((row) => row.appliedComponent === "ptet_entity_credit");
  const totalApplied = round2(confirmedFederalPayments + confirmedStatePayments + confirmedWithholding + confirmedPriorYearCredits + confirmedPtetEntityCredits);
  const projectedTax = value(c.liability?.projectedTotalTax) || 0;
  const remainingProjectedLiability = Math.max(0, round2(projectedTax - totalApplied));
  return {
    rows,
    appliedRows,
    unappliedRows,
    confirmedFederalPayments,
    confirmedStatePayments,
    confirmedWithholding,
    confirmedPriorYearCredits,
    confirmedPtetEntityCredits,
    totalApplied,
    pendingUnappliedPayments: round2(unappliedRows.reduce((total, row) => total + Number(row.amount || 0), 0)),
    projectedOverpayment: Math.max(0, round2(totalApplied - projectedTax)),
    remainingProjectedLiability,
  };
}

function normalizeSnapshotPayment(payment = {}, c = {}) {
  const paymentType = payment.paymentType || payment.payment_type || payment.type || null;
  const jurisdiction = String(payment.jurisdiction || (payment.stateCode || payment.state_code ? "state" : "federal") || "").toLowerCase();
  const status = String(payment.status || "posted").toLowerCase();
  const taxYear = Number(payment.taxYear || payment.tax_year || c.meta?.taxYear || 0) || null;
  const amount = value(payment.amount);
  const compatibility = paymentCompatibility({ paymentType, jurisdiction, status, taxYear, amount, payment, c });
  return {
    id: payment.id || payment.paymentId || null,
    paymentDate: payment.paymentDate || payment.payment_date || payment.paid_at || payment.date || null,
    jurisdiction,
    state: payment.stateCode || payment.state_code || null,
    paymentType,
    taxYear,
    period: payment.period || payment.taxPeriod || payment.tax_period || payment.quarter || payment.metadata?.quarter || null,
    amount,
    source: payment.source || null,
    confirmationStatus: status,
    applied: compatibility.applied,
    appliedComponent: compatibility.component,
    appliedAmount: compatibility.applied ? amount : null,
    unappliedReason: compatibility.reason,
  };
}

function paymentCompatibility({ paymentType, jurisdiction, status, taxYear, amount, payment, c }) {
  if (amount == null || amount <= 0) return { applied: false, component: null, reason: "invalid_amount" };
  if (["void", "voided", "deleted"].includes(status) || payment.voided_at) return { applied: false, component: null, reason: "voided" };
  if (!["posted", "confirmed", "active"].includes(status)) return { applied: false, component: null, reason: "not_confirmed" };
  if (taxYear && c.meta?.taxYear && Number(taxYear) !== Number(c.meta.taxYear)) return { applied: false, component: null, reason: "different_tax_year" };
  if (!["federal", "state"].includes(jurisdiction)) return { applied: false, component: null, reason: "unsupported_jurisdiction" };
  if ([TAX_PAYMENT_TYPES.ESTIMATED_PAYMENT, TAX_PAYMENT_TYPES.EXTENSION_PAYMENT, TAX_PAYMENT_TYPES.BALANCE_DUE].includes(paymentType)) {
    return { applied: true, component: "payments", reason: null };
  }
  if (paymentType === TAX_PAYMENT_TYPES.WITHHOLDING) return { applied: true, component: "withholding", reason: null };
  if ([TAX_PAYMENT_TYPES.PRIOR_YEAR_CREDIT, TAX_PAYMENT_TYPES.REFUND_APPLIED].includes(paymentType)) {
    return { applied: true, component: "prior_year_credit", reason: null };
  }
  if ([TAX_PAYMENT_TYPES.PTET_PAYMENT, TAX_PAYMENT_TYPES.ENTITY_TAX_PAYMENT].includes(paymentType)) {
    const metadata = payment.metadata || {};
    const creditable = metadata.applyToProjectedLiability === true || metadata.ownerCredit === true || metadata.appliedComponent === "ptet_entity_credit";
    return creditable
      ? { applied: true, component: "ptet_entity_credit", reason: null }
      : { applied: false, component: "ptet_entity_credit", reason: "entity_payment_not_confirmed_as_owner_credit" };
  }
  return { applied: false, component: null, reason: "unsupported_payment_type" };
}

function isPaymentApplied(payment = {}) {
  return paymentCompatibility({
    paymentType: payment.paymentType || payment.payment_type || payment.type || null,
    jurisdiction: String(payment.jurisdiction || (payment.stateCode || payment.state_code ? "state" : "federal") || "").toLowerCase(),
    status: String(payment.status || "posted").toLowerCase(),
    taxYear: Number(payment.taxYear || payment.tax_year || 0) || null,
    amount: value(payment.amount),
    payment,
    c: { meta: { taxYear: payment.taxYear || payment.tax_year || null } },
  }).applied;
}

function aggregatePaymentRefs(rows = [], filter = {}) {
  const filtered = rows.filter((row) =>
    (!filter.jurisdiction || row.jurisdiction === filter.jurisdiction) &&
    (!filter.component || row.appliedComponent === filter.component)
  );
  return filtered.length ? [{
    type: "tax_payment",
    count: filtered.length,
    ids: filtered.map((row) => row.id).filter(Boolean),
  }] : [];
}

function paymentLineLabel(payment = {}) {
  const parts = [
    payment.jurisdiction === "state" ? payment.state || "State" : "Federal",
    labelize(payment.paymentType || "payment"),
    payment.period ? String(payment.period).toUpperCase() : null,
  ].filter(Boolean);
  return parts.join(" ");
}

function reserveLineLabel(c = {}, code, fallback) {
  const lines = safeArray(c.reserve?.lines || c.reserve?.components);
  const found = lines.find((row) =>
    row.code === code ||
    row.componentType === code ||
    row.component_type === code ||
    row.type === code
  );
  return found?.label || found?.name || fallback;
}

function reserveExplanation({ c, liability, reserveValues, cadence, policy }) {
  const parts = [];
  const annual = value(c.liability?.projectedTotalTax);
  const remaining = value(liability.remainingProjectedLiability ?? c.reserveInput?.remainingLiability);
  if (annual != null && remaining != null) {
    parts.push(`Recommended reserve differs from projected annual tax because it starts with remaining projected liability of ${annual === remaining ? "the full projected amount" : formatLedgerMoney(remaining)} after compatible confirmed payments and credits.`);
  }
  const planningDate = c.reserve?.meta?.asOfDate || c.meta?.asOfDate;
  const deadline = liability.nextPaymentDate || cadence.targetDate;
  if (planningDate || deadline) {
    parts.push(`Reserve planning date${planningDate ? ` is ${planningDate}` : ""}${deadline ? ` with next target deadline ${deadline}` : ""}.`);
  }
  const policyUsed = reserveValues.strategyUsed || policy.strategy;
  if (policyUsed) parts.push(`Reserve policy: ${labelize(policyUsed)}.`);
  if (reserveValues.reserveSource) parts.push(`Current reserve source: ${labelize(reserveValues.reserveSource)}.`);
  return parts.join(" ");
}

function formatLedgerMoney(amount) {
  if (amount == null || !Number.isFinite(Number(amount))) return "not available";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(amount));
}

function stateStatus(individual) {
  if (!individual) return STATUS.UNAVAILABLE;
  if (individual.status === "verified_zero") return STATUS.CALCULATED;
  if (individual.status === "unavailable") return STATUS.UNAVAILABLE;
  if (individual.status === "partial") return STATUS.PARTIAL;
  return individual.amount == null ? STATUS.UNAVAILABLE : STATUS.CALCULATED;
}

function sumCategoryField(categories = [], field) {
  const value = (categories || []).reduce((sum, row) => sum + Number(row?.[field] || 0), 0);
  return value || null;
}

function boundedMonthly(monthly) {
  if (!monthly || typeof monthly !== "object") return null;
  return Object.fromEntries(Object.entries(monthly).slice(0, 12));
}

function materiality(amount) {
  const n = Math.abs(Number(amount || 0));
  if (amount == null) return null;
  if (n >= 10000) return "high";
  if (n >= 1000) return "medium";
  return "low";
}

function value(input) {
  return nullableNumber(input);
}

function sumAmounts(components) {
  const amounts = safeArray(components).map((row) => nullableNumber(row?.amount)).filter((amount) => amount != null);
  if (!amounts.length) return null;
  return round2(amounts.reduce((total, amount) => total + amount, 0));
}

function nullableNumber(input) {
  if (input == null || input === "" || !Number.isFinite(Number(input))) return null;
  return round2(Number(input));
}

function round2(input) {
  return Math.round((Number(input || 0) + Number.EPSILON) * 100) / 100;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
