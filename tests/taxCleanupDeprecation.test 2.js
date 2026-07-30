import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateTaxEnvironmentSafety } from "../src/services/tax/taxEnvironmentSafety.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("active Tax pages have no Calendar, right-extra, or page hero coupling", () => {
  const active = [
    "src/pages/Tax/TaxDashboard.jsx",
  ].map(read).join("\n");

  assert.doesNotMatch(active, /AgendaWidget|RightExtrasContext|setRightExtra|getHeroInsight|hero-insights/);
});

test("active Tax pages do not import legacy monthly snapshot or tax suggestion widgets", () => {
  const active = [
    "src/pages/Tax/TaxDashboard.jsx",
    "src/main.jsx",
  ].map(read).join("\n");

  assert.doesNotMatch(active, /TaxMonthlySnapshot|TaxSuggestions|TaxActionQueue|useTaxInsights/);
});

test("global InsightsRail remains mounted outside Tax pages", () => {
  const layout = read("src/layout/DashboardLayout.jsx");
  assert.match(layout, /InsightsRail/);
});

test("legacy tax snapshot and insight routes are quarantined", () => {
  const router = read("src/api/tax/index.js");
  assert.doesNotMatch(router, /import .*generateMonthlyTaxSnapshot/);
  assert.doesNotMatch(router, /import .*generateTaxInsights/);
  assert.doesNotMatch(router, /import .*snapshotExport/);
  assert.match(router, /legacy_tax_snapshot_deprecated/);
  assert.match(router, /legacy_tax_insights_deprecated/);
  assert.match(router, /status\(410\)/);
});

test("active Tax frontend auth uses shared authenticated client, not localStorage token scans", () => {
  const active = [
    "src/pages/Tax/TaxDashboard.jsx",
    "src/hooks/tax/useTaxOverview.js",
    "src/hooks/tax/useTaxDeductions.js",
    "src/hooks/tax/useTaxReserve.js",
    "src/hooks/tax/useTaxPayments.js",
    "src/hooks/tax/useTaxExplanation.js",
    "src/services/tax/taxApiClient.js",
  ].map(read).join("\n");

  assert.doesNotMatch(active, /sb-.*auth-token|getAccessToken|localStorage.*auth/);
  assert.match(read("src/services/api/authenticatedFetch.js"), /supabase\.auth\.getSession/);
});

test("Tax compatibility shells no longer perform duplicate fetch/auth work", () => {
  const snapshot = read("src/components/Tax/TaxMonthlySnapshot.jsx");
  const insights = read("src/hooks/useTaxInsights.js");

  assert.doesNotMatch(snapshot, /fetch\(|getAccessToken|sb-.*auth-token|monthly_metrics|tax_config/);
  assert.doesNotMatch(insights, /fetch\(|getAccessToken|sb-.*auth-token|generate-tax-insights/);
  assert.match(snapshot, /Deprecated Prompt 29/);
  assert.match(insights, /Deprecated Prompt 29/);
});

test("Contractor CFO tax context reads canonical calculation runs, not legacy tax snapshots", () => {
  const engine = read("src/services/insights/contractorCfoEngine.js");
  const loadTax = engine.slice(engine.indexOf("async function loadTax"), engine.indexOf("async function loadBookkeeping"));
  assert.match(loadTax, /tax_calculation_runs/);
  assert.doesNotMatch(loadTax, /tax_snapshots|monthly_metrics|tax_config/);
});

test("environment safety blocks implicit Tax mocks in production", () => {
  assert.throws(
    () => validateTaxEnvironmentSafety({
      env: { NODE_ENV: "production", MOCK_TAX: "true" },
      logger: { info() {} },
    }),
    /Unsafe Tax mock flags/
  );

  assert.throws(
    () => validateTaxEnvironmentSafety({
      env: { NODE_ENV: "production", TAX_LEGACY_MONTHLY_METRICS_FALLBACK: "true" },
      logger: { info() {} },
    }),
    /Unsafe Tax legacy fallback flags/
  );

  const result = validateTaxEnvironmentSafety({
    env: { NODE_ENV: "development", MOCK_TAX: "true" },
    logger: { info() {} },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.mockFlags, ["MOCK_TAX"]);
});
