// /src/services/tax/stateTaxRules.js
// Placeholder rules. In the future, read from tax_config.stateRules.
export function getStateRule(state) {
  const flat = {
    FL: { flatRate: 0 },
    TX: { flatRate: 0 },
    WA: { flatRate: 0 },
    NV: { flatRate: 0 },
    SD: { flatRate: 0 },
    WY: { flatRate: 0 },
    TN: { flatRate: 0 },
    NH: { flatRate: 0 },
    AK: { flatRate: 0 },
    NC: { flatRate: 0.0475 },
    CA: { flatRate: 0.06 },   // placeholder – replace with brackets
    NY: { flatRate: 0.058 },  // placeholder
  };
  return flat[state] || { flatRate: 0.05 };
}
