// /src/services/tax/runs/taxRunComparison.service.js

const DEFAULT_THRESHOLDS = Object.freeze({
  absoluteDollar: 100,
  percentage: 0.05,
});

export function compareTaxRuns({ previousRun, currentRun, thresholds = DEFAULT_THRESHOLDS } = {}) {
  const changes = {
    projectedTotalTax: diff(previousRun?.estimated_total_tax, currentRun?.estimated_total_tax, thresholds),
    federalTax: diff(previousRun?.estimated_federal_tax, currentRun?.estimated_federal_tax, thresholds),
    stateTax: diff(previousRun?.estimated_state_tax, currentRun?.estimated_state_tax, thresholds),
    seTax: diff(previousRun?.estimated_se_tax, currentRun?.estimated_se_tax, thresholds),
    taxableIncome: diff(previousRun?.taxable_income_ytd, currentRun?.taxable_income_ytd, thresholds),
    remainingLiability: diff(previousRun?.remaining_projected_liability, currentRun?.remaining_projected_liability, thresholds),
    reserveRecommendation: diff(previousRun?.recommended_reserve, currentRun?.recommended_reserve, thresholds),
    confidence: diff(previousRun?.confidence_score, currentRun?.confidence_score, { absoluteDollar: 10, percentage: 0.1 }),
  };
  const changedWarnings = warningDiff(previousRun?.warnings, currentRun?.warnings);
  const resolvedWarnings = warningDiff(currentRun?.warnings, previousRun?.warnings);
  const newBlockers = (currentRun?.missing_inputs || []).filter((code) => !(previousRun?.missing_inputs || []).includes(code));
  const materialChange = Object.values(changes).some((row) => row.material) || changedWarnings.length > 0 || newBlockers.length > 0;
  return {
    materialChange,
    changes,
    changedWarnings,
    resolvedWarnings,
    newBlockers,
    thresholdsUsed: thresholds,
  };
}

function diff(previous, current, thresholds) {
  const prev = Number(previous || 0);
  const next = Number(current || 0);
  const absoluteChange = Math.round((next - prev + Number.EPSILON) * 100) / 100;
  const percentChange = prev === 0 ? (next === 0 ? 0 : 1) : absoluteChange / Math.abs(prev);
  return {
    previous: prev,
    current: next,
    absoluteChange,
    percentChange,
    material: Math.abs(absoluteChange) >= thresholds.absoluteDollar || Math.abs(percentChange) >= thresholds.percentage,
  };
}

function warningDiff(previous = [], current = []) {
  const previousCodes = new Set((previous || []).map((warning) => warning.code || warning));
  return (current || []).filter((warning) => !previousCodes.has(warning.code || warning));
}
