// /src/services/tax/selfEmployment/selfEmploymentTaxConfidence.js

export function computeSelfEmploymentTaxConfidence({
  entityContext,
  rules,
  annualIncomeConfidence = null,
  otherW2WagesKnown = false,
  filingStatusKnown = false,
  additionalMedicareSupported = false,
  projectionConfidence = null,
  warnings = [],
  blockers = [],
} = {}) {
  const factors = [];
  const penalties = [];
  let score = 100;

  addFactor(factors, "verified_rule_configs", Boolean(rules?.ruleVersions?.selfEmploymentTax && rules?.ruleVersions?.socialSecurityWageBase), "Verified SE tax and wage-base configs are loaded.");
  addFactor(factors, "entity_eligible", Boolean(entityContext?.routing?.runSelfEmploymentTax), "Entity route is eligible for self-employment tax.");
  addFactor(factors, "other_w2_wages_known", otherW2WagesKnown, "Other W-2/FICA wages are known.");
  addFactor(factors, "filing_status_known", filingStatusKnown, "Filing status is known for Additional Medicare thresholds.");
  addFactor(factors, "additional_medicare_supported", additionalMedicareSupported, "Additional Medicare config and threshold are available.");

  if (!rules?.ruleVersions?.selfEmploymentTax) score -= penalty(penalties, "missing_se_rule", 40, "Self-employment tax rule config is missing.");
  if (!rules?.ruleVersions?.socialSecurityWageBase) score -= penalty(penalties, "missing_wage_base_rule", 35, "Social Security wage-base config is missing.");
  if (!entityContext?.routing?.runSelfEmploymentTax) score -= penalty(penalties, "entity_not_eligible", 50, "Entity context is not eligible for SE tax.");
  if (entityContext?.confidence?.score != null && entityContext.confidence.score < 70) {
    score -= penalty(penalties, "entity_confidence", 15, "Entity confidence is below 70.");
  }
  if (!otherW2WagesKnown) score -= penalty(penalties, "other_wages_unknown", 18, "Other W-2 wages are unknown; zero was used as an estimate assumption.");
  if (!filingStatusKnown) score -= penalty(penalties, "filing_status_unknown", 10, "Filing status is unknown.");
  if (!additionalMedicareSupported) score -= penalty(penalties, "additional_medicare_unavailable", 8, "Additional Medicare tax support is incomplete.");
  if (annualIncomeConfidence?.score != null && annualIncomeConfidence.score < 70) score -= penalty(penalties, "income_confidence", 12, "Annual income confidence is below 70.");
  if (projectionConfidence?.score != null && projectionConfidence.score < 70) score -= penalty(penalties, "projection_confidence", 8, "Projection confidence is below 70.");
  if (warnings.some((warning) => warning.code === "unsupported_multiple_businesses")) {
    score -= penalty(penalties, "multiple_business_uncertainty", 10, "Multiple business SE-tax coordination is not supported yet.");
  }

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

function addFactor(factors, factor, satisfied, explanation) {
  factors.push({ factor, satisfied: Boolean(satisfied), explanation });
}

function penalty(penalties, factor, points, explanation) {
  penalties.push({ factor, points, explanation });
  return points;
}
