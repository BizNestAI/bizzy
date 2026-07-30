// /src/services/tax/payments/safeHarborEngine.js
import { SAFE_HARBOR_METHODS, TAX_RULE_SUPPORT_LEVELS } from "../taxDomain.js";
import { allowLegacyRules, getSupportRank } from "../rules/taxRuleSafety.js";

export const SAFE_HARBOR_WARNING_CODES = Object.freeze({
  FEDERAL_RULE_MISSING: "federal_safe_harbor_rule_missing",
  STATE_RULE_MISSING: "state_safe_harbor_rule_missing",
  DUE_DATES_MISSING: "estimated_tax_due_dates_missing",
  PRIOR_YEAR_TAX_MISSING: "prior_year_tax_missing",
  PRIOR_YEAR_AGI_MISSING: "prior_year_agi_missing",
  METHOD_UNAVAILABLE: "safe_harbor_method_unavailable",
  WITHHOLDING_TIMING_MISSING: "withholding_timing_rule_missing",
  PROJECTION_UNAVAILABLE: "safe_harbor_projection_unavailable",
});

export function computeSafeHarbor({
  currentProjectedFederalTax = 0,
  currentProjectedStateTax = 0,
  priorYearTotalTax = null,
  priorYearAgi = null,
  filingStatus,
  safeHarborMethod = SAFE_HARBOR_METHODS.CURRENT_YEAR_90,
  federalSafeHarborConfig = null,
  stateSafeHarborConfig = null,
  federalDueDateConfig = null,
  stateDueDateConfig = null,
  payments = {},
  withholding = {},
  asOfDate,
  taxYear,
} = {}) {
  const federal = computeJurisdictionSafeHarbor({
    jurisdiction: "federal",
    projectedTax: currentProjectedFederalTax,
    priorYearTotalTax,
    priorYearAgi,
    filingStatus,
    method: safeHarborMethod,
    config: federalSafeHarborConfig,
    dueDateConfig: federalDueDateConfig,
    paid: Number(payments?.federal?.estimatedPayments || 0),
    withheld: Number(withholding?.federal || payments?.federal?.withholding || 0),
    asOfDate,
    taxYear,
  });
  const state = computeJurisdictionSafeHarbor({
    jurisdiction: "state",
    projectedTax: currentProjectedStateTax,
    priorYearTotalTax,
    priorYearAgi,
    filingStatus,
    method: safeHarborMethod,
    config: stateSafeHarborConfig,
    dueDateConfig: stateDueDateConfig,
    paid: Number(payments?.state?.estimatedPayments || 0),
    withheld: Number(withholding?.state || payments?.state?.withholding || 0),
    asOfDate,
    taxYear,
  });
  const knownRequired = [federal.requiredAnnual, state.requiredAnnual].filter((value) => value != null).reduce((sum, value) => sum + Number(value), 0);
  const knownRemaining = [federal.remainingAmount, state.remainingAmount].filter((value) => value != null).reduce((sum, value) => sum + Number(value), 0);
  const combinedStatus = federal.status === "available" && state.status === "available"
    ? "available"
    : federal.status === "available" || state.status === "available"
      ? "partial"
      : "unavailable";
  return {
    federal,
    state,
    combined: {
      status: combinedStatus,
      requiredAnnual: knownRequired ? round2(knownRequired) : null,
      coveredAmount: round2(federal.coveredAmount + state.coveredAmount),
      remainingAmount: knownRemaining || combinedStatus !== "unavailable" ? round2(Math.max(0, knownRemaining)) : null,
    },
  };
}

function computeJurisdictionSafeHarbor({ jurisdiction, projectedTax, priorYearTotalTax, priorYearAgi, filingStatus, method, config, dueDateConfig, paid, withheld, taxYear }) {
  const warnings = [];
  const blockers = [];
  const assumptions = [];
  const coveredAmount = round2(Number(paid || 0) + Number(withheld || 0));
  const configCheck = validateConfig({ jurisdiction, config });
  warnings.push(...configCheck.warnings);
  blockers.push(...configCheck.blockers);
  if (!configCheck.usable) {
    return unavailableResult({ jurisdiction, method, coveredAmount, warnings, blockers, assumptions });
  }

  const c = configCheck.config;
  if (jurisdiction === "state" && (c.entityEstimateOnly === true || c.doesNotCreateIndividualSafeHarbor === true)) {
    warnings.push(warning(SAFE_HARBOR_WARNING_CODES.METHOD_UNAVAILABLE, "medium", "State estimated-payment rule is entity-only and does not create an individual safe-harbor target.", "review_entity_estimates"));
    blockers.push({ code: SAFE_HARBOR_WARNING_CODES.METHOD_UNAVAILABLE, message: "Entity-only estimated-payment rule is excluded from individual safe harbor." });
    return unavailableResult({ jurisdiction, method, coveredAmount, warnings, blockers, assumptions });
  }
  const currentYearPercent = finiteOrNull(c.currentYearPercent);
  const priorYearPercent = finiteOrNull(c.priorYearPercent);
  const highIncomePriorYearPercent = finiteOrNull(c.highIncomePriorYearPercent);
  const dueDateRows = dueDateInstallments(dueDateConfig || (Array.isArray(c.installments) ? config : null), warnings, blockers);
  if (dueDateRows.assumption) assumptions.push(dueDateRows.assumption);
  const threshold = c.highIncomeAgiThresholdsByFilingStatus?.[filingStatus] ?? c.highIncomeAgiThresholdsByFilingStatus?.default ?? null;
  const currentYearTarget = Number.isFinite(Number(projectedTax)) ? round2(Number(projectedTax) * currentYearPercent) : null;
  let priorYearTarget = null;
  let requiredAnnual = null;
  if ([SAFE_HARBOR_METHODS.PRIOR_YEAR_100, SAFE_HARBOR_METHODS.PRIOR_YEAR_110].includes(method)) {
    const priorYearMethod = c.priorYearMethod || "prior_year_tax_percent";
    if (priorYearMethod !== "prior_year_tax_percent") {
      const requiredInputs = Array.isArray(c.priorYearMethodRequiredInputs) ? c.priorYearMethodRequiredInputs : [];
      warnings.push(warning(SAFE_HARBOR_WARNING_CODES.METHOD_UNAVAILABLE, "high", `${label(jurisdiction)} prior-year safe-harbor method requires jurisdiction-specific inputs.`, "complete_tax_profile"));
      blockers.push({
        code: SAFE_HARBOR_WARNING_CODES.METHOD_UNAVAILABLE,
        message: "Prior-year safe-harbor method is not a generic prior-year-tax percentage.",
        method: priorYearMethod,
        requiredInputs,
      });
      return unavailableResult({ jurisdiction, method, coveredAmount, currentYearTarget, warnings, blockers, assumptions });
    }
    if (method === SAFE_HARBOR_METHODS.PRIOR_YEAR_100 && priorYearPercent == null) {
      warnings.push(warning(SAFE_HARBOR_WARNING_CODES.METHOD_UNAVAILABLE, "high", `${label(jurisdiction)} prior-year safe-harbor percentage is unavailable.`, "verify_tax_rule_config"));
      blockers.push({ code: SAFE_HARBOR_WARNING_CODES.METHOD_UNAVAILABLE, message: "Prior-year safe-harbor percentage is unavailable." });
      return unavailableResult({ jurisdiction, method, coveredAmount, currentYearTarget, warnings, blockers, assumptions });
    }
    if (method === SAFE_HARBOR_METHODS.PRIOR_YEAR_110 && (priorYearPercent == null || highIncomePriorYearPercent == null)) {
      warnings.push(warning(SAFE_HARBOR_WARNING_CODES.METHOD_UNAVAILABLE, "high", `${label(jurisdiction)} high-income prior-year safe-harbor percentages are unavailable.`, "verify_tax_rule_config"));
      blockers.push({ code: SAFE_HARBOR_WARNING_CODES.METHOD_UNAVAILABLE, message: "High-income prior-year safe-harbor percentages are unavailable." });
      return unavailableResult({ jurisdiction, method, coveredAmount, currentYearTarget, warnings, blockers, assumptions });
    }
    if (priorYearTotalTax == null || !Number.isFinite(Number(priorYearTotalTax))) {
      warnings.push(warning(SAFE_HARBOR_WARNING_CODES.PRIOR_YEAR_TAX_MISSING, "high", "Prior-year total tax is required for prior-year safe harbor.", "complete_tax_profile"));
      blockers.push({ code: SAFE_HARBOR_WARNING_CODES.PRIOR_YEAR_TAX_MISSING, message: "Prior-year total tax is required." });
      return unavailableResult({ jurisdiction, method, coveredAmount, currentYearTarget, warnings, blockers, assumptions });
    }
    if (method === SAFE_HARBOR_METHODS.PRIOR_YEAR_110) {
      if (priorYearAgi == null || !Number.isFinite(Number(priorYearAgi)) || threshold == null || !Number.isFinite(Number(threshold))) {
        warnings.push(warning(SAFE_HARBOR_WARNING_CODES.PRIOR_YEAR_AGI_MISSING, "high", "Prior-year AGI and threshold config are required for 110% prior-year safe harbor.", "complete_tax_profile"));
        blockers.push({ code: SAFE_HARBOR_WARNING_CODES.PRIOR_YEAR_AGI_MISSING, message: "Prior-year AGI or threshold config is missing." });
        return unavailableResult({ jurisdiction, method, coveredAmount, currentYearTarget, warnings, blockers, assumptions });
      }
      priorYearTarget = round2(Number(priorYearTotalTax) * (Number(priorYearAgi) > Number(threshold) ? highIncomePriorYearPercent : priorYearPercent));
      requiredAnnual = priorYearTarget;
    } else {
      priorYearTarget = round2(Number(priorYearTotalTax) * priorYearPercent);
      requiredAnnual = priorYearTarget;
    }
  } else if (method === SAFE_HARBOR_METHODS.CURRENT_YEAR_90 || method === SAFE_HARBOR_METHODS.CUSTOM || method === SAFE_HARBOR_METHODS.UNKNOWN || !method) {
    if (currentYearPercent == null) {
      warnings.push(warning(SAFE_HARBOR_WARNING_CODES.METHOD_UNAVAILABLE, "high", `${label(jurisdiction)} current-year safe-harbor percentage is unavailable.`, "verify_tax_rule_config"));
      blockers.push({ code: SAFE_HARBOR_WARNING_CODES.METHOD_UNAVAILABLE, message: "Current-year safe-harbor percentage is unavailable." });
      return unavailableResult({ jurisdiction, method, coveredAmount, warnings, blockers, assumptions });
    }
    if (currentYearTarget == null) {
      warnings.push(warning(SAFE_HARBOR_WARNING_CODES.PROJECTION_UNAVAILABLE, "high", "Projected current-year liability is required for current-year safe harbor.", "run_tax_calculation"));
      blockers.push({ code: SAFE_HARBOR_WARNING_CODES.PROJECTION_UNAVAILABLE, message: "Projected liability is unavailable." });
      return unavailableResult({ jurisdiction, method, coveredAmount, warnings, blockers, assumptions });
    }
    requiredAnnual = currentYearTarget;
  } else {
    warnings.push(warning(SAFE_HARBOR_WARNING_CODES.METHOD_UNAVAILABLE, "high", "Selected safe-harbor method is not supported.", "complete_tax_profile"));
    blockers.push({ code: SAFE_HARBOR_WARNING_CODES.METHOD_UNAVAILABLE, message: "Safe-harbor method is unsupported." });
    return unavailableResult({ jurisdiction, method, coveredAmount, currentYearTarget, warnings, blockers, assumptions });
  }

  const remainingAmount = round2(Math.max(0, requiredAnnual - coveredAmount));
  return {
    status: "available",
    method,
    currentYearTarget,
    priorYearTarget,
    requiredAnnual: round2(requiredAnnual),
    coveredAmount,
    remainingAmount,
    quarterSchedule: dueDateRows.rows.length ? buildQuarterSchedule({ requiredAnnual, paid, taxYear, dueDates: dueDateRows.rows }) : [],
    warnings,
    blockers,
    assumptions,
  };
}

function buildQuarterSchedule({ requiredAnnual, paid, taxYear, dueDates }) {
  const rows = Array.isArray(dueDates) ? dueDates : [];
  const perQuarter = round2(Number(requiredAnnual || 0) / 4);
  let remainingPaid = Number(paid || 0);
  return rows.map((row, index) => {
    const year = Number(taxYear) + Number(row.yearOffset || (row.quarter === 4 && row.dueMonth === 1 ? 1 : 0));
    const due = `${year}-${String(row.dueMonth).padStart(2, "0")}-${String(row.dueDay).padStart(2, "0")}`;
    const percent = finiteOrNull(row.installmentPercent ?? row.percentage ?? row.percent);
    const dueAmount = percent == null ? perQuarter : round2(Number(requiredAnnual || 0) * percent);
    const applied = Math.min(dueAmount, Math.max(0, remainingPaid));
    remainingPaid -= applied;
    return { quarter: `Q${row.quarter || index + 1}`, due, amount: dueAmount, paid: round2(applied), remaining: round2(Math.max(0, dueAmount - applied)) };
  });
}

function validateConfig({ jurisdiction, config }) {
  const warnings = [];
  const blockers = [];
  if (!config) {
    const code = jurisdiction === "state" ? SAFE_HARBOR_WARNING_CODES.STATE_RULE_MISSING : SAFE_HARBOR_WARNING_CODES.FEDERAL_RULE_MISSING;
    warnings.push(warning(code, "high", `${label(jurisdiction)} safe-harbor rule config is missing.`, "verify_tax_rule_config"));
    blockers.push({ code, message: `${label(jurisdiction)} safe-harbor rule config is missing.` });
    return { usable: false, config: null, warnings, blockers };
  }
  const supportLevel = config.support_level || config.supportLevel || TAX_RULE_SUPPORT_LEVELS.UNSUPPORTED;
  const rank = getSupportRank(supportLevel);
  const supportedRank = getSupportRank(TAX_RULE_SUPPORT_LEVELS.SIMPLIFIED);
  const legacyAllowed = supportLevel === TAX_RULE_SUPPORT_LEVELS.LEGACY_ESTIMATE && allowLegacyRules();
  if (rank < supportedRank && !legacyAllowed) {
    const code = jurisdiction === "state" ? SAFE_HARBOR_WARNING_CODES.STATE_RULE_MISSING : SAFE_HARBOR_WARNING_CODES.FEDERAL_RULE_MISSING;
    warnings.push(warning(code, "high", `${label(jurisdiction)} safe-harbor rule config is not sufficiently supported.`, "verify_tax_rule_config"));
    blockers.push({ code, message: `${label(jurisdiction)} safe-harbor support level is ${supportLevel}.`, supportLevel });
    return { usable: false, config: null, warnings, blockers };
  }
  if (supportLevel === TAX_RULE_SUPPORT_LEVELS.SIMPLIFIED) {
    warnings.push(warning("safe_harbor_rule_simplified", "medium", `${label(jurisdiction)} safe-harbor rule is simplified.`, "verify_tax_rule_config"));
  }
  return { usable: true, config: config.config || config || {}, warnings, blockers };
}

function dueDateInstallments(config, warnings, blockers) {
  const c = config?.config || config || {};
  const rows = Array.isArray(c.installments) ? c.installments : [];
  if (!rows.length) {
    warnings.push(warning(SAFE_HARBOR_WARNING_CODES.DUE_DATES_MISSING, "medium", "Estimated tax due-date config is missing; quarterly schedule is unavailable.", "verify_tax_rule_config"));
    blockers.push({ code: SAFE_HARBOR_WARNING_CODES.DUE_DATES_MISSING, message: "Estimated payment due dates are unavailable." });
    return { rows: [], assumption: null };
  }
  return { rows, assumption: null };
}

function unavailableResult({ jurisdiction, method, coveredAmount, currentYearTarget = null, warnings, blockers, assumptions }) {
  return {
    status: "unavailable",
    method,
    currentYearTarget,
    priorYearTarget: null,
    requiredAnnual: null,
    coveredAmount,
    remainingAmount: null,
    quarterSchedule: [],
    warnings,
    blockers,
    assumptions,
    jurisdiction,
  };
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function label(jurisdiction) {
  return jurisdiction === "state" ? "State" : "Federal";
}

function warning(code, severity, message, action) {
  return { code, severity, message, ...(action ? { action } : {}) };
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
