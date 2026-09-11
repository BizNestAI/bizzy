// /src/services/tax/rules/deductionRuleSchemas.js
import { DEDUCTIBILITY_STATUSES, TaxEntityTypeSet, TaxJurisdictionSet, normalizeEntityType } from "../taxDomain.js";
import { validationError } from "../taxErrors.js";
import { assertFiniteNumber, assertObject } from "./ruleSchemaUtils.js";
import { normalizeQboGlAccountKey } from "../taxQboGlNormalizer.js";

const STRING_ARRAY_KEYS = new Set([
  "vendor_names",
  "entity_types",
  "taxonomy_types",
  "job_costing_tags",
  "qbo_account_names",
  "qbo_account_name_keys",
  "qbo_account_type_keys",
  "qbo_account_subtype_keys",
  "direction",
]);

const STRING_KEYS = new Set([
  "merchant_regex",
  "description_regex",
  "merchant_entity_id",
  "state_adjustment_hook",
]);

const NUMBER_KEYS = new Set([
  "minimum_amount",
  "min_amount",
  "maximum_amount",
  "max_amount",
]);

const BOOLEAN_KEYS = new Set([
  "requires_employee",
  "requires_reimbursement",
  "requires_inventory",
  "assigned_job_required",
]);

const METADATA_OBJECT_KEYS = new Set([
  "high_confidence",
  "medium_confidence",
  "needs_review",
]);

const METADATA_ARRAY_KEYS = new Set(["notes"]);

export function validateDeductionRuleShape(row) {
  assertObject(row, "row");
  if (!row.rule_code) throw validationError("invalid_deduction_rule", "Deduction rule requires rule_code.", { field: "rule_code" });
  if (!TaxJurisdictionSet.has(row.jurisdiction)) {
    throw validationError("invalid_jurisdiction", "Deduction rule jurisdiction is not supported.", { field: "jurisdiction" });
  }
  if (row.entity_type != null && !TaxEntityTypeSet.has(normalizeEntityType(row.entity_type))) {
    throw validationError("invalid_entity_type", "Deduction rule entity type is not supported.", { field: "entity_type" });
  }
  if (!Object.values(DEDUCTIBILITY_STATUSES).includes(row.deductibility_status)) {
    throw validationError("invalid_deductibility_status", "Deductibility status is not supported.", { field: "deductibility_status" });
  }
  assertDefaultDeductiblePercent(row.default_deductible_percent);
  if (row.match_conditions != null) validateDeductionMatchConditions(row);
  return row;
}

export function validateDeductionMatchConditions(row) {
  const conditions = assertObject(row.match_conditions, "match_conditions");
  for (const [key, value] of Object.entries(conditions)) {
    if (STRING_ARRAY_KEYS.has(key)) {
      validateStringArrayCondition({ key, value, normalized: key.endsWith("_keys") });
      continue;
    }
    if (STRING_KEYS.has(key) || key.endsWith("_regex")) {
      if (typeof value !== "string" || !value.trim()) throw invalidCondition(key, "must be a non-empty string.");
      continue;
    }
    if (NUMBER_KEYS.has(key)) {
      assertFiniteNumber(value, `match_conditions.${key}`);
      continue;
    }
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== "boolean") throw invalidCondition(key, "must be boolean.");
      continue;
    }
    if (METADATA_OBJECT_KEYS.has(key)) {
      assertObject(value, `match_conditions.${key}`);
      continue;
    }
    if (METADATA_ARRAY_KEYS.has(key)) {
      if (!Array.isArray(value)) throw invalidCondition(key, "must be an array.");
      continue;
    }
    throw validationError("unknown_deduction_match_condition", `Unsupported deduction match condition: ${key}.`, {
      field: `match_conditions.${key}`,
    });
  }
  if (row.qbo_account_subtype && Array.isArray(conditions.qbo_account_subtype_keys)) {
    const explicit = normalizeQboGlAccountKey(row.qbo_account_subtype);
    const keys = conditions.qbo_account_subtype_keys.map((value) => normalizeQboGlAccountKey(value));
    if (!keys.includes(explicit)) {
      throw validationError("conflicting_deduction_match_condition", "qbo_account_subtype conflicts with qbo_account_subtype_keys.", {
        field: "match_conditions.qbo_account_subtype_keys",
      });
    }
  }
  if (row.bookkeeping_category && Array.isArray(conditions.qbo_account_name_keys)) {
    const explicit = normalizeQboGlAccountKey(row.bookkeeping_category);
    const keys = conditions.qbo_account_name_keys.map((value) => normalizeQboGlAccountKey(value));
    if (!keys.includes(explicit)) {
      throw validationError("conflicting_deduction_match_condition", "bookkeeping_category conflicts with qbo_account_name_keys.", {
        field: "match_conditions.qbo_account_name_keys",
      });
    }
  }
  return conditions;
}

function assertDefaultDeductiblePercent(value) {
  if (value == null || value === "") {
    throw validationError("invalid_default_deductible_percent", "default_deductible_percent is required.", { field: "default_deductible_percent" });
  }
  if (typeof value === "string") {
    throw validationError("invalid_default_deductible_percent", "default_deductible_percent must be a numeric whole percentage from 0 to 100.", {
      field: "default_deductible_percent",
    });
  }
  assertFiniteNumber(value, "default_deductible_percent", { min: 0, max: 100 });
}

function validateStringArrayCondition({ key, value, normalized }) {
  if (!Array.isArray(value)) throw invalidCondition(key, "must be an array.");
  if (!value.length) throw invalidCondition(key, "must be a non-empty array.");
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !item.trim()) {
      throw validationError("invalid_deduction_match_condition", `match_conditions.${key} entries must be non-empty strings.`, {
        field: `match_conditions.${key}.${index}`,
      });
    }
    if (normalized && item !== normalizeQboGlAccountKey(item)) {
      throw validationError("invalid_deduction_match_condition", `match_conditions.${key} entries must be canonical normalized GL keys.`, {
        field: `match_conditions.${key}.${index}`,
      });
    }
  }
}

function invalidCondition(key, detail) {
  return validationError("invalid_deduction_match_condition", `match_conditions.${key} ${detail}`, {
    field: `match_conditions.${key}`,
  });
}
