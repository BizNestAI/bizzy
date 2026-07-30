// /src/services/tax/entity/entityDomain.js

const freeze = (value) => Object.freeze(value);

export const ENTITY_PATHS = freeze({
  SOLE_PROPRIETOR: "sole_proprietor",
  SINGLE_MEMBER_LLC_DISREGARDED: "single_member_llc_disregarded",
  S_CORPORATION: "s_corporation",
  UNSUPPORTED: "unsupported",
  UNKNOWN: "unknown",
});

export const ENTITY_TAX_TREATMENTS = freeze({
  SCHEDULE_C_LIKE: "schedule_c_like",
  PASS_THROUGH_S_CORP: "pass_through_s_corp",
  UNSUPPORTED: "unsupported",
});

export const ENTITY_ENGINE_APPLICABILITY = freeze({
  SELF_EMPLOYMENT_TAX: "self_employment_tax",
  S_CORP_PAYROLL: "s_corp_payroll",
  FEDERAL_INCOME_TAX: "federal_income_tax",
  STATE_INCOME_TAX: "state_income_tax",
  QBI_CANDIDATE: "qbi_candidate",
  SAFE_HARBOR: "safe_harbor",
  RESERVE: "reserve",
  PAYROLL_TAX_DIAGNOSTICS: "payroll_tax_diagnostics",
});

export const ENTITY_WARNING_CODES = freeze({
  ENTITY_TYPE_UNKNOWN: "entity_type_unknown",
  TAX_ELECTION_UNKNOWN: "tax_election_unknown",
  LLC_TAX_ELECTION_MISSING: "llc_tax_election_missing",
  S_CORP_ELECTION_UNCONFIRMED: "s_corp_election_unconfirmed",
  SELF_EMPLOYMENT_TAX_SETTING_CONFLICT: "self_employment_tax_setting_conflict",
  OWNER_SALARY_MISSING: "owner_salary_missing",
  OWNER_WAGES_MISSING: "owner_wages_missing",
  WITHHOLDING_MISSING: "withholding_missing",
  UNSUPPORTED_ENTITY: "unsupported_entity",
  PROFILE_INCOMPLETE: "profile_incomplete",
  ENTITY_PROFILE_CONFLICT: "entity_profile_conflict",
  QBI_ELIGIBILITY_UNKNOWN: "qbi_eligibility_unknown",
  ACCOUNTING_METHOD_UNKNOWN: "accounting_method_unknown",
  MULTI_MEMBER_LLC_UNSUPPORTED: "multi_member_llc_unsupported",
  PARTNERSHIP_UNSUPPORTED: "partnership_unsupported",
  C_CORP_UNSUPPORTED: "c_corp_unsupported",
});

export const ENTITY_BLOCKER_CODES = freeze({
  MISSING_ENTITY_TYPE: "missing_entity_type",
  MISSING_TAX_ELECTION: "missing_tax_election",
  UNSUPPORTED_ENTITY_TYPE: "unsupported_entity_type",
  INVALID_ENTITY_COMBINATION: "invalid_entity_combination",
  MISSING_S_CORP_ELECTION: "missing_s_corp_election",
  MISSING_REQUIRED_S_CORP_INPUTS: "missing_required_s_corp_inputs",
});

export const ENTITY_SUPPORT_STATUSES = freeze({
  SUPPORTED: "supported",
  PARTIAL: "partial",
  UNSUPPORTED: "unsupported",
  UNKNOWN: "unknown",
});

export const EntityPathSet = freeze(new Set(Object.values(ENTITY_PATHS)));

export function entityWarning(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

export function entityBlocker(code, message, extra = {}) {
  return { code, severity: "critical", message, ...extra };
}
