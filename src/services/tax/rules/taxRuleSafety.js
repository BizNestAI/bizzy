/* global process */
// /src/services/tax/rules/taxRuleSafety.js
import { TAX_RULE_SUPPORT_LEVELS } from "../taxDomain.js";
import { taxConfigurationError, unsupportedTaxScenarioError } from "../taxErrors.js";

export const SUPPORT_RANK = Object.freeze({
  [TAX_RULE_SUPPORT_LEVELS.VERIFIED]: 50,
  [TAX_RULE_SUPPORT_LEVELS.SUPPORTED]: 40,
  [TAX_RULE_SUPPORT_LEVELS.SIMPLIFIED]: 30,
  [TAX_RULE_SUPPORT_LEVELS.LEGACY_ESTIMATE]: 20,
  [TAX_RULE_SUPPORT_LEVELS.UNVERIFIED]: 10,
  [TAX_RULE_SUPPORT_LEVELS.UNSUPPORTED]: 0,
});

export function getSupportRank(level) {
  return SUPPORT_RANK[level] ?? SUPPORT_RANK[TAX_RULE_SUPPORT_LEVELS.UNSUPPORTED];
}

export function allowLegacyRules() {
  return String(process.env.TAX_ALLOW_LEGACY_RULES || "").toLowerCase() === "true";
}

export function assertRuleUsableForEstimate(config, context = {}) {
  const level = config?.support_level || config?.supportLevel;
  if ([TAX_RULE_SUPPORT_LEVELS.VERIFIED, TAX_RULE_SUPPORT_LEVELS.SUPPORTED, TAX_RULE_SUPPORT_LEVELS.SIMPLIFIED].includes(level)) {
    return true;
  }
  if (level === TAX_RULE_SUPPORT_LEVELS.LEGACY_ESTIMATE && allowLegacyRules()) return true;
  throw unsupportedTaxScenarioError("tax_rule_not_usable_for_estimate", "Tax rule is not usable for live estimates.", {
    ruleType: config?.rule_type || context.ruleType,
    supportLevel: level || TAX_RULE_SUPPORT_LEVELS.UNSUPPORTED,
  });
}

export function assertRuleUsableForReserve(config, context = {}) {
  const level = config?.support_level || config?.supportLevel;
  if ([TAX_RULE_SUPPORT_LEVELS.VERIFIED, TAX_RULE_SUPPORT_LEVELS.SUPPORTED].includes(level)) return true;
  if (level === TAX_RULE_SUPPORT_LEVELS.SIMPLIFIED) return true;
  throw taxConfigurationError("tax_rule_not_usable_for_reserve", "Tax rule is not usable for reserve guidance.", {
    ruleType: config?.rule_type || context.ruleType,
    supportLevel: level || TAX_RULE_SUPPORT_LEVELS.UNSUPPORTED,
  });
}

export function aggregateRuleSupport(configs = []) {
  const rows = Array.isArray(configs) ? configs.filter(Boolean) : Object.values(configs || {}).filter(Boolean);
  if (!rows.length) return TAX_RULE_SUPPORT_LEVELS.UNSUPPORTED;
  return rows.reduce((lowest, row) => (getSupportRank(row.support_level) < getSupportRank(lowest) ? row.support_level : lowest), rows[0].support_level);
}

export function buildRuleWarnings(configs = []) {
  const rows = Array.isArray(configs) ? configs.filter(Boolean) : Object.values(configs || {}).filter(Boolean);
  return rows
    .filter((row) => getSupportRank(row.support_level) < getSupportRank(TAX_RULE_SUPPORT_LEVELS.SUPPORTED))
    .map((row) => ({
      code: "low_support_tax_rule",
      severity: row.support_level === TAX_RULE_SUPPORT_LEVELS.UNSUPPORTED ? "high" : "medium",
      ruleType: row.rule_type,
      supportLevel: row.support_level,
      message: `Tax rule ${row.rule_type} has ${row.support_level || "unknown"} support.`,
    }));
}
