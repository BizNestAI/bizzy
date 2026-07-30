import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildMockTaxFixture } from "../src/services/demo/mockTaxFixture.js";

test("Tax Dashboard removes old Tax Drivers and links metrics to the workpaper route", () => {
  const dashboard = readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const viewModel = readFileSync("src/components/Tax/taxDashboardViewModel.js", "utf8");
  const trendCard = readFileSync("src/components/Tax/TaxTrendCard.jsx", "utf8");

  assert.doesNotMatch(dashboard, /TaxDriversPanel/);
  assert.doesNotMatch(dashboard, /What is driving the estimate/);
  assert.doesNotMatch(dashboard, /model\.drivers/);
  assert.doesNotMatch(viewModel, /normalizeDrivers/);
  assert.doesNotMatch(viewModel, /drivers:/);
  assert.match(dashboard, /\/dashboard\/tax\/calculation/);
  assert.match(trendCard, /View calculation/);
  assert.equal((trendCard.match(/View calculation/g) || []).length, 1);
});

test("Tax workpaper route is a dedicated full-page workpaper with compact header and accounting rows", () => {
  const route = readFileSync("src/main.jsx", "utf8");
  const page = readFileSync("src/pages/Tax/TaxCalculationWorkpaper.jsx", "utf8");

  assert.match(route, /path="tax\/calculation"/);
  assert.match(page, /Tax calculation/);
  assert.match(page, /Projected annual tax/);
  assert.match(page, /run\.throughDate/);
  assert.doesNotMatch(page, /Calculation details/);
  assert.doesNotMatch(page, /tax-run-select/);
  assert.doesNotMatch(page, /<select/);
  assert.match(page, /font-mono tabular-nums/);
  assert.match(page, /grid-cols-\[minmax\(0,1fr\)_max-content\]/);
  assert.match(page, /WorkpaperGraphSection/);
  assert.match(page, /WorkpaperNode/);
  assert.match(page, /TraceabilityDetailPanel/);
  assert.doesNotMatch(page, /NodeHoverTooltip/);
  assert.match(page, /DocumentNavigator/);
  assert.match(page, /calculationGraph\?\.nodes/);
  assert.match(page, /formulaExpression/);
  assert.match(page, /sourceRefs/);
  assert.match(page, /ruleRefs/);
  assert.match(page, /No formula was persisted for this node/);
  assert.match(page, /No source summary is available for this node/);
  assert.match(page, /Assumptions used/);
  assert.match(page, /Not included/);
  assert.match(page, /Needs attention/);
  assert.doesNotMatch(page, /progress|rounded-full bg-white\/\[0\.07\].*width/s);
});

test("workpaper rows recursively expand and show full traceability detail on hover", () => {
  const page = readFileSync("src/pages/Tax/TaxCalculationWorkpaper.jsx", "utf8");

  assert.match(page, /aria-expanded/);
  assert.match(page, /ArrowRight/);
  assert.match(page, /ArrowLeft/);
  assert.match(page, /Open audit details/);
  assert.match(page, /hoveredNode/);
  assert.match(page, /detailNode/);
  assert.match(page, /onMouseEnter/);
  assert.match(page, /onMouseLeave/);
  assert.match(page, /onFocus/);
  assert.match(page, /onBlur/);
  assert.match(page, /Expand calculation/);
  assert.match(page, /View source transactions/);
  assert.match(page, /role=\{pinned \? "dialog" : "tooltip"\}/);
  assert.match(page, /aria-modal=\{pinned \? "false" : undefined\}/);
  assert.match(page, /Formula/);
  assert.match(page, /Inputs/);
  assert.match(page, /Sources/);
  assert.match(page, /Rules/);
  assert.match(page, /Status/);
  assert.match(page, /Limitations/);
  assert.match(page, /View calculation run/);
  assert.match(page, /formatFormulaExpression/);
  assert.match(page, /summarizeSourceRefs/);
  assert.match(page, /normalizeRuleRefs/);
  assert.match(page, /traceabilityLabel/);
  assert.doesNotMatch(page, /createPortal/);
  assert.doesNotMatch(page, /LineTraceTooltip/);
  assert.doesNotMatch(page, /peer-hover:block/);
  assert.doesNotMatch(page, /peer-focus:block/);
  assert.doesNotMatch(page, /Click for audit details/);
  assert.doesNotMatch(page, /w-\[320px\]/);
});

test("mobile route uses full page layout instead of a small modal or dashboard card grid", () => {
  const page = readFileSync("src/pages/Tax/TaxCalculationWorkpaper.jsx", "utf8");

  assert.match(page, /min-h-screen/);
  assert.match(page, /max-w-\[1180px\]/);
  assert.match(page, /lg:grid-cols-\[minmax\(0,1fr\)_260px\]/);
  assert.doesNotMatch(page, /fixed inset-0/);
  assert.doesNotMatch(page, /SummaryCard|KpiCard|PaymentKpiCard/);
});

test("mock mode uses canonical workpaper DTO and no mock Tax Drivers", () => {
  const fixtureSource = readFileSync("src/services/demo/mockTaxFixture.js", "utf8");
  const fixture = buildMockTaxFixture({ year: 2026 });
  const workpaper = fixture.overview.workpaper;

  assert.equal(fixture.overview.drivers, undefined);
  assert.doesNotMatch(fixtureSource, /Business income included|What is driving the estimate/);
  assert.equal(workpaper.run.workpaperStatus, "complete");
  assert.equal(workpaper.reconciliation.ready, true);
  assert.equal(workpaper.calculationGraph.version, "tax-calculation-graph-v1");
  assert.equal(workpaper.calculationGraph.validation.fullyTraceable, true);
  assert.equal(Array.isArray(workpaper.calculationGraph.nodes), true);
  assert.ok(workpaper.calculationGraph.nodes.some((node) => node.nodeCode === "annual_income_bridge:projected_annual_income"));
  assert.ok(workpaper.calculationGraph.nodes.some((node) => node.childNodeCodes?.length > 0));
  assert.equal(Array.isArray(workpaper.sections), true);
  assert.ok(workpaper.sections.some((section) => section.code === "annual_income_bridge"));
  assert.ok(workpaper.sections.some((section) => section.code === "total_tax_components"));
});

test("workpaper UI avoids tax arithmetic and relies on graph node amounts and persisted formulas", () => {
  const page = readFileSync("src/pages/Tax/TaxCalculationWorkpaper.jsx", "utf8");

  assert.match(page, /node\.amount/);
  assert.match(page, /node\.inputValues/);
  assert.match(page, /formulaExpression/);
  assert.match(page, /lineToNode/);
  assert.doesNotMatch(page, /projectedAnnualTax.*-/);
  assert.doesNotMatch(page, /remainingProjectedLiability.*-/);
  assert.doesNotMatch(page, /recommendedReserve.*-/);
  assert.doesNotMatch(page, /Math\.(max|min)\([^)]*(projectedAnnualTax|remainingProjectedLiability|recommendedReserve|taxGeneratedYtd)/);
});

test("workpaper navigator is a clean outline and hides raw ids in user mode", () => {
  const page = readFileSync("src/pages/Tax/TaxCalculationWorkpaper.jsx", "utf8");

  assert.match(page, /SECTION_GROUPS/);
  assert.match(page, /DocumentNavigator/);
  assert.match(page, /Outline/);
  assert.doesNotMatch(page, /WorkpaperRail/);
  assert.match(page, /looksLikeRawId/);
  assert.match(page, /sourceLabel/);
  assert.match(page, /sourceSystemIdentifier/);
});

test("deep links open the requested canonical section and null values render explicitly", () => {
  const page = readFileSync("src/pages/Tax/TaxCalculationWorkpaper.jsx", "utf8");

  assert.match(page, /sectionParam/);
  assert.match(page, /workpaper-section-\$\{section\.code\}/);
  assert.match(page, /scrollIntoView/);
  assert.match(page, /Not applicable/);
  assert.match(page, /Not available/);
});
