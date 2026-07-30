// /src/services/tax/sCorp/reasonableSalaryDiagnostics.js
import { S_CORP_WARNING_CODES, round2, sCorpWarning } from "./sCorpDomain.js";

export function evaluateReasonableSalary({
  projectedBusinessIncomeBeforeOwnerComp,
  ownerReasonableSalaryTarget,
  ownerW2WagesYtd,
  projectedOwnerWages,
  distributionsYtd,
  industryContext = null,
  profile = null,
  memories = [],
} = {}) {
  const target = numberOrNull(ownerReasonableSalaryTarget);
  const projectedSalary = numberOrNull(projectedOwnerWages ?? ownerW2WagesYtd);
  const incomeBeforeComp = numberOrNull(projectedBusinessIncomeBeforeOwnerComp);
  const distributions = numberOrNull(distributionsYtd) || 0;
  const factors = [];
  const warnings = [];
  const suggestedActions = [];

  factors.push({ factor: "diagnostic_only", explanation: "This is a planning diagnostic, not a legal reasonable-compensation determination." });
  if (industryContext) factors.push({ factor: "industry_context_present", explanation: "Industry context was provided.", value: industryContext });
  if (memories?.length) factors.push({ factor: "tax_memory_available", explanation: "Tax memory may contain owner wage policy notes." });
  if (profile?.metadata?.owner_wage_policy) factors.push({ factor: "owner_wage_policy", explanation: "Profile contains owner wage policy metadata." });

  if (target == null) {
    warnings.push(sCorpWarning(S_CORP_WARNING_CODES.REASONABLE_SALARY_MISSING, "high", "Add a CPA/user-approved reasonable salary target before relying on salary diagnostics."));
    suggestedActions.push("Set an owner reasonable salary target with CPA support.");
    return response("insufficient_data", {
      targetSalary: null,
      projectedSalary,
      salaryGap: null,
      wageToProfitRatio: ratio(projectedSalary, incomeBeforeComp),
      distributionToWageRatio: ratio(distributions, projectedSalary),
      factors,
      warnings,
      suggestedActions,
      confidence: confidence(35, "low", ["reasonable salary target missing"]),
    });
  }

  const salaryGap = round2(target - (projectedSalary || 0));
  let status = "sufficient";
  if (projectedSalary == null) {
    status = "insufficient_data";
    warnings.push(sCorpWarning(S_CORP_WARNING_CODES.OWNER_WAGES_MISSING, "high", "Owner W-2 wage data is missing."));
    suggestedActions.push("Add owner W-2 wages YTD or projected annual owner wages.");
  } else if (projectedSalary < target * 0.75) {
    status = "materially_low";
    warnings.push(sCorpWarning(S_CORP_WARNING_CODES.OWNER_WAGES_BELOW_TARGET, "high", "Projected owner wages are materially below the supplied salary target."));
    suggestedActions.push("Review payroll timing and reasonable compensation with a CPA.");
  } else if (projectedSalary < target) {
    status = "possibly_low";
    warnings.push(sCorpWarning(S_CORP_WARNING_CODES.OWNER_WAGES_BELOW_TARGET, "medium", "Projected owner wages are below the supplied salary target."));
  } else if (incomeBeforeComp != null && projectedSalary > incomeBeforeComp && incomeBeforeComp > 0) {
    status = "possibly_high";
    warnings.push(sCorpWarning(S_CORP_WARNING_CODES.OWNER_WAGES_ABOVE_PROFIT, "medium", "Projected owner wages exceed business income before owner compensation."));
  }
  if (distributions > 0 && (!projectedSalary || distributions / projectedSalary > 2)) {
    warnings.push(sCorpWarning(S_CORP_WARNING_CODES.HIGH_DISTRIBUTION_LOW_WAGE, "high", "Distributions are high relative to owner wages."));
    suggestedActions.push("Review wage/distribution mix; distributions do not replace reasonable compensation.");
    if (status === "sufficient") status = "possibly_low";
  }
  if (incomeBeforeComp != null && incomeBeforeComp > 25000 && !projectedSalary) {
    warnings.push(sCorpWarning(S_CORP_WARNING_CODES.OWNER_WAGES_MISSING, "high", "Material profit with zero/missing wages needs review."));
  }

  return response(status, {
    targetSalary: target,
    projectedSalary,
    salaryGap,
    wageToProfitRatio: ratio(projectedSalary, incomeBeforeComp),
    distributionToWageRatio: ratio(distributions, projectedSalary),
    factors,
    warnings,
    suggestedActions,
    confidence: confidence(status === "sufficient" ? 85 : status === "possibly_low" ? 65 : status === "possibly_high" ? 60 : status === "materially_low" ? 55 : 35),
  });
}

function response(status, payload) {
  return { status, ...payload };
}

function ratio(numerator, denominator) {
  if (numerator == null || denominator == null || Number(denominator) === 0) return null;
  return round2(Number(numerator) / Number(denominator));
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? round2(n) : null;
}

function confidence(score, level = null, blockers = []) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: clamped,
    level: level || (clamped >= 80 ? "high" : clamped >= 55 ? "medium" : clamped > 0 ? "low" : "unavailable"),
    blockers,
  };
}
