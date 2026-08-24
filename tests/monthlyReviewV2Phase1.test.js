import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const extractRouteBody = (source, route, method = "post") => {
  const start = source.indexOf(`router.${method}("${route}"`);
  assert.notEqual(start, -1, `${route} route should exist`);
  const nextRoute = source.indexOf("\nrouter.", start + 1);
  return nextRoute === -1 ? source.slice(start) : source.slice(start, nextRoute);
};

test("Monthly Review V2 phase 1 removes obsolete visible module review surfaces", () => {
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");

  assert.doesNotMatch(ui, /\(detail\?\.sections \|\| \[\]\)\.map/);
  assert.doesNotMatch(ui, /<SectionCard[\s>]/);
  assert.doesNotMatch(ui, /TimelinePanel title="Audit Log"/);
  assert.doesNotMatch(ui, />\s*Finalize Monthly Review\s*</);
  assert.doesNotMatch(ui, />\s*Review Readiness\s*</);
  assert.doesNotMatch(ui, />\s*Finalize Requirements\s*</);
  assert.doesNotMatch(ui, /review sections complete/);
});

test("Monthly Review V2 phase 1 keeps backend audit and finalization infrastructure", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");

  assert.match(route, /monthly_review_audit_events/);
  assert.match(route, /financial_monthly_review_stamps/);
  assert.match(route, /router\.post\("\/runs\/:runId\/finalize"/);
  assert.match(route, /router\.post\("\/runs\/:runId\/reopen"/);
  assert.match(route, /logAuditEvent/);
  assert.match(ui, /\/api\/admin\/monthly-review\/runs\/\$\{encodeURIComponent\(detail\.run\.id\)\}\/finalize/);
  assert.match(ui, /\/api\/admin\/monthly-review\/runs\/\$\{encodeURIComponent\(detail\.run\.id\)\}\/reopen/);
});

test("Monthly Review V2 phase 1 finalization no longer gates on removed module section reviews", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const finalizeRoute = extractRouteBody(route, "/runs/:runId/finalize");

  assert.doesNotMatch(finalizeRoute, /required_sections_not_reviewed/);
  assert.doesNotMatch(finalizeRoute, /missing_sections/);
  assert.doesNotMatch(finalizeRoute, /All required sections must be reviewed/);
  assert.doesNotMatch(finalizeRoute, /SECTION_DEFS\.filter\(\(def\) => def\.required\)/);
  assert.doesNotMatch(finalizeRoute, /forecasting/);
  assert.doesNotMatch(finalizeRoute, /tax_liability/);
  assert.doesNotMatch(finalizeRoute, /job_costing/);
  assert.doesNotMatch(finalizeRoute, /reconciliations.*must be reviewed/i);
});

test("Monthly Review V2 phase 1 finalization uses accounting-close blocker sources", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const guard = read("src/api/admin/monthlyReviewCloseGuard.js");
  const finalizeRoute = extractRouteBody(route, "/runs/:runId/finalize");

  assert.match(finalizeRoute, /buildMonthlySourceLedger\(run\.business_id, run\.review_month\)/);
  assert.match(finalizeRoute, /fetchOperatorResponsesAwaitingReview\(run\.business_id, run\.review_month\)/);
  assert.match(finalizeRoute, /buildCanonicalCoaEvidence\(run\.business_id, run\.review_month\)/);
  assert.match(finalizeRoute, /buildAccountingCloseFinalizationGuard/);
  assert.match(finalizeRoute, /accounting_close_not_ready_for_finalization/);
  assert.match(guard, /books_review_tab !== "needs_review"/);
  assert.match(guard, /operatorResponses\?\.rows/);
  assert.match(route, /selected_month_required_count: review\.length/);
  assert.match(route, /needs_review: review/);
  assert.match(route, /reconciliation_totals: reconciliationTotals/);
  assert.match(guard, /reconciliationEvidence\?\.raw\?\.exceptionItems/);
  assert.match(guard, /qbo_failed/);
  assert.match(guard, /qbo_queued/);
  assert.match(guard, /qbo_not_posted/);
  assert.match(guard, /missing_gl_account/);
  assert.match(guard, /removed_module_section_requirements: \["forecasting", "tax_liability", "job_costing", "reconciliations"\]/);
});

test("Monthly Review V2 phase 1 finalization preserves stamps audit and reopen behavior", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const finalizeRoute = extractRouteBody(route, "/runs/:runId/finalize");
  const reopenRoute = extractRouteBody(route, "/runs/:runId/reopen");

  assert.match(finalizeRoute, /\.from\("monthly_review_runs"\)/);
  assert.match(finalizeRoute, /\.from\("financial_monthly_review_stamps"\)/);
  assert.match(finalizeRoute, /reviewed_by: req\.user\.email \|\| req\.user\.id/);
  assert.match(finalizeRoute, /reviewer_user_id: req\.user\.id/);
  assert.match(finalizeRoute, /completed_at: now/);
  assert.match(finalizeRoute, /logAuditEvent/);
  assert.match(finalizeRoute, /eventType: "finalized"/);
  assert.match(reopenRoute, /\.from\("monthly_review_runs"\)/);
  assert.match(reopenRoute, /\.from\("financial_monthly_review_stamps"\)/);
  assert.match(reopenRoute, /eventType: "reopened"/);
});

test("Monthly Review V2 phase 1 summary and detail use the same accounting-close guard", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const detailRoute = extractRouteBody(route, "/businesses/:businessId", "get");

  assert.match(detailRoute, /buildAccountingCloseFinalizationGuard/);
  assert.match(ui, /const finalizationGuard = detail\?\.finalization_guard \|\| sourceLedger\?\.finalization_guard \|\| \{\}/);
  assert.doesNotMatch(ui, /Number\(business\.reviewed_sections \|\| 0\) \/ Math\.max/);
  assert.match(ui, /getBusinessQueueProgress\(business\)/);
  assert.match(ui, /sourceLedger\?\.totals\?\.needs_review_count/);
  assert.match(ui, /detail\?\.operator_responses\?\.count/);
  assert.match(ui, /detail\?\.canonical_chart_of_accounts\?\.summary\?\.needs_review_count/);
  assert.match(ui, /finalizationGuard\?\.counts\?\.qbo_failed/);
  assert.match(ui, /counts\.needs_review_transactions/);
  assert.match(ui, /counts\.operator_responses_unresolved/);
  assert.match(ui, /counts\.canonical_coa_needs_review/);
  assert.match(ui, /counts\.reconciliation_exception/);
});

test("Monthly Review V2 phase 1 exposes safe header actions and reviewed stamp", () => {
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");

  assert.match(ui, /View Customer App/);
  assert.match(ui, /const openCustomerApp = async \(\) =>/);
  assert.match(ui, /safeFetch\("\/api\/admin\/customer-view\/sessions"/);
  assert.match(ui, /business_id: selectedBusinessId/);
  assert.match(ui, /window\.open\("about:blank", "_blank"\)/);
  assert.match(ui, /placeholderTab\.location\.assign\(handoffUrl\)/);
  assert.match(ui, /buildMonthlyReviewReturnUrl\(\{ month, businessId: selectedBusinessId \}\)/);
  assert.doesNotMatch(ui, /Admin customer view coming in the next implementation phase\./);
  assert.match(ui, /Approve \{formatMonthShort\(month\)\} Books/);
  assert.match(ui, /function ReviewedStamp/);
  assert.match(ui, /Reviewed by \{formatReviewerName/);
  assert.match(ui, /Reopen Month/);
  assert.match(ui, /Month Close Summary/);
  assert.match(ui, /getMonthlyCloseStatus/);
});

test("Monthly Review V2 phase 1 preserves core accounting review sections", () => {
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");

  assert.match(ui, /SourceLedgerPanel/);
  assert.match(ui, /Monthly P&amp;L Review/);
  assert.match(ui, /OperatorResponsesPanel/);
  assert.match(ui, /Operator Responses/);
  assert.match(ui, /CanonicalCoaReviewPanel/);
  assert.match(ui, /Canonical Account Review/);
  assert.match(ui, /CanonicalVendorReviewPanel/);
  assert.match(ui, /Vendor Activity/);
  assert.match(ui, /ReconciliationTracePanel/);
  assert.match(ui, /Posting Trace/);
});

test("Monthly Review V2 phase 1 preserves admin routing and internal authorization", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const adminRoute = read("src/components/Admin/AdminProtectedRoute.jsx");
  const main = read("src/main.jsx");

  assert.match(route, /router\.use\(requireAuth\)/);
  assert.match(route, /router\.use\(requireInternalRole\(MONTHLY_REVIEW_STAFF_ROLES\)\)/);
  assert.match(route, /router\.get\("\/me"/);
  assert.match(adminRoute, /\/api\/admin\/me/);
  assert.match(main, /getAdminRoutePath\("monthlyReview", applicationSurface\)/);
});
