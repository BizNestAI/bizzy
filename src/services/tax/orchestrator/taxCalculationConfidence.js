// /src/services/tax/orchestrator/taxCalculationConfidence.js

export function computeTaxCalculationConfidence({ profileCompleteness, entityContext, taxableIncome, projection, federal, seTax, sCorp, state, payments, safeHarbor, warnings = [], blockers = [] } = {}) {
  const factors = [];
  const penalties = [];
  let score = 100;
  add(factors, "profile_complete", profileCompleteness?.isCompleteForEstimate, "Tax profile is estimate-ready.");
  add(factors, "entity_available", entityContext?.confidence?.level !== "unavailable", "Entity routing is available.");
  add(factors, "taxable_income_available", taxableIncome?.businessTaxableIncome?.finalBusinessTaxableIncome != null, "Taxable-income context is available.");
  add(factors, "projection_available", projection?.projectedAnnual?.taxableBusinessIncome != null, "Annual projection is available.");
  add(factors, "federal_available", federal?.tax?.federalIncomeTax != null, "Federal income tax is available.");
  add(factors, "state_available", state?.tax?.totalStateTax != null && state?.confidence?.level !== "unavailable", "State tax result is available.");
  add(factors, "payments_available", payments?.source !== "none", "Payment/withholding data is available.");
  add(factors, "safe_harbor_available", safeHarbor?.combined?.requiredAnnual != null, "Safe harbor context is available.");

  if (!profileCompleteness?.isCompleteForEstimate) score -= penalty(penalties, "profile_incomplete", 12, "Tax profile is incomplete.");
  if (entityContext?.confidence?.level === "unavailable") score -= penalty(penalties, "entity_unavailable", 35, "Entity context is unavailable.");
  if (taxableIncome?.confidence?.score != null && taxableIncome.confidence.score < 70) score -= penalty(penalties, "taxable_income_confidence", 12, "Taxable-income confidence is below 70.");
  if (projection?.confidence?.score != null && projection.confidence.score < 70) score -= penalty(penalties, "projection_confidence", 10, "Projection confidence is below 70.");
  if (federal?.confidence?.level === "unavailable") score -= penalty(penalties, "federal_unavailable", 35, "Federal calculation is unavailable.");
  if (seTax?.confidence?.score != null && seTax.confidence.score < 70) score -= penalty(penalties, "se_tax_confidence", 8, "Self-employment tax confidence is below 70.");
  if (sCorp?.confidence?.score != null && sCorp.confidence.score < 70) score -= penalty(penalties, "s_corp_confidence", 10, "S-Corp confidence is below 70.");
  if (state?.confidence?.level === "unavailable") score -= penalty(penalties, "state_partial", 15, "State calculation is unavailable or partial.");
  if (payments?.source === "none") score -= penalty(penalties, "payments_missing", 8, "Payment data is missing.");
  if (safeHarbor?.combined?.status === "unavailable") score -= penalty(penalties, "safe_harbor_unavailable", 10, "Safe-harbor guidance is unavailable.");
  else if (safeHarbor?.combined?.status === "partial") score -= penalty(penalties, "safe_harbor_partial", 6, "Safe-harbor guidance is partial.");
  if (warnings.some((warning) => warning.code === "qbi_not_applied" || warning.code === "qbi_deferred")) score -= penalty(penalties, "qbi_deferred", 6, "QBI remains deferred.");

  const finalScore = blockers.length ? Math.min(score, 20) : score;
  const clamped = Math.max(0, Math.min(100, Math.round(finalScore)));
  return {
    score: clamped,
    level: blockers.length ? "unavailable" : clamped >= 85 ? "high" : clamped >= 60 ? "medium" : clamped > 0 ? "low" : "unavailable",
    factors,
    penalties,
    blockers,
  };
}

export function calculationStatus({ blockers = [], state, federal, safeHarbor } = {}) {
  if (blockers.length || !federal) return "failed";
  if (state?.confidence?.level === "unavailable" || state?.warnings?.some((w) => ["state_rule_missing", "unsupported_state"].includes(w.code))) return "partial";
  if (["unavailable", "partial"].includes(safeHarbor?.combined?.status)) return "partial";
  return "completed";
}

function add(factors, factor, satisfied, explanation) {
  factors.push({ factor, satisfied: Boolean(satisfied), explanation });
}

function penalty(penalties, factor, points, explanation) {
  penalties.push({ factor, points, explanation });
  return points;
}
