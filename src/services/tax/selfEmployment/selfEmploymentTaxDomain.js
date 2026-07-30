// /src/services/tax/selfEmployment/selfEmploymentTaxDomain.js

const freeze = (value) => Object.freeze(value);

export const SELF_EMPLOYMENT_TAX_COMPONENTS = freeze({
  NET_PROFIT_INPUT: "net_profit_input",
  NET_EARNINGS_FACTOR: "net_earnings_factor",
  NET_EARNINGS_FROM_SELF_EMPLOYMENT: "net_earnings_from_self_employment",
  SOCIAL_SECURITY_TAXABLE_BASE: "social_security_taxable_base",
  SOCIAL_SECURITY_TAX: "social_security_tax",
  MEDICARE_TAXABLE_BASE: "medicare_taxable_base",
  MEDICARE_TAX: "medicare_tax",
  ADDITIONAL_MEDICARE_TAX: "additional_medicare_tax",
  TOTAL_SELF_EMPLOYMENT_TAX: "total_self_employment_tax",
  DEDUCTIBLE_HALF_SE_TAX: "deductible_half_se_tax",
  REMAINING_SOCIAL_SECURITY_WAGE_BASE: "remaining_social_security_wage_base",
  WAGES_SUBJECT_TO_FICA: "wages_subject_to_fica",
  UNSUPPORTED_WAGE_INPUTS: "unsupported_wage_inputs",
});

export const SELF_EMPLOYMENT_WARNING_CODES = freeze({
  SE_TAX_NOT_APPLICABLE: "se_tax_not_applicable",
  ENTITY_NOT_SUPPORTED_FOR_SE_TAX: "entity_not_supported_for_se_tax",
  MISSING_SE_TAX_CONFIG: "missing_se_tax_config",
  MISSING_WAGE_BASE_CONFIG: "missing_wage_base_config",
  MISSING_W2_WAGES: "missing_w2_wages",
  OTHER_FICA_WAGES_UNKNOWN: "other_fica_wages_unknown",
  ADDITIONAL_MEDICARE_NOT_COMPUTED: "additional_medicare_not_computed",
  FILING_STATUS_MISSING: "filing_status_missing",
  NEGATIVE_SE_INCOME: "negative_se_income",
  WAGE_BASE_CONSUMED: "wage_base_consumed",
  UNSUPPORTED_MULTIPLE_BUSINESSES: "unsupported_multiple_businesses",
  LOW_CONFIDENCE_PROJECTION: "low_confidence_projection",
  QBI_DEFERRED: "qbi_deferred",
});

export function seWarning(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

export function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
