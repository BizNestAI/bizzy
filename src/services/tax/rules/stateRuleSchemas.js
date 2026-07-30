// /src/services/tax/rules/stateRuleSchemas.js
import { STATE_TAX_RULE_TYPES } from "../taxRuleTypes.js";
import { validationError } from "../taxErrors.js";
import { assertFiniteNumber, assertObject, assertRate, validateBrackets } from "./ruleSchemaUtils.js";

export function validateStateRuleConfig(ruleType, config) {
  const c = assertObject(config, "config");
  if (ruleType === STATE_TAX_RULE_TYPES.NO_INDIVIDUAL_INCOME_TAX) {
    return { ...c, kind: "none", annual: c.annual !== false };
  }
  if (ruleType === STATE_TAX_RULE_TYPES.INDIVIDUAL_INCOME_TAX) {
    if (!["flat", "progressive", "income_classes", "gross_income_categories", "none", "unsupported"].includes(c.kind)) {
      throw validationError("invalid_state_income_tax_kind", "State income tax kind must be flat, progressive, income_classes, gross_income_categories, none, or unsupported.", { field: "config.kind" });
    }
    if (c.kind === "flat") return { ...c, rate: assertRate(c.rate, "config.rate"), annual: c.annual === true };
    if (c.kind === "progressive") return { ...c, brackets: validateBrackets(c.brackets), annual: c.annual === true };
    return c;
  }
  if (ruleType === STATE_TAX_RULE_TYPES.INDIVIDUAL_CAPITAL_GAINS_EXCISE_TAX) {
    return c;
  }
  if (ruleType === STATE_TAX_RULE_TYPES.GROSS_RECEIPTS_TAX || ruleType === STATE_TAX_RULE_TYPES.PAYROLL_EXCISE_TAX) {
    return { ...c, rate: c.rate == null ? null : assertRate(c.rate, "config.rate") };
  }
  if (ruleType === STATE_TAX_RULE_TYPES.S_CORP_ENTITY_TAX) {
    return { ...c, rate: c.rate == null ? null : assertRate(c.rate, "config.rate") };
  }
  if (ruleType === STATE_TAX_RULE_TYPES.OWNER_LEVEL_BUSINESS_INCOME_ELECTION) {
    return { ...c, rate: c.rate == null ? null : assertRate(c.rate, "config.rate") };
  }
  if (ruleType === STATE_TAX_RULE_TYPES.S_CORP_MINIMUM_TAX || ruleType === STATE_TAX_RULE_TYPES.FRANCHISE_TAX) {
    return { ...c, amount: c.amount == null ? null : assertFiniteNumber(c.amount, "config.amount", { min: 0 }) };
  }
  return c;
}
