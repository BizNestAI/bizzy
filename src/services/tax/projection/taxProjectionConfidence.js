// /src/services/tax/projection/taxProjectionConfidence.js
import { PROJECTION_METHODS } from "./taxProjectionDomain.js";

export function computeTaxProjectionConfidence({
  actual,
  historicalPatterns,
  forecastInputs,
  taxableIncome,
  warnings = [],
  method,
  manualOverrides,
} = {}) {
  let score = 100;
  const factors = [];
  const penalties = [];
  const blockers = [];

  const monthsCompleted = Number(actual?.monthsCompleted || 0);
  factors.push({ factor: "actual_months", impact: monthsCompleted >= 3 ? "positive" : "negative", explanation: `${monthsCompleted} completed actual months available.` });
  if (monthsCompleted < 2) {
    score -= 25;
    penalties.push({ factor: "actual_months", points: 25, explanation: "Less than two completed months of taxable-income actuals are available." });
  }

  const years = historicalPatterns?.yearsAvailable?.length || 0;
  if (years < 1) {
    score -= 20;
    penalties.push({ factor: "historical_years", points: 20, explanation: "No usable prior-year seasonality is available." });
  } else if (years < 2) {
    score -= 10;
    penalties.push({ factor: "historical_years", points: 10, explanation: "Only one prior year is available." });
  }

  if (forecastInputs?.confidence === "low") {
    score -= 10;
    penalties.push({ factor: "forecast_confidence", points: 10, explanation: "Forecast source coverage is incomplete." });
  }
  if (taxableIncome?.coverage?.classificationCoveragePercent < 80) {
    score -= 15;
    penalties.push({ factor: "classification_coverage", points: 15, explanation: "Classification coverage is below 80%." });
  }
  if (taxableIncome?.expenses?.needsReviewAmount > Math.abs(taxableIncome?.revenue?.netBusinessRevenue || 0) * 0.1) {
    score -= 15;
    penalties.push({ factor: "needs_review", points: 15, explanation: "Needs-review exposure is material." });
  }
  if (historicalPatterns?.volatility?.level === "high") {
    score -= 12;
    penalties.push({ factor: "historical_volatility", points: 12, explanation: "Historical taxable-income volatility is high." });
  }
  if (forecastInputs?.accountingMethod === "accrual") {
    score -= 5;
    penalties.push({ factor: "accounting_method_fit", points: 5, explanation: "Cashflow forecast timing may not match accrual taxable revenue." });
  }
  if (manualOverrides) {
    score -= 5;
    penalties.push({ factor: "manual_override", points: 5, explanation: "Manual projection overrides were applied." });
  }
  if (warnings.some((warning) => warning.code === "insufficient_history") && method !== PROJECTION_METHODS.ACTUAL_ONLY) {
    blockers.push("weak_history");
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    level: score >= 85 && !blockers.length ? "high" : score >= 60 ? "medium" : score > 0 ? "low" : "unavailable",
    factors,
    penalties,
    blockers,
    recommendedMethod: recommendedMethod({ monthsCompleted, years, forecastInputs }),
  };
}

function recommendedMethod({ monthsCompleted, years, forecastInputs }) {
  if (forecastInputs?.confidence === "medium" && monthsCompleted >= 1) return PROJECTION_METHODS.BLENDED;
  if (years >= 2 && monthsCompleted >= 3) return PROJECTION_METHODS.MULTI_YEAR_SEASONALITY;
  if (years >= 1 && monthsCompleted >= 3) return PROJECTION_METHODS.PRIOR_YEAR_SEASONALITY;
  if (monthsCompleted >= 3) return PROJECTION_METHODS.TRAILING_3_MONTH;
  if (monthsCompleted >= 1) return PROJECTION_METHODS.ANNUALIZED_RUN_RATE;
  return PROJECTION_METHODS.ACTUAL_ONLY;
}
