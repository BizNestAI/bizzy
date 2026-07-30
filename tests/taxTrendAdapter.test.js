import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTaxTrendChartData } from "../src/components/Tax/taxTrendAdapter.js";

test("adapter separates actual, current partial, and projected points", () => {
  const result = buildTaxTrendChartData({
    trend: [
      { month: "2026-01", periodType: "actual", cumulativeActualTax: 1000, isCurrent: false },
      { month: "2026-02", periodType: "current_partial", cumulativeActualTax: 1500, isCurrent: true, confidenceLevel: "medium" },
      { month: "2026-03", periodType: "projected", projectedTax: 2500, projectedYearEndTax: 12000, isCurrent: false },
    ],
    taxYear: 2026,
    asOfDate: "2026-02-14",
  });
  assert.equal(result.points[0].actualValue, 1000);
  assert.equal(result.points[0].projectedValue, null);
  assert.equal(result.points[1].isCurrent, true);
  assert.equal(result.currentPoint.key, "2026-02");
  assert.equal(result.points[1].projectedValue, 1500);
  assert.equal(result.points[2].actualValue, null);
  assert.equal(result.points[2].projectedValue, 2500);
});

test("adapter does not mark last point current automatically", () => {
  const result = buildTaxTrendChartData({
    trend: [
      { month: "2026-11", periodType: "projected", projectedTax: 11000 },
      { month: "2026-12", periodType: "projected", projectedTax: 12000 },
    ],
  });
  assert.equal(result.currentPoint, null);
  assert.equal(result.points.some((point) => point.isCurrent), false);
});

test("adapter deduplicates month keys and preserves null and zero", () => {
  const result = buildTaxTrendChartData({
    trend: [
      { month: "2026-01", periodType: "actual", cumulativeActualTax: 0 },
      { month: "2026-01", periodType: "actual", cumulativeActualTax: 500 },
      { month: "2026-02", periodType: "projected", projectedTax: null },
    ],
  });
  assert.deepEqual(result.points.map((point) => point.key), ["2026-01", "2026-02"]);
  assert.equal(result.points[0].actualValue, 0);
  assert.equal(result.points[1].projectedValue, null);
  assert.equal(result.warnings.some((warning) => warning.code === "duplicate_month"), true);
});

test("adapter builds backend deadline markers and omits unavailable deadlines", () => {
  const withDeadlines = buildTaxTrendChartData({
    trend: [
      { month: "2026-04", periodType: "projected", projectedTax: 4000 },
      { month: "2026-05", periodType: "projected", projectedTax: 5000 },
    ],
    deadlines: [
      { type: "estimated_payment", dueDate: "2026-04-15", status: "upcoming" },
      { type: "outside_range", dueDate: "2026-09-15", status: "upcoming" },
    ],
  });
  assert.equal(withDeadlines.deadlineMarkers.length, 1);
  assert.equal(withDeadlines.deadlineMarkers[0].month, "2026-04");

  const unavailable = buildTaxTrendChartData({
    trend: [{ month: "2026-04", periodType: "projected", projectedTax: 4000 }],
    deadlines: [],
  });
  assert.equal(unavailable.deadlineMarkers.length, 0);
  assert.equal(unavailable.warnings.some((warning) => warning.code === "deadlines_unavailable"), true);
});

test("chart source removes slope advice and uses actual/projected line semantics", () => {
  const chart = readFileSync("src/components/Tax/TaxLiabilityChart.jsx", "utf8");
  const card = readFileSync("src/components/Tax/TaxTrendCard.jsx", "utf8");
  assert.match(chart, /dataKey="actualValue"/);
  assert.match(chart, /dataKey="projectedValue"/);
  assert.match(chart, /strokeDasharray="7 6"/);
  assert.match(chart, /Current estimate|Through/);
  assert.match(chart, /role="img"/);
  assert.doesNotMatch(card, /buildInsight|isTrendingDown|from prior month|trending up|trending down/);
});
