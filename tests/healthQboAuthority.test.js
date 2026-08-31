import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

const dashboard = read("src/pages/accounting/AccountingDashboard.jsx");
const kpis = read("src/components/Accounting/FinancialKPICards.jsx");
const revenueChart = read("src/components/Accounting/RevenueChart.jsx");
const profitChart = read("src/components/Accounting/NetProfitChart.jsx");
const expenseChart = read("src/components/Accounting/ExpenseBreakdownChart.jsx");
const apiBase = read("src/utils/apiBase.js");
const metricsRoute = read("src/api/accounting/metrics.js");
const healthRoute = read("src/api/accounting/health.routes.js");
const healthService = read("src/services/accounting/healthMonthlySnapshotService.js");
const server = read("src/server.js");
const qboAuth = read("src/api/auth/quickbooksAuth.js");
const qboSync = read("src/api/accounting/qbo-sync.js");
const financialCron = read("src/cron/qboFinancialHealth.cron.js");

test("apiFetch attaches Supabase bearer auth for protected accounting endpoints", () => {
  assert.match(apiBase, /supabase\.auth\.getSession\(\)/);
  assert.match(apiBase, /headers\.set\("Authorization", `Bearer \$\{token\}`\)/);
});

test("Health normal reads use persisted financial state instead of live-only QBO fetches", () => {
  for (const source of [dashboard, kpis, revenueChart, profitChart, expenseChart]) {
    assert.doesNotMatch(source, /live_only=true/);
  }
  assert.match(dashboard, /\/api\/accounting\/health\/monthly-summary/);
  assert.match(kpis, /\/api\/accounting\/health\/monthly-summary/);
  assert.match(revenueChart, /\/api\/accounting\/health\/series/);
  assert.match(profitChart, /\/api\/accounting\/health\/series/);
  assert.match(expenseChart, /\/api\/accounting\/health\/monthly-summary/);
  assert.match(healthRoute, /getMonthlyHealthSummary/);
  assert.match(healthService, /monthly_review_qbo_pnl_snapshots/);
  assert.match(metricsRoute, /const persistedOnly = String\(req\.query\?\.persisted_only/);
  assert.match(metricsRoute, /persisted_only: true/);
  assert.match(metricsRoute, /source: "cache_miss"/);
});

test("Health widgets no longer read QBO financial tables directly from the browser", () => {
  for (const source of [revenueChart, profitChart, expenseChart]) {
    assert.doesNotMatch(source, /services\/supabaseClient/);
    assert.doesNotMatch(source, /\.from\("financial_metrics"\)/);
    assert.doesNotMatch(source, /\.from\("expense_totals_monthly"\)/);
  }
});

test("manual Health refresh is bounded to the selected month QBO sync", () => {
  assert.match(dashboard, /\/api\/accounting\/health\/refresh\?business_id=\$\{encodeURIComponent\(businessId\)\}&year=\$\{encodeURIComponent\(year\)\}&month=\$\{encodeURIComponent\(month\)\}/);
  assert.doesNotMatch(dashboard, /\/api\/qbo\/backfill\/start/);
  assert.doesNotMatch(dashboard, /months:\s*12/);
  assert.match(dashboard, /Refresh from QuickBooks/);
});

test("QuickBooks connection bootstraps initial persisted Health history idempotently", () => {
  assert.match(qboAuth, /bootstrapMissingHealthHistory/);
  assert.doesNotMatch(qboAuth, /shouldSkipBackfill/);
  assert.doesNotMatch(qboAuth, /backfillLast12Months/);
  assert.match(qboAuth, /setImmediate\(\(\) =>/);
});

test("QBO financial Health refresh runs in background without user session", () => {
  assert.match(financialCron, /from\("quickbooks_tokens"\)/);
  assert.match(financialCron, /refreshMonthlyQboFinancialSnapshot/);
  assert.match(financialCron, /setInterval\(\(\) =>/);
  assert.match(server, /startQboFinancialHealthCron\(\)/);
  assert.match(qboSync, /refreshMonthlyQboFinancialSnapshot/);
  assert.doesNotMatch(financialCron, /requireAuth|req\.auth|user_id/);
});

test("existing Books Review private mounts remain unchanged", () => {
  assert.match(server, /app\.use\("\/api\/bookkeeping", \.\.\.requireCustomerOrAdminView, bookkeepingPlaidRouter\)/);
  assert.match(server, /app\.use\("\/api\/accounting\/metrics", \.\.\.requireCustomerOrAdminView, financialMetricsRoute\)/);
});
