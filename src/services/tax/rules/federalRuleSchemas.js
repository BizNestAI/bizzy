// /src/services/tax/rules/federalRuleSchemas.js
import { FEDERAL_TAX_RULE_TYPES } from "../taxRuleTypes.js";
import { validationError } from "../taxErrors.js";
import { assertBoolean, assertFiniteNumber, assertObject, assertRate, validateBrackets } from "./ruleSchemaUtils.js";

export function validateFederalRuleConfig(ruleType, config) {
  const c = assertObject(config, "config");
  switch (ruleType) {
    case FEDERAL_TAX_RULE_TYPES.FEDERAL_INCOME_TAX_BRACKETS:
      return { ...c, brackets: validateBrackets(c.brackets), currency: c.currency || "USD", annual: c.annual === true };
    case FEDERAL_TAX_RULE_TYPES.STANDARD_DEDUCTION:
      return validateStandardDeduction(c);
    case FEDERAL_TAX_RULE_TYPES.SELF_EMPLOYMENT_TAX:
      return {
        ...c,
        netEarningsFactor: assertRate(c.netEarningsFactor, "config.netEarningsFactor"),
        socialSecurityRate: assertRate(c.socialSecurityRate, "config.socialSecurityRate"),
        medicareRate: assertRate(c.medicareRate, "config.medicareRate"),
        socialSecurityWageBase: assertFiniteNumber(c.socialSecurityWageBase, "config.socialSecurityWageBase", { min: 0 }),
        deductiblePortionRate: assertRate(c.deductiblePortionRate, "config.deductiblePortionRate"),
      };
    case FEDERAL_TAX_RULE_TYPES.ADDITIONAL_MEDICARE_TAX:
      return validateThresholdRule(c, "additionalMedicareTax", { rateRequired: true });
    case FEDERAL_TAX_RULE_TYPES.QBI:
      return {
        ...c,
        baseDeductionRate: assertRate(c.baseDeductionRate, "config.baseDeductionRate"),
        limitationsSupported: assertBoolean(c.limitationsSupported, "config.limitationsSupported"),
      };
    case FEDERAL_TAX_RULE_TYPES.ESTIMATED_TAX_SAFE_HARBOR:
      return {
        ...c,
        currentYearPercent: assertRate(c.currentYearPercent, "config.currentYearPercent"),
        priorYearPercent: assertRate(c.priorYearPercent, "config.priorYearPercent"),
        highIncomePriorYearPercent: assertFiniteNumber(c.highIncomePriorYearPercent, "config.highIncomePriorYearPercent", { min: 0, max: 2 }),
      };
    case FEDERAL_TAX_RULE_TYPES.ESTIMATED_TAX_DUE_DATES:
      return validateDueDates(c);
    case FEDERAL_TAX_RULE_TYPES.SOCIAL_SECURITY_WAGE_BASE:
    case FEDERAL_TAX_RULE_TYPES.SECTION_179:
    case FEDERAL_TAX_RULE_TYPES.DE_MINIMIS_SAFE_HARBOR:
      return { ...c, amount: assertFiniteNumber(c.amount, "config.amount", { min: 0 }) };
    case FEDERAL_TAX_RULE_TYPES.MILEAGE_RATE:
    case FEDERAL_TAX_RULE_TYPES.BONUS_DEPRECIATION:
    case FEDERAL_TAX_RULE_TYPES.MEALS_DEDUCTION:
      return { ...c, rate: assertRate(c.rate, "config.rate") };
    case FEDERAL_TAX_RULE_TYPES.QUALIFIED_PLAN_LIMITS:
    case FEDERAL_TAX_RULE_TYPES.HSA_LIMITS:
    case FEDERAL_TAX_RULE_TYPES.FILING_STATUS_THRESHOLDS:
      return c;
    default:
      throw validationError("invalid_rule_type", "Federal tax rule type is not supported.", { ruleType });
  }
}

function validateStandardDeduction(c) {
  return { ...c, amount: assertFiniteNumber(c.amount, "config.amount", { min: 0 }), annual: c.annual === true };
}

function validateThresholdRule(c, name, { rateRequired = false } = {}) {
  if (rateRequired) assertRate(c.rate, "config.rate");
  assertObject(c.thresholdsByFilingStatus, "config.thresholdsByFilingStatus");
  for (const [status, threshold] of Object.entries(c.thresholdsByFilingStatus)) {
    assertFiniteNumber(threshold, `config.thresholdsByFilingStatus.${status}`, { min: 0 });
  }
  return c;
}

function validateDueDates(c) {
  if (!Array.isArray(c.installments) || !c.installments.length) {
    throw validationError("invalid_due_dates", "Due date config requires installments.", { field: "config.installments" });
  }
  for (const item of c.installments) {
    assertFiniteNumber(item.quarter, "config.installments.quarter", { min: 1, max: 4 });
    assertFiniteNumber(item.dueMonth, "config.installments.dueMonth", { min: 1, max: 12 });
    assertFiniteNumber(item.dueDay, "config.installments.dueDay", { min: 1, max: 31 });
  }
  return c;
}
