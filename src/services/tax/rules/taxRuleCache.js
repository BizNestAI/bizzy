/* global process */
// /src/services/tax/rules/taxRuleCache.js

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MISS_TTL_MS = 60 * 1000;
const cache = new Map();

function enabled() {
  return process.env.NODE_ENV !== "test" && String(process.env.TAX_RULE_CACHE_DISABLED || "").toLowerCase() !== "true";
}

export function buildTaxRuleCacheKey(parts = {}) {
  return [
    parts.kind || "rule",
    parts.taxYear || "",
    parts.stateCode || "",
    parts.jurisdiction || "",
    parts.ruleType || "",
    parts.filingStatus || "",
    parts.entityType || "",
    parts.entityPath || "",
    parts.taxElection || "",
    parts.ptetElection || "",
    parts.minimumSupportLevel || "",
    parts.asOfDate || "",
  ].join(":");
}

export function getCachedTaxRule(key) {
  if (!enabled()) return undefined;
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

export function setCachedTaxRule(key, value, { isMiss = false, ttlMs } = {}) {
  if (!enabled()) return value;
  cache.set(key, { value, expiresAt: Date.now() + (ttlMs ?? (isMiss ? MISS_TTL_MS : DEFAULT_TTL_MS)) });
  return value;
}

export function invalidateTaxRuleCache(prefix) {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export function getTaxRuleCacheDiagnostics() {
  return { size: cache.size, enabled: enabled(), ttlMs: DEFAULT_TTL_MS, missTtlMs: MISS_TTL_MS };
}
