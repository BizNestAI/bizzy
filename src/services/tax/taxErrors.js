// /src/services/tax/taxErrors.js

export class TaxEngineError extends Error {
  constructor({ code, message, status = 400, details = undefined, safeToExpose = true }) {
    super(message);
    this.name = "TaxEngineError";
    this.code = code || "tax_error";
    this.status = Number(status) || 400;
    this.details = details;
    this.safeToExpose = safeToExpose !== false;
  }
}

function makeError(code, message, status, details, safeToExpose = true) {
  return new TaxEngineError({ code, message, status, details, safeToExpose });
}

export const validationError = (code = "validation_error", message = "Invalid tax request.", details) =>
  makeError(code, message, 422, details);

export const unauthorizedError = (message = "Authentication is required.", details) =>
  makeError("unauthorized", message, 401, details);

export const forbiddenBusinessError = (message = "You do not have access to this business.", details) =>
  makeError("business_access_denied", message, 403, details);

export const notFoundError = (code = "not_found", message = "The requested tax resource was not found.", details) =>
  makeError(code, message, 404, details);

export const conflictError = (code = "conflict", message = "The tax resource is in conflict.", details) =>
  makeError(code, message, 409, details);

export const taxConfigurationError = (code = "tax_rule_config_missing", message = "Tax configuration is unavailable.", details) =>
  makeError(code, message, 500, details);

export const taxCalculationError = (code = "tax_calculation_failed", message = "Tax calculation failed.", details) =>
  makeError(code, message, 500, details, false);

export const unsupportedTaxScenarioError = (code = "unsupported_tax_scenario", message = "This tax scenario is not supported yet.", details) =>
  makeError(code, message, 422, details);

export const dataUnavailableError = (message = "Tax data is temporarily unavailable.", details) =>
  makeError("tax_data_unavailable", message, 503, details);

export const TAX_ERROR_CODES = Object.freeze({
  INVALID_TAX_YEAR: "invalid_tax_year",
  INVALID_STATE_CODE: "invalid_state_code",
  INVALID_ENTITY_TYPE: "invalid_entity_type",
  INVALID_FILING_STATUS: "invalid_filing_status",
  MISSING_BUSINESS_ID: "missing_business_id",
  BUSINESS_ACCESS_DENIED: "business_access_denied",
  TAX_PROFILE_NOT_FOUND: "tax_profile_not_found",
  TAX_PROFILE_INCOMPLETE: "tax_profile_incomplete",
  TAX_RULE_CONFIG_MISSING: "tax_rule_config_missing",
  UNSUPPORTED_STATE_TAX_RULE: "unsupported_state_tax_rule",
  INVALID_TAX_PAYMENT: "invalid_tax_payment",
  TAX_DATA_UNAVAILABLE: "tax_data_unavailable",
  TAX_CALCULATION_FAILED: "tax_calculation_failed",
});

export function isTaxEngineError(err) {
  return err instanceof TaxEngineError || Boolean(err?.code && err?.status);
}
