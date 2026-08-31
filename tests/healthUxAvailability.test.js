import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

const dashboard = read("src/pages/accounting/AccountingDashboard.jsx");
const metricsRoute = read("src/api/accounting/metrics.js");
const healthRoute = read("src/api/accounting/health.routes.js");
const kpis = read("src/components/Accounting/FinancialKPICards.jsx");
const revenue = read("src/components/Accounting/RevenueChart.jsx");
const profit = read("src/components/Accounting/NetProfitChart.jsx");
const expenses = read("src/components/Accounting/ExpenseBreakdownChart.jsx");

test("Health month dropdown is click-based and not hover-only", () => {
  assert.match(dashboard, /onClick=\{\(\) => setPeriodOpen\(\(open\) => !open\)\}/);
  assert.match(dashboard, /aria-haspopup="listbox"/);
  assert.match(dashboard, /role="listbox"/);
  assert.match(dashboard, /role="option"/);
  assert.doesNotMatch(dashboard, /onMouseEnter=\{\(\) => setPeriodOpen\(true\)\}/);
  assert.doesNotMatch(dashboard, /onMouseLeave=\{\(\) => setPeriodOpen\(false\)\}/);
});

test("Health month dropdown closes on outside click and Escape", () => {
  assert.match(dashboard, /document\.addEventListener\("mousedown", closeOnOutside\)/);
  assert.match(dashboard, /document\.addEventListener\("keydown", closeOnEscape\)/);
  assert.match(dashboard, /event\.key === "Escape"/);
  assert.match(dashboard, /periodMenuRef\.current\.contains\(event\.target\)/);
});

test("available Health months are loaded from backend financial authority", () => {
  assert.match(healthRoute, /router\.get\("\/available-months"/);
  assert.match(healthRoute, /listAvailableHealthMonths/);
  assert.match(metricsRoute, /monthly_review_qbo_pnl_snapshots/);
  assert.match(dashboard, /\/api\/accounting\/health\/available-months/);
  assert.match(dashboard, /if \(availableMonths\.length\) return availableMonths/);
});

test("latest available month fallback uses real persisted activity", () => {
  assert.match(metricsRoute, /has_activity:/);
  assert.match(dashboard, /currentHasData/);
  assert.match(dashboard, /setFallbackTag\(true\)/);
  assert.match(dashboard, /Showing latest available month/);
});

test("Health distinguishes empty, auth, QBO, and backend load failure states", () => {
  assert.match(dashboard, /No financial activity for \{periodLabel\(\)\}/);
  assert.match(dashboard, /Your session needs attention\. Please sign in again\./);
  assert.match(dashboard, /QuickBooks connection needs attention\./);
  assert.match(dashboard, /Unable to load financial data\./);
  assert.match(dashboard, /Preparing your financial history\.\.\./);
});

test("Health refresh is non-blocking and uses backend refresh metadata", () => {
  assert.match(dashboard, /Refreshing\.\.\./);
  assert.match(dashboard, /selectedMonthMeta\.lastRefreshedAt/);
  assert.doesNotMatch(dashboard, /bizzy:lastFinancialRefresh/);
  assert.match(dashboard, /setFinancialRefreshVersion\(\(version\) => version \+ 1\)/);
});

test("Health widgets cache rendered persisted data for stale-while-revalidate", () => {
  assert.match(kpis, /const KPI_CACHE = new Map\(\)/);
  assert.match(revenue, /const REVENUE_SERIES_CACHE = new Map\(\)/);
  assert.match(profit, /const NET_PROFIT_SERIES_CACHE = new Map\(\)/);
  assert.match(expenses, /const EXPENSE_BREAKDOWN_CACHE = new Map\(\)/);
  assert.match(kpis, /if \(cached\) \{/);
  assert.match(revenue, /if \(cached\) \{/);
  assert.match(profit, /if \(cached\) \{/);
  assert.match(expenses, /if \(cached\) \{/);
});

test("Health widgets use the dashboard-selected business and month", () => {
  assert.match(dashboard, /<FinancialKPICards[\s\S]*businessId=\{businessId\}[\s\S]*year=\{year\}[\s\S]*month=\{month\}/);
  assert.match(dashboard, /<RevenueChart[\s\S]*businessId=\{businessId\}[\s\S]*year=\{year\}[\s\S]*month=\{month\}/);
  assert.match(dashboard, /<ExpenseBreakdownChart[\s\S]*businessId=\{businessId\}[\s\S]*year=\{year\}[\s\S]*month=\{month\}/);
  assert.match(dashboard, /<NetProfitChart[\s\S]*businessId=\{businessId\}[\s\S]*year=\{year\}[\s\S]*month=\{month\}/);
  assert.match(kpis, /year: yearProp/);
  assert.match(revenue, /year: yearProp/);
  assert.match(profit, /year: yearProp/);
  assert.match(expenses, /year: yearProp/);
});

test("monthly-summary available status clears the Health empty gate", () => {
  assert.match(dashboard, /resp\?\.data_status === "available"/);
  assert.match(dashboard, /setEmptyMonth\(false\)/);
  assert.match(dashboard, /snapshot\?\.last_successful_refresh_at/);
  assert.match(dashboard, /if \(hasMetrics\) \{/);
});

test("Refresh from QuickBooks remains bounded to selected month", () => {
  assert.match(dashboard, /Refresh from QuickBooks/);
  assert.match(dashboard, /\/api\/accounting\/health\/refresh\?business_id=\$\{encodeURIComponent\(businessId\)\}&year=\$\{encodeURIComponent\(year\)\}&month=\$\{encodeURIComponent\(month\)\}/);
  assert.doesNotMatch(dashboard, /\/api\/qbo\/backfill\/start/);
  assert.doesNotMatch(dashboard, /months:\s*12/);
});
