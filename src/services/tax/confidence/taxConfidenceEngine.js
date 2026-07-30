// /src/services/tax/confidence/taxConfidenceEngine.js
import {
  TAX_CONFIDENCE_BLOCKER_SEVERITIES,
  TAX_CONFIDENCE_FACTOR_CATEGORIES as CATEGORIES,
  TAX_CONFIDENCE_MATERIALITY,
  TAX_CONFIDENCE_METHODOLOGY_VERSION,
  TAX_CONFIDENCE_STATUSES,
  confidenceLevelForScore,
} from "./taxConfidenceDomain.js";
import { createConfidenceBlocker, createConfidenceFactor, createConfidencePenalty } from "./taxConfidenceFactor.js";
import { evaluateTaxSourceFreshness } from "./taxSourceFreshness.js";

const BASE_WEIGHTS = Object.freeze({
  taxableIncome: 0.25,
  entityProfile: 0.15,
  classifications: 0.15,
  projection: 0.15,
  federal: 0.10,
  entityTax: 0.10,
  state: 0.05,
  paymentsSafeHarbor: 0.05,
});

export function computeCanonicalTaxConfidence({
  canonicalResult,
  engineConfidences = {},
  ruleSupport = {},
  sourceFreshness = {},
  coverage = null,
  warnings = null,
  unsupportedItems = null,
  deferredItems = null,
} = {}) {
  const c = canonicalResult || {};
  const allWarnings = warnings || c.warnings || [];
  const unsupported = unsupportedItems || c.unsupportedItems || [];
  const deferred = deferredItems || c.supportedButDeferred || [];
  const freshness = evaluateTaxSourceFreshness({ sourceFreshness: sourceFreshness || c.meta?.sourceFreshness || {}, canonicalResult: c });
  const weights = weightsFor(c.meta?.calculationType);
  const materiality = computeMaterialUncertainty(c, coverage);
  const blockers = collectBlockers(c, allWarnings, unsupported);
  const factors = buildFactors({ c, engineConfidences, freshness, coverage, ruleSupport, weights, materiality });
  const penalties = buildPenalties({ c, freshness, materiality, allWarnings, unsupported, deferred });
  const baseScore = weightedScore(factors);
  const capped = applyCaps(baseScore - totalPenaltyPoints(penalties), blockers);
  const score = Math.max(0, Math.min(100, Math.round(capped)));
  const level = confidenceLevelForScore(score, blockers);
  const estimateReady = isEstimateReady({ c, blockers, score });
  const reserveReady = isReserveReady({ c, blockers, score });
  const status = statusFor({ estimateReady, reserveReady, blockers, c, level });

  return {
    score,
    level,
    status,
    estimateReady,
    reserveReady,
    factors,
    penalties,
    blockers,
    confidenceBySection: sectionScores(factors),
    materialUncertainty: materiality,
    improvementActions: improvementActions({ blockers, penalties, c, materiality, freshness }),
    explanation: explanationFor({ score, level, status, blockers }),
    methodologyVersion: TAX_CONFIDENCE_METHODOLOGY_VERSION,
    sourceFreshness: freshness,
  };
}

function buildFactors({ c, engineConfidences, freshness, coverage, weights, materiality }) {
  const profileScore = scoreFrom(c.profile?.completeness?.score, c.profile?.profile?.confidence_score, c.profile?.entityContext?.confidence?.score);
  const entityScore = scoreFrom(c.entity?.confidence?.score, c.profile?.entityContext?.confidence?.score, profileScore);
  const taxableScore = scoreFrom(c.actuals?.taxableIncome?.confidence?.score, engineConfidences.taxableIncome?.score);
  const classificationCoverage = Number(coverage?.classificationCoveragePercent ?? c.actuals?.coverage?.classificationCoveragePercent ?? c.actuals?.deductions?.coverage?.classificationCoveragePercent ?? 0);
  const deductionsScore = classificationCoverage ? Math.min(100, Math.max(20, classificationCoverage)) : scoreFrom(c.actuals?.deductions?.coverage?.classificationCoveragePercent, 60);
  const projectionScore = scoreFrom(c.projection?.confidence?.score, engineConfidences.projection?.score);
  const federalScore = scoreFrom(c.federal?.incomeTax?.confidence?.score, engineConfidences.federal?.score);
  const entityTaxScore = c.federal?.selfEmploymentTax ? scoreFrom(c.federal.selfEmploymentTax.confidence?.score, engineConfidences.selfEmployment?.score) : c.federal?.payrollTaxContext ? scoreFrom(c.federal.payrollTaxContext.confidence?.score, 65) : entityScore;
  const stateScore = c.state?.incomeTax?.confidence?.level === "unavailable" ? 20 : scoreFrom(c.state?.incomeTax?.confidence?.score, engineConfidences.state?.score, 70);
  const paymentsScore = scorePayments(c);
  const reserveScore = c.reserve?.confidence?.score ?? (c.reserve?.status === "setup_incomplete" ? 45 : 70);
  const safeHarborScore = c.safeHarbor?.combined?.status === "unavailable" ? 35 : c.safeHarbor?.combined?.status === "partial" ? 55 : 85;
  return [
    factor("profile_entity", CATEGORIES.PROFILE, "Profile and entity setup", Math.min(profileScore, entityScore), weights.entityProfile, c.profile?.completeness?.isCompleteForEstimate ? "Profile supports estimate." : "Profile is incomplete.", "complete_tax_profile"),
    factor("taxable_income_source", CATEGORIES.TAXABLE_INCOME, "Taxable income source quality", taxableScore, weights.taxableIncome, "Taxable-income engine output and source quality.", "review_tax_inputs"),
    factor("classification_deductions", CATEGORIES.TRANSACTION_CLASSIFICATION, "Classification and deduction coverage", Math.min(deductionsScore, materiality.needsReviewScore), weights.classifications, "Transaction classification coverage and material needs-review exposure.", "classify_transactions", materiality.needsReviewMateriality),
    factor("projection", CATEGORIES.PROJECTION, "Annual projection", projectionScore, weights.projection, "Projection data quality and methodology.", "refresh_forecast"),
    factor("federal_rules_inputs", CATEGORIES.FEDERAL_RULES, "Federal rules and inputs", federalScore, weights.federal, "Federal rule support and personal input completeness.", "complete_tax_profile"),
    factor("entity_tax_engine", c.federal?.selfEmploymentTax ? CATEGORIES.SELF_EMPLOYMENT : CATEGORIES.S_CORP, "Entity tax engine", entityTaxScore, weights.entityTax, "Self-employment or S-Corp pathway confidence.", c.federal?.selfEmploymentTax ? "add_other_w2_wages" : "review_s_corp_salary"),
    factor("state_support", CATEGORIES.STATE_RULES, "State support", stateScore, weights.state, "Primary-state rule support and state input completeness.", "verify_state_rules", stateScore < 60 ? TAX_CONFIDENCE_MATERIALITY.MEDIUM : TAX_CONFIDENCE_MATERIALITY.LOW),
    factor("payments_safe_harbor", CATEGORIES.PAYMENTS, "Payments, safe harbor, and reserve", Math.min(paymentsScore, safeHarborScore, reserveScore), weights.paymentsSafeHarbor, "Payments, withholding, safe-harbor readiness, and reserve-account setup.", "enter_tax_payments"),
    factor("source_freshness", CATEGORIES.FRESHNESS, "Source freshness", freshness.freshnessScore, 0, "Freshness does not replace calculation quality but can cap confidence.", "refresh_books"),
  ];
}

function buildPenalties({ c, freshness, materiality, allWarnings, unsupported, deferred }) {
  const penalties = [];
  for (const source of freshness.staleSources || []) {
    penalties.push(createConfidencePenalty({ code: `${source.code}_${source.status}`, category: CATEGORIES.FRESHNESS, points: source.critical ? 8 : 4, message: `${source.label} is ${source.status}.`, materiality: source.critical ? TAX_CONFIDENCE_MATERIALITY.MEDIUM : TAX_CONFIDENCE_MATERIALITY.LOW, fixAction: source.fixAction }));
  }
  if (materiality.needsReviewMateriality === TAX_CONFIDENCE_MATERIALITY.HIGH) penalties.push(createConfidencePenalty({ code: "high_material_needs_review", category: CATEGORIES.TRANSACTION_CLASSIFICATION, points: 15, message: "Needs-review transaction dollars are material.", materiality: TAX_CONFIDENCE_MATERIALITY.HIGH, fixAction: "review_large_deductions" }));
  if (materiality.needsReviewMateriality === TAX_CONFIDENCE_MATERIALITY.CRITICAL) penalties.push(createConfidencePenalty({ code: "critical_material_needs_review", category: CATEGORIES.TRANSACTION_CLASSIFICATION, points: 25, message: "Needs-review transaction dollars are critically material.", materiality: TAX_CONFIDENCE_MATERIALITY.CRITICAL, fixAction: "review_large_deductions" }));
  if ((unsupported || []).length) penalties.push(createConfidencePenalty({ code: "unsupported_items_present", category: CATEGORIES.UNSUPPORTED_SCOPE, points: Math.min(20, unsupported.length * 5), message: "Some tax scope is unsupported.", materiality: TAX_CONFIDENCE_MATERIALITY.MEDIUM, fixAction: "review_tax_inputs" }));
  if ((deferred || []).includes("qbi_deduction")) penalties.push(createConfidencePenalty({ code: "qbi_deferred", category: CATEGORIES.UNSUPPORTED_SCOPE, points: 6, message: "QBI is deferred and not included.", materiality: TAX_CONFIDENCE_MATERIALITY.MEDIUM, fixAction: "review_qbi_inputs" }));
  if (c.safeHarbor?.combined?.status === "unavailable") penalties.push(createConfidencePenalty({ code: "safe_harbor_unavailable", category: CATEGORIES.SAFE_HARBOR, points: 6, message: "Safe harbor is unavailable; reserve readiness is reduced.", materiality: TAX_CONFIDENCE_MATERIALITY.MEDIUM, fixAction: "add_prior_year_tax" }));
  if (c.reserve?.status === "setup_incomplete") penalties.push(createConfidencePenalty({ code: "reserve_account_missing", category: CATEGORIES.RESERVE, points: 8, message: "No verified tax reserve balance is available.", materiality: TAX_CONFIDENCE_MATERIALITY.MEDIUM, fixAction: "connect_reserve_account" }));
  if (allWarnings.some((warning) => ["missing_w2_wages", "other_fica_wages_unknown", "missing_other_w2_wages"].includes(warning.code))) {
    penalties.push(createConfidencePenalty({ code: "other_w2_wages_unknown", category: CATEGORIES.SELF_EMPLOYMENT, points: 8, message: "Other W-2/FICA wages are unknown.", materiality: TAX_CONFIDENCE_MATERIALITY.MEDIUM, fixAction: "add_other_w2_wages" }));
  }
  if (allWarnings.some((warning) => ["reasonable_salary_missing", "owner_wages_missing", "owner_wages_below_target"].includes(warning.code))) {
    penalties.push(createConfidencePenalty({ code: "s_corp_salary_uncertainty", category: CATEGORIES.S_CORP, points: 10, message: "S-Corp wage or salary inputs are uncertain.", materiality: TAX_CONFIDENCE_MATERIALITY.HIGH, fixAction: "review_s_corp_salary" }));
  }
  return penalties;
}

function collectBlockers(c, warnings, unsupported) {
  const blockers = [];
  if (c.profile?.entityContext?.blockers?.length) {
    for (const blocker of c.profile.entityContext.blockers) blockers.push(createConfidenceBlocker({ code: blocker.code || "entity_blocker", severity: TAX_CONFIDENCE_BLOCKER_SEVERITIES.FATAL, message: blocker.message || "Entity setup blocks calculation.", affectedOutputs: ["all"], fixAction: "complete_tax_profile" }));
  }
  if (!c.federal?.incomeTax && !c.federal?.totalFederalTax) blockers.push(createConfidenceBlocker({ code: "federal_unavailable", severity: TAX_CONFIDENCE_BLOCKER_SEVERITIES.FATAL, message: "Federal tax calculation is unavailable.", affectedOutputs: ["federal", "liability"], fixAction: "verify_tax_rule_config" }));
  if (!c.actuals?.taxableIncome) blockers.push(createConfidenceBlocker({ code: "taxable_income_unavailable", severity: TAX_CONFIDENCE_BLOCKER_SEVERITIES.FATAL, message: "Taxable-income source is unavailable.", affectedOutputs: ["taxable_income", "projection", "liability"], fixAction: "run_classification" }));
  if (warnings.some((warning) => ["missing_brackets", "missing_standard_deduction_rule", "rule_support_insufficient"].includes(warning.code))) {
    blockers.push(createConfidenceBlocker({ code: "federal_rules_unusable", severity: TAX_CONFIDENCE_BLOCKER_SEVERITIES.FATAL, message: "Federal rule configuration is missing or unusable.", affectedOutputs: ["federal", "liability"], fixAction: "verify_tax_rule_config" }));
  }
  if ((unsupported || []).some((item) => ["unsupported_entity", "partnership", "c_corp"].includes(item))) {
    blockers.push(createConfidenceBlocker({ code: "unsupported_entity", severity: TAX_CONFIDENCE_BLOCKER_SEVERITIES.FATAL, message: "Entity scenario is unsupported.", affectedOutputs: ["all"], fixAction: "complete_tax_profile", resolvable: true }));
  }
  if (c.state?.incomeTax?.confidence?.level === "unavailable") {
    blockers.push(createConfidenceBlocker({ code: "state_unavailable", severity: TAX_CONFIDENCE_BLOCKER_SEVERITIES.MODERATE, message: "State tax is unavailable; federal estimate may still be usable.", affectedOutputs: ["state", "total_liability"], fixAction: "verify_state_rules" }));
  }
  return blockers;
}

function computeMaterialUncertainty(c, coverage) {
  const projectedTaxableIncome = Math.max(1, Math.abs(Number(c.projection?.projectedAnnual?.taxableBusinessIncome || c.actuals?.taxableIncome?.businessTaxableIncome?.finalBusinessTaxableIncome || 0)));
  const needsReviewAmount = Math.abs(Number(coverage?.needsReviewAmount ?? c.actuals?.deductions?.coverage?.needsReviewBookAmount ?? c.actuals?.taxableIncome?.expenses?.needsReviewAmount ?? 0));
  const needsReviewRatio = needsReviewAmount / projectedTaxableIncome;
  const projectedTax = Math.max(1, Math.abs(Number(c.liability?.projectedTotalTax || 0)));
  const low = Number(c.projection?.range?.taxableIncomeLow ?? c.projection?.range?.low ?? c.projection?.projectedAnnual?.taxableBusinessIncome ?? 0);
  const high = Number(c.projection?.range?.taxableIncomeHigh ?? c.projection?.range?.high ?? c.projection?.projectedAnnual?.taxableBusinessIncome ?? 0);
  const dollarRange = Math.abs(high - low);
  const percentRange = dollarRange / projectedTaxableIncome;
  const missingPaymentsRatio = Number(c.liability?.remainingProjectedLiability || 0) / projectedTax;
  return {
    dollarRange: round2(dollarRange),
    percentRange: round2(percentRange),
    needsReviewAmount: round2(needsReviewAmount),
    needsReviewRatio: round2(needsReviewRatio),
    missingPaymentsRatio: round2(missingPaymentsRatio),
    needsReviewMateriality: materialityFor(needsReviewRatio),
    needsReviewScore: scoreForMateriality(needsReviewRatio),
    topDrivers: [
      { code: "projection_range", amount: round2(dollarRange), materiality: materialityFor(percentRange) },
      { code: "needs_review_amount", amount: round2(needsReviewAmount), materiality: materialityFor(needsReviewRatio) },
      { code: "remaining_liability", amount: round2(c.liability?.remainingProjectedLiability), materiality: materialityFor(missingPaymentsRatio) },
    ],
  };
}

function improvementActions({ blockers, penalties, c, materiality, freshness }) {
  const actions = new Map();
  const add = (code, priority, title, description, expectedConfidenceGain, route, payload = {}) => {
    if (!actions.has(code)) actions.set(code, { code, priority, title, description, expectedConfidenceGain, route, payload });
  };
  for (const blocker of blockers) add(blocker.fixAction || "review_tax_inputs", "high", titleFor(blocker.fixAction), blocker.message, "high impact", routeFor(blocker.fixAction), { blockerCode: blocker.code });
  for (const penalty of penalties) add(penalty.fixAction || "review_tax_inputs", priorityFor(penalty), titleFor(penalty.fixAction), penalty.message, gainFor(penalty), routeFor(penalty.fixAction), { penaltyCode: penalty.code });
  if (materiality.needsReviewMateriality === TAX_CONFIDENCE_MATERIALITY.HIGH || materiality.needsReviewMateriality === TAX_CONFIDENCE_MATERIALITY.CRITICAL) add("review_large_deductions", "high", "Review large deductions", "Needs-review deductions are materially affecting confidence.", "high impact", "/tax");
  if (c.safeHarbor?.combined?.status === "unavailable") add("add_prior_year_tax", "medium", "Add prior-year tax inputs", "Safe harbor cannot be completed without verified inputs and rules.", "medium impact", "/tax/profile");
  for (const stale of freshness.staleSources || []) add(stale.fixAction, stale.critical ? "high" : "medium", titleFor(stale.fixAction), `${stale.label} is ${stale.status}.`, stale.critical ? "medium impact" : "low impact", routeFor(stale.fixAction));
  return [...actions.values()].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.code.localeCompare(b.code));
}

function isEstimateReady({ c, blockers, score }) {
  const fatal = blockers.some((blocker) => blocker.severity === TAX_CONFIDENCE_BLOCKER_SEVERITIES.FATAL);
  return !fatal && score > 0 && Boolean(c.federal?.totalFederalTax != null || c.federal?.incomeTax) && Boolean(c.actuals?.taxableIncome);
}

function isReserveReady({ c, blockers, score }) {
  return isEstimateReady({ c, blockers, score })
    && score >= 65
    && c.safeHarbor?.combined?.status !== "unavailable"
    && c.reserveInput?.reserveBufferPercent != null
    && c.reserve?.status !== "setup_incomplete"
    && c.reserve?.status !== "unavailable"
    && c.reserve?.reserve?.currentReserve != null;
}

function statusFor({ estimateReady, reserveReady, blockers, c, level }) {
  if (blockers.some((blocker) => blocker.severity === TAX_CONFIDENCE_BLOCKER_SEVERITIES.FATAL)) return TAX_CONFIDENCE_STATUSES.UNAVAILABLE;
  if (c.profile?.completeness?.isCompleteForEstimate === false) return TAX_CONFIDENCE_STATUSES.SETUP_INCOMPLETE;
  if (!estimateReady) return TAX_CONFIDENCE_STATUSES.PARTIAL;
  if (reserveReady) return TAX_CONFIDENCE_STATUSES.RESERVE_READY;
  if (level === "low" || blockers.length) return TAX_CONFIDENCE_STATUSES.PARTIAL;
  return TAX_CONFIDENCE_STATUSES.ESTIMATE_READY;
}

function weightsFor(calculationType) {
  const weights = { ...BASE_WEIGHTS };
  if (calculationType === "ytd_actual") {
    weights.projection = 0.05;
    weights.taxableIncome = 0.32;
    weights.classifications = 0.20;
  } else if (calculationType === "reserve_only") {
    weights.paymentsSafeHarbor = 0.20;
    weights.projection = 0.18;
    weights.taxableIncome = 0.18;
    weights.federal = 0.08;
  } else if (calculationType === "manual_override" || calculationType === "scenario") {
    weights.projection = 0.18;
    weights.entityProfile = 0.12;
  }
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0) || 1;
  return Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, value / total]));
}

function weightedScore(factors) {
  const weighted = factors.filter((factor) => factor.weight > 0);
  const totalWeight = weighted.reduce((sum, factor) => sum + factor.weight, 0) || 1;
  return weighted.reduce((sum, factor) => sum + factor.score * factor.weight, 0) / totalWeight;
}

function applyCaps(score, blockers) {
  if (blockers.some((blocker) => blocker.severity === TAX_CONFIDENCE_BLOCKER_SEVERITIES.FATAL)) return Math.min(score, 20);
  if (blockers.some((blocker) => blocker.severity === TAX_CONFIDENCE_BLOCKER_SEVERITIES.MAJOR)) return Math.min(score, 55);
  if (blockers.some((blocker) => blocker.severity === TAX_CONFIDENCE_BLOCKER_SEVERITIES.MODERATE)) return Math.min(score, 75);
  return score;
}

function sectionScores(factors) {
  const map = {};
  for (const factor of factors) map[factor.category] = Math.round(factor.score);
  return {
    taxableIncome: map[CATEGORIES.TAXABLE_INCOME],
    projection: map[CATEGORIES.PROJECTION],
    federal: map[CATEGORIES.FEDERAL_RULES],
    selfEmployment: map[CATEGORIES.SELF_EMPLOYMENT],
    sCorp: map[CATEGORIES.S_CORP],
    state: map[CATEGORIES.STATE_RULES],
    payments: map[CATEGORIES.PAYMENTS],
    safeHarbor: map[CATEGORIES.PAYMENTS],
    reserve: map[CATEGORIES.RESERVE] || map[CATEGORIES.PAYMENTS],
  };
}

function factor(code, category, label, score, weight, message, fixAction, materiality = TAX_CONFIDENCE_MATERIALITY.LOW) {
  return createConfidenceFactor({ code, category, label, score, weight, message, fixAction, materiality, source: category });
}

function scorePayments(c) {
  if (c.payments?.source === "none") return 30;
  const projected = Math.max(1, Number(c.liability?.projectedTotalTax || 0));
  const covered = Number(c.liability?.paymentsAndWithholdingYtd || 0);
  if (covered <= 0 && projected > 0) return 55;
  return 80;
}

function scoreFrom(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, Math.round(n)));
  }
  return 60;
}

function materialityFor(ratio) {
  if (ratio >= 0.5) return TAX_CONFIDENCE_MATERIALITY.CRITICAL;
  if (ratio >= 0.2) return TAX_CONFIDENCE_MATERIALITY.HIGH;
  if (ratio >= 0.1) return TAX_CONFIDENCE_MATERIALITY.MEDIUM;
  if (ratio >= 0.02) return TAX_CONFIDENCE_MATERIALITY.LOW;
  return TAX_CONFIDENCE_MATERIALITY.IMMATERIAL;
}

function scoreForMateriality(ratio) {
  if (ratio >= 0.5) return 20;
  if (ratio >= 0.2) return 45;
  if (ratio >= 0.1) return 65;
  if (ratio >= 0.02) return 82;
  return 95;
}

function totalPenaltyPoints(penalties) {
  return penalties.reduce((sum, penalty) => sum + Number(penalty.points || 0), 0);
}

function explanationFor({ score, level, status, blockers }) {
  if (blockers.some((blocker) => blocker.severity === TAX_CONFIDENCE_BLOCKER_SEVERITIES.FATAL)) {
    return "Critical setup or rule blockers prevent an authoritative tax estimate.";
  }
  return `Overall tax confidence is ${level} (${score}/100) with status ${status}.`;
}

function titleFor(code) {
  return String(code || "review_tax_inputs").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function routeFor(code) {
  return ({
    complete_tax_profile: "/tax/profile",
    confirm_llc_election: "/tax/profile",
    classify_transactions: "/tax",
    review_large_deductions: "/tax",
    add_prior_year_tax: "/tax/profile",
    add_other_w2_wages: "/tax/profile",
    verify_state_rules: "/tax/rule-support",
    enter_tax_payments: "/tax/payments",
    connect_reserve_account: "/tax/reserve",
    refresh_forecast: "/forecast",
    review_s_corp_salary: "/tax/entity",
    resolve_source_mismatch: "/accounting/bookkeeping",
    refresh_books: "/accounting/bookkeeping",
  })[code] || "/tax";
}

function priorityFor(penalty) {
  if (penalty.materiality === TAX_CONFIDENCE_MATERIALITY.CRITICAL || penalty.points >= 15) return "high";
  if (penalty.materiality === TAX_CONFIDENCE_MATERIALITY.HIGH || penalty.points >= 8) return "medium";
  return "low";
}

function gainFor(penalty) {
  if (penalty.points >= 12) return "high impact";
  if (penalty.points >= 6) return "medium impact";
  return "low impact";
}

function priorityRank(priority) {
  return { high: 0, medium: 1, low: 2 }[priority] ?? 3;
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
