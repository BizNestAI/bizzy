// /src/services/tax/state/stateTaxDomain.js

const freeze = (value) => Object.freeze(value);

export const STATE_TAX_COMPONENTS = freeze({
  STATE_TAXABLE_INCOME: "state_taxable_income",
  STATE_STANDARD_DEDUCTION: "state_standard_deduction",
  STATE_PERSONAL_EXEMPTION: "state_personal_exemption",
  STATE_INCOME_TAX: "state_income_tax",
  STATE_FLAT_TAX: "state_flat_tax",
  STATE_PROGRESSIVE_TAX: "state_progressive_tax",
  NO_INDIVIDUAL_INCOME_TAX: "no_individual_income_tax",
  STATE_PASS_THROUGH_ENTITY_TAX: "state_pass_through_entity_tax",
  STATE_FRANCHISE_TAX: "state_franchise_tax",
  STATE_CAPITAL_GAINS_EXCISE_TAX: "state_capital_gains_excise_tax",
  STATE_GROSS_RECEIPTS_TAX: "state_gross_receipts_tax",
  STATE_PAYROLL_EXCISE_TAX: "state_payroll_excise_tax",
  STATE_DEDUCTION_ADJUSTMENT: "state_deduction_adjustment",
  OWNER_LEVEL_BUSINESS_INCOME_ELECTION: "owner_level_business_income_election",
  S_CORP_ENTITY_TAX: "s_corp_entity_tax",
  S_CORP_REPLACEMENT_TAX: "s_corp_replacement_tax",
  S_CORP_MINIMUM_TAX: "s_corp_minimum_tax",
  LOCAL_INCOME_TAX: "local_income_tax",
  STATE_WITHHOLDING: "state_withholding",
  STATE_ESTIMATED_PAYMENTS: "state_estimated_payments",
  UNSUPPORTED_STATE_COMPONENT: "unsupported_state_component",
  ENTITY_TAX_CAVEAT: "entity_tax_caveat",
  PROVISIONAL_STATE_RESERVE: "provisional_state_reserve",
  PROVISIONAL_STATE_RESERVE_BUFFER: "provisional_state_reserve_buffer",
});

export const STATE_COMPONENT_STATUSES = freeze({
  VERIFIED_CALCULATED: "verified_calculated",
  VERIFIED_ZERO: "verified_zero",
  PARTIAL: "partial",
  DEFERRED: "deferred",
  UNAVAILABLE: "unavailable",
  UNSUPPORTED: "unsupported",
  NOT_APPLICABLE: "not_applicable",
});

export const STATE_TAX_WARNING_CODES = freeze({
  STATE_MISSING: "state_missing",
  STATE_RULE_MISSING: "state_rule_missing",
  STATE_RULE_UNVERIFIED: "state_rule_unverified",
  UNSUPPORTED_STATE: "unsupported_state",
  MULTI_STATE_UNSUPPORTED: "multi_state_unsupported",
  LOCAL_TAX_UNSUPPORTED: "local_tax_unsupported",
  PTE_TAX_UNSUPPORTED: "pte_tax_unsupported",
  S_CORP_ENTITY_TAX_UNKNOWN: "s_corp_entity_tax_unknown",
  S_CORP_MINIMUM_TAX_UNKNOWN: "s_corp_minimum_tax_unknown",
  STATE_QBI_ADJUSTMENT_UNKNOWN: "state_qbi_adjustment_unknown",
  STATE_DEDUCTION_ADJUSTMENT_UNKNOWN: "state_deduction_adjustment_unknown",
  OWNER_LEVEL_BUSINESS_INCOME_ELECTION_DEFERRED: "owner_level_business_income_election_deferred",
  STATE_CAPITAL_GAINS_EXCISE_TAX_UNKNOWN: "state_capital_gains_excise_tax_unknown",
  STATE_GROSS_RECEIPTS_TAX_UNKNOWN: "state_gross_receipts_tax_unknown",
  STATE_PAYROLL_EXCISE_TAX_UNKNOWN: "state_payroll_excise_tax_unknown",
  STATE_DEDUCTION_UNKNOWN: "state_deduction_unknown",
  STATE_WITHHOLDING_MISSING: "state_withholding_missing",
  STATE_INCOME_ALLOCATION_UNKNOWN: "state_income_allocation_unknown",
  ENTITY_TAX_CAVEAT: "entity_tax_caveat",
  PROVISIONAL_RESERVE_USED: "provisional_state_reserve_used",
});

export function stateWarning(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

export function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
