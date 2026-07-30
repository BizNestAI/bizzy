import { TAX_RECALCULATION_EVENT_TYPES as EVENTS } from "../taxRecalculationEventDomain.js";

export function taxRuleEvent({ scope = "federal", action = "updated", businessId, taxYear, ruleId, userId, changedFields = [], before, after } = {}) {
  const eventType = scope === "state"
    ? action === "published" ? EVENTS.STATE_TAX_RULE_PUBLISHED : EVENTS.STATE_TAX_RULE_UPDATED
    : scope === "deduction"
      ? action === "published" ? EVENTS.TAX_DEDUCTION_RULE_PUBLISHED : EVENTS.TAX_DEDUCTION_RULE_UPDATED
      : action === "published" ? EVENTS.FEDERAL_TAX_RULE_PUBLISHED : EVENTS.FEDERAL_TAX_RULE_UPDATED;
  return {
    eventType,
    businessId,
    taxYear,
    userId,
    source: "tax_rule",
    sourceRecordId: ruleId,
    sourceTable: scope === "state" ? "state_tax_rule_configs" : scope === "deduction" ? "tax_deduction_rules" : "tax_rule_configs",
    changedFields,
    before,
    after,
  };
}
