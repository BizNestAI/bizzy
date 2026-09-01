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
  assert.match(dashboard, /buildCalendarMonthOptions/);
  assert.match(dashboard, /availableByValue/);
  assert.match(dashboard, /Imported/);
  assert.match(dashboard, /Import required/);
});

test("Health period selector is calendar-selectable and prevents future months", () => {
  assert.match(dashboard, /const DEFAULT_HEALTH_HISTORY_YEARS = 3/);
  assert.match(dashboard, /const lastMonth = year === currentYear \? currentMonth : 12/);
  assert.match(dashboard, /for \(let month = lastMonth; month >= 1; month -= 1\)/);
  assert.match(dashboard, /Month to date/);
  assert.doesNotMatch(dashboard, /October|November|December/);
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
  assert.match(dashboard, /Importing QuickBooks history\.\.\./);
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

test("missing selected Health month shows explicit QuickBooks import action", () => {
  assert.match(dashboard, /No QuickBooks snapshot has been imported for \{periodLabel\(\)\}/);
  assert.match(dashboard, /Import from QuickBooks/);
  assert.match(dashboard, /Importing…/);
  assert.doesNotMatch(dashboard, /Connected — no persisted QuickBooks data for this period/);
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
  assert.match(dashboard, /\{refreshing \? "Importing…" : "Import from QuickBooks"\}/);
});

test("Health refresh failure is visible and never becomes no activity", () => {
  assert.match(dashboard, /setEmptyMonth\(false\);\s*handleDataError\(e\);\s*setSyncError\("QuickBooks refresh failed\. Please try again\."\)/);
  assert.match(dashboard, /onClick=\{\(\) => runHealthRefresh\(\{ source: "retry" \}\)\}/);
  assert.doesNotMatch(dashboard, /catch \(e\) \{\s*console\.warn\("\[AccountingDashboard\] refresh failed"/);
});

test("Health refresh success invalidates all dashboard financial reads", () => {
  assert.match(dashboard, /setFinancialRefreshVersion\(\(version\) => version \+ 1\)/);
  assert.match(dashboard, /\[businessId, periodValue, setYearMonth, financialRefreshVersion\]/);
  assert.match(dashboard, /\[businessId, userId, year, month, financialRefreshVersion\]/);
  assert.match(dashboard, /<FinancialKPICards[\s\S]*refreshVersion=\{financialRefreshVersion\}/);
  assert.match(dashboard, /<RevenueChart[\s\S]*refreshVersion=\{financialRefreshVersion\}/);
  assert.match(dashboard, /<ExpenseBreakdownChart[\s\S]*refreshVersion=\{financialRefreshVersion\}/);
  assert.match(dashboard, /<NetProfitChart[\s\S]*refreshVersion=\{financialRefreshVersion\}/);
});

test("Health Live Mode does not require legacy localStorage user_id to fetch persisted data", () => {
  assert.doesNotMatch(dashboard, /if \(!businessId \|\| \(!userId && !adminView\.active\)/);
  assert.doesNotMatch(dashboard, /if \(!businessId \|\| \(!userId && !adminView\.active\) \|\| !year \|\| !month\)/);
  assert.match(dashboard, /const userParam = userId \? `&user_id=\$\{encodeURIComponent\(userId\)\}` : ""/);
  assert.match(kpis, /if \(!businessId \|\| !year \|\| !month\)/);
  assert.match(revenue, /if \(!businessId \|\| windowMonths\.length === 0\)/);
  assert.match(profit, /if\(!businessId \|\| windowMonths\.length===0\)/);
  assert.doesNotMatch(kpis, /if \(!userId \|\| !businessId/);
  assert.doesNotMatch(revenue, /if \(!userId \|\| !businessId/);
  assert.doesNotMatch(profit, /if\(!userId \|\| !businessId/);
});

test("Health Live Mode keeps user_id as optional compatibility metadata only", () => {
  assert.match(kpis, /const userId = userIdProp \|\| localStorage\.getItem\("user_id"\) \|\| ""/);
  assert.match(revenue, /const userId = userIdProp \|\| localStorage\.getItem\("user_id"\) \|\| ""/);
  assert.match(profit, /const userId = userIdProp \|\| localStorage\.getItem\("user_id"\) \|\| ""/);
  assert.match(kpis, /"x-user-id": userId \|\| ""/);
  assert.match(revenue, /"x-user-id": userId \|\| ""/);
  assert.match(profit, /"x-user-id":userId \|\| ""/);
  assert.doesNotMatch(`${dashboard}\n${kpis}\n${revenue}\n${profit}`, /setItem\(["']user_id["']/);
  assert.doesNotMatch(`${dashboard}\n${kpis}\n${revenue}\n${profit}`, /admin_view_user|fake_user|patrick/i);
});

test("Health persisted reads bypass browser 304 caching", () => {
  assert.match(dashboard, /available-months[\s\S]*cache: "no-store"/);
  assert.match(dashboard, /monthly-summary[\s\S]*cache: "no-store"/);
  assert.match(kpis, /monthly-summary[\s\S]*cache: "no-store"/);
  assert.match(revenue, /\/api\/accounting\/health\/series[\s\S]*cache: "no-store"/);
  assert.match(profit, /\/api\/accounting\/health\/series[\s\S]*cache: "no-store"/);
  assert.match(expenses, /monthly-summary[\s\S]*cache: "no-store"/);
});

test("monthly-summary top spending category comes from QBO snapshot expense rows", () => {
  assert.match(kpis, /m\.top_spending_category \?\? m\.topSpendingCategory/);
  assert.match(kpis, /rawTopSpendingCategory\.name \?\? rawTopSpendingCategory\.category/);
  assert.match(kpis, /label: "Top Spending Category"/);
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

test("Expense Breakdown discloses negative expense adjustments separately from donut slices", () => {
  assert.match(expenses, /expense_adjustments/);
  assert.match(expenses, /expense_display_totals/);
  assert.match(expenses, /Less: refunds and credits/);
  assert.match(expenses, /Net expenses/);
  assert.match(expenses, /Math\.max\(0, Number\(r\.amount \?\? r\.balance \?\? 0\)\)/);
});

test("monthly-summary available status clears the Health empty gate", () => {
  assert.match(dashboard, /resp\?\.data_status === "available"/);
  assert.match(dashboard, /setEmptyMonth\(false\)/);
  assert.match(dashboard, /snapshot\?\.last_successful_refresh_at/);
  assert.match(dashboard, /if \(hasMetrics\) \{/);
});

test("missing monthly-summary does not render as no financial activity", () => {
  assert.match(dashboard, /const handleEmptyData = \(status = "empty"\) =>/);
  assert.match(dashboard, /setEmptyMonth\(status === "empty"\)/);
  assert.match(kpis, /onEmptyDataRef\.current\?\.\(parsed\.data_status \|\| \(allNull \? "missing" : "empty"\)\)/);
});

test("Import from QuickBooks remains bounded to selected month", () => {
  assert.match(dashboard, /Import from QuickBooks/);
  assert.match(dashboard, /\/api\/accounting\/health\/refresh\?\$\{params\.toString\(\)\}/);
  assert.match(dashboard, /Need more chart history/);
  assert.match(dashboard, /\/api\/qbo\/backfill\/start/);
  assert.match(dashboard, /anchor_year: year/);
  assert.match(dashboard, /anchor_month: month/);
  assert.match(dashboard, /force: false/);
});
