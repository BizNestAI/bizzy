// /src/services/tax/confidence/taxConfidenceDomain.js

const freeze = (value) => Object.freeze(value);

export const TAX_CONFIDENCE_LEVELS = freeze({
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  UNAVAILABLE: "unavailable",
});

export const TAX_CONFIDENCE_STATUSES = freeze({
  ESTIMATE_READY: "estimate_ready",
  RESERVE_READY: "reserve_ready",
  PARTIAL: "partial",
  SETUP_INCOMPLETE: "setup_incomplete",
  UNSUPPORTED: "unsupported",
  UNAVAILABLE: "unavailable",
});

export const TAX_CONFIDENCE_FACTOR_CATEGORIES = freeze({
  PROFILE: "profile",
  ENTITY: "entity",
  SOURCE_DATA: "source_data",
  TRANSACTION_CLASSIFICATION: "transaction_classification",
  DEDUCTIONS: "deductions",
  TAXABLE_INCOME: "taxable_income",
  PROJECTION: "projection",
  FEDERAL_RULES: "federal_rules",
  FEDERAL_INPUTS: "federal_inputs",
  SELF_EMPLOYMENT: "self_employment",
  S_CORP: "s_corp",
  STATE_RULES: "state_rules",
  STATE_INPUTS: "state_inputs",
  PAYMENTS: "payments",
  SAFE_HARBOR: "safe_harbor",
  RESERVE: "reserve",
  FRESHNESS: "freshness",
  UNSUPPORTED_SCOPE: "unsupported_scope",
});

export const TAX_CONFIDENCE_BLOCKER_SEVERITIES = freeze({
  FATAL: "fatal",
  MAJOR: "major",
  MODERATE: "moderate",
  INFORMATIONAL: "informational",
});

export const TAX_CONFIDENCE_MATERIALITY = freeze({
  IMMATERIAL: "immaterial",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
});

export const TAX_CONFIDENCE_METHODOLOGY_VERSION = "tax-confidence-v1";

export function confidenceLevelForScore(score, blockers = []) {
  if (blockers.some((blocker) => blocker.severity === TAX_CONFIDENCE_BLOCKER_SEVERITIES.FATAL)) return TAX_CONFIDENCE_LEVELS.UNAVAILABLE;
  const n = Math.max(0, Math.min(100, Math.round(Number(score || 0))));
  if (n >= 85) return TAX_CONFIDENCE_LEVELS.HIGH;
  if (n >= 60) return TAX_CONFIDENCE_LEVELS.MEDIUM;
  if (n > 0) return TAX_CONFIDENCE_LEVELS.LOW;
  return TAX_CONFIDENCE_LEVELS.UNAVAILABLE;
}
