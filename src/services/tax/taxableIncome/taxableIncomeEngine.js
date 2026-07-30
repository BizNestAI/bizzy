// /src/services/tax/taxableIncome/taxableIncomeEngine.js
import { TAX_ADJUSTMENT_DIRECTIONS, TAX_ENTITY_TYPES, normalizeDateOnly, normalizeTaxYear } from "../taxDomain.js";
import { validationError } from "../taxErrors.js";
import { TAXABLE_INCOME_ENGINE_VERSION } from "../taxEngineVersions.js";
import { countPostedTransactionsForTax } from "../taxPostedTransaction.repository.js";
import { getTaxProfile, computeTaxProfileCompleteness } from "../taxProfile.service.js";
import { getActiveTaxMemories } from "../taxProfileMemory.service.js";
import { listTaxAdjustments, summarizeAdjustmentRows } from "../taxAdjustment.service.js";
import { getTaxRevenueSummary } from "./taxRevenueSource.service.js";
import { getTaxExpenseSummary } from "./taxExpenseSource.service.js";
import { computeTaxableIncomeConfidence, taxableIncomeRange } from "./taxableIncomeConfidence.js";
import {
  TAXABLE_INCOME_COMPONENT_TYPES,
  TAXABLE_INCOME_SOURCES,
  TAXABLE_INCOME_WARNING_CODES,
  round2,
  taxableWarning,
} from "./taxableIncomeDomain.js";
import { fetchAllClassifications, percent } from "./taxableIncomeSourceUtils.js";

export async function computeTaxableIncome({
  supabase,
  businessId,
  taxYear,
  year,
  asOfDate,
  calculationType = "ytd_actual",
  includeForecast = false,
  projectionContext = null,
  manualOverrides = null,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const normalizedYear = normalizeTaxYear(taxYear ?? year);
  if (!normalizedYear) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "year" });
  const cutoff = normalizeDateOnly(asOfDate) || `${normalizedYear}-12-31`;

  const [profile, memories, revenue, expenses, adjustmentRows, coverage] = await Promise.all([
    getTaxProfile({ supabase, businessId, taxYear: normalizedYear, includeBusinessDefaults: false }),
    safeMemories({ supabase, businessId, asOfDate: cutoff }),
    getTaxRevenueSummary({ supabase, businessId, taxYear: normalizedYear, asOfDate: cutoff, includeForecast }),
    getTaxExpenseSummary({ supabase, businessId, taxYear: normalizedYear, asOfDate: cutoff }),
    listTaxAdjustments({ supabase, businessId, taxYear: normalizedYear, asOfDate: cutoff }),
    computeCoverage({ supabase, businessId, taxYear: normalizedYear }),
  ]);
  const profileCompleteness = computeTaxProfileCompleteness(profile);
  const accountingMethod = profile?.accounting_method || "cash";
  const adjustments = summarizeAdjustmentRows([...adjustmentRows, ...normalizeManualOverrides(manualOverrides)]);
  const warnings = [
    ...profileCompleteness.warnings.map((warning) => ({ ...warning, code: TAXABLE_INCOME_WARNING_CODES.INCOMPLETE_TAX_PROFILE })),
    ...revenue.warnings,
    ...expenses.warnings,
  ];
  if (!profile) warnings.push(taxableWarning(TAXABLE_INCOME_WARNING_CODES.INCOMPLETE_TAX_PROFILE, "high", "Tax profile is missing."));
  if ([TAX_ENTITY_TYPES.S_CORP].includes(profile?.entity_type)) {
    warnings.push(taxableWarning(TAXABLE_INCOME_WARNING_CODES.UNSUPPORTED_ENTITY, "medium", "S-Corp entity-specific tax logic is not applied in the taxable-income engine."));
  }
  if (projectionContext && !includeForecast) {
    warnings.push(taxableWarning(TAXABLE_INCOME_WARNING_CODES.FUTURE_DATA_EXCLUDED, "low", "Projection context was ignored because includeForecast is false."));
  }

  const netBusinessRevenue = revenue.netBusinessRevenue;
  const grossProfit = round2(netBusinessRevenue - expenses.costOfGoodsSold);
  const beforeAdjustments = round2(grossProfit - expenses.deductibleOperatingExpenses);
  const confirmedBeforeAdjustments = round2(netBusinessRevenue - expenses.confirmedDeductibleExpenses);
  const afterBookTaxAdjustments = round2(
    beforeAdjustments +
    adjustments.increasesToTaxableIncome -
    adjustments.decreasesToTaxableIncome
  );
  const confirmedAfterAdjustments = round2(
    confirmedBeforeAdjustments +
    adjustments.increasesToTaxableIncome -
    adjustments.decreasesToTaxableIncome
  );

  if (afterBookTaxAdjustments < 0) {
    warnings.push(taxableWarning(TAXABLE_INCOME_WARNING_CODES.NEGATIVE_INCOME, "low", "Taxable business income is negative; later tax engines will determine loss treatment."));
  }

  const monthly = buildMonthly({ taxYear: normalizedYear, revenue, expenses });
  const confidence = computeTaxableIncomeConfidence({ profileCompleteness, coverage, revenue, expenses, warnings, adjustments });
  const range = taxableIncomeRange({
    currentEstimate: afterBookTaxAdjustments,
    confirmedEstimate: confirmedAfterAdjustments,
    needsReviewAmount: expenses.needsReviewAmount,
  });

  return {
    meta: {
      businessId,
      taxYear: normalizedYear,
      asOfDate: cutoff,
      calculationType,
      engineVersion: TAXABLE_INCOME_ENGINE_VERSION,
      generatedAt: new Date().toISOString(),
      sourceFreshness: {
        transactionClassifications: coverage.classifiedTransactions ? "available" : "missing",
        taxProfile: profile ? profile.updated_at || profile.created_at || null : null,
        taxMemory: memories.length ? "available" : "none",
      },
    },
    profile: {
      entityType: profile?.entity_type || "unknown",
      taxElection: profile?.tax_election || "unknown",
      filingStatus: profile?.filing_status || "unknown",
      accountingMethod,
      primaryTaxState: profile?.primary_tax_state || null,
      profileStatus: profile?.profile_status || "missing",
      completeness: profileCompleteness,
    },
    revenue: {
      grossReceipts: revenue.grossReceipts,
      otherBusinessIncome: revenue.otherBusinessIncome,
      returnsAndAllowances: revenue.returnsAndAllowances,
      netBusinessRevenue,
    },
    expenses: {
      costOfGoodsSold: expenses.costOfGoodsSold,
      grossProfit,
      deductibleOperatingExpenses: expenses.deductibleOperatingExpenses,
      estimatedDeductibleOperatingExpenses: expenses.deductibleOperatingExpenses,
      confirmedDeductibleOperatingExpenses: expenses.confirmedDeductibleExpenses,
      nondeductibleBookExpenses: expenses.nondeductibleBookExpenses,
      capitalizableExpenditures: expenses.capitalizableExpenditures,
      needsReviewAmount: expenses.needsReviewAmount,
    },
    adjustments,
    businessTaxableIncome: {
      beforeAdjustments,
      afterBookTaxAdjustments,
      beforeEntitySpecificAdjustments: afterBookTaxAdjustments,
      finalBusinessTaxableIncome: afterBookTaxAdjustments,
      estimatedBusinessTaxableIncome: afterBookTaxAdjustments,
      confirmedBusinessTaxableIncome: confirmedAfterAdjustments,
      taxableIncomeRange: range,
    },
    monthly,
    coverage,
    confidence,
    warnings,
    assumptions: [
      "Federal income tax, state tax, self-employment tax, QBI, standard deduction, and safe harbor calculations are intentionally excluded from this engine.",
      "Needs-review classifications do not reduce confirmed taxable income.",
    ],
    components: buildComponents({ revenue, expenses, adjustments, finalBusinessTaxableIncome: afterBookTaxAdjustments }),
  };
}

async function safeMemories({ supabase, businessId, asOfDate }) {
  try {
    return await getActiveTaxMemories({ supabase, businessId, asOfDate });
  } catch {
    return [];
  }
}

async function computeCoverage({ supabase, businessId, taxYear }) {
  const rows = await fetchAllClassifications({ supabase, businessId, taxYear });
  let postedTransactions = 0;
  try {
    postedTransactions = await countPostedTransactionsForTax({ supabase, businessId, taxYear });
  } catch {
    postedTransactions = rows.length;
  }
  const classifiedTransactions = rows.filter((row) => row.classification_status !== "excluded").length;
  const confirmedTransactions = rows.filter((row) => ["user_confirmed", "cpa_confirmed"].includes(row.classification_status)).length;
  const needsReviewTransactions = rows.filter((row) => row.classification_status === "needs_review" || row.requires_review === true).length;
  return {
    postedTransactions,
    classifiedTransactions,
    confirmedTransactions,
    needsReviewTransactions,
    classificationCoveragePercent: percent(classifiedTransactions, postedTransactions),
    confirmedCoveragePercent: percent(confirmedTransactions, postedTransactions),
    revenueCoverageStatus: classifiedTransactions ? "available" : "missing",
    expenseCoverageStatus: classifiedTransactions ? "available" : "missing",
  };
}

function buildMonthly({ taxYear, revenue, expenses }) {
  const months = Array.from({ length: 12 }, (_, i) => `${taxYear}-${String(i + 1).padStart(2, "0")}`);
  return Object.fromEntries(months.map((month) => {
    const rev = revenue.monthly?.[month] || {};
    const exp = expenses.monthly?.[month] || {};
    const taxableBusinessIncome = round2(
      Number(rev.netBusinessRevenue || 0) -
      Number(exp.costOfGoodsSold || 0) -
      Number(exp.deductibleOperatingExpenses || 0)
    );
    return [month, {
      revenue: Number(rev.netBusinessRevenue || 0),
      cogs: Number(exp.costOfGoodsSold || 0),
      deductibleExpenses: Number(exp.deductibleOperatingExpenses || 0),
      nondeductibleExpenses: Number(exp.nondeductibleBookExpenses || 0),
      capitalizableAmount: Number(exp.capitalizableExpenditures || 0),
      taxableBusinessIncome,
    }];
  }));
}

function buildComponents({ revenue, expenses, adjustments, finalBusinessTaxableIncome }) {
  return [
    component(TAXABLE_INCOME_COMPONENT_TYPES.GROSS_RECEIPTS, revenue.grossReceipts, TAXABLE_INCOME_SOURCES.TRANSACTION_CLASSIFICATIONS),
    component(TAXABLE_INCOME_COMPONENT_TYPES.OTHER_BUSINESS_INCOME, revenue.otherBusinessIncome, TAXABLE_INCOME_SOURCES.TRANSACTION_CLASSIFICATIONS),
    component(TAXABLE_INCOME_COMPONENT_TYPES.RETURNS_ALLOWANCES, -revenue.returnsAndAllowances, TAXABLE_INCOME_SOURCES.TRANSACTION_CLASSIFICATIONS),
    component(TAXABLE_INCOME_COMPONENT_TYPES.COST_OF_GOODS_SOLD, -expenses.costOfGoodsSold, TAXABLE_INCOME_SOURCES.TRANSACTION_CLASSIFICATIONS),
    component(TAXABLE_INCOME_COMPONENT_TYPES.DEDUCTIBLE_OPERATING_EXPENSES, -expenses.deductibleOperatingExpenses, TAXABLE_INCOME_SOURCES.TRANSACTION_CLASSIFICATIONS),
    component(TAXABLE_INCOME_COMPONENT_TYPES.NONDEDUCTIBLE_BOOK_EXPENSES, 0, TAXABLE_INCOME_SOURCES.TRANSACTION_CLASSIFICATIONS, { bookAmount: expenses.nondeductibleBookExpenses }),
    component(TAXABLE_INCOME_COMPONENT_TYPES.CAPITALIZABLE_EXPENDITURES, 0, TAXABLE_INCOME_SOURCES.TRANSACTION_CLASSIFICATIONS, { bookAmount: expenses.capitalizableExpenditures }),
    component(TAXABLE_INCOME_COMPONENT_TYPES.TAX_ADJUSTMENT, adjustments.increasesToTaxableIncome - adjustments.decreasesToTaxableIncome, TAXABLE_INCOME_SOURCES.TAX_ADJUSTMENTS),
    component(TAXABLE_INCOME_COMPONENT_TYPES.TAXABLE_BUSINESS_INCOME, finalBusinessTaxableIncome, TAXABLE_INCOME_SOURCES.SYSTEM),
  ];
}

function component(componentType, amount, source, extra = {}) {
  return { componentType, amount: round2(amount), source, ...extra };
}

function normalizeManualOverrides(manualOverrides) {
  if (!manualOverrides) return [];
  const rows = Array.isArray(manualOverrides) ? manualOverrides : manualOverrides.items || [];
  return rows.map((row, index) => ({
    id: row.id || `manual-${index}`,
    adjustment_type: row.adjustmentType || row.adjustment_type || "manual_override",
    direction: row.direction || TAX_ADJUSTMENT_DIRECTIONS.INCREASE_TAXABLE_INCOME,
    amount: Math.abs(Number(row.amount || 0)),
    reason: row.reason || "Manual override supplied for this taxable-income run.",
    source: "manual_override",
  }));
}
