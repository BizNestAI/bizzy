import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  derivePipelineStatus,
  finalizePipelineTotals,
  summarizePipelineStatuses,
} from "../src/services/bookkeeping/reconciliationPipelineStatus.js";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

test("unified reconciliation pipeline partitions canonical monthly Plaid transactions exactly once", () => {
  const canonicalRows = [
    derivePipelineStatus({ bank: {}, cat: { status: "needs_review" } }),
    derivePipelineStatus({ bank: { pending: true }, cat: { status: "needs_review", meta: { pending: true } } }),
    derivePipelineStatus({ bank: {}, cat: { status: "approved" } }),
    derivePipelineStatus({ bank: {}, cat: { status: "auto_approved", post_after: "2999-01-01T00:00:00Z" } }),
    derivePipelineStatus({ bank: {}, cat: { status: "posted", qbo_txn_id: "101", qbo_txn_type: "Purchase" } }),
    derivePipelineStatus({
      bank: {},
      cat: { status: "posted", qbo_txn_id: "102", qbo_txn_type: "Deposit" },
      reconciliationItem: { status: "mismatch", details: { reason_code: "amount_mismatch" } },
    }),
  ].map((pipeline_status) => ({ pipeline_status }));

  const totals = finalizePipelineTotals(summarizePipelineStatuses(canonicalRows));
  assert.equal(totals.plaid_transactions_count, 6);
  assert.equal(totals.needs_review_count, 2);
  assert.equal(totals.handled_not_posted_count, 2);
  assert.equal(totals.posted_matched_count, 1);
  assert.equal(totals.exceptions_count, 1);
  assert.equal(totals.explained_count, 6);
});

test("posting failed requires durable QBO mutation-attempt evidence", () => {
  assert.equal(
    derivePipelineStatus({ bank: {}, cat: { status: "failed", post_error: "legacy error" } }).key,
    "handled_not_posted"
  );
  assert.equal(
    derivePipelineStatus({ bank: { pending: true }, cat: { status: "needs_review", post_error: "pending not postable" } }).key,
    "needs_review"
  );
  assert.equal(
    derivePipelineStatus({
      bank: {},
      cat: {
        status: "failed",
        post_error: "QBO rejected payload",
        latest_post_attempt: { attempted_at: "2026-08-24T17:00:00Z", status: "failed" },
      },
    }).key,
    "posting_failed"
  );
  assert.equal(
    derivePipelineStatus({
      bank: {},
      cat: { status: "failed", post_error: "stale error", qbo_txn_id: "1294", qbo_txn_type: "Purchase" },
    }).key,
    "posted_matched"
  );
});

test("Monthly Review and customer reconciliation routes use the same shared pipeline read model", () => {
  const monthlyRoute = read("src/api/admin/monthlyReview.routes.js");
  const customerRoute = read("src/api/bookkeeping/routes/bookkeeping.reconciliations.routes.js");
  const customerPage = read("src/pages/accounting/Reconciliations.jsx");
  const customerTable = read("src/components/Accounting/ReconciliationAuditTable.jsx");
  const monthlyUi = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const service = read("src/services/bookkeeping/monthlyReconciliationPipelineService.js");

  assert.match(monthlyRoute, /loadMonthlyReconciliationPipeline/);
  assert.match(customerRoute, /loadMonthlyReconciliationPipeline/);
  assert.match(customerRoute, /loadAvailableMonthlyReconciliationPeriods/);
  assert.match(customerRoute, /router\.get\("\/reconciliations\/months"/);
  assert.match(service, /derivePipelineStatus/);
  assert.match(service, /loadAuthoritativeMonthlyPlaidTransactions/);
  assert.doesNotMatch(customerRoute, /if \(!resolvedRunId\)[\s\S]*rows: \[\]/);
  assert.match(customerPage, /getReconciliationsMonths/);
  assert.match(customerPage, /month:\s*targetMonth/);
  assert.match(customerPage, /const \[pageSize\] = useState\(200\)/);
  assert.doesNotMatch(customerPage, /getReconciliationsRuns/);
  assert.match(customerTable, /row\.pipeline_status\?\.label|pipeline_status/);
  assert.match(customerTable, /max-h-\[min\(70vh,820px\)\] overflow-auto overscroll-contain/);
  assert.match(customerTable, /sticky top-0/);
  assert.match(monthlyUi, /PipelineStatusBadge/);
  assert.match(monthlyUi, /Plaid Transactions/);
  assert.doesNotMatch(monthlyUi, /<div>QBO Status<\/div>/);
  assert.doesNotMatch(monthlyUi, /<div>Reconciliation<\/div>/);
});

test("customer reconciliation month selection uses explicit calendar month boundaries", () => {
  const service = read("src/services/bookkeeping/monthlyReconciliationPipelineService.js");
  const customerRoute = read("src/api/bookkeeping/routes/bookkeeping.reconciliations.routes.js");
  const customerPage = read("src/pages/accounting/Reconciliations.jsx");

  assert.match(service, /export function normalizeMonthKey/);
  assert.match(service, /export function normalizeMonthInput/);
  assert.match(service, /if \(value && typeof value === "object"\)/);
  assert.match(service, /startDate/);
  assert.match(service, /endDateExclusive/);
  assert.match(service, /\?:-\\d\{1,2\}\)\?\$/);
  assert.match(service, /export function monthBounds/);
  assert.match(service, /new Date\(Date\.UTC\(parts\.year, parts\.month - 1, 1\)\)/);
  assert.match(service, /new Date\(Date\.UTC\(parts\.year, parts\.month, 1\)\)/);
  assert.match(customerRoute, /const requestedMonth = req\.query\?\.month \? normalizeMonthKey\(req\.query\.month\) : null/);
  assert.match(customerRoute, /month,\s+plaid_account_id/);
  assert.doesNotMatch(customerRoute, /const runSummaryRow = runId \? await pickRunById\(businessId, runId\) : await pickLatestRun\(businessId\)/);
  assert.ok(customerPage.includes('String(value || "").match(/^(\\d{4})-(\\d{2})/)'));
  assert.match(customerPage, /new Date\(Date\.UTC\(year, month, 0\)\)/);
});

test("Monthly Review keeps supporting month=YYYY-MM while malformed months fail as client errors", () => {
  const adminRoute = read("src/api/admin/monthlyReview.routes.js");
  const monthlyUi = read("src/pages/Admin/MonthlyReviewConsole.jsx");

  assert.match(monthlyUi, /month=\$\{encodeURIComponent\(month\)\}/);
  assert.match(adminRoute, /normalizeMonthInput/);
  assert.match(adminRoute, /if \(normalized\) return normalized\.startDate/);
  assert.match(adminRoute, /err\.status = 400/);
  assert.match(adminRoute, /err\.error = "invalid_month"/);
  assert.match(adminRoute, /sendMonthlyReviewError\(res, "monthly_review_businesses_failed"/);
  assert.match(adminRoute, /sendMonthlyReviewError\(res, "monthly_review_detail_failed"/);
  assert.match(adminRoute, /sendMonthlyReviewError\(res, "monthly_review_source_ledger_failed"/);
  assert.match(adminRoute, /sendMonthlyReviewError\(res, "monthly_review_bookkeeping_feed_counts_failed"/);
  assert.match(adminRoute, /sendMonthlyReviewError\(res, "monthly_review_bookkeeping_feed_failed"/);
});

test("available reconciliation months use canonical Plaid rows and pending replacement dedupe", () => {
  const service = read("src/services/bookkeeping/monthlyReconciliationPipelineService.js");
  assert.match(service, /export async function loadAvailableMonthlyReconciliationPeriods/);
  assert.match(service, /\.from\("bank_transactions"\)/);
  assert.match(service, /\.eq\("is_archived", false\)/);
  assert.match(service, /\.not\("plaid_transaction_id", "is", null\)/);
  assert.match(service, /\.not\("plaid_account_id", "is", null\)/);
  assert.match(service, /removeSupersededPendingPlaidRows\(rows\)/);
});
