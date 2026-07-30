import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import {
  boundedRefs,
  dedupeByCode,
  routeForAction,
} from "../src/components/Tax/Explanations/taxExplanationDisplay.js";

test("confidence drawer surfaces score with explanation, blockers, sections, actions, freshness, warnings, and assumptions", () => {
  const drawer = fs.readFileSync("src/components/Tax/Confidence/TaxConfidenceDrawer.jsx", "utf8");
  assert.match(drawer, /TaxConfidenceSummary/);
  assert.match(drawer, /TaxWarningsPanel/);
  assert.match(drawer, /TaxConfidenceSectionBreakdown/);
  assert.match(drawer, /TaxUncertaintyPanel/);
  assert.match(drawer, /TaxImprovementActions/);
  assert.match(drawer, /TaxSourceFreshnessPanel/);
  assert.match(drawer, /TaxConfidenceFactorList/);
  assert.match(drawer, /TaxAssumptionsPanel/);
  assert.match(drawer, /does not prepare or file your tax return/);
  assert.doesNotMatch(drawer, /rawPayload|plaidPayload|qboPayload|quickbooksPayload|sourcePayload/i);
});

test("confidence summary does not present score as an accuracy guarantee and keeps fatal blocker visible", () => {
  const summary = fs.readFileSync("src/components/Tax/Confidence/TaxConfidenceSummary.jsx", "utf8");
  assert.match(summary, /\/100/);
  assert.match(summary, /Top blocker/);
  assert.match(summary, /affectedOutputs/);
  assert.doesNotMatch(summary, /% accurate|accuracy/i);
  assert.match(summary, /not a filing guarantee/);
});

test("warning panel dedupes and groups blocking, material, informational, deferred, and resolved warnings", () => {
  const panel = fs.readFileSync("src/components/Tax/Warnings/TaxWarningsPanel.jsx", "utf8");
  assert.match(panel, /Blocking/);
  assert.match(panel, /Material/);
  assert.match(panel, /Informational/);
  assert.match(panel, /Deferred/);
  assert.match(panel, /Resolved since prior run/);
  assert.deepEqual(dedupeByCode([{ code: "x" }, { code: "x" }, { code: "y" }]).map((row) => row.code), ["x", "y"]);
});

test("explanation drawer renders backend formulas and bounded safe refs without browser evaluation", () => {
  const drawer = fs.readFileSync("src/components/Tax/Explanations/TaxExplanationDrawer.jsx", "utf8");
  assert.match(drawer, /formula\.expression/);
  assert.match(drawer, /formula\.variables/);
  assert.match(drawer, /boundedRefs/);
  assert.match(drawer, /TaxRunChangesPanel/);
  assert.match(drawer, /TaxAssumptionsPanel/);
  assert.match(drawer, /TaxWarningsPanel/);
  assert.doesNotMatch(drawer, /eval\(|new Function|Function\(/);
  assert.doesNotMatch(drawer, /rawPayload|plaidPayload|qboPayload|quickbooksPayload|sourcePayload/i);
  const refs = boundedRefs(Array.from({ length: 12 }, (_, index) => ({ id: index })), 6);
  assert.equal(refs.visible.length, 6);
  assert.equal(refs.hiddenCount, 6);
});

test("run changes panel displays canonical run comparison without frontend recomputation", () => {
  const panel = fs.readFileSync("src/components/Tax/Explanations/TaxRunChangesPanel.jsx", "utf8");
  assert.match(panel, /changes\?\.changes/);
  assert.match(panel, /changedWarnings/);
  assert.match(panel, /resolvedWarnings/);
  assert.doesNotMatch(panel, /previousRun|currentRun|estimated_total_tax/);
});

test("action routing maps backend tax routes to current app routes", () => {
  assert.equal(routeForAction({ route: "/tax/deductions/review" }), "/dashboard/tax");
  assert.equal(routeForAction({ route: "/tax/profile" }), "/dashboard/tax");
  assert.equal(routeForAction({ route: "dashboard/tax" }), "/dashboard/tax");
});

test("dashboard keeps confidence breakdown in the trajectory header pill and links tax surfaces to the workpaper route", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const trendCard = fs.readFileSync("src/components/Tax/TaxTrendCard.jsx", "utf8");
  assert.match(trendCard, /ConfidencePill/);
  assert.match(trendCard, /ConfidenceTooltip/);
  assert.match(trendCard, /Confidence breakdown/);
  assert.match(dashboard, /viewCalculation/);
  assert.match(dashboard, /\/dashboard\/tax\/calculation/);
  assert.match(trendCard, /ViewCalculationButton/);
  assert.match(trendCard, /View calculation/);
  assert.match(trendCard, /Show estimate confidence details/);
  assert.doesNotMatch(trendCard, /label="Estimate confidence"/);
  assert.doesNotMatch(dashboard, /TaxConfidenceDrawer/);
  assert.doesNotMatch(dashboard, /TaxExplanationDrawer/);
});

test("dashboard keeps secondary tax breakdowns condensed into top-level tooltips", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const trendCard = fs.readFileSync("src/components/Tax/TaxTrendCard.jsx", "utf8");
  assert.match(trendCard, /TaxMetricInfoPopover/);
  assert.match(trendCard, /Show \$\{metric\.label\} details/);
  assert.match(dashboard, /taxBreakdown: model\.taxBreakdown/);
  assert.doesNotMatch(dashboard, /TaxBreakdownCard/);
});

test("source freshness and assumptions panels expose safe, bounded user-facing fields", () => {
  const freshness = fs.readFileSync("src/components/Tax/Confidence/TaxSourceFreshnessPanel.jsx", "utf8");
  const assumptions = fs.readFileSync("src/components/Tax/Explanations/TaxAssumptionsPanel.jsx", "utf8");
  assert.match(freshness, /Freshness|Source freshness|Last seen/);
  assert.match(assumptions, /Value:/);
  assert.match(assumptions, /Source:/);
  assert.match(assumptions, /Update input/);
  assert.doesNotMatch(`${freshness}\n${assumptions}`, /access_token|refresh_token|authorization|secret/i);
});
