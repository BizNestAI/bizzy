// /src/services/tax/explanations/taxExplanationSummary.js

export function buildTaxCalculationSummary({ canonicalResult, components = [], diff = null } = {}) {
  const totalTax = money(canonicalResult?.liability?.projectedTotalTax);
  const year = canonicalResult?.meta?.taxYear;
  const drivers = [...components]
    .filter((component) => Math.abs(Number(component.amount || 0)) > 0)
    .sort((a, b) => Math.abs(Number(b.amount || 0)) - Math.abs(Number(a.amount || 0)))
    .slice(0, 3)
    .map((component) => ({
      componentKey: component.componentKey || component.component_key,
      label: component.componentName || component.component_name,
      amount: Number(component.amount || 0),
      summary: component.summary || component.explanation || "",
    }));
  const warnings = (canonicalResult?.warnings || []).slice(0, 3).map((warning) => ({
    code: warning.code,
    severity: warning.severity || "medium",
    message: warning.message || warning.code,
  }));
  const biggestChange = diff?.materialChanges?.[0] || null;
  return {
    primarySummary: `Bizzi estimates ${formatMoney(totalTax)} of total tax for ${year}.`,
    topDrivers: drivers,
    topWarnings: warnings,
    biggestChange,
    nextRecommendedAction: nextAction(canonicalResult),
  };
}

function nextAction(canonical) {
  if (canonical?.missingInputs?.length) return "complete_missing_tax_inputs";
  if ((canonical?.warnings || []).some((warning) => warning.severity === "high" || warning.severity === "critical")) return "review_high_priority_warnings";
  if (canonical?.safeHarbor?.combined?.status === "unavailable") return "verify_safe_harbor_rules";
  return "review_tax_estimate";
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
}

function formatMoney(value) {
  return `$${Math.round(Number(value || 0)).toLocaleString("en-US")}`;
}
