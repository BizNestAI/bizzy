/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

const tenantAuthSource = read("src/api/_shared/tenantAuth.js");
const metricsSource = read("src/api/accounting/metrics.js");
const pulseSource = read("src/api/accounting/pulse.js");
const forecastSource = read("src/api/accounting/forecast.js");
const legacyBookkeepingSource = read("src/api/accounting/bookkeeping.routes.js");

test("Admin View GET safety helpers provide stable cache-only and unavailable semantics", () => {
  assert.match(tenantAuthSource, /export function isAdminViewRequest\(req\)/);
  assert.match(tenantAuthSource, /req\?\.tenantContext\?\.mode === "admin_view"/);
  assert.match(tenantAuthSource, /export function sendAdminViewReadOnlyUnavailable\(res/);
  assert.match(tenantAuthSource, /admin_view_read_only_data_unavailable/);
});

test("Admin View metrics GET is persisted-cache only before QBO or derived-data writes", () => {
  const adminBranch = metricsSource.indexOf("if (isAdminViewRequest(req))");
  assert.ok(adminBranch > 0, "metrics route must branch for Admin View");
  assert.ok(adminBranch < metricsSource.indexOf("const runProfitAndLoss"), "Admin View must branch before QBO fetch setup");
  assert.ok(adminBranch < metricsSource.indexOf("fetchProfitAndLossReportDirect", adminBranch), "Admin View must branch before QBO report calls");
  assert.ok(adminBranch < metricsSource.indexOf('supabase.from("financial_metrics").upsert', adminBranch), "Admin View must branch before metrics upsert");
  assert.ok(adminBranch < metricsSource.indexOf('supabase.from("account_breakdown").upsert', adminBranch), "Admin View must branch before breakdown upsert");
  assert.ok(adminBranch < metricsSource.indexOf("upsertExpenseTotalsMonthly", adminBranch), "Admin View must branch before expense totals upsert");
  assert.ok(adminBranch < metricsSource.indexOf("generateFinancialPulseSnapshot", adminBranch), "Admin View must branch before pulse generation");
  assert.ok(adminBranch < metricsSource.indexOf("generateSuggestedMoves", adminBranch), "Admin View must branch before moves generation");
  assert.match(metricsSource, /admin_view_cache_only: true/);
  assert.match(metricsSource, /sendAdminViewReadOnlyUnavailable\(res, \{ error: "admin_view_read_only_data_unavailable" \}\)/);
});

test("Admin View pulse GET never honors generate=1 and returns persisted data only", () => {
  const adminBranch = pulseSource.indexOf("if (isAdminViewRequest(req))");
  assert.ok(adminBranch > 0, "pulse route must branch for Admin View");
  assert.ok(adminBranch < pulseSource.indexOf("if (shouldGenerate)"), "Admin View must branch before generation condition");
  assert.ok(adminBranch < pulseSource.indexOf("generateFinancialPulseSnapshot", adminBranch), "Admin View must branch before pulse generation call");
  assert.match(pulseSource, /monthly_financial_pulse/);
  assert.match(pulseSource, /admin_view_cache_only: true/);
  assert.match(pulseSource, /sendAdminViewReadOnlyUnavailable\(res, \{ error: "admin_view_read_only_data_unavailable" \}\)/);
});

test("Admin View forecast GET reads persisted rows only and cannot upsert generated forecasts", () => {
  const adminBranch = forecastSource.indexOf("if (isAdminViewRequest(req))");
  assert.ok(adminBranch > 0, "forecast route must preserve Admin View unavailable handling");
  assert.doesNotMatch(forecastSource, /generateCashFlowForecast/);
  assert.doesNotMatch(forecastSource, /\.from\('cashflow_forecast'\)/);
  assert.match(forecastSource, /getForecastV1Status/);
  assert.match(forecastSource, /router\.post\("\/generate"/);
  assert.match(forecastSource, /admin_view_cache_only: isAdminViewRequest\(req\) \? true : undefined/);
  assert.match(forecastSource, /sendAdminViewReadOnlyUnavailable\(res, \{ error: "admin_view_read_only_data_unavailable" \}\)/);
});

test("Admin View legacy uncategorized GET is denied before QBO reads or health writes", () => {
  const routeStart = legacyBookkeepingSource.indexOf('router.get("/uncategorized"');
  const adminBranch = legacyBookkeepingSource.indexOf("if (isAdminViewRequest(req))", routeStart);
  assert.ok(adminBranch > routeStart, "legacy uncategorized route must branch for Admin View");
  assert.ok(adminBranch < legacyBookkeepingSource.indexOf("getQBOClient(businessId)", routeStart), "Admin View must branch before QBO client reads");
  assert.ok(adminBranch < legacyBookkeepingSource.indexOf("upsertBookkeepingHealth", routeStart), "Admin View must branch before health mutation");
  assert.match(legacyBookkeepingSource, /admin_view_provider_refresh_blocked/);
});
