import {
  ACCOUNTING_METHOD_OPTIONS,
  FILING_STATUS_OPTIONS,
  LLC_ELECTION_OPTIONS,
  MONEY_FIELDS,
  SAFE_HARBOR_OPTIONS,
  TAX_PROFILE_FIELDS,
  US_STATE_OPTIONS,
  isSCorp,
  isSoleOrDisregarded,
} from "./taxProfileFields.js";
import { getStepFields } from "./taxSetupSteps.js";

const ENTITY_VALUES = new Set(["sole_proprietor", "single_member_llc", "s_corp", "unknown", "unsupported"]);
const LLC_ELECTION_VALUES = new Set(LLC_ELECTION_OPTIONS.map((option) => option.value));
const FILING_VALUES = new Set(FILING_STATUS_OPTIONS.map((option) => option.value));
const STATE_VALUES = new Set(US_STATE_OPTIONS.map((option) => option.value));
const ACCOUNTING_VALUES = new Set(ACCOUNTING_METHOD_OPTIONS.map((option) => option.value));
const SAFE_HARBOR_VALUES = new Set(SAFE_HARBOR_OPTIONS.map((option) => option.value));

export function validateTaxSetup(values = {}, { stepId = null, fieldsOverride = null } = {}) {
  const errors = {};
  const fields = Array.isArray(fieldsOverride)
    ? fieldsOverride
    : stepId ? getStepFields(stepId, values) : Object.keys(TAX_PROFILE_FIELDS);

  if (fields.includes("entity_type")) {
    if (!values.entity_type) errors.entity_type = "Choose a business tax structure.";
    else if (!ENTITY_VALUES.has(values.entity_type)) errors.entity_type = "Choose a supported business tax structure.";
    else if (values.entity_type === "unknown") errors.entity_type = "Confirm the entity type before relying on an estimate.";
    else if (values.entity_type === "unsupported") errors.entity_type = "This entity type is not supported by the current estimate engine.";
  }

  if (values.entity_type === "single_member_llc" && fields.includes("tax_election")) {
    if (!values.tax_election || values.tax_election === "unknown") errors.tax_election = "Confirm how the single-member LLC is taxed.";
    else if (!LLC_ELECTION_VALUES.has(values.tax_election)) errors.tax_election = "Choose a valid LLC election.";
  }

  if (fields.includes("filing_status")) {
    if (!values.filing_status || values.filing_status === "unknown") errors.filing_status = "Filing status is required for the federal estimate.";
    else if (!FILING_VALUES.has(values.filing_status)) errors.filing_status = "Choose a valid filing status.";
  }

  if (fields.includes("primary_tax_state")) {
    if (!values.primary_tax_state) errors.primary_tax_state = "Confirm the primary tax state.";
    else if (!STATE_VALUES.has(String(values.primary_tax_state).toUpperCase())) errors.primary_tax_state = "Choose a valid US state or DC.";
  }

  if (fields.includes("accounting_method")) {
    if (!values.accounting_method || values.accounting_method === "other") errors.accounting_method = "Confirm the accounting method when available.";
    else if (!ACCOUNTING_VALUES.has(values.accounting_method)) errors.accounting_method = "Choose a valid accounting method.";
  }

  if (fields.includes("safe_harbor_method")) {
    if (!values.safe_harbor_method || values.safe_harbor_method === "unknown") errors.safe_harbor_method = "Choose a safe-harbor planning method.";
    else if (!SAFE_HARBOR_VALUES.has(values.safe_harbor_method)) errors.safe_harbor_method = "Choose a valid safe-harbor method.";
  }

  if (fields.includes("self_employment_tax_applies") && isSoleOrDisregarded(values)) {
    const value = values.self_employment_tax_applies;
    if (value === "" || value == null) {
      errors.self_employment_tax_applies = "Confirm whether this business income is subject to self-employment tax.";
    } else if (![true, false, "true", "false"].includes(value)) {
      errors.self_employment_tax_applies = "Choose yes or no for self-employment tax.";
    }
  }

  if (isSCorp(values)) {
    if (fields.includes("owner_reasonable_salary")) requireNonnegativeMoney(values, "owner_reasonable_salary", errors, "Add the established reasonable salary target.");
    if (fields.includes("owner_w2_wages_ytd")) requireNonnegativeMoney(values, "owner_w2_wages_ytd", errors, "Add owner W-2 wages YTD.");
  }

  if (["prior_year_100", "prior_year_110"].includes(values.safe_harbor_method) && fields.includes("prior_year_total_tax")) {
    requireNonnegativeMoney(values, "prior_year_total_tax", errors, "Add prior-year total tax for this safe-harbor method.");
  }
  if (values.safe_harbor_method === "prior_year_110" && fields.includes("prior_year_agi")) {
    requireNonnegativeMoney(values, "prior_year_agi", errors, "Add prior-year AGI for the 110% method.");
  }

  for (const field of fields) {
    if (MONEY_FIELDS.includes(field) && values[field] !== "" && values[field] != null && !isFiniteNonnegative(values[field])) {
      errors[field] ||= "Enter a nonnegative amount.";
    }
  }

  if (fields.includes("reserve_buffer_percent") && values.reserve_buffer_percent !== "" && values.reserve_buffer_percent != null) {
    const percent = Number(values.reserve_buffer_percent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      errors.reserve_buffer_percent = "Enter a reserve buffer from 0 to 100%.";
    }
  }

  return errors;
}

export function buildTaxProfilePatch(values = {}, { confirmedFields = new Set() } = {}) {
  const out = {
    source: "user",
  };

  const candidateFields = [
    "entity_type", "tax_election", "filing_status", "primary_tax_state", "accounting_method",
    "qbi_eligible", "self_employment_tax_applies", "safe_harbor_method", "prior_year_total_tax",
    "prior_year_agi", "owner_reasonable_salary", "owner_w2_wages_ytd", "federal_withholding_ytd",
    "state_withholding_ytd", "health_insurance_deduction_ytd", "retirement_contributions_ytd",
    "hsa_contributions_ytd", "reserve_buffer_percent",
  ];

  for (const field of candidateFields) {
    if (!confirmedFields.has(field)) continue;
    const value = normalizePatchValue(field, values[field]);
    if (value !== undefined) out[field] = value;
  }

  if (!isSCorp(values)) {
    delete out.owner_reasonable_salary;
    delete out.owner_w2_wages_ytd;
  }
  if (!isSoleOrDisregarded(values)) {
    delete out.self_employment_tax_applies;
  }
  if (!["prior_year_100", "prior_year_110"].includes(values.safe_harbor_method)) {
    delete out.prior_year_total_tax;
    delete out.prior_year_agi;
  }
  if (values.safe_harbor_method !== "prior_year_110") {
    delete out.prior_year_agi;
  }

  return out;
}

export function buildMemoryPayloads(memoryValues = {}, changedKeys = new Set()) {
  return Array.from(changedKeys)
    .filter((memoryKey) => memoryValues[memoryKey] !== undefined)
    .map((memoryKey) => ({
      memoryKey,
      value: memoryValues[memoryKey],
      source: "user",
      confidenceScore: 1,
      metadata: { surface: "tax_setup_workflow" },
    }));
}

function requireNonnegativeMoney(values, field, errors, message) {
  if (values[field] === "" || values[field] == null) {
    errors[field] = message;
  } else if (!isFiniteNonnegative(values[field])) {
    errors[field] = "Enter a nonnegative amount.";
  }
}

function isFiniteNonnegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
}

function normalizePatchValue(field, value) {
  if (value === undefined || value === "") return undefined;
  if (field === "qbi_eligible" || field === "self_employment_tax_applies") {
    if (value == null) return null;
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    return undefined;
  }
  if (field === "reserve_buffer_percent") {
    if (value == null) return null;
    return Number(value) / 100;
  }
  if (MONEY_FIELDS.includes(field)) return value == null ? null : Number(value);
  if (field === "primary_tax_state") return value ? String(value).toUpperCase() : undefined;
  return value;
}
