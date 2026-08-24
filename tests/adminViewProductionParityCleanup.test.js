import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file) => readFileSync(join(root, file), "utf8");

test("Books Review Admin View does not call live QBO COA and does not use source account as GL fallback", () => {
  const cleanup = read("src/pages/accounting/BookkeepingCleanup.jsx");
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");

  const reloadStart = cleanup.indexOf("const reloadCoa = useCallback");
  const adminBranch = cleanup.indexOf("if (adminView.active)", reloadStart);
  const providerCall = cleanup.indexOf("await fetchQboCoa(businessId)", reloadStart);
  assert.ok(reloadStart > 0, "reloadCoa should exist");
  assert.ok(adminBranch > reloadStart, "reloadCoa should branch for Admin View");
  assert.ok(providerCall > adminBranch, "Admin View must return before live QBO COA fetch");
  assert.match(cleanup, /derivePersistedChartAccountsFromTransactions\(transactions\)/);

  const derivedBlock = cleanup.slice(
    cleanup.indexOf("function derivePersistedChartAccountsFromTransactions"),
    cleanup.indexOf("function SummaryCard")
  );
  assert.doesNotMatch(derivedBlock, /txn\.currentAccount/);

  const labelBlock = feed.slice(feed.indexOf("const readOnlyGlLabel ="), feed.indexOf("const canRejectCcPayment"));
  assert.doesNotMatch(labelBlock, /txn\.currentAccount/);
  assert.match(labelBlock, /txn\.glAccountName[\s\S]*txn\.final_qbo_account_name[\s\S]*txn\.suggested_qbo_account_name[\s\S]*"Uncategorized"/);
});

test("Admin View QuickBooks connection UI has a loading state before disconnected CTAs", () => {
  const integrationManager = read("src/hooks/useIntegrationManager.js");
  const accounting = read("src/pages/accounting/AccountingDashboard.jsx");
  const forecasts = read("src/pages/accounting/Forecasts.jsx");
  const reports = read("src/pages/accounting/Reports.jsx");
  const jobs = read("src/pages/LeadsJobs/JobsDashboard.jsx");

  assert.match(integrationManager, /LOADING: "loading"/);
  assert.match(integrationManager, /withReadOnlyLoadingState/);
  assert.match(accounting, /qbStatusLoading/);
  assert.match(forecasts, /qbStatusLoading/);
  assert.match(reports, /qbStatusLoading/);
  assert.match(jobs, /qbStatusLoading/);
});

test("Admin View forecast and pulse widgets use optional persisted-only reads instead of expected 409s", () => {
  const forecastEditor = read("src/components/Accounting/ForecastEditorChart.jsx");
  const forecastVsActual = read("src/components/Accounting/ForecastVsActualChart.jsx");
  const monthlyBrief = read("src/components/Accounting/MonthlyBriefCard.jsx");
  const pulseCard = read("src/components/Accounting/FinancialPulseCard.jsx");
  const forecastApi = read("src/api/accounting/forecast.js");
  const pulseApi = read("src/api/accounting/pulse.js");

  assert.match(forecastEditor, /params\.set\('admin_view_optional', '1'\)/);
  assert.match(forecastEditor, /No persisted forecast is available for this business/);
  assert.match(forecastVsActual, /No persisted forecast accuracy is available for this business/);
  assert.match(monthlyBrief, /&admin_view_optional=1/);
  assert.match(pulseCard, /&admin_view_optional=1/);
  assert.match(forecastApi, /adminViewOptional[\s\S]*status\(200\)\.json/);
  assert.match(pulseApi, /adminViewOptional[\s\S]*status\(200\)\.json/);
});

test("Reports Admin View reads report_metadata through verified backend archive endpoint", () => {
  const routes = read("src/api/accounting/pnlPdf.routes.js");
  const viewer = read("src/components/Accounting/PNLArchiveViewer.jsx");

  assert.match(routes, /router\.get\("\/archive"/);
  assert.match(routes, /req\?\.tenantContext\?\.businessId/);
  assert.match(routes, /\.from\("report_metadata"\)[\s\S]*\.eq\("business_id", businessId\)/);
  assert.match(viewer, /if \(adminView\.active\)/);
  assert.match(viewer, /apiFetch\("\/api\/accounting\/pnl\/archive"\)/);
});

test("Job Costing Admin View skips GET-side generation and disables change-order actions", () => {
  const changeRoutes = read("src/api/jobCosting/routes/jobCosting.changeOrders.routes.js");
  const jobs = read("src/pages/LeadsJobs/JobsDashboard.jsx");

  const routeStart = changeRoutes.indexOf('router.get("/potential-change-orders"');
  const adminGuard = changeRoutes.indexOf("if (!adminView)", routeStart);
  const detectCall = changeRoutes.indexOf("await detectPotential({ businessId })", routeStart);
  assert.ok(routeStart > 0, "potential change order GET should exist");
  assert.ok(adminGuard > routeStart, "GET should branch for Admin View");
  assert.ok(detectCall > adminGuard, "Admin View must not run potential change-order detection");

  assert.match(jobs, /readOnly = false/);
  assert.match(jobs, /Change order updates are unavailable in read-only Admin View/);
  assert.match(jobs, /disabled=\{readOnly \|\| changeOrderActionId/);
  assert.match(jobs, /disabled=\{readOnly \|\| potentialChangeOrderBusyId/);
});

test("Tax Admin View overview is persisted-only and never recalculates on refresh/as-of mismatch", () => {
  const taxRoutes = read("src/api/tax/taxCalculation.routes.js");
  const overviewStart = taxRoutes.indexOf('router.get("/overview"');
  const refreshGuard = taxRoutes.indexOf("if (isAdminView && refresh)", overviewStart);
  const refreshCalc = taxRoutes.indexOf("runCanonicalTaxCalculation({", overviewStart);
  const asOfGuard = taxRoutes.indexOf("if (isAdminView) {", taxRoutes.indexOf("requestedAsOfDate", overviewStart));

  assert.ok(refreshGuard > overviewStart, "Admin View refresh guard should exist");
  assert.ok(refreshCalc > refreshGuard, "Admin View refresh must return before calculation");
  assert.ok(asOfGuard > overviewStart, "Admin View as-of mismatch guard should exist");
  assert.match(taxRoutes, /adminViewTaxUnavailableDto/);
  assert.match(taxRoutes, /admin_view_read_only_data_unavailable: true/);
});

test("Docs, Settings, and Chat Admin View controls are visibly read-only", () => {
  const docs = read("src/pages/Docs/DocsLibraryPage.jsx");
  const sidebar = read("src/components/UserAdmin/Sidebar.jsx");
  const navRail = read("src/layout/NavRail.jsx");
  const chatBar = read("src/components/Bizzy/BizzyChatBar.jsx");
  const canvasBar = read("src/components/Bizzy/ChatCanvasBar.jsx");

  assert.match(docs, /!\s*readOnly \? \(/);
  assert.match(docs, /No persisted business documents are available for this Admin View session/);
  assert.match(sidebar, /disableActiveBounce=\{adminView\.active\}/);
  assert.match(sidebar, /if \(!disableActiveBounce && activePath\.startsWith/);
  assert.match(navRail, /disableActiveBounce=\{adminView\.active\}/);
  assert.match(chatBar, /!\s*chatReadOnly \? \(/);
  assert.match(chatBar, /if \(chatReadOnly\) return/);
  assert.match(canvasBar, /!\s*chatReadOnly \? \(/);
  assert.match(canvasBar, /if \(chatReadOnly\) return/);
});
