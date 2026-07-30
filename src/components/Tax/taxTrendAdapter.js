const PERIOD_LABELS = {
  actual: "Actual",
  current_partial: "Current partial",
  projected: "Projected",
  modeled_reconstructed: "Modeled",
};

export function buildTaxTrendChartData({
  trend = [],
  taxYear,
  asOfDate,
  payments,
  reserve,
  deadlines = [],
} = {}) {
  const warnings = [];
  const seen = new Set();
  const normalized = [];
  let currentSeen = false;

  for (const raw of Array.isArray(trend) ? trend : []) {
    const month = normalizeMonth(raw?.month);
    if (!month) continue;
    if (seen.has(month)) {
      warnings.push({ code: "duplicate_month", message: `Duplicate trend month omitted: ${month}` });
      continue;
    }
    seen.add(month);
    const periodType = normalizePeriodType(raw?.periodType);
    const isCurrent = raw?.isCurrent === true && !currentSeen;
    if (raw?.isCurrent === true && currentSeen) warnings.push({ code: "multiple_current_points", message: "Multiple current trend points were supplied." });
    if (isCurrent) currentSeen = true;
    normalized.push({
      key: month,
      month,
      monthLabel: formatMonth(month, { short: true }),
      fullLabel: formatMonth(month, { short: false }),
      periodType,
      periodLabel: PERIOD_LABELS[periodType],
      actualValue: nullableNumber(raw?.cumulativeActualTax ?? raw?.actualTax),
      projectedValue: nullableNumber(raw?.projectedCumulativeTax ?? raw?.projectedTax),
      modeledValue: nullableNumber(raw?.modeledTax),
      combinedValue: nullableNumber(raw?.amount ?? raw?.estTax ?? raw?.cumulativeActualTax ?? raw?.actualTax ?? raw?.modeledTax ?? raw?.projectedCumulativeTax ?? raw?.projectedTax),
      projectedYearEndTax: nullableNumber(raw?.projectedYearEndTax),
      paymentsApplied: nullableNumber(raw?.paymentsApplied ?? payments?.totalApplied ?? payments?.totals?.totalPaidAndWithheld),
      reserveTarget: nullableNumber(raw?.reserveTarget ?? reserve?.recommendedReserve ?? reserve?.recommendedTransfer),
      isCurrent,
      confidenceLevel: raw?.confidenceLevel || null,
      method: raw?.method || null,
      pointType: raw?.pointType || null,
      sourceType: raw?.sourceType || null,
      workpaperDeepLink: raw?.workpaperDeepLink || null,
      warnings: Array.isArray(raw?.warnings) ? raw.warnings : [],
    });
  }

  normalized.sort((a, b) => a.key.localeCompare(b.key));
  const currentPoint = normalized.find((point) => point.isCurrent) || null;
  const actualEndPoint = [...normalized].reverse().find((point) => point.actualValue != null) || null;
  const projectedEndPoint = [...normalized].reverse().find((point) => point.projectedValue != null) || null;

  // Visual handoff: keep the projected dashed line connected at the current/actual boundary.
  if (actualEndPoint && normalized.some((point) => point.projectedValue != null && point.key > actualEndPoint.key)) {
    const handoff = normalized.find((point) => point.key === actualEndPoint.key);
    if (handoff && handoff.projectedValue == null) handoff.projectedValue = handoff.actualValue;
  }

  const deadlineMarkers = buildDeadlineMarkers({ deadlines, knownMonths: seen });
  if (!deadlineMarkers.length && Array.isArray(deadlines) && deadlines.length === 0) {
    warnings.push({ code: "deadlines_unavailable", message: "Tax deadline markers are unavailable." });
  }

  return {
    points: normalized,
    currentPoint,
    actualEndPoint,
    projectedEndPoint,
    quarterMarkers: buildQuarterMarkers({ taxYear, points: normalized }),
    deadlineMarkers,
    yDomain: buildYDomain(normalized),
    warnings,
    chartDescription: buildChartDescription({ currentPoint, projectedEndPoint, asOfDate }),
  };
}

function normalizeMonth(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function normalizePeriodType(value) {
  if (value === "actual" || value === "current_partial" || value === "projected" || value === "modeled_reconstructed") return value;
  return "projected";
}

function nullableNumber(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return null;
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function formatMonth(month, { short }) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1, 1));
  return date.toLocaleDateString(undefined, short ? { month: "short", timeZone: "UTC" } : { month: "long", year: "numeric", timeZone: "UTC" });
}

function buildQuarterMarkers({ taxYear, points }) {
  return points
    .filter((point) => {
      const month = Number(point.key.slice(5, 7));
      return month === 3 || month === 6 || month === 9 || month === 12;
    })
    .map((point) => ({
      key: `q${Math.ceil(Number(point.key.slice(5, 7)) / 3)}-${point.key}`,
      month: point.key,
      label: `Q${Math.ceil(Number(point.key.slice(5, 7)) / 3)}`,
      taxYear: taxYear || Number(point.key.slice(0, 4)),
    }));
}

function buildDeadlineMarkers({ deadlines, knownMonths }) {
  return (Array.isArray(deadlines) ? deadlines : [])
    .map((deadline) => {
      const dueDate = deadline?.dueDate || deadline?.due || deadline?.date;
      const month = normalizeMonth(dueDate);
      if (!month || !knownMonths.has(month)) return null;
      return {
        key: `${deadline.type || deadline.name || "deadline"}-${dueDate}`,
        month,
        dueDate,
        label: deadline.label || deadline.name || deadline.type || "Tax deadline",
        status: deadline.status || null,
      };
    })
    .filter(Boolean);
}

function buildYDomain(points) {
  const values = points.flatMap((point) => [
    point.actualValue,
    point.projectedValue,
    point.paymentsApplied,
    point.reserveTarget,
  ]).filter((value) => value != null && Number.isFinite(Number(value)));
  if (!values.length) return [0, 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const includeZero = min >= 0 || min / Math.max(max, 1) > -0.15;
  const floor = includeZero ? 0 : min;
  const padding = Math.max(100, (max - floor) * 0.12);
  return [Math.floor(floor), Math.ceil(max + padding)];
}

function buildChartDescription({ currentPoint, projectedEndPoint, asOfDate }) {
  const current = currentPoint?.combinedValue ?? currentPoint?.actualValue;
  const projected = projectedEndPoint?.projectedYearEndTax ?? projectedEndPoint?.combinedValue;
  const parts = ["Estimated cumulative tax obligation through the year."];
  if (current != null) parts.push(`Current estimate ${formatMoney(current)}${asOfDate ? ` through ${formatDate(asOfDate)}` : ""}.`);
  if (projected != null) parts.push(`Projected year-end tax ${formatMoney(projected)}.`);
  if (currentPoint?.confidenceLevel) parts.push(`Confidence ${currentPoint.confidenceLevel}.`);
  return parts.join(" ");
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value));
}

function formatDate(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default buildTaxTrendChartData;
