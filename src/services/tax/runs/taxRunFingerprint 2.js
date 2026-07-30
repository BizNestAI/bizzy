// /src/services/tax/runs/taxRunFingerprint.js
import crypto from "node:crypto";

export function buildTaxRunFingerprint({
  businessId,
  taxYear,
  asOfDate,
  calculationType,
  projectionMethod,
  projectionScenario,
  triggerSource,
  profileVersion,
  sourceFreshness,
  engineVersions,
  ruleVersions,
  manualOverrides,
} = {}) {
  const payload = {
    businessId,
    taxYear,
    asOfDate,
    calculationType,
    projectionMethod,
    projectionScenario,
    triggerSource,
    profileVersion,
    sourceFreshness,
    engineVersions,
    ruleVersions,
    manualOverrides,
  };
  return crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((out, key) => {
        const next = canonicalize(value[key]);
        if (next !== undefined) out[key] = next;
        return out;
      }, {});
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value;
  }
  return value;
}
