import { buildTaxProfilePatch, validateTaxSetup } from "./taxSetupValidation.js";
import { isSoleOrDisregarded } from "./taxProfileFields.js";

export const TAX_PROFILE_EMPTY_VALUES = {
  entity_type: "",
  tax_election: "",
  filing_status: "",
  primary_tax_state: "",
  accounting_method: "",
  safe_harbor_method: "",
  self_employment_tax_applies: "",
  prior_year_total_tax: "",
  prior_year_agi: "",
  owner_reasonable_salary: "",
  owner_w2_wages_ytd: "",
  federal_withholding_ytd: "",
  state_withholding_ytd: "",
  reserve_buffer_percent: "",
};

export const MINIMUM_TAX_PROFILE_FIELDS = [
  "entity_type",
  "filing_status",
  "primary_tax_state",
  "accounting_method",
  "safe_harbor_method",
  "self_employment_tax_applies",
];

export function getOnboardingTaxYear(asOf = new Date()) {
  const date = asOf instanceof Date ? asOf : new Date(asOf);
  const year = date.getFullYear();
  return Number.isFinite(year) ? year : new Date().getFullYear();
}

export function getOnboardingTaxProfileFields(values = {}) {
  const fields = [...MINIMUM_TAX_PROFILE_FIELDS];
  if (values.entity_type === "single_member_llc") fields.splice(1, 0, "tax_election");
  return fields.filter((field) => field !== "self_employment_tax_applies" || isSoleOrDisregarded(values));
}

export function validateOnboardingTaxProfile(values = {}) {
  return validateTaxSetup(values, { fieldsOverride: getOnboardingTaxProfileFields(values) });
}

export function buildOnboardingTaxProfilePatch(values = {}) {
  const confirmedFields = new Set(getOnboardingTaxProfileFields(values));
  return {
    ...buildTaxProfilePatch(values, { confirmedFields }),
    source: "onboarding",
  };
}

export function profileToTaxProfileValues(profile) {
  const source = profile || {};
  return {
    ...TAX_PROFILE_EMPTY_VALUES,
    ...source,
    entity_type: source.entity_type || source.entityType || "",
    tax_election: source.tax_election || source.taxElection || "",
    filing_status: source.filing_status || source.filingStatus || "",
    primary_tax_state: source.primary_tax_state || source.primaryState || source.state || "",
    accounting_method: source.accounting_method || source.accountingMethod || "",
    safe_harbor_method: source.safe_harbor_method || source.safeHarborMethod || "",
    self_employment_tax_applies: source.self_employment_tax_applies === true || source.selfEmploymentTaxApplies === true
      ? "true"
      : source.self_employment_tax_applies === false || source.selfEmploymentTaxApplies === false
        ? "false"
        : "",
    prior_year_total_tax: source.prior_year_total_tax ?? source.priorYearTotalTax ?? "",
    prior_year_agi: source.prior_year_agi ?? source.priorYearAgi ?? source.priorYearAGI ?? "",
    owner_reasonable_salary: source.owner_reasonable_salary ?? source.ownerReasonableSalary ?? "",
    owner_w2_wages_ytd: source.owner_w2_wages_ytd ?? source.ownerW2WagesYtd ?? source.ownerW2WagesYTD ?? source.ownerWagesYtd ?? "",
    federal_withholding_ytd: source.federal_withholding_ytd ?? source.federalWithholdingYtd ?? source.federalWithholdingYTD ?? "",
    state_withholding_ytd: source.state_withholding_ytd ?? source.stateWithholdingYtd ?? source.stateWithholdingYTD ?? "",
    reserve_buffer_percent: source.reserve_buffer_percent == null && source.reserveBufferPercent == null
      ? ""
      : Math.round(Number(source.reserve_buffer_percent ?? source.reserveBufferPercent) * 100),
  };
}

export function profileResultHasMinimumCompleteness(result = {}) {
  const completeness = result?.completeness || result?.profile?.completeness || null;
  const readiness = result?.readiness || result?.profile?.readiness || null;
  const missingRequired = completeness?.missingRequired || readiness?.missing_fields || [];
  return (
    readiness?.profile_status === "calculation_ready" ||
    readiness?.profile_status === "profile_ready" ||
    completeness?.isCompleteForEstimate === true ||
    (Array.isArray(missingRequired) && missingRequired.length === 0 && Boolean(result?.profile))
  );
}
