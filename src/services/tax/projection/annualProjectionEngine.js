// /src/services/tax/projection/annualProjectionEngine.js
import { computeTaxableIncome } from "../taxableIncome/taxableIncomeEngine.js";
import { TAX_PROJECTION_ENGINE_VERSION } from "../taxEngineVersions.js";
import { validationError } from "../taxErrors.js";
import { getHistoricalTaxPatterns } from "./taxHistoricalPattern.service.js";
import { getTaxProjectionForecastInputs } from "./taxForecastSource.service.js";
import { computeTaxProjectionConfidence } from "./taxProjectionConfidence.js";
import {
  PROJECTION_METHODS,
  PROJECTION_SCENARIOS,
  PROJECTION_WARNING_CODES,
  ProjectionMethodSet,
  ProjectionScenarioSet,
  projectionWarning,
  round2,
} from "./taxProjectionDomain.js";
import {
  actualProjectionComponents,
  addRows,
  buildProjectionContext,
  completedMonths,
  daysInMonthKey,
  dayOfMonth,
  emptyComponentRow,
  isPartialCurrentMonth,
  mergeActualAndProjectedMonths,
  monthKey,
  monthsForYear,
  scaleRow,
  sumMonthly,
  validateManualOverrides,
} from "./taxProjectionUtils.js";

export async function projectAnnualTaxableIncome({
  supabase,
  businessId,
  taxYear,
  year,
  asOfDate,
  method = PROJECTION_METHODS.BLENDED,
  scenario = PROJECTION_SCENARIOS.BASE,
  manualOverrides = null,
  includeOptionalSources = true,
} = {}) {
  const context = buildProjectionContext({ supabase, businessId, taxYear: taxYear ?? year, asOfDate });
  const normalizedMethod = normalizeMethod(method);
  const normalizedScenario = normalizeScenario(scenario);
  const overrides = validateManualOverrides(manualOverrides, context.taxYear);

  const [actualResult, historicalPatterns, forecastInputs] = await Promise.all([
    computeTaxableIncome({ supabase, businessId, taxYear: context.taxYear, asOfDate: context.asOfDate }),
    includeOptionalSources ? getHistoricalTaxPatterns({ supabase, businessId, taxYear: context.taxYear, asOfDate: context.asOfDate }) : emptyPatterns(),
    includeOptionalSources ? getTaxProjectionForecastInputs({ supabase, businessId, taxYear: context.taxYear, asOfDate: context.asOfDate }) : emptyForecast(),
  ]);
  const actualMonthly = normalizeActualMonthly(actualResult.monthly || {});
  const warnings = [...actualResult.warnings, ...historicalPatterns.warnings, ...forecastInputs.warnings].map(normalizeWarning);
  const actual = buildActualSummary({ actualResult, actualMonthly, taxYear: context.taxYear, asOfDate: context.asOfDate });

  const methodProjections = buildMethodProjections({
    method: normalizedMethod,
    actual,
    actualMonthly,
    historicalPatterns,
    forecastInputs,
    taxYear: context.taxYear,
    asOfDate: context.asOfDate,
    warnings,
  });
  let selected = selectProjection({ normalizedMethod, methodProjections, actual, actualMonthly, taxYear: context.taxYear, asOfDate: context.asOfDate, warnings });
  const originalProjection = cloneProjection(selected);

  if (overrides) {
    selected = applyManualOverrides({ selected, overrides, taxYear: context.taxYear, warnings });
  }

  const scenarios = buildScenarios({ baseProjection: selected, actualResult, historicalPatterns });
  const scenarioProjection = scenarios[scenarioKey(normalizedScenario)] || scenarios.base;
  const confidence = computeTaxProjectionConfidence({
    actual,
    historicalPatterns,
    forecastInputs,
    taxableIncome: actualResult,
    warnings,
    method: normalizedMethod,
    manualOverrides: overrides,
  });

  const scenarioIncomeValues = [
    scenarios.lower_income_case.projectedAnnual.taxableBusinessIncome,
    scenarios.base_case.projectedAnnual.taxableBusinessIncome,
    scenarios.higher_income_case.projectedAnnual.taxableBusinessIncome,
  ];
  const range = {
    taxableIncomeLow: Math.min(...scenarioIncomeValues),
    taxableIncomeBase: scenarios.base_case.projectedAnnual.taxableBusinessIncome,
    taxableIncomeHigh: Math.max(...scenarioIncomeValues),
  };

  if (scenarioProjection.projectedAnnual.taxableBusinessIncome < 0) {
    warnings.push(projectionWarning(PROJECTION_WARNING_CODES.NEGATIVE_PROJECTION, "low", "Projected taxable business income is negative; later tax engines will determine loss treatment."));
  }
  if (confidence.score < 60 && normalizedMethod !== PROJECTION_METHODS.ACTUAL_ONLY) {
    warnings.push(projectionWarning(PROJECTION_WARNING_CODES.INSUFFICIENT_HISTORY, "medium", "Projection source data is weak; range and confidence were adjusted."));
  }

  return {
    meta: {
      businessId,
      taxYear: context.taxYear,
      asOfDate: context.asOfDate,
      method: normalizedMethod,
      scenario: normalizedScenario,
      engineVersion: TAX_PROJECTION_ENGINE_VERSION,
      generatedAt: new Date().toISOString(),
    },
    actual,
    projectedFuture: scenarioProjection.projectedFuture,
    projectedAnnual: scenarioProjection.projectedAnnual,
    scenarios,
    range,
    methodology: {
      primaryMethod: normalizedMethod,
      methodsUsed: selected.methodsUsed,
      weights: selected.weights,
      assumptions: [
        "Actual taxable-income data is used through the as-of date.",
        "MVP partial-month policy: actual transactions are included to date and only the remaining days of the current month are projected.",
        "No federal, state, self-employment, QBI, safe harbor, or payment math is applied.",
      ],
      sourceInputs: {
        taxableIncomeEngineVersion: actualResult.meta?.engineVersion,
        yearsAvailable: historicalPatterns.yearsAvailable,
        forecastConfidence: forecastInputs.confidence,
        originalProjection: overrides ? originalProjection.projectedAnnual : undefined,
        overrideImpact: overrides ? impact(originalProjection.projectedAnnual, selected.projectedAnnual) : undefined,
      },
    },
    confidence,
    warnings: dedupeWarnings(warnings),
  };
}

export function getAvailableProjectionMethods({ actualMonths = 0, historyYears = 0, forecastMonths = 0 } = {}) {
  const available = [PROJECTION_METHODS.ACTUAL_ONLY];
  const unavailable = [];
  if (actualMonths >= 1) available.push(PROJECTION_METHODS.ANNUALIZED_RUN_RATE);
  else unavailable.push({ method: PROJECTION_METHODS.ANNUALIZED_RUN_RATE, reason: "No actual months available." });
  if (actualMonths >= 3) available.push(PROJECTION_METHODS.TRAILING_3_MONTH);
  else unavailable.push({ method: PROJECTION_METHODS.TRAILING_3_MONTH, reason: "Requires at least 3 actual months." });
  if (actualMonths >= 6) available.push(PROJECTION_METHODS.TRAILING_6_MONTH);
  else unavailable.push({ method: PROJECTION_METHODS.TRAILING_6_MONTH, reason: "Requires at least 6 actual months." });
  if (historyYears >= 1) available.push(PROJECTION_METHODS.PRIOR_YEAR_SEASONALITY);
  else unavailable.push({ method: PROJECTION_METHODS.PRIOR_YEAR_SEASONALITY, reason: "Prior-year history unavailable." });
  if (historyYears >= 2) available.push(PROJECTION_METHODS.MULTI_YEAR_SEASONALITY);
  else unavailable.push({ method: PROJECTION_METHODS.MULTI_YEAR_SEASONALITY, reason: "Requires at least two prior years." });
  if (forecastMonths > 0) available.push(PROJECTION_METHODS.CASHFLOW_FORECAST);
  else unavailable.push({ method: PROJECTION_METHODS.CASHFLOW_FORECAST, reason: "No future forecast rows available." });
  available.push(PROJECTION_METHODS.BLENDED, PROJECTION_METHODS.MANUAL_OVERRIDE);
  return { availableMethods: available, unavailableMethods: unavailable };
}

function buildMethodProjections({ actual, actualMonthly, historicalPatterns, forecastInputs, taxYear, asOfDate, warnings }) {
  return {
    [PROJECTION_METHODS.ACTUAL_ONLY]: buildProjectionFromFutureMonthly({ actual, actualMonthly, projectedMonthly: {}, taxYear, asOfDate, methodsUsed: [PROJECTION_METHODS.ACTUAL_ONLY], weights: { actual_only: 1 } }),
    [PROJECTION_METHODS.ANNUALIZED_RUN_RATE]: buildRunRateProjection({ actual, actualMonthly, taxYear, asOfDate, window: null, method: PROJECTION_METHODS.ANNUALIZED_RUN_RATE, warnings }),
    [PROJECTION_METHODS.TRAILING_3_MONTH]: buildRunRateProjection({ actual, actualMonthly, taxYear, asOfDate, window: 3, method: PROJECTION_METHODS.TRAILING_3_MONTH, warnings }),
    [PROJECTION_METHODS.TRAILING_6_MONTH]: buildRunRateProjection({ actual, actualMonthly, taxYear, asOfDate, window: 6, method: PROJECTION_METHODS.TRAILING_6_MONTH, warnings }),
    [PROJECTION_METHODS.PRIOR_YEAR_SEASONALITY]: buildSeasonalityProjection({ actual, actualMonthly, historicalPatterns, taxYear, asOfDate, multiYear: false, warnings }),
    [PROJECTION_METHODS.MULTI_YEAR_SEASONALITY]: buildSeasonalityProjection({ actual, actualMonthly, historicalPatterns, taxYear, asOfDate, multiYear: true, warnings }),
    [PROJECTION_METHODS.CASHFLOW_FORECAST]: buildProjectionFromFutureMonthly({ actual, actualMonthly, projectedMonthly: forecastInputs.monthlyForecast, taxYear, asOfDate, methodsUsed: [PROJECTION_METHODS.CASHFLOW_FORECAST], weights: { cashflow_forecast: 1 } }),
  };
}

function selectProjection({ normalizedMethod, methodProjections, actual, actualMonthly, taxYear, asOfDate, warnings }) {
  if (normalizedMethod === PROJECTION_METHODS.BLENDED || normalizedMethod === PROJECTION_METHODS.MANUAL_OVERRIDE) {
    return buildBlendedProjection({ methodProjections, actual, actualMonthly, taxYear, asOfDate, warnings });
  }
  return methodProjections[normalizedMethod] || methodProjections[PROJECTION_METHODS.ACTUAL_ONLY];
}

function buildRunRateProjection({ actual, actualMonthly, taxYear, asOfDate, window, method, warnings }) {
  const months = monthsForYear(taxYear);
  const currentMonth = monthKey(asOfDate);
  const completed = completedMonths({ taxYear, asOfDate });
  const basisMonths = window ? completed.slice(-window) : completed;
  if (!basisMonths.length) {
    warnings.push(projectionWarning(PROJECTION_WARNING_CODES.INSUFFICIENT_HISTORY, "medium", `${method} has no completed month basis.`));
    return buildProjectionFromFutureMonthly({ actual, actualMonthly, projectedMonthly: {}, taxYear, asOfDate, methodsUsed: [PROJECTION_METHODS.ACTUAL_ONLY], weights: { actual_only: 1 } });
  }
  const avg = scaleRow(sumMonthly(actualMonthly, basisMonths), 1 / basisMonths.length);
  const projectedMonthly = {};
  for (const month of months) {
    if (month >= currentMonth) projectedMonthly[month] = { ...avg };
  }
  if (!window && elapsedDaysInYear(asOfDate) < 30) {
    warnings.push(projectionWarning(PROJECTION_WARNING_CODES.INSUFFICIENT_HISTORY, "medium", "Annualized run rate uses less than 30 elapsed days."));
  }
  return buildProjectionFromFutureMonthly({ actual, actualMonthly, projectedMonthly, taxYear, asOfDate, methodsUsed: [method], weights: { [method]: 1 } });
}

function buildSeasonalityProjection({ actual, actualMonthly, historicalPatterns, taxYear, asOfDate, multiYear, warnings }) {
  const neededYears = multiYear ? 2 : 1;
  if ((historicalPatterns.yearsAvailable || []).length < neededYears) {
    warnings.push(projectionWarning(PROJECTION_WARNING_CODES.SEASONALITY_UNAVAILABLE, "medium", "Seasonality projection lacks enough prior-year history."));
    return buildRunRateProjection({ actual, actualMonthly, taxYear, asOfDate, window: 3, method: PROJECTION_METHODS.TRAILING_3_MONTH, warnings });
  }
  const currentMonth = monthKey(asOfDate);
  const completed = completedMonths({ taxYear, asOfDate });
  const ytd = sumMonthly(actualMonthly, completed);
  const revenueYtdShare = shareThroughMonth(historicalPatterns, "revenue", completed);
  const cogsYtdShare = shareThroughMonth(historicalPatterns, "cogs", completed);
  const expenseYtdShare = shareThroughMonth(historicalPatterns, "deductibleExpenses", completed);
  const annualRevenue = revenueYtdShare ? ytd.revenue / revenueYtdShare : ytd.revenue;
  const annualCogs = cogsYtdShare ? ytd.cogs / cogsYtdShare : ytd.cogs;
  const annualExpenses = expenseYtdShare ? ytd.deductibleExpenses / expenseYtdShare : ytd.deductibleExpenses;
  const projectedMonthly = {};
  for (const month of monthsForYear(taxYear)) {
    if (month < currentMonth) continue;
    projectedMonthly[month] = {
      revenue: monthShare(historicalPatterns, "revenue", month) * annualRevenue,
      cogs: monthShare(historicalPatterns, "cogs", month) * annualCogs,
      deductibleExpenses: monthShare(historicalPatterns, "deductibleExpenses", month) * annualExpenses,
    };
    projectedMonthly[month].taxableBusinessIncome = projectedMonthly[month].revenue - projectedMonthly[month].cogs - projectedMonthly[month].deductibleExpenses;
  }
  return buildProjectionFromFutureMonthly({
    actual,
    actualMonthly,
    projectedMonthly,
    taxYear,
    asOfDate,
    methodsUsed: [multiYear ? PROJECTION_METHODS.MULTI_YEAR_SEASONALITY : PROJECTION_METHODS.PRIOR_YEAR_SEASONALITY],
    weights: { [multiYear ? PROJECTION_METHODS.MULTI_YEAR_SEASONALITY : PROJECTION_METHODS.PRIOR_YEAR_SEASONALITY]: 1 },
  });
}

function buildBlendedProjection({ methodProjections, actual, actualMonthly, taxYear, asOfDate, warnings }) {
  const desired = [
    [PROJECTION_METHODS.CASHFLOW_FORECAST, 0.4],
    [PROJECTION_METHODS.TRAILING_3_MONTH, 0.25],
    [PROJECTION_METHODS.PRIOR_YEAR_SEASONALITY, 0.2],
    [PROJECTION_METHODS.MULTI_YEAR_SEASONALITY, 0.15],
  ];
  const available = desired.filter(([method]) => projectionHasFuture(methodProjections[method]));
  if (!available.length) return methodProjections[PROJECTION_METHODS.ANNUALIZED_RUN_RATE] || methodProjections[PROJECTION_METHODS.ACTUAL_ONLY];
  const totalWeight = available.reduce((sum, [, weight]) => sum + weight, 0);
  const weights = Object.fromEntries(available.map(([method, weight]) => [method, round2(weight / totalWeight)]));
  const futureMonthsToProject = monthsForYear(taxYear).filter((month) => month >= monthKey(asOfDate));
  const projectedMonthly = {};
  for (const month of futureMonthsToProject) {
    let row = emptyComponentRow();
    for (const [method, weight] of Object.entries(weights)) {
      row = addRows(row, scaleRow(methodProjections[method].projectedMonthlyRaw?.[month] || {}, weight));
    }
    projectedMonthly[month] = row;
  }
  if (Object.keys(weights).length < desired.length) {
    warnings.push(projectionWarning(PROJECTION_WARNING_CODES.INSUFFICIENT_HISTORY, "low", "Blended projection redistributed weights because some source methods were unavailable.", { weights }));
  }
  return buildProjectionFromFutureMonthly({
    actual,
    actualMonthly,
    projectedMonthly,
    taxYear,
    asOfDate,
    methodsUsed: Object.keys(weights),
    weights,
  });
}

function buildProjectionFromFutureMonthly({ actual, actualMonthly, projectedMonthly, taxYear, asOfDate, methodsUsed, weights }) {
  const merged = mergeActualAndProjectedMonths({ actualMonthly, projectedMonthly, asOfDate, taxYear });
  const annual = sumMonthly(merged.monthly, monthsForYear(taxYear));
  const actualSum = actualToRow(actual);
  const futureMonthly = futureProjectionOnly({ projectedMonthly, asOfDate, taxYear });
  const future = {
    ...sumMonthly(futureMonthly, Object.keys(futureMonthly)),
    monthly: futureMonthly,
  };
  return {
    projectedMonthlyRaw: projectedMonthly,
    projectedFuture: future,
    projectedAnnual: {
      revenue: annual.revenue,
      cogs: annual.cogs,
      grossProfit: round2(annual.revenue - annual.cogs),
      deductibleExpenses: annual.deductibleExpenses,
      taxableBusinessIncome: annual.taxableBusinessIncome,
    },
    actualAnnualPart: actualSum,
    monthly: merged.monthly,
    methodsUsed,
    weights,
    warnings: merged.warnings,
  };
}

function futureProjectionOnly({ projectedMonthly, asOfDate, taxYear }) {
  const currentMonth = monthKey(asOfDate);
  const output = {};
  for (const month of monthsForYear(taxYear)) {
    if (month < currentMonth) continue;
    const row = actualProjectionComponents(projectedMonthly[month] || {});
    if (month === currentMonth) {
      const remainingRatio = asOfDate < `${month}-${String(daysInMonthKey(month)).padStart(2, "0")}`
        ? (daysInMonthKey(month) - dayOfMonth(asOfDate)) / daysInMonthKey(month)
        : 0;
      output[month] = { ...scaleRow(row, remainingRatio), partial: remainingRatio > 0, source: projectedMonthly[month] ? "projected_remainder" : "none" };
    } else {
      output[month] = { ...row, source: projectedMonthly[month] ? "projected" : "missing_projection" };
    }
  }
  return output;
}

function applyManualOverrides({ selected, overrides, taxYear, warnings }) {
  const next = cloneProjection(selected);
  if (overrides.annual) {
    next.projectedAnnual = {
      revenue: overrides.annual.revenue ?? next.projectedAnnual.revenue,
      cogs: overrides.annual.cogs ?? next.projectedAnnual.cogs,
      grossProfit: round2((overrides.annual.revenue ?? next.projectedAnnual.revenue) - (overrides.annual.cogs ?? next.projectedAnnual.cogs)),
      deductibleExpenses: overrides.annual.deductibleExpenses ?? next.projectedAnnual.deductibleExpenses,
      taxableBusinessIncome: overrides.annual.taxableBusinessIncome ?? round2((overrides.annual.revenue ?? next.projectedAnnual.revenue) - (overrides.annual.cogs ?? next.projectedAnnual.cogs) - (overrides.annual.deductibleExpenses ?? next.projectedAnnual.deductibleExpenses)),
    };
  }
  for (const [month, row] of Object.entries(overrides.monthly || {})) {
    next.monthly[month] = {
      ...(next.monthly[month] || emptyComponentRow()),
      revenue: row.revenue ?? next.monthly[month]?.revenue ?? 0,
      cogs: row.cogs ?? next.monthly[month]?.cogs ?? 0,
      deductibleExpenses: row.deductibleExpenses ?? next.monthly[month]?.deductibleExpenses ?? 0,
      taxableBusinessIncome: row.taxableBusinessIncome ?? round2((row.revenue ?? next.monthly[month]?.revenue ?? 0) - (row.cogs ?? next.monthly[month]?.cogs ?? 0) - (row.deductibleExpenses ?? next.monthly[month]?.deductibleExpenses ?? 0)),
      source: "manual_override",
    };
  }
  if (Object.keys(overrides.monthly || {}).length) {
    const annual = sumMonthly(next.monthly, monthsForYear(taxYear));
    next.projectedAnnual = {
      revenue: annual.revenue,
      cogs: annual.cogs,
      grossProfit: round2(annual.revenue - annual.cogs),
      deductibleExpenses: annual.deductibleExpenses,
      taxableBusinessIncome: annual.taxableBusinessIncome,
    };
  }
  next.projectedFuture = {
    ...next.projectedFuture,
    taxableBusinessIncome: round2(next.projectedAnnual.taxableBusinessIncome - next.actualAnnualPart.taxableBusinessIncome),
  };
  next.methodsUsed = [...new Set([...next.methodsUsed, PROJECTION_METHODS.MANUAL_OVERRIDE])];
  next.weights = { ...next.weights, manual_override: 1 };
  warnings.push(projectionWarning(PROJECTION_WARNING_CODES.PROJECTION_OVERRIDE_USED, "medium", "Manual projection override was applied.", { reason: overrides.reason }));
  return next;
}

function buildScenarios({ baseProjection, actualResult, historicalPatterns }) {
  const volatility = Math.max(
    Number(historicalPatterns?.volatility?.taxableIncomeCoefficient || 0),
    Number(actualResult?.expenses?.needsReviewAmount || 0) / Math.max(Math.abs(Number(actualResult?.revenue?.netBusinessRevenue || 0)), 1),
    0.08
  );
  const band = Math.min(0.45, Math.max(0.05, volatility));
  const lower = scenarioProjection(baseProjection, 1 - band);
  const base = scenarioProjection(baseProjection, 1);
  const higher = scenarioProjection(baseProjection, 1 + band);
  return {
    conservative: higher,
    base,
    optimistic: lower,
    lower_income_case: lower,
    base_case: base,
    higher_income_case: higher,
  };
}

function scenarioProjection(projection, taxableFactor) {
  const annual = { ...projection.projectedAnnual, taxableBusinessIncome: round2(projection.projectedAnnual.taxableBusinessIncome * taxableFactor) };
  return {
    projectedFuture: { ...projection.projectedFuture, taxableBusinessIncome: round2(projection.projectedFuture.taxableBusinessIncome * taxableFactor) },
    projectedAnnual: annual,
  };
}

function normalizeActualMonthly(monthly) {
  return Object.fromEntries(Object.entries(monthly || {}).map(([month, row]) => [month, actualProjectionComponents(row)]));
}

function buildActualSummary({ actualResult, actualMonthly, taxYear, asOfDate }) {
  const completed = completedMonths({ taxYear, asOfDate });
  const monthsCompleted = completed.length;
  const throughMonths = [...completed];
  if (isPartialCurrentMonth(asOfDate)) throughMonths.push(monthKey(asOfDate));
  const ytd = sumMonthly(actualMonthly, throughMonths);
  return {
    throughDate: asOfDate,
    monthsCompleted,
    partialCurrentMonth: isPartialCurrentMonth(asOfDate),
    revenue: actualResult.revenue.netBusinessRevenue,
    cogs: actualResult.expenses.costOfGoodsSold,
    deductibleExpenses: actualResult.expenses.deductibleOperatingExpenses,
    taxableBusinessIncome: actualResult.businessTaxableIncome.finalBusinessTaxableIncome,
    monthly: actualMonthly,
    ytdFromMonthly: ytd,
  };
}

function actualToRow(actual) {
  return {
    revenue: actual.revenue,
    cogs: actual.cogs,
    deductibleExpenses: actual.deductibleExpenses,
    taxableBusinessIncome: actual.taxableBusinessIncome,
  };
}

function projectionHasFuture(projection) {
  return Object.values(projection?.projectedMonthlyRaw || {}).some((row) => {
    const c = actualProjectionComponents(row);
    return Math.abs(c.revenue) + Math.abs(c.cogs) + Math.abs(c.deductibleExpenses) + Math.abs(c.taxableBusinessIncome) > 0;
  });
}

function shareThroughMonth(patterns, component, completed) {
  if (!completed.length) return 0;
  const total = completed.reduce((sum, month) => sum + monthShare(patterns, component, month), 0);
  return total;
}

function monthShare(patterns, component, month) {
  const index = Number(patterns?.seasonalityIndices?.[component]?.[month] ?? 1);
  return index / 12;
}

function elapsedDaysInYear(asOfDate) {
  const year = Number(asOfDate.slice(0, 4));
  const start = Date.UTC(year, 0, 1);
  const now = Date.parse(`${asOfDate}T00:00:00Z`);
  return Math.floor((now - start) / 86400000) + 1;
}

function normalizeMethod(value) {
  const method = String(value || PROJECTION_METHODS.BLENDED).trim().toLowerCase();
  if (!ProjectionMethodSet.has(method)) throw validationError("unsupported_projection_method", "Projection method is not supported.", { method });
  return method;
}

function normalizeScenario(value) {
  const scenario = String(value || PROJECTION_SCENARIOS.BASE).trim().toLowerCase();
  if (!ProjectionScenarioSet.has(scenario)) throw validationError("unsupported_projection_scenario", "Projection scenario is not supported.", { scenario });
  return scenario;
}

function scenarioKey(scenario) {
  if (scenario === PROJECTION_SCENARIOS.CONSERVATIVE) return "higher_income_case";
  if (scenario === PROJECTION_SCENARIOS.OPTIMISTIC) return "lower_income_case";
  return "base_case";
}

function normalizeWarning(warning) {
  if (warning?.code && warning?.message) return warning;
  return projectionWarning(PROJECTION_WARNING_CODES.INCOMPLETE_ACTUALS, "medium", String(warning?.message || "Projection source warning."));
}

function dedupeWarnings(warnings) {
  const seen = new Set();
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.message}:${JSON.stringify(warning.month || warning.method || "")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emptyPatterns() {
  return { yearsAvailable: [], seasonalityIndices: {}, trailingAverages: {}, volatility: { level: "unavailable" }, warnings: [] };
}

function emptyForecast() {
  return { monthlyForecast: {}, sourceFreshness: { latestUpdatedAt: null }, confidence: "unavailable", overlapWithActuals: 0, warnings: [] };
}

function cloneProjection(projection) {
  return JSON.parse(JSON.stringify(projection));
}

function impact(before, after) {
  return {
    revenue: round2(after.revenue - before.revenue),
    cogs: round2(after.cogs - before.cogs),
    deductibleExpenses: round2(after.deductibleExpenses - before.deductibleExpenses),
    taxableBusinessIncome: round2(after.taxableBusinessIncome - before.taxableBusinessIncome),
  };
}
