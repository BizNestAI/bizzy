// /src/services/tax/federal/federalTaxConfidence.js
import { TAX_FILING_STATUSES, TAX_RULE_SUPPORT_LEVELS } from "../taxDomain.js";
import { getSupportRank } from "../rules/taxRuleSafety.js";
import { FEDERAL_TAX_WARNING_CODES } from "./federalTaxDomain.js";

export function computeFederalTaxConfidence({
  filingStatus,
  bracketRule,
  standardDeductionRule,
  taxableIncomeConfidence,
  unsupportedItems = [],
  warnings = [],
  projectionConfidence,
} = {}) {
  let score = 100;
  const factors = [];
  const penalties = [];
  const blockers = [];

  if (!filingStatus || filingStatus === TAX_FILING_STATUSES.UNKNOWN) {
    score -= 40;
    blockers.push("unknown_filing_status");
  } else {
    factors.push({ factor: "filing_status", impact: "positive", explanation: `Filing status is ${filingStatus}.` });
  }

  score = applyRuleSupport({ score, rule: bracketRule, label: "federal_brackets", blockers, penalties });
  score = applyRuleSupport({ score, rule: standardDeductionRule, label: "standard_deduction", blockers, penalties });

  if (taxableIncomeConfidence?.score != null && taxableIncomeConfidence.score < 70) {
    score -= 10;
    penalties.push({ factor: "taxable_income_confidence", points: 10, explanation: "Taxable-income confidence is below 70." });
  }
  if (projectionConfidence?.score != null && projectionConfidence.score < 70) {
    score -= 8;
    penalties.push({ factor: "projection_confidence", points: 8, explanation: "Projection confidence is below 70." });
  }
  if (unsupportedItems.length) {
    score -= Math.min(20, unsupportedItems.length * 3);
    penalties.push({ factor: "unsupported_personal_tax_items", points: Math.min(20, unsupportedItems.length * 3), explanation: "Some personal-tax items are unsupported." });
  }
  if (warnings.some((warning) => warning.code === FEDERAL_TAX_WARNING_CODES.QBI_NOT_APPLIED)) {
    score -= 8;
    penalties.push({ factor: "qbi_not_applied", points: 8, explanation: "QBI may apply but is not calculated here." });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    level: blockers.length ? "low" : score >= 85 ? "high" : score >= 60 ? "medium" : score > 0 ? "low" : "unavailable",
    factors,
    penalties,
    blockers,
  };
}

function applyRuleSupport({ score, rule, label, blockers, penalties }) {
  const level = rule?.support_level;
  if (!level) {
    blockers.push(`missing_${label}`);
    penalties.push({ factor: label, points: 35, explanation: `${label} rule is missing.` });
    return score - 35;
  }
  if (getSupportRank(level) < getSupportRank(TAX_RULE_SUPPORT_LEVELS.VERIFIED)) {
    blockers.push(`${label}_not_verified`);
    penalties.push({ factor: label, points: 25, explanation: `${label} rule support is ${level}.` });
    return score - 25;
  }
  return score;
}
