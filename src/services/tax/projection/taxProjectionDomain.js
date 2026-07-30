// /src/services/tax/projection/taxProjectionDomain.js

const freeze = (value) => Object.freeze(value);

export const PROJECTION_METHODS = freeze({
  ACTUAL_ONLY: "actual_only",
  ANNUALIZED_RUN_RATE: "annualized_run_rate",
  TRAILING_3_MONTH: "trailing_3_month",
  TRAILING_6_MONTH: "trailing_6_month",
  PRIOR_YEAR_SEASONALITY: "prior_year_seasonality",
  MULTI_YEAR_SEASONALITY: "multi_year_seasonality",
  CASHFLOW_FORECAST: "cashflow_forecast",
  BLENDED: "blended",
  MANUAL_OVERRIDE: "manual_override",
});

export const PROJECTION_SCENARIOS = freeze({
  CONSERVATIVE: "conservative",
  BASE: "base",
  OPTIMISTIC: "optimistic",
});

export const PROJECTION_COMPONENTS = freeze({
  REVENUE: "revenue",
  COGS: "cogs",
  DEDUCTIBLE_EXPENSES: "deductible_expenses",
  TAXABLE_BUSINESS_INCOME: "taxable_business_income",
  OWNER_WAGES_PLACEHOLDER: "owner_wages_placeholder",
  TAX_ADJUSTMENTS: "tax_adjustments",
  CONFIDENCE_RANGE: "confidence_range",
});

export const PROJECTION_WARNING_CODES = freeze({
  INSUFFICIENT_HISTORY: "insufficient_history",
  STALE_FORECAST: "stale_forecast",
  FORECAST_ACTUAL_OVERLAP: "forecast_actual_overlap",
  SEASONALITY_UNAVAILABLE: "seasonality_unavailable",
  PROJECTION_OVERRIDE_USED: "projection_override_used",
  NEGATIVE_PROJECTION: "negative_projection",
  HIGH_VARIANCE: "high_variance",
  INCOMPLETE_ACTUALS: "incomplete_actuals",
  MISSING_FUTURE_MONTHS: "missing_future_months",
  UNSUPPORTED_PROJECTION_METHOD: "unsupported_projection_method",
});

export const ProjectionMethodSet = immutableSet(Object.values(PROJECTION_METHODS));
export const ProjectionScenarioSet = immutableSet(Object.values(PROJECTION_SCENARIOS));

function immutableSet(values) {
  const set = new Set(values);
  Object.defineProperties(set, {
    add: { value: immutableSetMutation, configurable: false },
    delete: { value: immutableSetMutation, configurable: false },
    clear: { value: immutableSetMutation, configurable: false },
  });
  return freeze(set);
}

function immutableSetMutation() {
  throw new TypeError("Projection domain sets are immutable.");
}

export function projectionWarning(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

export function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}
