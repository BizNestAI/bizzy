// /src/services/tax/taxRuleTypes.js

const freeze = (value) => Object.freeze(value);

export const FEDERAL_TAX_RULE_TYPES = freeze({
  FEDERAL_INCOME_TAX_BRACKETS: "federal_income_tax_brackets",
  STANDARD_DEDUCTION: "standard_deduction",
  SELF_EMPLOYMENT_TAX: "self_employment_tax",
  ADDITIONAL_MEDICARE_TAX: "additional_medicare_tax",
  QBI: "qbi",
  ESTIMATED_TAX_SAFE_HARBOR: "estimated_tax_safe_harbor",
  ESTIMATED_TAX_DUE_DATES: "estimated_tax_due_dates",
  SOCIAL_SECURITY_WAGE_BASE: "social_security_wage_base",
  QUALIFIED_PLAN_LIMITS: "qualified_plan_limits",
  HSA_LIMITS: "hsa_limits",
  MILEAGE_RATE: "mileage_rate",
  SECTION_179: "section_179",
  BONUS_DEPRECIATION: "bonus_depreciation",
  DE_MINIMIS_SAFE_HARBOR: "de_minimis_safe_harbor",
  MEALS_DEDUCTION: "meals_deduction",
  FILING_STATUS_THRESHOLDS: "filing_status_thresholds",
});

export const STATE_TAX_RULE_TYPES = freeze({
  INDIVIDUAL_INCOME_TAX: "individual_income_tax",
  PASS_THROUGH_ENTITY_TAX: "pass_through_entity_tax",
  FRANCHISE_TAX: "franchise_tax",
  GROSS_RECEIPTS_TAX: "gross_receipts_tax",
  INDIVIDUAL_CAPITAL_GAINS_EXCISE_TAX: "individual_capital_gains_excise_tax",
  PAYROLL_EXCISE_TAX: "payroll_excise_tax",
  LOCAL_INCOME_TAX: "local_income_tax",
  ESTIMATED_TAX_SAFE_HARBOR: "estimated_tax_safe_harbor",
  ESTIMATED_TAX_DUE_DATES: "estimated_tax_due_dates",
  STANDARD_DEDUCTION: "standard_deduction",
  PERSONAL_EXEMPTION: "personal_exemption",
  STATE_QBI_ADJUSTMENT: "state_qbi_adjustment",
  STATE_DEDUCTION_ADJUSTMENT: "state_deduction_adjustment",
  OWNER_LEVEL_BUSINESS_INCOME_ELECTION: "owner_level_business_income_election",
  S_CORP_ENTITY_TAX: "s_corp_entity_tax",
  S_CORP_MINIMUM_TAX: "s_corp_minimum_tax",
  NO_INDIVIDUAL_INCOME_TAX: "no_individual_income_tax",
  ENTITY_TAX_CAVEAT: "entity_tax_caveat",
  CORPORATE_INCOME_TAX_CAVEAT: "corporate_income_tax_caveat",
  FRANCHISE_TAX_CAVEAT: "franchise_tax_caveat",
  GROSS_RECEIPTS_TAX_CAVEAT: "gross_receipts_tax_caveat",
  BUSINESS_PROFITS_TAX_CAVEAT: "business_profits_tax_caveat",
  BUSINESS_ENTERPRISE_TAX_CAVEAT: "business_enterprise_tax_caveat",
  CONTRACTOR_EXCISE_TAX_CAVEAT: "contractor_excise_tax_caveat",
  CAPITAL_GAINS_TAX_CAVEAT: "capital_gains_tax_caveat",
});

export const FEDERAL_TAX_RULE_TYPE_VALUES = freeze(Object.values(FEDERAL_TAX_RULE_TYPES));
export const STATE_TAX_RULE_TYPE_VALUES = freeze(Object.values(STATE_TAX_RULE_TYPES));
export const TAX_RULE_TYPE_VALUES = freeze([...FEDERAL_TAX_RULE_TYPE_VALUES, ...STATE_TAX_RULE_TYPE_VALUES]);

export const REQUIRED_FEDERAL_RULE_TYPES = freeze([
  FEDERAL_TAX_RULE_TYPES.FEDERAL_INCOME_TAX_BRACKETS,
  FEDERAL_TAX_RULE_TYPES.STANDARD_DEDUCTION,
  FEDERAL_TAX_RULE_TYPES.SELF_EMPLOYMENT_TAX,
  FEDERAL_TAX_RULE_TYPES.ADDITIONAL_MEDICARE_TAX,
  FEDERAL_TAX_RULE_TYPES.QBI,
  FEDERAL_TAX_RULE_TYPES.ESTIMATED_TAX_SAFE_HARBOR,
  FEDERAL_TAX_RULE_TYPES.ESTIMATED_TAX_DUE_DATES,
]);

export const REQUIRED_STATE_RULE_TYPES = freeze([
  STATE_TAX_RULE_TYPES.INDIVIDUAL_INCOME_TAX,
]);

export function isFederalRuleType(value) {
  return FEDERAL_TAX_RULE_TYPE_VALUES.includes(value);
}

export function isStateRuleType(value) {
  return STATE_TAX_RULE_TYPE_VALUES.includes(value);
}
