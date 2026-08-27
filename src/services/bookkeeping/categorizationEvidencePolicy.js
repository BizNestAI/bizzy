export const CATEGORIZATION_POLICY_VERSION = "2026-09-categorization-hardening-v1";

export const CATEGORIZATION_SOURCE_PRIORITY = Object.freeze({
  confirmed_special_workflow: 100,
  approved_business_rule: 90,
  exact_universal_vendor: 80,
  approved_learned_vendor_rule: 70,
  plaid_merchant_agreement: 60,
  plaid_baseline: 30,
  unresolved: 0,
});

function normalizeVendorCandidate(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsWordBoundary(haystack = "", needle = "") {
  const normalizedHaystack = normalizeVendorCandidate(haystack);
  const normalizedNeedle = normalizeVendorCandidate(needle);
  if (!normalizedHaystack || !normalizedNeedle) return false;
  const escaped = normalizedNeedle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, "i").test(normalizedHaystack);
}

export function isStrongUniversalVendorEvidence(hint = null) {
  if (!hint?.primary_intent || hint.confidence !== "high") return false;
  if (hint.match_type === "exact" || hint.match_type === "starts_with") return true;
  const candidate = hint.matched_value || hint.candidate || "";
  const canonical = hint.canonical_vendor || hint.canonical_vendor_name || hint.label || "";
  return Boolean(
    canonical &&
      candidate &&
      (normalizeVendorCandidate(candidate).startsWith(normalizeVendorCandidate(canonical)) ||
        containsWordBoundary(candidate, canonical))
  );
}

const SPECIFIC_MEDIUM_UNIVERSAL_INTENTS = new Set([
  "software",
  "insurance",
  "internet_services",
  "electric",
  "security",
  "cleaning",
]);

export function isSpecificUniversalVendorEvidence(hint = null) {
  if (isStrongUniversalVendorEvidence(hint)) return true;
  if (!hint?.primary_intent || hint.confidence !== "medium") return false;
  if (!SPECIFIC_MEDIUM_UNIVERSAL_INTENTS.has(String(hint.primary_intent))) return false;
  const candidate = hint.matched_value || hint.candidate || "";
  const canonical = hint.canonical_vendor || hint.canonical_vendor_name || hint.label || "";
  if (!candidate || !canonical) return false;
  return Boolean(
    normalizeVendorCandidate(candidate).startsWith(normalizeVendorCandidate(canonical)) ||
      containsWordBoundary(candidate, canonical)
  );
}

export function withCategorizationPolicyVersion(meta = {}) {
  return {
    ...(meta || {}),
    categorization_policy_version: CATEGORIZATION_POLICY_VERSION,
    categorization_source_priority: CATEGORIZATION_SOURCE_PRIORITY,
  };
}
