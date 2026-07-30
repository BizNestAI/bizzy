// /src/services/tax/taxClassificationConfidence.js
import { TAX_CONFIDENCE_LEVELS, TAX_RULE_SUPPORT_LEVELS } from "./taxDomain.js";

export function scoreTaxClassification({
  source = "rule_engine",
  rule,
  structural = false,
  businessRule = false,
  exactQboSubtype = false,
  exactQboAccount = false,
  broadCategory = false,
  textOnly = false,
  fallback = false,
  warnings = [],
  partialDeduction = false,
} = {}) {
  const factors = [];
  const penalties = [];
  let score = 0;

  if (source === "user" || source === "cpa") {
    score = 100;
    factors.push({ factor: `${source}_confirmed`, impact: 100, explanation: `${source.toUpperCase()} confirmed classification.` });
    return finish(score, factors, penalties);
  }

  if (fallback) {
    factors.push({ factor: "fallback", impact: 20, explanation: "No reliable tax deduction rule matched." });
    return finish(20, factors, penalties);
  }

  if (structural) {
    score += 82;
    factors.push({ factor: "structural_taxonomy", impact: 82, explanation: "Strong transaction taxonomy indicates non-expense treatment." });
  }
  if (businessRule) {
    score += 92;
    factors.push({ factor: "business_specific_rule", impact: 92, explanation: "Matched a business-specific tax rule." });
  } else if (rule) {
    score += 82;
    factors.push({ factor: "global_rule", impact: 82, explanation: "Matched a global tax deduction rule." });
  }
  if (exactQboSubtype) {
    score += 12;
    factors.push({ factor: "qbo_subtype_match", impact: 12, explanation: "Matched exact QBO account subtype." });
  }
  if (exactQboAccount) {
    score += 8;
    factors.push({ factor: "qbo_account_match", impact: 8, explanation: "Matched posted QBO account/category." });
  }
  if (broadCategory) {
    score += 4;
    factors.push({ factor: "broad_category_match", impact: 4, explanation: "Matched a broad bookkeeping category." });
  }
  if (textOnly) {
    score += 2;
    factors.push({ factor: "text_match", impact: 2, explanation: "Matched text-based vendor or memo condition." });
  }

  if (rule && [TAX_RULE_SUPPORT_LEVELS.UNVERIFIED, TAX_RULE_SUPPORT_LEVELS.UNSUPPORTED, TAX_RULE_SUPPORT_LEVELS.LEGACY_ESTIMATE].includes(rule.support_level)) {
    score = Math.min(score, 59);
    penalties.push({ factor: "low_rule_support", impact: -25, explanation: "Rule support level is not sufficient for auto-classification." });
  }
  if (warnings?.length) {
    score = Math.min(score, 74);
    penalties.push({ factor: "source_warnings", impact: -15, explanation: "Source transaction has unresolved warnings." });
  }
  if (partialDeduction && !rule) {
    score = Math.min(score, 59);
    penalties.push({ factor: "partial_without_rule", impact: -25, explanation: "Partial deduction requires an explicit rule." });
  }

  return finish(score, factors, penalties);
}

export function confidenceLevel(score) {
  if (score == null) return TAX_CONFIDENCE_LEVELS.UNAVAILABLE;
  if (score >= 85) return TAX_CONFIDENCE_LEVELS.HIGH;
  if (score >= 60) return TAX_CONFIDENCE_LEVELS.MEDIUM;
  if (score >= 1) return TAX_CONFIDENCE_LEVELS.LOW;
  return TAX_CONFIDENCE_LEVELS.UNAVAILABLE;
}

export function shouldAutoClassify({ score, rule, structural = false, warnings = [], partialDeduction = false } = {}) {
  if (warnings?.length) return false;
  if (structural && score >= 75) return true;
  if (!rule) return false;
  if ([TAX_RULE_SUPPORT_LEVELS.UNVERIFIED, TAX_RULE_SUPPORT_LEVELS.UNSUPPORTED, TAX_RULE_SUPPORT_LEVELS.LEGACY_ESTIMATE].includes(rule.support_level)) {
    return false;
  }
  if (partialDeduction && score < 90) return false;
  return score >= 90;
}

function finish(score, factors, penalties) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(score || 0))));
  return { score: clamped, level: confidenceLevel(clamped), factors, penalties };
}
