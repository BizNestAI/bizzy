// /src/services/tax/legacyTaxProfileAdapter.js
import { computeTaxProfileCompleteness, buildTaxProfileWarnings } from "./taxProfile.service.js";

export function adaptCanonicalTaxProfileForLegacyCalculator(profile) {
  if (!profile) return {};
  return {
    ...profile,
    state: profile.primary_tax_state || null,
    se_tax_applies: profile.self_employment_tax_applies,
    safe_harbor_mode: legacySafeHarbor(profile.safe_harbor_method),
    prior_year_total_tax: profile.prior_year_total_tax,
    qbi_eligible: profile.qbi_eligible,
    filing_status: profile.filing_status,
  };
}

export function buildLegacyTaxProfileMetadata(profile) {
  return {
    taxProfileCompleteness: computeTaxProfileCompleteness(profile),
    taxProfileWarnings: buildTaxProfileWarnings(profile),
  };
}

function legacySafeHarbor(method) {
  if (method === "prior_year_110") return "110pct_prior";
  if (method === "prior_year_100") return "100pct_prior";
  if (method === "current_year_90") return "90pct_current";
  return method || "unknown";
}
