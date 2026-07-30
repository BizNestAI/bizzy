// /src/services/tax/taxMemoryKeys.js
import { STATE_CODES, normalizeStateCode } from "./taxDomain.js";
import { validationError } from "./taxErrors.js";

export const TAX_MEMORY_KEYS = Object.freeze({
  VEHICLE_BUSINESS_USE_PERCENT: "vehicle_business_use_percent",
  VEHICLE_DEDUCTION_METHOD: "vehicle_deduction_method",
  HOME_OFFICE_METHOD: "home_office_method",
  HOME_OFFICE_SQUARE_FEET: "home_office_square_feet",
  TOTAL_HOME_SQUARE_FEET: "total_home_square_feet",
  HEALTH_INSURANCE_TREATMENT: "health_insurance_treatment",
  RETIREMENT_PLAN_TYPE: "retirement_plan_type",
  RETIREMENT_CONTRIBUTION_TARGET: "retirement_contribution_target",
  HSA_ELIGIBLE: "hsa_eligible",
  MILEAGE_TRACKING_ENABLED: "mileage_tracking_enabled",
  MEALS_DEFAULT_BUSINESS_PURPOSE_REQUIRED: "meals_default_business_purpose_required",
  EQUIPMENT_CAPITALIZATION_THRESHOLD: "equipment_capitalization_threshold",
  DE_MINIMIS_SAFE_HARBOR_ELECTION: "de_minimis_safe_harbor_election",
  CPA_CONTACT_NAME: "cpa_contact_name",
  CPA_CONTACT_EMAIL: "cpa_contact_email",
  CPA_INSTRUCTION_NOTES: "cpa_instruction_notes",
  PREFERRED_TAX_RESERVE_BUFFER_PERCENT: "preferred_tax_reserve_buffer_percent",
  STATE_LOCAL_TAX_NOTES: "state_local_tax_notes",
  MULTI_STATE_OPERATIONS: "multi_state_operations",
  OWNER_WAGE_POLICY: "owner_wage_policy",
  QBI_ASSUMPTION_NOTES: "qbi_assumption_notes",
});

const ALL_ENTITIES = Object.freeze(["sole_proprietor", "single_member_llc", "s_corp", "unknown"]);

export const TAX_MEMORY_KEY_DEFINITIONS = Object.freeze({
  vehicle_business_use_percent: def("number", "Business-use percent for vehicle deductions.", { annualReview: true, min: 0, max: 100 }),
  vehicle_deduction_method: def("enum", "Preferred vehicle deduction method.", { allowedValues: ["standard_mileage", "actual_expense", "undecided"], annualReview: true }),
  home_office_method: def("enum", "Home office deduction method.", { allowedValues: ["simplified", "actual_expense", "none", "undecided"], annualReview: true }),
  home_office_square_feet: def("number", "Business-use home office square feet.", { min: 0, annualReview: true }),
  total_home_square_feet: def("number", "Total home square feet for allocation.", { min: 0, annualReview: true }),
  health_insurance_treatment: def("enum", "Health insurance tax treatment.", { allowedValues: ["self_employed_health_insurance", "payroll_benefit", "none", "undecided"], annualReview: true }),
  retirement_plan_type: def("string", "Retirement plan type used for planning.", { annualReview: true }),
  retirement_contribution_target: def("money", "Target retirement contribution for the year.", { annualReview: true }),
  hsa_eligible: def("boolean", "Whether owner is HSA eligible.", { annualReview: true }),
  mileage_tracking_enabled: def("boolean", "Whether mileage tracking is enabled.", { annualReview: false }),
  meals_default_business_purpose_required: def("boolean", "Whether meals require business-purpose review by default.", { annualReview: false }),
  equipment_capitalization_threshold: def("money", "Equipment capitalization threshold.", { annualReview: true }),
  de_minimis_safe_harbor_election: def("boolean", "Whether de minimis safe harbor election is intended.", { annualReview: true }),
  cpa_contact_name: def("string", "CPA contact name.", { sensitive: true }),
  cpa_contact_email: def("email", "CPA contact email.", { sensitive: true }),
  cpa_instruction_notes: def("string", "CPA instruction notes.", { sensitive: true, annualReview: true }),
  preferred_tax_reserve_buffer_percent: def("number", "Preferred tax reserve buffer percent.", { min: 0, max: 100, annualReview: true }),
  state_local_tax_notes: def("string", "State/local tax notes.", { sensitive: true, annualReview: true }),
  multi_state_operations: def("state_array", "States where the business operates.", { annualReview: true }),
  owner_wage_policy: def("string", "Owner wage policy notes.", { applicableEntityTypes: ["s_corp"], sensitive: true, annualReview: true }),
  qbi_assumption_notes: def("string", "QBI assumption notes.", { sensitive: true, annualReview: true }),
});

export const TaxMemoryKeySet = Object.freeze(new Set(Object.keys(TAX_MEMORY_KEY_DEFINITIONS)));

function def(valueType, description, opts = {}) {
  return Object.freeze({
    valueType,
    description,
    allowedValues: opts.allowedValues || null,
    sensitive: Boolean(opts.sensitive),
    annualReview: opts.annualReview !== false,
    applicableEntityTypes: Object.freeze(opts.applicableEntityTypes || ALL_ENTITIES),
    min: opts.min,
    max: opts.max,
  });
}

export function getTaxMemoryKeyDefinition(memoryKey) {
  return TAX_MEMORY_KEY_DEFINITIONS[String(memoryKey || "")] || null;
}

export function validateTaxMemoryValue(memoryKey, value) {
  const key = String(memoryKey || "").trim();
  const definition = getTaxMemoryKeyDefinition(key);
  if (!definition) {
    throw validationError("invalid_tax_memory_key", "Tax memory key is not supported.", { memoryKey: key });
  }

  switch (definition.valueType) {
    case "number": return validateNumber(key, value, definition);
    case "money": return validateNumber(key, value, { ...definition, min: definition.min ?? 0 });
    case "enum": return validateEnum(key, value, definition.allowedValues);
    case "boolean": return validateBoolean(key, value);
    case "email": return validateEmail(key, value);
    case "state_array": return validateStateArray(key, value);
    case "string":
    default: return validateString(key, value);
  }
}

function validateNumber(key, value, definition) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw invalidValue(key, "Value must be a finite number.");
  if (definition.min != null && n < definition.min) throw invalidValue(key, `Value must be at least ${definition.min}.`);
  if (definition.max != null && n > definition.max) throw invalidValue(key, `Value must be at most ${definition.max}.`);
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function validateEnum(key, value, allowedValues = []) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!allowedValues.includes(normalized)) throw invalidValue(key, "Value is not allowed.", { allowedValues });
  return normalized;
}

function validateBoolean(key, value) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalidValue(key, "Value must be boolean.");
}

function validateEmail(key, value) {
  const text = validateString(key, value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw invalidValue(key, "Value must be an email address.");
  return text;
}

function validateStateArray(key, value) {
  if (!Array.isArray(value)) throw invalidValue(key, "Value must be an array of state codes.");
  const states = value.map(normalizeStateCode);
  if (states.some((state) => !state)) throw invalidValue(key, "All states must be valid US state/DC codes.", { validStates: STATE_CODES });
  return [...new Set(states)];
}

function validateString(key, value) {
  if (value == null) throw invalidValue(key, "Value is required.");
  const text = String(value).trim();
  if (!text) throw invalidValue(key, "Value cannot be blank.");
  return text;
}

function invalidValue(memoryKey, message, details = {}) {
  return validationError("invalid_tax_memory_value", message, { memoryKey, ...details });
}
