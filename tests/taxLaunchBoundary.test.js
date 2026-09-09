import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isTaxLiabilityEstimateEnabled, TAX_LIABILITY_ESTIMATE_FLAG } from "../src/config/taxFeatures.js";

test("tax liability estimate feature flag defaults off and supports explicit opt-in", () => {
  assert.equal(isTaxLiabilityEstimateEnabled({}), false);
  assert.equal(isTaxLiabilityEstimateEnabled({ [TAX_LIABILITY_ESTIMATE_FLAG]: "false" }), false);
  assert.equal(isTaxLiabilityEstimateEnabled({ [TAX_LIABILITY_ESTIMATE_FLAG]: "1" }), true);
  assert.equal(isTaxLiabilityEstimateEnabled({ [TAX_LIABILITY_ESTIMATE_FLAG]: "true" }), true);
  assert.equal(isTaxLiabilityEstimateEnabled({ [TAX_LIABILITY_ESTIMATE_FLAG]: "enabled" }), true);
});

test("Tax dashboard puts Deductions first and keeps liability estimator behind the launch flag", () => {
  const dashboard = readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const deductionsIndex = dashboard.indexOf('<section id="tax-deductions-matrix">');
  const comingSoonIndex = dashboard.indexOf("<TaxLiabilityComingSoonCard");
  const trendIndex = dashboard.indexOf("<TaxTrendCard");

  assert.ok(deductionsIndex > -1, "Deductions section should render on the Tax dashboard.");
  assert.ok(comingSoonIndex > -1, "Coming-soon estimate boundary should render on the Tax dashboard.");
  assert.ok(trendIndex > -1, "Existing estimator component should remain available behind the flag.");
  assert.ok(deductionsIndex < comingSoonIndex, "Deductions should render before the coming-soon estimate card.");
  assert.match(dashboard, /taxLiabilityEstimateEnabled \? \(/);
  assert.match(dashboard, /useTaxOverview\(\{ businessId, year: taxYear, enabled: taxLiabilityEstimateEnabled \}\)/);
  assert.match(dashboard, /useTaxPayments\(\{ businessId, year: taxYear, enabled: taxLiabilityEstimateEnabled && Boolean\(businessId\) \}\)/);
});

test("ordinary Tax page loading does not surface customer-facing estimator copy or generation controls", () => {
  const dashboard = readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const card = readFileSync("src/components/Tax/TaxLiabilityComingSoonCard.jsx", "utf8");

  assert.match(dashboard, /title="Tax deductions"/);
  assert.match(dashboard, /Quarterly tax estimates are coming soon/);
  assert.match(dashboard, /onSaveAndCalculate=\{taxLiabilityEstimateEnabled \? tax\.refreshCalculation : undefined\}/);
  assert.match(card, /Quarterly tax estimate/);
  assert.match(card, /Coming soon/);
  assert.match(card, /confirmed deductions/);
  assert.doesNotMatch(card, /Calculate|Generate|Retry|Prepare|\$0|\$—|Projected annual tax|Estimated tax liability/);
});

test("direct workpaper route is gated by the same tax liability estimate flag", () => {
  const main = readFileSync("src/main.jsx", "utf8");

  assert.match(main, /function TaxCalculationRouteBoundary/);
  assert.match(main, /isTaxLiabilityEstimateEnabled\(\)/);
  assert.match(main, /return <TaxCalculationWorkpaper \/>/);
  assert.match(main, /<TaxLiabilityComingSoonCard className="w-full" \/>/);
  assert.match(main, /path="tax\/calculation" element=\{<TaxCalculationRouteBoundary \/>\}/);
});

test("hidden estimator errors do not replace the Deductions workspace for ordinary customers", () => {
  const dashboard = readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");

  assert.match(dashboard, /const initialLoading = taxLiabilityEstimateEnabled && tax\.loading && !hasPreviousData/);
  assert.match(dashboard, /const initialRequestFailed = taxLiabilityEstimateEnabled && Boolean/);
  assert.match(dashboard, /\{taxLiabilityEstimateEnabled && tax\.error \? \(/);
  assert.match(dashboard, /onClassificationComplete=\{taxLiabilityEstimateEnabled \? tax\.refetch : null\}/);
});
