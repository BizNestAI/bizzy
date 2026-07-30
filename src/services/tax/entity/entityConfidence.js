// /src/services/tax/entity/entityConfidence.js
import { TAX_FILING_STATUSES, TAX_PROFILE_STATUSES } from "../taxDomain.js";
import { ENTITY_PATHS } from "./entityDomain.js";

export function computeEntityConfidence({ resolution, profile = {}, requirements = {}, missingInputs = [], conflicts = [], blockers = [] } = {}) {
  const factors = [];
  const penalties = [];
  let score = 100;

  addFactor(factors, "entity_type_known", resolution?.entityPath && ![ENTITY_PATHS.UNKNOWN, ENTITY_PATHS.UNSUPPORTED].includes(resolution.entityPath), "Entity type is known.");
  addFactor(factors, "tax_election_known", resolution?.taxElection && resolution.taxElection !== "unknown", "Tax election is known.");
  addFactor(factors, "profile_active", profile?.profile_status === TAX_PROFILE_STATUSES.ACTIVE, "Tax profile is active.");
  addFactor(factors, "filing_status_known", profile?.filing_status && profile.filing_status !== TAX_FILING_STATUSES.UNKNOWN, "Filing status is known.");
  addFactor(factors, "state_known", Boolean(profile?.primary_tax_state), "Primary tax state is known.");
  addFactor(factors, "accounting_method_known", Boolean(profile?.accounting_method && profile.accounting_method !== "unknown"), "Accounting method is known.");

  if (!resolution?.entityPath || resolution.entityPath === ENTITY_PATHS.UNKNOWN) score -= penalty(penalties, "entity_unknown", 60, "Entity path is unknown.");
  if (resolution?.entityPath === ENTITY_PATHS.UNSUPPORTED) score -= penalty(penalties, "entity_unsupported", 75, "Entity path is unsupported.");
  if (!resolution?.taxElection || resolution.taxElection === "unknown") score -= penalty(penalties, "tax_election_unknown", 20, "Tax election is unknown.");
  if (profile?.profile_status && profile.profile_status !== TAX_PROFILE_STATUSES.ACTIVE) score -= penalty(penalties, "profile_not_active", 10, "Tax profile is not active.");
  if (missingInputs.length) score -= penalty(penalties, "missing_required_inputs", Math.min(35, missingInputs.length * 7), "Required entity inputs are missing.");
  if (conflicts.length) score -= penalty(penalties, "entity_conflicts", Math.min(40, conflicts.length * 15), "Entity profile conflicts need review.");
  if (resolution?.entityPath === ENTITY_PATHS.S_CORPORATION) {
    if (profile?.tax_election !== "s_corp") score -= penalty(penalties, "s_corp_election_unconfirmed", 10, "S-Corp election is not confirmed in the profile.");
    if (profile?.owner_reasonable_salary == null || profile?.owner_w2_wages_ytd == null) {
      score -= penalty(penalties, "s_corp_wage_inputs_missing", 15, "S-Corp owner wage inputs are incomplete.");
    }
  }

  const blockerList = [...(blockers || [])];
  const finalScore = blockerList.length ? Math.min(score, 20) : score;
  const clamped = Math.max(0, Math.min(100, Math.round(finalScore)));
  return {
    score: clamped,
    level: blockerList.length ? "unavailable" : clamped >= 85 ? "high" : clamped >= 60 ? "medium" : clamped > 0 ? "low" : "unavailable",
    factors,
    penalties,
    blockers: blockerList,
    requirementsEvaluated: requirements?.requiredInputs || [],
  };
}

function addFactor(factors, factor, satisfied, explanation) {
  factors.push({ factor, satisfied: Boolean(satisfied), explanation });
}

function penalty(penalties, factor, points, explanation) {
  penalties.push({ factor, points, explanation });
  return points;
}
