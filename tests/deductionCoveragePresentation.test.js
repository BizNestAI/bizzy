import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildDeductionCoveragePresentation } from "../src/pages/Tax/deductionCoveragePresentation.js";

const dashboard = readFileSync(new URL("../src/pages/Tax/TaxDashboard.jsx", import.meta.url), "utf8");

test("deduction KPI derives authoritative coverage and proportional status segments", () => {
  const result = buildDeductionCoveragePresentation({ matrixTransactionCount: 690, estimated: 276, reviewed: 283, needsInput: 131 });
  assert.equal(result.percentage, 81);
  assert.equal(result.segmentWidths.estimated, 40);
  assert.equal(result.segmentWidths.reviewed, 41.01449275362319);
  assert.equal(result.segmentWidths.needsInput, 18.985507246376812);
  assert.equal(result.accessibleBreakdown, "276 estimated, 283 reviewed, 131 need input.");
});

test("deduction KPI safely degrades for zero, missing, and invalid coverage values", () => {
  for (const input of [
    { matrixTransactionCount: 0, estimated: 0, reviewed: 0, needsInput: 0 },
    { matrixTransactionCount: null, estimated: 2, reviewed: 1, needsInput: 1 },
    { matrixTransactionCount: 4, estimated: undefined, reviewed: 1, needsInput: 1 },
  ]) {
    const result = buildDeductionCoveragePresentation(input);
    assert.equal(result.percentage, null);
    assert.equal(result.segmentWidths, null);
    assert.doesNotMatch(JSON.stringify(result), /NaN|Infinity/);
  }
  assert.equal(buildDeductionCoveragePresentation({ matrixTransactionCount: 2, estimated: 5, reviewed: 5, needsInput: 0 }).percentage, 100);
});

test("deduction KPI markup preserves source values, accessibility, responsive stacking, and overflow containment", () => {
  assert.match(dashboard, /formatCurrencyLocal\(estimatedDeductibleExpenses\)/);
  assert.match(dashboard, /matrixTransactionCount: overviewProjection\?\.matrixIncludedCount/);
  assert.match(dashboard, /evaluatedTransactionCount/);
  assert.match(dashboard, /outsideDeductionsCount/);
  assert.match(dashboard, /buildDeductionCoveragePresentation/);
  assert.match(dashboard, /aria-label=\{`Estimate coverage: \$\{coverage\.accessibleBreakdown\}`\}/);
  assert.match(dashboard, /grid-cols-1[^"]*lg:grid-cols-2/);
  assert.match(dashboard, /overflow-hidden/);
  assert.doesNotMatch(dashboard, /donut|conic-gradient/i);
});
