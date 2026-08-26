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
  const customerTable = read("src/components/Accounting/ReconciliationAuditTable.jsx");
  const monthlyUi = read("src/pages/Admin/MonthlyReviewConsole.jsx");

  assert.match(monthlyRoute, /derivePipelineStatus/);
  assert.match(monthlyRoute, /summarizePipelineStatuses\(reconciliationTrace\)/);
  assert.match(customerRoute, /derivePipelineStatus/);
  assert.match(customerTable, /row\.pipeline_status\?\.label|pipeline_status/);
  assert.match(monthlyUi, /PipelineStatusBadge/);
  assert.match(monthlyUi, /Plaid Transactions/);
  assert.doesNotMatch(monthlyUi, /<div>QBO Status<\/div>/);
  assert.doesNotMatch(monthlyUi, /<div>Reconciliation<\/div>/);
});
