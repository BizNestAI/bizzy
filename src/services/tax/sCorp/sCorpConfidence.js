// /src/services/tax/sCorp/sCorpConfidence.js

export function computeSCorpConfidence({
  entityContext,
  inputs,
  salaryDiagnostics,
  warnings = [],
  blockers = [],
  projectionContext = null,
} = {}) {
  const factors = [];
  const penalties = [];
  let score = 100;

  addFactor(factors, "confirmed_s_corp_election", entityContext?.entity?.taxElection === "s_corp", "S-Corp election is confirmed.");
  addFactor(factors, "entity_confidence", Number(entityContext?.confidence?.score || 0) >= 70, "Entity confidence is at least medium.");
  addFactor(factors, "owner_wages_known", inputs?.ownerW2WagesYtd != null, "Owner W-2 wages YTD are known.");
  addFactor(factors, "salary_target_known", inputs?.ownerReasonableSalaryTarget != null, "Reasonable salary target is present.");
  addFactor(factors, "withholding_known", inputs?.federalWithholdingYtd != null && inputs?.stateWithholdingYtd != null, "Federal and state withholding are known.");
  addFactor(factors, "distributions_known", inputs?.distributionsKnown === true, "Distributions are identified from source data.");
  addFactor(factors, "income_source_clear", inputs?.ownerWagesAlreadyIncludedInBookExpenses !== "unknown", "Owner wage inclusion in books is known.");
  addFactor(factors, "health_insurance_known", inputs?.ownerHealthInsurance != null || inputs?.healthInsuranceTreatment != null, "Health insurance treatment input is present.");
  addFactor(factors, "retirement_known", inputs?.retirementContribution != null || inputs?.retirementPlanType != null, "Retirement treatment input is present.");

  if (entityContext?.entity?.taxElection !== "s_corp") score -= penalty(penalties, "election_unconfirmed", 30, "S-Corp election is not confirmed.");
  if (Number(entityContext?.confidence?.score || 0) < 70) score -= penalty(penalties, "entity_confidence", 12, "Entity confidence is below 70.");
  if (inputs?.ownerW2WagesYtd == null) score -= penalty(penalties, "owner_wages_missing", 18, "Owner W-2 wage data is missing.");
  if (inputs?.ownerReasonableSalaryTarget == null) score -= penalty(penalties, "reasonable_salary_missing", 14, "Reasonable salary target is missing.");
  if (inputs?.federalWithholdingYtd == null || inputs?.stateWithholdingYtd == null) score -= penalty(penalties, "withholding_missing", 10, "Withholding data is incomplete.");
  if (inputs?.distributionsKnown !== true) score -= penalty(penalties, "distributions_unknown", 8, "Distributions are unknown.");
  if (inputs?.ownerWagesAlreadyIncludedInBookExpenses === "unknown") score -= penalty(penalties, "wage_treatment_unclear", 25, "Owner wage inclusion in taxable income is unclear.");
  if (salaryDiagnostics?.status && salaryDiagnostics.status !== "sufficient") score -= penalty(penalties, "salary_diagnostic", 10, "Reasonable salary diagnostics require review.");
  if (projectionContext?.confidence?.score != null && projectionContext.confidence.score < 70) score -= penalty(penalties, "projection_confidence", 8, "Projection confidence is below 70.");
  if (warnings.some((warning) => warning.code === "payroll_source_stale")) score -= penalty(penalties, "payroll_stale", 8, "Payroll source appears stale.");

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
