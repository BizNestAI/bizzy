import { TAX_ENTITY_TYPES, TAX_ELECTIONS, TAX_FILING_STATUSES, TAX_PAYMENT_TYPES } from "../taxDomain.js";
import { FEDERAL_TAX_RULE_TYPES, STATE_TAX_RULE_TYPES } from "../taxRuleTypes.js";

export const TAX_QA_STATUSES = Object.freeze({
  PASS: "pass",
  WARNING: "warning",
  FAIL: "fail",
  UNSUPPORTED: "unsupported",
  NOT_APPLICABLE: "not_applicable",
});

export const TAX_QA_ENTITY_PATHS = Object.freeze({
  SOLE_PROPRIETOR: "sole_proprietor",
  SINGLE_MEMBER_LLC_DISREGARDED: "single_member_llc_disregarded",
  SINGLE_MEMBER_LLC_S_CORP: "single_member_llc_s_corp",
  S_CORPORATION: "s_corporation",
});

export const TAX_SUPPORTED_SCOPE = Object.freeze({
  entityPaths: {
    [TAX_QA_ENTITY_PATHS.SOLE_PROPRIETOR]: {
      entityType: TAX_ENTITY_TYPES.SOLE_PROPRIETOR,
      taxElection: TAX_ELECTIONS.SOLE_PROPRIETOR,
      requiresSelfEmploymentTax: true,
      requiresSCorpSupport: false,
    },
    [TAX_QA_ENTITY_PATHS.SINGLE_MEMBER_LLC_DISREGARDED]: {
      entityType: TAX_ENTITY_TYPES.SINGLE_MEMBER_LLC,
      taxElection: TAX_ELECTIONS.DISREGARDED_ENTITY,
      requiresSelfEmploymentTax: true,
      requiresSCorpSupport: false,
    },
    [TAX_QA_ENTITY_PATHS.SINGLE_MEMBER_LLC_S_CORP]: {
      entityType: TAX_ENTITY_TYPES.SINGLE_MEMBER_LLC,
      taxElection: TAX_ELECTIONS.S_CORP,
      requiresSelfEmploymentTax: false,
      requiresSCorpSupport: true,
    },
    [TAX_QA_ENTITY_PATHS.S_CORPORATION]: {
      entityType: TAX_ENTITY_TYPES.S_CORP,
      taxElection: TAX_ELECTIONS.S_CORP,
      requiresSelfEmploymentTax: false,
      requiresSCorpSupport: true,
    },
  },
  filingStatuses: [
    TAX_FILING_STATUSES.SINGLE,
    TAX_FILING_STATUSES.MARRIED_FILING_JOINTLY,
    TAX_FILING_STATUSES.MARRIED_FILING_SEPARATELY,
    TAX_FILING_STATUSES.HEAD_OF_HOUSEHOLD,
    TAX_FILING_STATUSES.QUALIFYING_SURVIVING_SPOUSE,
  ],
  federalRequiredComponents: [
    { key: "income_tax_brackets", ruleType: FEDERAL_TAX_RULE_TYPES.FEDERAL_INCOME_TAX_BRACKETS },
    { key: "standard_deduction", ruleType: FEDERAL_TAX_RULE_TYPES.STANDARD_DEDUCTION },
    { key: "se_tax_net_earnings_factor", ruleType: FEDERAL_TAX_RULE_TYPES.SELF_EMPLOYMENT_TAX },
    { key: "social_security_wage_base_rates", ruleType: FEDERAL_TAX_RULE_TYPES.SOCIAL_SECURITY_WAGE_BASE },
    { key: "medicare_rate", ruleType: FEDERAL_TAX_RULE_TYPES.SELF_EMPLOYMENT_TAX },
    { key: "additional_medicare_thresholds", ruleType: FEDERAL_TAX_RULE_TYPES.ADDITIONAL_MEDICARE_TAX },
    { key: "safe_harbor_percentages", ruleType: FEDERAL_TAX_RULE_TYPES.ESTIMATED_TAX_SAFE_HARBOR },
    { key: "estimated_payment_dates", ruleType: FEDERAL_TAX_RULE_TYPES.ESTIMATED_TAX_DUE_DATES },
  ],
  stateRequiredComponents: [
    { key: "individual_income_tax", ruleType: STATE_TAX_RULE_TYPES.INDIVIDUAL_INCOME_TAX, alternativeRuleType: STATE_TAX_RULE_TYPES.NO_INDIVIDUAL_INCOME_TAX },
    { key: "state_standard_deduction_or_exemption", ruleType: STATE_TAX_RULE_TYPES.STANDARD_DEDUCTION, optional: true },
    { key: "state_estimated_payment_dates", ruleType: STATE_TAX_RULE_TYPES.ESTIMATED_TAX_DUE_DATES, optional: true },
    { key: "state_safe_harbor", ruleType: STATE_TAX_RULE_TYPES.ESTIMATED_TAX_SAFE_HARBOR, optional: true },
    { key: "s_corp_minimum_or_entity_tax", ruleType: STATE_TAX_RULE_TYPES.S_CORP_MINIMUM_TAX, sCorpOnly: true },
  ],
  deductionCategories: [
    "advertising",
    "auto",
    "bank_fees",
    "contract_labor",
    "cost_of_goods_sold",
    "dues_subscriptions",
    "equipment",
    "insurance",
    "interest",
    "legal_professional",
    "meals",
    "office",
    "payroll",
    "rent",
    "repairs_maintenance",
    "supplies",
    "taxes_licenses",
    "travel",
    "utilities",
  ],
  certificationDeductionRequirements: [
    { key: "materials_and_supplies", label: "Materials and supplies", categories: ["supplies", "materials", "cost_of_goods_sold"] },
    { key: "subcontractors_contract_labor", label: "Subcontractors / contract labor", categories: ["contract_labor", "subcontractors"] },
    { key: "meals", label: "Meals", categories: ["meals"] },
    { key: "vehicle_fuel", label: "Vehicle / fuel", categories: ["auto", "vehicle", "fuel"] },
    { key: "insurance", label: "Insurance", categories: ["insurance"] },
    { key: "office_expense", label: "Office expense", categories: ["office"] },
    { key: "tools_small_equipment", label: "Tools and small equipment", categories: ["equipment", "tools"] },
    { key: "capitalizable_equipment", label: "Capitalizable equipment", categories: ["equipment", "capitalizable_equipment"], requiredStatus: "capitalizable" },
    { key: "loan_principal", label: "Loan principal", categories: ["loan_principal", "debt_principal"], requiredStatus: "balance_sheet" },
    { key: "loan_interest", label: "Loan interest", categories: ["interest", "loan_interest"] },
    { key: "owner_draws_contributions", label: "Owner draws/contributions", categories: ["owner_draw", "owner_contribution", "equity"], requiredStatus: "balance_sheet" },
    { key: "transfers", label: "Transfers", categories: ["transfer", "transfers"], requiredStatus: "balance_sheet" },
    { key: "credit_card_payments", label: "Credit-card payments", categories: ["credit_card_payment"], requiredStatus: "balance_sheet" },
    { key: "refunds_reversals", label: "Refunds/reversals", categories: ["refund", "reversal", "refunds_reversals"] },
    { key: "payroll_payroll_taxes", label: "Payroll/payroll taxes", categories: ["payroll", "payroll_taxes"] },
    { key: "personal_nondeductible", label: "Personal/nondeductible expenses", categories: ["personal", "nondeductible"], requiredStatus: "nondeductible" },
  ],
  paymentTypes: Object.values(TAX_PAYMENT_TYPES),
  reserveSupport: ["manual_reserve", "plaid_account", "qbo_account"],
  deferredUnsupportedFeatures: [
    "qbi_calculation",
    "complex_credits",
    "multi_state_allocation",
    "local_taxes_where_unverified",
    "capital_gains",
    "partnership_income",
    "spouse_income_integration",
    "advanced_depreciation_unless_configured",
  ],
});

export function entityPathToProfile(entityPath) {
  return TAX_SUPPORTED_SCOPE.entityPaths[entityPath] || null;
}

export function isSupportedEntityPath(entityPath) {
  return Boolean(entityPathToProfile(entityPath));
}
