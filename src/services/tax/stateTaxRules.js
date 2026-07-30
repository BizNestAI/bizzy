// /src/services/tax/stateTaxRules.js
// Deprecated compatibility wrapper.
// State rules must now be loaded from state_tax_rule_configs through
// stateTaxRule.repository.js. This file intentionally does not estimate.

export function getStateRule(state) {
  return {
    stateCode: state || null,
    kind: "unsupported",
    flatRate: null,
    brackets: null,
    supportLevel: "unsupported",
    warning: "State tax rules must be loaded from state_tax_rule_configs.",
  };
}
