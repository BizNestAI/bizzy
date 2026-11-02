export function buildDeductionCoveragePresentation({ matrixTransactionCount, estimated, reviewed, needsInput } = {}) {
  const denominator = finiteNonNegative(matrixTransactionCount);
  const counts = {
    estimated: finiteNonNegative(estimated),
    reviewed: finiteNonNegative(reviewed),
    needsInput: finiteNonNegative(needsInput),
  };
  const hasDenominator = denominator != null && denominator > 0;
  const knownCounts = Object.values(counts).every((value) => value != null);
  const covered = (counts.estimated || 0) + (counts.reviewed || 0);
  const percentage = hasDenominator && knownCounts
    ? clamp(Math.round((covered / denominator) * 100), 0, 100)
    : null;
  const segmentWidths = hasDenominator && knownCounts
    ? Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, clamp((value / denominator) * 100, 0, 100)]))
    : null;

  return {
    denominator,
    counts,
    percentage,
    segmentWidths,
    accessibleBreakdown: knownCounts
      ? `${counts.estimated} estimated, ${counts.reviewed} reviewed, ${counts.needsInput} need input.`
      : "Estimate coverage breakdown is not available.",
  };
}

function finiteNonNegative(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
