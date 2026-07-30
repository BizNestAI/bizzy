// /src/services/tax/projection/taxHistoricalPattern.service.js
import { computeTaxableIncome } from "../taxableIncome/taxableIncomeEngine.js";
import { PROJECTION_WARNING_CODES, projectionWarning, round2 } from "./taxProjectionDomain.js";
import { actualProjectionComponents, buildProjectionContext, monthsForYear } from "./taxProjectionUtils.js";

export async function getHistoricalTaxPatterns({
  supabase,
  businessId,
  taxYear,
  lookbackYears = 3,
  asOfDate,
} = {}) {
  const context = buildProjectionContext({ supabase, businessId, taxYear, asOfDate });
  const years = [];
  const warnings = [];
  const monthlyByComparableYear = {};

  for (let year = context.taxYear - 1; year >= context.taxYear - Math.max(1, lookbackYears); year -= 1) {
    const result = await safeTaxableIncome({ supabase, businessId, taxYear: year });
    if (!result) continue;
    const annual = annualFromMonthly(result.monthly || {});
    const activeMonths = Object.values(result.monthly || {}).filter((row) => Math.abs(Number(row.revenue || 0)) + Math.abs(Number(row.cogs || 0)) + Math.abs(Number(row.deductibleExpenses || 0)) > 0).length;
    if (activeMonths < 3) {
      warnings.push(projectionWarning(PROJECTION_WARNING_CODES.INSUFFICIENT_HISTORY, "low", "A prior year had too little completed taxable-income history and was excluded.", { year }));
      continue;
    }
    years.push({ year, annual, activeMonths, monthly: result.monthly || {} });
    monthlyByComparableYear[year] = result.monthly || {};
  }

  if (!years.length) warnings.push(projectionWarning(PROJECTION_WARNING_CODES.INSUFFICIENT_HISTORY, "medium", "No usable prior-year taxable-income history is available."));

  const seasonalityIndices = buildSeasonalityIndices(years, context.taxYear);
  const trailingAverages = buildTrailingAverages({ years, taxYear: context.taxYear, asOfDate: context.asOfDate });
  const volatility = buildVolatility(years);

  return {
    yearsAvailable: years.map((row) => row.year),
    monthlyRevenuePatterns: componentPattern(years, "revenue", context.taxYear),
    monthlyCogsPatterns: componentPattern(years, "cogs", context.taxYear),
    monthlyExpensePatterns: componentPattern(years, "deductibleExpenses", context.taxYear),
    monthlyTaxableIncomePatterns: componentPattern(years, "taxableBusinessIncome", context.taxYear),
    seasonalityIndices,
    trailingAverages,
    volatility,
    sourceQuality: years.length >= 2 ? "medium" : years.length === 1 ? "low" : "unavailable",
    warnings,
    monthlyByComparableYear,
  };
}

async function safeTaxableIncome({ supabase, businessId, taxYear }) {
  try {
    return await computeTaxableIncome({ supabase, businessId, taxYear, asOfDate: `${taxYear}-12-31` });
  } catch {
    return null;
  }
}

function annualFromMonthly(monthly) {
  return Object.values(monthly || {}).reduce((sum, row) => {
    const c = actualProjectionComponents(row);
    return {
      revenue: round2(sum.revenue + c.revenue),
      cogs: round2(sum.cogs + c.cogs),
      deductibleExpenses: round2(sum.deductibleExpenses + c.deductibleExpenses),
      taxableBusinessIncome: round2(sum.taxableBusinessIncome + c.taxableBusinessIncome),
    };
  }, { revenue: 0, cogs: 0, deductibleExpenses: 0, taxableBusinessIncome: 0 });
}

function buildSeasonalityIndices(years, targetYear) {
  const months = monthsForYear(targetYear);
  const result = {};
  for (const component of ["revenue", "cogs", "deductibleExpenses", "taxableBusinessIncome"]) {
    result[component] = {};
    for (let i = 0; i < 12; i += 1) {
      const ratios = years.map((year) => {
        const month = `${year.year}-${String(i + 1).padStart(2, "0")}`;
        const annual = Number(year.annual[component] || 0);
        if (!annual) return null;
        return Number(actualProjectionComponents(year.monthly[month] || {})[component] || 0) / annual;
      }).filter((n) => Number.isFinite(n));
      result[component][months[i]] = ratios.length ? round2((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 12) : 1;
    }
  }
  return result;
}

function componentPattern(years, component, targetYear) {
  const months = monthsForYear(targetYear);
  return Object.fromEntries(months.map((targetMonth, i) => {
    const values = years.map((year) => {
      const sourceMonth = `${year.year}-${String(i + 1).padStart(2, "0")}`;
      return Number(actualProjectionComponents(year.monthly[sourceMonth] || {})[component] || 0);
    });
    return [targetMonth, { average: avg(values), values }];
  }));
}

function buildTrailingAverages({ years, taxYear, asOfDate }) {
  const currentYearMonths = monthsForYear(taxYear).filter((month) => month <= asOfDate.slice(0, 7));
  const lastCompleted = currentYearMonths.slice(-6);
  const output = {};
  for (const size of [3, 6]) {
    const selected = lastCompleted.slice(-size);
    output[`trailing_${size}_month`] = {};
    for (const component of ["revenue", "cogs", "deductibleExpenses", "taxableBusinessIncome"]) {
      const values = [];
      for (const source of years) {
        for (const month of selected) {
          const sourceMonth = `${source.year}-${month.slice(5, 7)}`;
          values.push(Number(actualProjectionComponents(source.monthly[sourceMonth] || {})[component] || 0));
        }
      }
      output[`trailing_${size}_month`][component] = avg(values);
    }
  }
  return output;
}

function buildVolatility(years) {
  const values = years.map((year) => year.annual.taxableBusinessIncome);
  const mean = avg(values);
  const variance = values.length > 1 ? values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length : 0;
  const stddev = Math.sqrt(variance);
  return {
    taxableIncomeStdDev: round2(stddev),
    taxableIncomeCoefficient: mean ? round2(Math.abs(stddev / mean)) : 0,
    level: stddev > Math.abs(mean) * 0.3 ? "high" : stddev > Math.abs(mean) * 0.15 ? "medium" : values.length ? "low" : "unavailable",
  };
}

function avg(values) {
  const usable = values.filter((n) => Number.isFinite(n));
  return usable.length ? round2(usable.reduce((a, b) => a + b, 0) / usable.length) : 0;
}
