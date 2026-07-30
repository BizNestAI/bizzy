// /src/services/tax/taxableIncome/taxableIncomeConfidence.js
import {
  TAXABLE_INCOME_CONFIDENCE_LEVELS,
  TAXABLE_INCOME_WARNING_CODES,
  round2,
} from "./taxableIncomeDomain.js";

export function computeTaxableIncomeConfidence({
  profileCompleteness,
  coverage = {},
  revenue = {},
  expenses = {},
  warnings = [],
  adjustments = {},
} = {}) {
  let score = 100;
  const factors = [];
  const penalties = [];
  const blockers = [];

  const profileScore = Number(profileCompleteness?.score || 0);
  factors.push({ factor: "tax_profile", impact: profileScore >= 80 ? "positive" : "negative", explanation: `Profile completeness score is ${profileScore}.` });
  if (!profileCompleteness || profileCompleteness.isCompleteForEstimate === false) {
    score -= 20;
    penalties.push({ factor: "tax_profile_incomplete", points: 20, explanation: "Tax profile is incomplete." });
  }

  const classificationCoverage = Number(coverage.classificationCoveragePercent || 0);
  factors.push({ factor: "classification_coverage", impact: classificationCoverage >= 90 ? "positive" : "negative", explanation: `${classificationCoverage}% of eligible posted transactions are classified.` });
  if (classificationCoverage < 50) {
    score -= 25;
    blockers.push("classification_coverage_below_minimum");
  } else if (classificationCoverage < 90) {
    score -= 10;
    penalties.push({ factor: "classification_coverage", points: 10, explanation: "Classification coverage is below 90%." });
  }

  const confirmedCoverage = Number(coverage.confirmedCoveragePercent || 0);
  if (confirmedCoverage < 50) {
    score -= 10;
    penalties.push({ factor: "confirmed_coverage", points: 10, explanation: "Less than half of eligible posted activity is user/CPA confirmed." });
  }

  const needsReview = Number(expenses.needsReviewAmount || coverage.needsReviewBookAmount || 0);
  const revenueBase = Math.max(Math.abs(Number(revenue.netBusinessRevenue || 0)), 1);
  if (needsReview > revenueBase * 0.1) {
    score -= 15;
    penalties.push({ factor: "needs_review_amount", points: 15, explanation: "Needs-review amount is material relative to revenue." });
  }

  if (revenue.reconciliation?.status === "difference_found") {
    score -= 10;
    penalties.push({ factor: "revenue_reconciliation", points: 10, explanation: "Transaction revenue differs from financial metrics." });
  }
  if (!Number(revenue.grossReceipts || 0) && !Number(revenue.otherBusinessIncome || 0)) {
    score -= 20;
    blockers.push("no_revenue_source");
  }
  if ((adjustments.items || []).some((item) => !item.reason)) {
    score -= 5;
    penalties.push({ factor: "adjustment_quality", points: 5, explanation: "Some tax adjustments are missing reason metadata." });
  }
  if (warnings.some((warning) => warning.code === TAXABLE_INCOME_WARNING_CODES.UNSUPPORTED_ENTITY)) {
    blockers.push("unsupported_entity");
    score -= 20;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    level: confidenceLevel(score, blockers),
    factors,
    penalties,
    blockers,
  };
}

function confidenceLevel(score, blockers) {
  if (blockers?.length) return TAXABLE_INCOME_CONFIDENCE_LEVELS.LOW;
  if (score >= 85) return TAXABLE_INCOME_CONFIDENCE_LEVELS.HIGH;
  if (score >= 60) return TAXABLE_INCOME_CONFIDENCE_LEVELS.MEDIUM;
  if (score > 0) return TAXABLE_INCOME_CONFIDENCE_LEVELS.LOW;
  return TAXABLE_INCOME_CONFIDENCE_LEVELS.UNAVAILABLE;
}

export function taxableIncomeRange({ currentEstimate, confirmedEstimate, needsReviewAmount }) {
  const conservativeHigh = round2(confirmedEstimate);
  const optimisticLow = round2(currentEstimate - Number(needsReviewAmount || 0));
  return {
    conservativeHigh,
    currentEstimate: round2(currentEstimate),
    optimisticLow,
    explanation: "Conservative high uses confirmed deductions only; current estimate includes valid auto-classified deductions; optimistic low is scenario-only review exposure.",
  };
}
