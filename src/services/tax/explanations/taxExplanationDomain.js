// /src/services/tax/explanations/taxExplanationDomain.js

const freeze = (value) => Object.freeze(value);

export const TAX_EXPLANATION_COMPONENT_GROUPS = freeze({
  PROFILE: "profile",
  SOURCE_DATA: "source_data",
  REVENUE: "revenue",
  COGS: "cogs",
  DEDUCTIONS: "deductions",
  NONDEDUCTIBLE_ADDBACKS: "nondeductible_addbacks",
  CAPITAL_ASSETS: "capital_assets",
  TAXABLE_INCOME: "taxable_income",
  PROJECTION: "projection",
  ENTITY: "entity",
  FEDERAL_TAX: "federal_tax",
  SELF_EMPLOYMENT_TAX: "self_employment_tax",
  S_CORP: "s_corp",
  STATE_TAX: "state_tax",
  PAYMENTS: "payments",
  WITHHOLDING: "withholding",
  SAFE_HARBOR: "safe_harbor",
  DEADLINES: "deadlines",
  RESERVE: "reserve",
  CONFIDENCE: "confidence",
  WARNING: "warning",
  ASSUMPTION: "assumption",
  UNSUPPORTED_ITEM: "unsupported_item",
});

export const TAX_EXPLANATION_DIRECTIONS = freeze({
  INCREASE_TAXABLE_INCOME: "increase_taxable_income",
  DECREASE_TAXABLE_INCOME: "decrease_taxable_income",
  INCREASE_TAX: "increase_tax",
  DECREASE_TAX: "decrease_tax",
  PAYMENT_CREDIT: "payment_credit",
  RESERVE_ADJUSTMENT: "reserve_adjustment",
  INFORMATIONAL: "informational",
  NEUTRAL: "neutral",
});

export const TAX_SOURCE_REFERENCE_TYPES = freeze({
  BANK_TRANSACTION: "bank_transaction",
  TRANSACTION_CLASSIFICATION: "transaction_classification",
  TAX_PROFILE: "tax_profile",
  TAX_MEMORY: "tax_memory",
  TAX_RULE_CONFIG: "tax_rule_config",
  STATE_TAX_RULE_CONFIG: "state_tax_rule_config",
  DEDUCTION_RULE: "deduction_rule",
  TAX_ADJUSTMENT: "tax_adjustment",
  FINANCIAL_METRIC: "financial_metric",
  FORECAST: "forecast",
  TAX_PAYMENT: "tax_payment",
  TAX_DEADLINE: "tax_deadline",
  PRIOR_CALCULATION_RUN: "prior_calculation_run",
  MANUAL_OVERRIDE: "manual_override",
  SYSTEM_ASSUMPTION: "system_assumption",
});

export const EXPLANATION_SEVERITY_RANK = freeze({
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
});
