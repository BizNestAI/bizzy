// /src/api/tax/taxValidation.js
import {
  TaxCalculationTypeSet,
  TaxTriggerSourceSet,
  TaxEntityTypeSet,
  TaxFilingStatusSet,
  TaxProfileSourceSet,
  DEDUCTIBILITY_STATUSES,
  TAX_CLASSIFICATION_STATUSES,
  TAX_CALCULATION_TYPES,
  TAX_TRIGGER_SOURCES,
  normalizeTaxYear,
  normalizeDateOnly,
  normalizeMoney,
  normalizePercent,
  normalizeEntityType,
  normalizeFilingStatus,
  normalizeStateCode,
  normalizeProfileSource,
  normalizePaymentType,
  isValidUuid,
} from "../../services/tax/taxDomain.js";
import { TAX_ERROR_CODES, validationError } from "../../services/tax/taxErrors.js";

const MAX_PROJECTION_OVERRIDE_BYTES = 12_000;
const MAX_PROJECTION_OVERRIDE_MONTHS = 36;
const MAX_CLASSIFICATION_REASON_LENGTH = 1200;

export function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw validationError(`missing_${field}`, `${field} is required.`, { field });
  }
  return value.trim();
}

export function optionalString(value, field) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw validationError(`invalid_${field}`, `${field} must be a string.`, { field });
  }
  return value.trim() || null;
}

export function requireUuid(value, field) {
  const v = requireString(value, field);
  if (!isValidUuid(v)) {
    throw validationError(`invalid_${field}`, `${field} must be a valid UUID.`, { field });
  }
  return v;
}

export function optionalUuid(value, field) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !isValidUuid(value.trim())) {
    throw validationError(`invalid_${field}`, `${field} must be a valid UUID.`, { field });
  }
  return value.trim();
}

export function requireTaxYear(value) {
  const year = normalizeTaxYear(value);
  if (!year) {
    throw validationError(TAX_ERROR_CODES.INVALID_TAX_YEAR, "Tax year must be between 2000 and 2100.", {
      field: "year",
    });
  }
  return year;
}

export function optionalTaxYear(value, fallback = new Date().getFullYear()) {
  if (value == null || value === "") return requireTaxYear(fallback);
  return requireTaxYear(value);
}

export function optionalDate(value, field) {
  if (value == null || value === "") return null;
  const normalized = normalizeDateOnly(value);
  if (!normalized) {
    throw validationError(`invalid_${field}`, `${field} must be a YYYY-MM-DD date.`, { field });
  }
  return normalized;
}

export function optionalMoney(value, field) {
  if (value == null || value === "") return null;
  const normalized = normalizeMoney(value);
  if (normalized == null) {
    throw validationError(`invalid_${field}`, `${field} must be a finite number.`, { field });
  }
  return normalized;
}

export function optionalPercent(value, field) {
  if (value == null || value === "") return null;
  const normalized = normalizePercent(value);
  if (normalized == null || normalized < 0 || normalized > 1) {
    throw validationError(`invalid_${field}`, `${field} must be a decimal between 0 and 1.`, { field });
  }
  return normalized;
}

export function optionalEnum(value, allowedValues, field) {
  if (value == null || value === "") return null;
  const allowed = allowedValues instanceof Set ? allowedValues : new Set(allowedValues || []);
  const normalized = String(value).trim().toLowerCase();
  if (!allowed.has(normalized)) {
    throw validationError(`invalid_${field}`, `${field} is not supported.`, { field, allowed: [...allowed] });
  }
  return normalized;
}

export function validatePagination({ limit, offset, cursor } = {}) {
  const out = {};
  if (limit != null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 250) {
      throw validationError("invalid_limit", "limit must be an integer from 1 to 250.", { field: "limit" });
    }
    out.limit = n;
  }
  if (offset != null) {
    const n = Number(offset);
    if (!Number.isInteger(n) || n < 0) {
      throw validationError("invalid_offset", "offset must be a non-negative integer.", { field: "offset" });
    }
    out.offset = n;
  }
  if (cursor != null) out.cursor = requireString(cursor, "cursor");
  return out;
}

export function validateBusinessIdInput(req) {
  const source = req?.params?.businessId ?? req?.body?.businessId ?? req?.body?.business_id ?? req?.query?.businessId ?? req?.query?.business_id ?? req?.businessId ?? req?.user?.business_id;
  if (!source) {
    throw validationError(TAX_ERROR_CODES.MISSING_BUSINESS_ID, "businessId is required.", { field: "businessId" });
  }
  return requireUuid(source, "businessId");
}

export function validateTaxCalculationRequest(req) {
  const body = req?.body || {};
  const businessId = validateBusinessIdInput(req);
  const taxYear = optionalTaxYear(body.year ?? body.taxYear, new Date().getFullYear());
  const asOfDate = optionalDate(body.asOfDate, "asOfDate");
  const calculationType =
    optionalEnum(body.calculationType, TaxCalculationTypeSet, "calculationType") ||
    TAX_CALCULATION_TYPES.FULL_ESTIMATE;
  const triggerSource =
    optionalEnum(body.triggerSource, TaxTriggerSourceSet, "triggerSource") ||
    TAX_TRIGGER_SOURCES.PAGE_REFRESH;
  const projectionOverride = validateProjectionOverride(body.projectionOverride);

  return { businessId, taxYear, asOfDate, calculationType, triggerSource, projectionOverride };
}

export function validateTaxProfilePayload(req) {
  const body = req?.body || {};
  const businessId = validateBusinessIdInput(req);
  const state = body.state == null ? null : normalizeStateCode(body.state);
  if (body.state != null && !state) {
    throw validationError(TAX_ERROR_CODES.INVALID_STATE_CODE, "State code must be a valid US state or DC.", { field: "state" });
  }
  const entityType = normalizeEntityType(body.entityType ?? body.entity_type);
  if (body.entityType != null || body.entity_type != null) assertKnown(entityType, TaxEntityTypeSet, TAX_ERROR_CODES.INVALID_ENTITY_TYPE, "entityType");
  const filingStatus = normalizeFilingStatus(body.filingStatus ?? body.filing_status);
  if (body.filingStatus != null || body.filing_status != null) assertKnown(filingStatus, TaxFilingStatusSet, TAX_ERROR_CODES.INVALID_FILING_STATUS, "filingStatus");
  const source = body.source == null ? null : normalizeProfileSource(body.source);
  if (body.source != null && !TaxProfileSourceSet.has(source)) {
    throw validationError("invalid_profile_source", "Profile source is not supported.", { field: "source" });
  }
  return { businessId, state, entityType, filingStatus, source };
}

export function validateTaxMemoryPayload(req) {
  const body = req?.body || {};
  return {
    businessId: validateBusinessIdInput(req),
    key: requireString(body.key, "key"),
    value: body.value,
  };
}

export function validateTaxPaymentPayload(req) {
  const body = req?.body || {};
  return {
    businessId: validateBusinessIdInput(req),
    paymentType: normalizePaymentType(body.paymentType ?? body.payment_type),
    amount: optionalMoney(body.amount, "amount"),
    paymentDate: optionalDate(body.paymentDate ?? body.payment_date, "paymentDate"),
    taxYear: optionalTaxYear(body.year ?? body.taxYear, new Date().getFullYear()),
  };
}

export function validateTaxClassificationOverridePayload(req) {
  const body = req?.body || {};
  const deductibilityStatus = normalizeDeductibilityStatus(body.deductibilityStatus ?? body.deductibility_status);
  const taxCategory = optionalString(body.taxCategory ?? body.tax_category, "taxCategory");
  const reason = optionalReason(body.reason, "reason");
  const taxTreatment = normalizeTaxTreatment(body.taxTreatment ?? body.tax_treatment);
  const rawPercent = body.deductiblePercent ?? body.deductible_percent;
  const deductiblePercent = normalizeOverridePercent({ deductibilityStatus, value: rawPercent });
  if ((taxCategory || deductibilityStatus || taxTreatment) && !taxCategory) {
    throw validationError("missing_tax_category", "taxCategory is required when changing tax treatment.", { field: "taxCategory" });
  }
  return {
    businessId: validateBusinessIdInput(req),
    taxCategory,
    deductibilityStatus,
    deductiblePercent,
    taxTreatment,
    reason,
    confirmationType: normalizeConfirmationType(body.confirmationType ?? body.confirmation_type),
    createBusinessRule: body.createBusinessRule === true || body.create_business_rule === true,
    businessRuleOptions: validateBusinessRuleOptions(body.businessRuleOptions ?? body.business_rule_options),
    expectedUpdatedAt: optionalString(body.expectedUpdatedAt ?? body.expected_updated_at, "expectedUpdatedAt"),
  };
}

function normalizeDeductibilityStatus(value) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim().toLowerCase();
  if (!Object.values(DEDUCTIBILITY_STATUSES).includes(normalized)) {
    throw validationError("invalid_deductibility_status", "Deductibility status is not supported.", { field: "deductibilityStatus" });
  }
  return normalized;
}

function normalizeOverridePercent({ deductibilityStatus, value }) {
  if (deductibilityStatus === DEDUCTIBILITY_STATUSES.FULLY_DEDUCTIBLE) return 100;
  if ([DEDUCTIBILITY_STATUSES.NONDEDUCTIBLE, DEDUCTIBILITY_STATUSES.CAPITALIZABLE, DEDUCTIBILITY_STATUSES.BALANCE_SHEET].includes(deductibilityStatus)) return 0;
  if (value == null || value === "") {
    if (deductibilityStatus === DEDUCTIBILITY_STATUSES.PARTIALLY_DEDUCTIBLE) {
      throw validationError("missing_deductible_percent", "deductiblePercent is required for partial deductions.", { field: "deductiblePercent" });
    }
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw validationError("invalid_deductible_percent", "deductiblePercent must be between 0 and 100.", { field: "deductiblePercent" });
  }
  return n;
}

function normalizeTaxTreatment(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw validationError("invalid_tax_treatment", "taxTreatment must be a string.", { field: "taxTreatment" });
  const text = value.trim();
  if (!text || text.length > 120) throw validationError("invalid_tax_treatment", "taxTreatment is too long.", { field: "taxTreatment" });
  return { type: text };
}

function normalizeConfirmationType(value) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim().toLowerCase();
  if (!["user", "cpa"].includes(normalized)) {
    throw validationError("invalid_confirmation_type", "confirmationType must be user or cpa.", { field: "confirmationType" });
  }
  return normalized;
}

function optionalReason(value, field) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw validationError(`invalid_${field}`, `${field} must be a string.`, { field });
  const trimmed = value.trim();
  if (trimmed.length > MAX_CLASSIFICATION_REASON_LENGTH) {
    throw validationError(`${field}_too_long`, `${field} is too long.`, { field, maxLength: MAX_CLASSIFICATION_REASON_LENGTH });
  }
  return trimmed || null;
}

function validateBusinessRuleOptions(value) {
  if (value == null) return null;
  if (Array.isArray(value) || typeof value !== "object") {
    throw validationError("invalid_business_rule_options", "businessRuleOptions must be an object.", { field: "businessRuleOptions" });
  }
  const matchType = optionalString(value.matchType ?? value.match_type, "matchType");
  if (!["qbo_account", "bookkeeping_category", "merchant_entity", "merchant_plus_account"].includes(matchType)) {
    throw validationError("invalid_business_rule_match_type", "Business rule match type is not supported.", { field: "businessRuleOptions.matchType" });
  }
  return {
    matchType,
    ruleCode: optionalString(value.ruleCode ?? value.rule_code, "ruleCode"),
    explanation: optionalReason(value.explanation, "explanation"),
  };
}

export function validateProjectionOverride(value) {
  if (value == null) return {};
  if (Array.isArray(value) || typeof value !== "object") {
    throw validationError("invalid_projection_override", "projectionOverride must be an object.", {
      field: "projectionOverride",
    });
  }

  const text = JSON.stringify(value);
  if (text.length > MAX_PROJECTION_OVERRIDE_BYTES) {
    throw validationError("projection_override_too_large", "projectionOverride is too large.", {
      field: "projectionOverride",
      maxBytes: MAX_PROJECTION_OVERRIDE_BYTES,
    });
  }

  const overrides = value.overrides;
  if (overrides == null) return { ...value };
  if (Array.isArray(overrides) || typeof overrides !== "object") {
    throw validationError("invalid_projection_override", "projectionOverride.overrides must be an object.", {
      field: "projectionOverride.overrides",
    });
  }

  const months = Object.keys(overrides);
  if (months.length > MAX_PROJECTION_OVERRIDE_MONTHS) {
    throw validationError("projection_override_too_large", "projectionOverride contains too many months.", {
      field: "projectionOverride.overrides",
      maxMonths: MAX_PROJECTION_OVERRIDE_MONTHS,
    });
  }

  for (const month of months) {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw validationError("invalid_projection_override", "projectionOverride month keys must use YYYY-MM.", {
        field: `projectionOverride.overrides.${month}`,
      });
    }
    const row = overrides[month];
    if (Array.isArray(row) || typeof row !== "object" || row == null) {
      throw validationError("invalid_projection_override", "Each projection override month must be an object.", {
        field: `projectionOverride.overrides.${month}`,
      });
    }
    for (const [key, raw] of Object.entries(row)) {
      if (!["revenue", "expenses", "profit", "taxes_paid"].includes(key)) {
        throw validationError("invalid_projection_override", "Projection override includes an unsupported field.", {
          field: `projectionOverride.overrides.${month}.${key}`,
        });
      }
      if (optionalMoney(raw, `projectionOverride.overrides.${month}.${key}`) == null) {
        throw validationError("invalid_projection_override", "Projection override values must be finite numbers.", {
          field: `projectionOverride.overrides.${month}.${key}`,
        });
      }
    }
  }

  return { ...value, overrides: { ...overrides } };
}

function assertKnown(value, set, code, field) {
  if (!set.has(value) || value === "unknown") {
    throw validationError(code, `${field} is not supported.`, { field });
  }
}
