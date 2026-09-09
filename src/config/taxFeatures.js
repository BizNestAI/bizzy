export const TAX_LIABILITY_ESTIMATE_FLAG = "VITE_ENABLE_TAX_LIABILITY_ESTIMATE";

export function isTaxLiabilityEstimateEnabled(env = readTaxFeatureEnv()) {
  return isTruthyFlag(env?.[TAX_LIABILITY_ESTIMATE_FLAG]);
}

function readTaxFeatureEnv() {
  const viteEnv = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};
  const nodeEnv = globalThis.process?.env || {};
  return { ...nodeEnv, ...viteEnv };
}

function isTruthyFlag(value) {
  return ["1", "true", "yes", "on", "enabled"].includes(String(value || "").trim().toLowerCase());
}
