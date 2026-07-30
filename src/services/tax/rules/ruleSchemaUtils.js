// /src/services/tax/rules/ruleSchemaUtils.js
import {
  TaxEntityTypeSet,
  TaxFilingStatusSet,
  TaxJurisdictionSet,
  TaxRuleSupportLevelSet,
  normalizeDateOnly,
  normalizeEntityType,
  normalizeFilingStatus,
  normalizeStateCode,
  normalizeTaxYear,
} from "../taxDomain.js";
import { validationError } from "../taxErrors.js";
import { getSupportRank } from "./taxRuleSafety.js";

export function assertObject(value, field = "config") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError(`invalid_${field}`, `${field} must be an object.`, { field });
  }
  return value;
}

export function assertFiniteNumber(value, field, { min = -Infinity, max = Infinity, allowNull = false } = {}) {
  if (value == null && allowNull) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw validationError(`invalid_${field}`, `${field} must be a finite number${Number.isFinite(min) ? ` >= ${min}` : ""}${Number.isFinite(max) ? ` <= ${max}` : ""}.`, { field });
  }
  return n;
}

export function assertRate(value, field) {
  return assertFiniteNumber(value, field, { min: 0, max: 1 });
}

export function assertBoolean(value, field, { optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== "boolean") throw validationError(`invalid_${field}`, `${field} must be boolean.`, { field });
  return value;
}

export function assertString(value, field, { optional = false } = {}) {
  if ((value == null || value === "") && optional) return null;
  if (typeof value !== "string" || !value.trim()) throw validationError(`invalid_${field}`, `${field} must be a non-empty string.`, { field });
  return value.trim();
}

export function validateBrackets(brackets, field = "config.brackets") {
  if (!Array.isArray(brackets) || !brackets.length) {
    throw validationError("invalid_tax_brackets", `${field} must be a non-empty array.`, { field });
  }
  let previous = -Infinity;
  return brackets.map((bracket, index) => {
    assertObject(bracket, `${field}.${index}`);
    const upTo = bracket.upTo == null ? null : assertFiniteNumber(bracket.upTo, `${field}.${index}.upTo`, { min: 0 });
    const rate = assertRate(bracket.rate, `${field}.${index}.rate`);
    if (upTo == null && index !== brackets.length - 1) {
      throw validationError("invalid_tax_brackets", "Only the final bracket may use upTo = null.", { field: `${field}.${index}.upTo` });
    }
    if (upTo != null && upTo <= previous) {
      throw validationError("invalid_tax_brackets", "Tax brackets must be ordered by increasing upTo thresholds.", { field: `${field}.${index}.upTo` });
    }
    if (upTo != null) previous = upTo;
    return { upTo, rate };
  });
}

export function validateCommonRuleRow(row, { state = false } = {}) {
  assertObject(row, "row");
  const taxYear = normalizeTaxYear(row.tax_year);
  if (!taxYear) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "tax_year" });
  if (state && !normalizeStateCode(row.state_code)) {
    throw validationError("invalid_state_code", "State code must be a valid US state or DC.", { field: "state_code" });
  }
  if (!state && row.jurisdiction && !TaxJurisdictionSet.has(row.jurisdiction)) {
    throw validationError("invalid_jurisdiction", "Jurisdiction is not supported.", { field: "jurisdiction" });
  }
  if (row.filing_status != null && !TaxFilingStatusSet.has(normalizeFilingStatus(row.filing_status))) {
    throw validationError("invalid_filing_status", "Filing status is not supported.", { field: "filing_status" });
  }
  if (row.entity_type != null && !TaxEntityTypeSet.has(normalizeEntityType(row.entity_type))) {
    throw validationError("invalid_entity_type", "Entity type is not supported.", { field: "entity_type" });
  }
  if (!TaxRuleSupportLevelSet.has(row.support_level)) {
    throw validationError("invalid_support_level", "Support level is not supported.", { field: "support_level" });
  }
  if (row.verified_at && !normalizeDateLike(row.verified_at)) {
    throw validationError("invalid_verified_at", "verified_at must be a valid date.", { field: "verified_at" });
  }
  if (row.effective_from && !normalizeDateOnly(row.effective_from)) {
    throw validationError("invalid_effective_from", "effective_from must be a valid date.", { field: "effective_from" });
  }
  if (row.effective_to && !normalizeDateOnly(row.effective_to)) {
    throw validationError("invalid_effective_to", "effective_to must be a valid date.", { field: "effective_to" });
  }
  if (row.support_level === "verified") {
    assertString(row.source_name, "source_name");
    assertString(row.source_url, "source_url");
    assertString(row.verified_at, "verified_at");
  }
  if (row.is_active && getSupportRank(row.support_level) >= getSupportRank("supported")) {
    const config = assertObject(row.config, "config");
    if (!Object.keys(config).length) {
      throw validationError("empty_tax_rule_config", "Active supported tax rule config cannot be empty.", { field: "config" });
    }
  }
  return row;
}

function normalizeDateLike(value) {
  if (normalizeDateOnly(value)) return true;
  return normalizeDateOnly(String(value || "").slice(0, 10));
}
