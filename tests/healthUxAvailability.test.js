/* global process */
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
const refreshHandler = dashboard.match(/const runHealthRefresh = async[\s\S]*?const handleEmptyData =/)?.[0] || "";

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

test("Health refresh controls share one canonical selected-month handler", () => {
  assert.match(dashboard, /const runHealthRefresh = async \(\{ source = "toolbar" \} = \{\}\) =>/);
  assert.doesNotMatch(dashboard, /const handleSyncNow = async/);
  assert.doesNotMatch(dashboard, /const handleRefresh = async/);
  assert.match(dashboard, /onClick=\{\(\) => runHealthRefresh\(\{ source: "toolbar" \}\)\}/);
  assert.match(dashboard, /onClick=\{\(\) => runHealthRefresh\(\{ source: "empty_state" \}\)\}/);
});

test("Health refresh sends the correct business and one-based month to the backend", () => {
  assert.match(dashboard, /new URLSearchParams\(\{\s*business_id: businessId,\s*year: String\(year\),\s*month: String\(month\),\s*\}\)/);
  assert.match(dashboard, /\/api\/accounting\/health\/refresh\?\$\{params\.toString\(\)\}/);
  assert.match(dashboard, /body: \{ business_id: businessId, year, month \}/);
  assert.doesNotMatch(refreshHandler, /month:\s*String\(month\s*-\s*1\)/);
  assert.doesNotMatch(refreshHandler, /body:\s*\{ business_id: businessId, year, month:\s*month\s*-\s*1 \}/);
  assert.doesNotMatch(refreshHandler, /accounting_method|accountingMethod/);
});

test("Health refresh loading disables both controls and prevents duplicate requests", () => {
  assert.match(dashboard, /const refreshInFlightRef = useRef\(false\)/);
  assert.match(dashboard, /if \(refreshInFlightRef\.current\) return/);
  assert.match(dashboard, /refreshInFlightRef\.current = true/);
  assert.match(dashboard, /refreshInFlightRef\.current = false/);
  assert.match(dashboard, /disabled=\{refreshing \|\| adminView\.active\}/);
  assert.match(dashboard, /\{refreshing \? "Refreshing…" : "Refresh from QuickBooks"\}/);
});

test("Health refresh failure is visible and never becomes no activity", () => {
  assert.match(dashboard, /setEmptyMonth\(false\);\s*handleDataError\(e\);\s*setSyncError\("QuickBooks refresh failed\. Please try again\."\)/);
  assert.match(dashboard, /onClick=\{\(\) => runHealthRefresh\(\{ source: "retry" \}\)\}/);
  assert.doesNotMatch(dashboard, /catch \(e\) \{\s*console\.warn\("\[AccountingDashboard\] refresh failed"/);
});

test("Health refresh success invalidates all dashboard financial reads", () => {
  assert.match(dashboard, /setFinancialRefreshVersion\(\(version\) => version \+ 1\)/);
  assert.match(dashboard, /\[adminView\.active, businessId, userId, periodValue, setYearMonth, financialRefreshVersion\]/);
  assert.match(dashboard, /\[adminView\.active, businessId, userId, year, month, financialRefreshVersion\]/);
  assert.match(dashboard, /<FinancialKPICards[\s\S]*refreshVersion=\{financialRefreshVersion\}/);
  assert.match(dashboard, /<RevenueChart[\s\S]*refreshVersion=\{financialRefreshVersion\}/);
  assert.match(dashboard, /<ExpenseBreakdownChart[\s\S]*refreshVersion=\{financialRefreshVersion\}/);
  assert.match(dashboard, /<NetProfitChart[\s\S]*refreshVersion=\{financialRefreshVersion\}/);
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
  assert.match(dashboard, /\/api\/accounting\/health\/refresh\?\$\{params\.toString\(\)\}/);
  assert.doesNotMatch(dashboard, /\/api\/qbo\/backfill\/start/);
  assert.doesNotMatch(dashboard, /months:\s*12/);
});
