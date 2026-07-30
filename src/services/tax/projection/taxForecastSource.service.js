// /src/services/tax/projection/taxForecastSource.service.js
import { getTaxProfile } from "../taxProfile.service.js";
import { PROJECTION_WARNING_CODES, projectionWarning, round2 } from "./taxProjectionDomain.js";
import { buildProjectionContext, monthKey, monthsForYear } from "./taxProjectionUtils.js";

export async function getTaxProjectionForecastInputs({
  supabase,
  businessId,
  taxYear,
  asOfDate,
} = {}) {
  const context = buildProjectionContext({ supabase, businessId, taxYear, asOfDate });
  const profile = await getTaxProfile({ supabase, businessId, taxYear: context.taxYear, includeBusinessDefaults: false }).catch(() => null);
  const accountingMethod = profile?.accounting_method || "cash";
  const warnings = [];
  const monthlyForecast = {};
  const actualMonth = monthKey(context.asOfDate);
  const rows = [
    ...await fetchForecastRows({ supabase, table: "cashflow_forecast", businessId, taxYear: context.taxYear }),
    ...await fetchForecastRows({ supabase, table: "monthly_forecast", businessId, taxYear: context.taxYear }),
  ];
  let overlapWithActuals = 0;
  let latestUpdatedAt = null;

  for (const row of rows) {
    const month = forecastMonth(row);
    if (!month || !month.startsWith(`${context.taxYear}-`)) continue;
    if (month < actualMonth) {
      overlapWithActuals += 1;
      continue;
    }
    latestUpdatedAt = maxIso(latestUpdatedAt, row.updated_at || row.created_at || row.generated_at || null);
    const normalized = normalizeForecastRow(row);
    monthlyForecast[month] = {
      revenue: round2(Number(monthlyForecast[month]?.revenue || 0) + normalized.revenue),
      cogs: round2(Number(monthlyForecast[month]?.cogs || 0) + normalized.cogs),
      deductibleExpenses: round2(Number(monthlyForecast[month]?.deductibleExpenses || 0) + normalized.deductibleExpenses),
      taxableBusinessIncome: round2(Number(monthlyForecast[month]?.taxableBusinessIncome || 0) + normalized.taxableBusinessIncome),
      source: row.source || "cashflow_forecast",
    };
  }

  if (overlapWithActuals > 0) {
    warnings.push(projectionWarning(PROJECTION_WARNING_CODES.FORECAST_ACTUAL_OVERLAP, "low", "Forecast rows overlapped completed actual periods; actuals win.", { overlapWithActuals }));
  }
  if (accountingMethod === "accrual") {
    warnings.push(projectionWarning(PROJECTION_WARNING_CODES.STALE_FORECAST, "medium", "Cashflow forecast rows may not match accrual taxable revenue timing."));
  }
  const futureMonths = monthsForYear(context.taxYear).filter((month) => month >= actualMonth);
  const missing = futureMonths.filter((month) => !monthlyForecast[month]);
  if (missing.length) warnings.push(projectionWarning(PROJECTION_WARNING_CODES.MISSING_FUTURE_MONTHS, "low", "Forecast source does not cover every remaining month.", { missingMonths: missing }));

  return {
    monthlyForecast,
    sourceFreshness: latestUpdatedAt ? { latestUpdatedAt } : { latestUpdatedAt: null },
    confidence: Object.keys(monthlyForecast).length >= Math.max(1, futureMonths.length - 1) ? "medium" : "low",
    overlapWithActuals,
    warnings,
    accountingMethod,
  };
}

async function fetchForecastRows({ supabase, table, businessId, taxYear }) {
  try {
    const { data, error } = await supabase.from(table).select("*").eq("business_id", businessId);
    if (error) return [];
    return (data || []).filter((row) => {
      const month = forecastMonth(row);
      return month?.startsWith(`${taxYear}-`);
    });
  } catch {
    return [];
  }
}

function forecastMonth(row) {
  return String(row.month || row.period || row.forecast_month || row.date || row.as_of || row.as_of_date || "").slice(0, 7);
}

function normalizeForecastRow(row) {
  const revenue = number(row.revenue ?? row.projected_revenue ?? row.forecastRevenue ?? row.total_revenue ?? row.cash_in ?? row.inflows);
  const expenses = number(row.expenses ?? row.projected_expenses ?? row.forecastExpenses ?? row.total_expenses ?? row.cash_out ?? row.outflows);
  const cogs = number(row.cogs ?? row.projected_cogs ?? row.cost_of_goods_sold);
  const deductibleExpenses = number(row.deductible_expenses ?? row.deductibleExpenses ?? Math.max(0, expenses - cogs));
  const explicitTaxable = row.taxable_business_income ?? row.taxableBusinessIncome ?? row.net_profit ?? row.projected_profit ?? row.net_cash;
  const taxableBusinessIncome = explicitTaxable == null ? revenue - cogs - deductibleExpenses : number(explicitTaxable);
  return {
    revenue: round2(revenue),
    cogs: round2(cogs),
    deductibleExpenses: round2(deductibleExpenses),
    taxableBusinessIncome: round2(taxableBusinessIncome),
  };
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function maxIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return String(a) > String(b) ? a : b;
}
