// /src/services/tax/sCorp/sCorpDomain.js

const freeze = (value) => Object.freeze(value);

export const S_CORP_COMPONENTS = freeze({
  ORDINARY_BUSINESS_INCOME_BEFORE_OWNER_COMPENSATION: "ordinary_business_income_before_owner_compensation",
  OFFICER_COMPENSATION: "officer_compensation",
  EMPLOYER_PAYROLL_TAX: "employer_payroll_tax",
  OWNER_HEALTH_INSURANCE: "owner_health_insurance",
  RETIREMENT_CONTRIBUTION: "retirement_contribution",
  PASS_THROUGH_INCOME: "pass_through_income",
  DISTRIBUTIONS: "distributions",
  FEDERAL_WITHHOLDING: "federal_withholding",
  STATE_WITHHOLDING: "state_withholding",
  PAYROLL_TAX_PAID: "payroll_tax_paid",
  REASONABLE_SALARY_TARGET: "reasonable_salary_target",
  REASONABLE_SALARY_GAP: "reasonable_salary_gap",
  DISTRIBUTION_TO_WAGE_RATIO: "distribution_to_wage_ratio",
  UNSUPPORTED_PAYROLL_DATA: "unsupported_payroll_data",
});

export const S_CORP_WARNING_CODES = freeze({
  S_CORP_ELECTION_UNCONFIRMED: "s_corp_election_unconfirmed",
  REASONABLE_SALARY_MISSING: "reasonable_salary_missing",
  OWNER_WAGES_MISSING: "owner_wages_missing",
  OWNER_WAGES_BELOW_TARGET: "owner_wages_below_target",
  OWNER_WAGES_ABOVE_PROFIT: "owner_wages_above_profit",
  HIGH_DISTRIBUTION_LOW_WAGE: "high_distribution_low_wage",
  PAYROLL_TAX_DATA_MISSING: "payroll_tax_data_missing",
  WITHHOLDING_MISSING: "withholding_missing",
  DISTRIBUTIONS_UNKNOWN: "distributions_unknown",
  HEALTH_INSURANCE_TREATMENT_UNKNOWN: "health_insurance_treatment_unknown",
  RETIREMENT_TREATMENT_UNKNOWN: "retirement_treatment_unknown",
  PASS_THROUGH_INCOME_NEGATIVE: "pass_through_income_negative",
  PAYROLL_SOURCE_STALE: "payroll_source_stale",
  MULTIPLE_OWNER_S_CORP_UNSUPPORTED: "multiple_owner_s_corp_unsupported",
  QBI_DEFERRED: "qbi_deferred",
  STATE_S_CORP_RULES_DEFERRED: "state_s_corp_rules_deferred",
});

export const S_CORP_BLOCKER_CODES = freeze({
  ENTITY_NOT_S_CORP: "entity_not_s_corp",
  ELECTION_UNCONFIRMED: "election_unconfirmed",
  PASS_THROUGH_INCOME_UNAVAILABLE: "pass_through_income_unavailable",
  WAGE_TREATMENT_UNCLEAR: "wage_treatment_double_count_uncertainty",
  MULTIPLE_OWNER_UNSUPPORTED: "multiple_owner_s_corp_unsupported",
});

export function sCorpWarning(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

export function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
