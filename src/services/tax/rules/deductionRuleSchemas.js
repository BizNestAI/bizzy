// /src/services/tax/rules/deductionRuleSchemas.js
import { DEDUCTIBILITY_STATUSES, TaxEntityTypeSet, TaxJurisdictionSet, normalizeEntityType } from "../taxDomain.js";
import { validationError } from "../taxErrors.js";
import { assertFiniteNumber, assertObject } from "./ruleSchemaUtils.js";

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
  if (row.match_conditions != null) assertObject(row.match_conditions, "match_conditions");
  return row;
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
