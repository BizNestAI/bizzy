// /src/services/tax/state/stateTaxConfidence.js
import { TAX_RULE_SUPPORT_LEVELS } from "../taxDomain.js";
import { getSupportRank } from "../rules/taxRuleSafety.js";

export function computeStateTaxConfidence({
  stateCode,
  configSet,
  filingStatus,
  entityContext,
  withholdingKnown,
  stateResultStatus = null,
  multiState = false,
  projectionContext = null,
  warnings = [],
  blockers = [],
} = {}) {
  const factors = [];
  const penalties = [];
  let score = 100;

  addFactor(factors, "primary_state_known", Boolean(stateCode), "Primary state is known.");
  addFactor(factors, "rule_supported", getSupportRank(configSet?.supportLevel) >= getSupportRank(TAX_RULE_SUPPORT_LEVELS.SIMPLIFIED), "State rule config is usable.");
  addFactor(factors, "filing_status_known", Boolean(filingStatus && filingStatus !== "unknown"), "Filing status is known.");
  addFactor(factors, "entity_path_known", Boolean(entityContext?.entity?.entityPath && entityContext.entity.entityPath !== "unknown"), "Entity path is known.");
  addFactor(factors, "state_withholding_known", withholdingKnown, "State withholding is known.");
  addFactor(factors, "single_state", !multiState, "Multi-state allocation is not required.");

  if (!stateCode) score -= penalty(penalties, "state_missing", 60, "Primary state is missing.");
  if (!configSet?.isUsableForEstimate) score -= penalty(penalties, "state_rule_unusable", 50, "State tax rule is missing or unsupported.");
  if (configSet?.supportLevel && getSupportRank(configSet.supportLevel) < getSupportRank(TAX_RULE_SUPPORT_LEVELS.SUPPORTED)) {
    score -= penalty(penalties, "state_rule_support", 12, "State rule support is below supported.");
  }
  if (!filingStatus || filingStatus === "unknown") score -= penalty(penalties, "filing_status_unknown", 10, "Filing status is unknown.");
  if (!withholdingKnown) score -= penalty(penalties, "withholding_unknown", 8, "State withholding is missing.");
  if (multiState) score -= penalty(penalties, "multi_state_unsupported", 30, "Multi-state income allocation is deferred.");
  if (stateResultStatus === "partial") score -= penalty(penalties, "state_partial", 25, "State result has unresolved material components.");
  if (stateResultStatus === "unavailable") score -= penalty(penalties, "state_unavailable", 50, "State liability calculation is unavailable.");
  if (stateResultStatus === "unsupported") score -= penalty(penalties, "state_unsupported", 50, "State liability calculation is unsupported.");
  if (projectionContext?.confidence?.score != null && projectionContext.confidence.score < 70) {
    score -= penalty(penalties, "projection_confidence", 8, "Projection confidence is below 70.");
  }
  if (warnings.some((warning) => warning.code === "local_tax_unsupported" && (warning.materialExposure === true || warning.exposureReasonablyPossible === true))) {
    score -= penalty(penalties, "local_tax", 5, "Local tax support is deferred for a possible local-tax exposure.");
  }

  const partialCap = stateResultStatus === "partial" ? 74 : 100;
  const unavailableCap = ["unavailable", "unsupported"].includes(stateResultStatus) ? 30 : partialCap;
  const finalScore = blockers.length ? Math.min(score, 20) : Math.min(score, unavailableCap);
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
