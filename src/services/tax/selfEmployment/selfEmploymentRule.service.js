// /src/services/tax/selfEmployment/selfEmploymentRule.service.js
import { TAX_FILING_STATUSES, TAX_RULE_SUPPORT_LEVELS, normalizeFilingStatus, normalizeTaxYear } from "../taxDomain.js";
import { taxConfigurationError, validationError } from "../taxErrors.js";
import { getTaxRuleConfig, buildTaxRuleConfigSummary } from "../taxRuleConfig.repository.js";
import { FEDERAL_TAX_RULE_TYPES } from "../taxRuleTypes.js";
import { SELF_EMPLOYMENT_WARNING_CODES, seWarning } from "./selfEmploymentTaxDomain.js";

export async function getSelfEmploymentTaxRules({ supabase, taxYear, filingStatus, asOfDate } = {}) {
  if (!supabase) throw new Error("Supabase client required");
  const year = normalizeTaxYear(taxYear);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "taxYear" });
  const status = normalizeFilingStatus(filingStatus);
  const warnings = [];
  if (!status || status === TAX_FILING_STATUSES.UNKNOWN) {
    warnings.push(seWarning(SELF_EMPLOYMENT_WARNING_CODES.FILING_STATUS_MISSING, "medium", "Filing status is missing, so filing-status thresholds may be unavailable."));
  }

  const seRule = await loadRule({
    supabase,
    taxYear: year,
    ruleType: FEDERAL_TAX_RULE_TYPES.SELF_EMPLOYMENT_TAX,
    filingStatus: status,
    asOfDate,
    errorCode: "missing_se_tax_config",
  });
  const wageBaseRule = await loadRule({
    supabase,
    taxYear: year,
    ruleType: FEDERAL_TAX_RULE_TYPES.SOCIAL_SECURITY_WAGE_BASE,
    filingStatus: status,
    asOfDate,
    errorCode: "missing_wage_base_config",
  });
  let additionalMedicareRule = null;
  try {
    additionalMedicareRule = await loadRule({
      supabase,
      taxYear: year,
      ruleType: FEDERAL_TAX_RULE_TYPES.ADDITIONAL_MEDICARE_TAX,
      filingStatus: status,
      asOfDate,
      errorCode: "missing_additional_medicare_config",
    });
  } catch (err) {
    warnings.push(seWarning(SELF_EMPLOYMENT_WARNING_CODES.ADDITIONAL_MEDICARE_NOT_COMPUTED, "medium", "Additional Medicare rule config is unavailable.", { reason: err.code || "missing_additional_medicare_config" }));
  }

  const seConfig = seRule.config || {};
  const wageBase = number(wageBaseRule.config?.amount ?? seConfig.socialSecurityWageBase, "socialSecurityWageBase");
  const threshold = additionalMedicareRule
    ? thresholdForFilingStatus(additionalMedicareRule.config?.thresholdsByFilingStatus, status)
    : null;
  if (additionalMedicareRule && threshold == null) {
    warnings.push(seWarning(SELF_EMPLOYMENT_WARNING_CODES.ADDITIONAL_MEDICARE_NOT_COMPUTED, "medium", "Additional Medicare threshold for filing status is unavailable."));
  }

  return {
    netEarningsFactor: rate(seConfig.netEarningsFactor, "netEarningsFactor"),
    socialSecurityRate: rate(seConfig.socialSecurityRate, "socialSecurityRate"),
    medicareRate: rate(seConfig.medicareRate, "medicareRate"),
    socialSecurityWageBase: wageBase,
    deductiblePortionRate: rate(seConfig.deductiblePortionRate, "deductiblePortionRate"),
    additionalMedicareRate: additionalMedicareRule ? rate(additionalMedicareRule.config?.rate, "additionalMedicareRate") : 0,
    additionalMedicareThreshold: threshold,
    ruleVersions: {
      selfEmploymentTax: seRule.version,
      socialSecurityWageBase: wageBaseRule.version,
      additionalMedicareTax: additionalMedicareRule?.version || null,
    },
    supportSummary: buildTaxRuleConfigSummary([seRule, wageBaseRule, additionalMedicareRule].filter(Boolean)),
    warnings,
    rules: {
      selfEmploymentTax: seRule,
      socialSecurityWageBase: wageBaseRule,
      additionalMedicareTax: additionalMedicareRule,
    },
  };
}

async function loadRule({ errorCode, ...args }) {
  try {
    return await getTaxRuleConfig({
      ...args,
      minimumSupportLevel: TAX_RULE_SUPPORT_LEVELS.VERIFIED,
    });
  } catch (err) {
    throw taxConfigurationError(errorCode, "Required self-employment tax rule configuration is unavailable.", err.details || { ruleType: args.ruleType, taxYear: args.taxYear });
  }
}

function thresholdForFilingStatus(thresholds, filingStatus) {
  if (!thresholds || !filingStatus || filingStatus === TAX_FILING_STATUSES.UNKNOWN) return null;
  return thresholds[filingStatus] ?? thresholds.default ?? null;
}

function number(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw validationError(`invalid_${field}`, `${field} must be a nonnegative finite number.`, { field });
  return n;
}

function rate(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw validationError(`invalid_${field}`, `${field} must be between 0 and 1.`, { field });
  return n;
}
