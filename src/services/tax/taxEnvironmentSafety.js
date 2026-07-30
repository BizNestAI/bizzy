const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export const TAX_MOCK_ENV_FLAGS = Object.freeze([
  "MOCK_TAX",
  "MOCK_TAX_LIABILITY",
  "MOCK_TAX_DEDUCTIONS",
  "VITE_MOCK_TAX",
  "TAX_USE_MOCKS",
]);

export const TAX_LEGACY_FALLBACK_ENV_FLAGS = Object.freeze([
  "TAX_LEGACY_MONTHLY_METRICS_FALLBACK",
  "TAX_LEGACY_TAX_CONFIG_FALLBACK",
]);

export function validateTaxEnvironmentSafety({ env = process.env, logger = console } = {}) {
  const nodeEnv = String(env.NODE_ENV || "development");
  const production = nodeEnv === "production";
  const mockFlags = TAX_MOCK_ENV_FLAGS.filter((flag) => truthy(env[flag]));
  const legacyFallbackFlags = TAX_LEGACY_FALLBACK_ENV_FLAGS.filter((flag) => truthy(env[flag]));
  const apiVersion = env.TAX_API_VERSION || env.VITE_TAX_API_VERSION || "2026-01";
  const schedulerEnabled = truthy(env.TAX_SCHEDULER_ENABLED) || production;

  if (production && mockFlags.length) {
    throw new Error(`Unsafe Tax mock flags enabled in production: ${mockFlags.join(", ")}`);
  }
  if (production && legacyFallbackFlags.length) {
    throw new Error(`Unsafe Tax legacy fallback flags enabled in production: ${legacyFallbackFlags.join(", ")}`);
  }

  logger?.info?.("[tax-env] safety", {
    nodeEnv,
    apiVersion,
    mockFlagsEnabled: mockFlags.length,
    legacyFallbackFlagsEnabled: legacyFallbackFlags.length,
    schedulerEnabled,
    schedulerEnvironment: env.TAX_SCHEDULER_ENV || nodeEnv,
  });

  return {
    ok: true,
    nodeEnv,
    apiVersion,
    mockFlags,
    legacyFallbackFlags,
    schedulerEnabled,
  };
}

function truthy(value) {
  return TRUE_VALUES.has(String(value || "").trim().toLowerCase());
}
