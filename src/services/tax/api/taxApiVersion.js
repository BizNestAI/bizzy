// /src/services/tax/api/taxApiVersion.js
import { validationError } from "../taxErrors.js";

export const TAX_API_VERSION = "2026-01";
export const TAX_CANONICAL_PAYLOAD_VERSION = "tax-calculation-v1";

export const TAX_API_INCLUDE_FIELDS = Object.freeze([
  "components",
  "explanations",
  "confidenceFactors",
  "deductions",
  "reserveHistory",
  "paymentDetails",
  "deadlines",
  "runChanges",
  "ruleSupport",
]);

const INCLUDE_SET = new Set(TAX_API_INCLUDE_FIELDS);
const MAX_INCLUDE_COUNT = 6;

export function resolveTaxApiVersion(reqOrValue) {
  const requested = typeof reqOrValue === "string"
    ? reqOrValue
    : reqOrValue?.headers?.["x-bizzi-tax-version"] || reqOrValue?.query?.apiVersion || reqOrValue?.body?.apiVersion;
  if (!requested) return TAX_API_VERSION;
  const normalized = String(requested).trim();
  if (normalized !== TAX_API_VERSION) {
    throw validationError("unsupported_tax_api_version", "Requested tax API version is not supported.", {
      requested: normalized,
      supported: [TAX_API_VERSION],
      action: "use_supported_tax_api_version",
    });
  }
  return normalized;
}

export function parseTaxApiIncludes(value) {
  if (value == null || value === "") return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const includes = [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))];
  if (includes.length > MAX_INCLUDE_COUNT) {
    throw validationError("too_many_tax_api_includes", "Too many include fields requested.", {
      max: MAX_INCLUDE_COUNT,
      allowed: TAX_API_INCLUDE_FIELDS,
    });
  }
  const unknown = includes.filter((item) => !INCLUDE_SET.has(item));
  if (unknown.length) {
    throw validationError("unknown_tax_api_include", "One or more include fields are not supported.", {
      unknown,
      allowed: TAX_API_INCLUDE_FIELDS,
    });
  }
  return includes;
}

export function includeSet(include = []) {
  return new Set(include || []);
}
