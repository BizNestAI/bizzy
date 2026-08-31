import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveQboPostingLifecycle } from "../src/services/bookkeeping/qboPostingLifecycle.js";
import {
  derivePipelineStatus,
  finalizePipelineTotals,
  summarizePipelineStatuses,
} from "../src/services/bookkeeping/reconciliationPipelineStatus.js";
import {
  deriveTraceReconciliationStatus,
  formatPlaidAccountDisplayLabel,
} from "../src/services/bookkeeping/postingTraceDisplay.js";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

test("Posting Trace bank account labels use persisted Plaid account identity, not raw IDs", () => {
  assert.equal(
    formatPlaidAccountDisplayLabel({ name: "Checking", mask: "8626", type: "depository", subtype: "checking" }),
    "Checking ••••8626"
  );
  assert.equal(
    formatPlaidAccountDisplayLabel({ official_name: "Blue Cash Everyday®", mask: "1008", type: "credit", subtype: "credit card" }),
    "Blue Cash Everyday® ••••1008"
  );
  assert.equal(
    formatPlaidAccountDisplayLabel({ type: "credit", subtype: "credit card", mask: "6735" }),
    "Credit Card ••••6735"
  );

  const service = read("src/services/bookkeeping/monthlyReconciliationPipelineService.js");
  assert.match(service, /\.from\("plaid_accounts"\)[\s\S]*\.eq\("business_id", businessId\)[\s\S]*\.in\("plaid_account_id", ids\)/);
  assert.match(service, /bank_account:\s*plaidAccountLabels\.get\(String\(row\.plaid_account_id\)\) \|\| "Financial account"/);
  assert.doesNotMatch(service, /bank_account:\s*txn\.plaid_account_id \|\| "Plaid account"/);
});

test("shared QBO lifecycle gives qbo_txn_id highest posted authority", () => {
  const posted = deriveQboPostingLifecycle({
    status: "failed_post",
    post_error: "stale failure",
    qbo_txn_id: "123",
    qbo_txn_type: "Purchase",
  });
  assert.equal(posted.key, "posted");
  assert.equal(posted.label, "Posted");

  assert.equal(deriveQboPostingLifecycle({ status: "needs_review" }).key, "needs_review");
  assert.notEqual(deriveQboPostingLifecycle({ status: "needs_review" }).key, "failed");
  assert.equal(deriveQboPostingLifecycle({ status: "approved" }).key, "handled_not_posted");
  assert.equal(deriveQboPostingLifecycle({ status: "auto_approved", post_after: "2999-08-24T17:00:00Z" }).key, "queued");
  assert.equal(deriveQboPostingLifecycle({ status: "approved", post_error: "stale legacy error" }).key, "handled_not_posted");
  assert.equal(deriveQboPostingLifecycle({
    status: "approved",
    post_error: "QBO rejected payload",
    last_post_attempt_at: "2026-08-24T17:00:00Z",
  }).key, "failed");
});

test("Posting Trace reconciliation states are separate from QBO posted lifecycle", () => {
  const posted = deriveQboPostingLifecycle({ status: "approved", qbo_txn_id: "qbo-1" });
  const handled = deriveQboPostingLifecycle({ status: "approved" });
  const needsReview = deriveQboPostingLifecycle({ status: "needs_review" });

  assert.equal(deriveTraceReconciliationStatus({ lifecycle: posted }).key, "awaiting_reconciliation");
  assert.equal(deriveTraceReconciliationStatus({ lifecycle: handled }).key, "awaiting_qbo");
  assert.equal(deriveTraceReconciliationStatus({ lifecycle: needsReview }).key, "not_yet_eligible");

  assert.equal(deriveTraceReconciliationStatus({ lifecycle: posted, reconciliationItem: { status: "matched" } }).key, "matched");
  assert.equal(deriveTraceReconciliationStatus({ lifecycle: posted, reconciliationItem: { status: "mismatch" } }).key, "mismatch");
  assert.equal(deriveTraceReconciliationStatus({ lifecycle: posted, reconciliationItem: { status: "duplicate" } }).key, "duplicate");
  assert.equal(deriveTraceReconciliationStatus({ lifecycle: posted, reconciliationItem: { status: "error", note: "missing_in_qbo" } }).key, "missing_in_qbo");
  assert.equal(deriveTraceReconciliationStatus({ lifecycle: posted, reconciliationItem: { status: "error", note: "provider conflict" } }).key, "needs_investigation");
});

test("Posting Trace UI and KPIs no longer use fake match confidence", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const service = read("src/services/bookkeeping/monthlyReconciliationPipelineService.js");
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const guard = read("src/api/admin/monthlyReviewCloseGuard.js");

  assert.match(ui, /Plaid Transactions/);
  assert.match(ui, /Handled · Not Posted/);
  assert.match(ui, /Posted & Matched/);
  assert.match(ui, /Needs Review/);
  assert.match(ui, /Exceptions/);
  assert.match(ui, /<div>Pipeline Status<\/div>/);
  assert.doesNotMatch(ui, /<div>QBO Status<\/div>/);
  assert.doesNotMatch(ui, /<div>Reconciliation<\/div>/);
  assert.doesNotMatch(ui, /Matched QBO|<div>Match<\/div>|ReconciliationMatchBadge/);

  assert.match(route, /loadMonthlyReconciliationPipeline/);
  assert.match(service, /summarizePipelineStatuses\(rows\)/);
  assert.match(service, /finalizePipelineTotals/);
  assert.match(route, /needs_review_count/);
  assert.match(service, /pipeline_status/);
  assert.doesNotMatch(service, /matched_qbo_count \+=|pending_count \+=|exception_count \+=|match_confidence:/);
  assert.match(guard, /row\.reconciliation_status\?\.exception !== true/);
});

test("unified pipeline statuses are mutually exclusive and prevent false failed rows", () => {
  const rows = [
    { pipeline_status: derivePipelineStatus({ bank: {}, cat: { status: "needs_review", post_error: "pending_transaction_not_postable" } }) },
    { pipeline_status: derivePipelineStatus({ bank: {}, cat: { status: "approved", post_error: "stale qbo error" } }) },
    { pipeline_status: derivePipelineStatus({ bank: {}, cat: { status: "approved" } }) },
    { pipeline_status: derivePipelineStatus({ bank: {}, cat: { status: "approved", post_after: "2999-08-24T17:00:00Z" } }) },
    { pipeline_status: derivePipelineStatus({ bank: {}, cat: { status: "posted", qbo_txn_id: "qbo-1", qbo_txn_type: "Purchase" } }) },
    {
      pipeline_status: derivePipelineStatus({
        bank: {},
        cat: {
          status: "failed",
          post_error: "QBO rejected payload",
          last_post_attempt_at: "2026-08-24T17:00:00Z",
        },
      }),
    },
  ];

  assert.deepEqual(rows.map((row) => row.pipeline_status.key), [
    "needs_review",
    "handled_not_posted",
    "handled_not_posted",
    "scheduled_for_qbo",
    "posted_matched",
    "posting_failed",
  ]);

  const totals = finalizePipelineTotals(summarizePipelineStatuses(rows));
  assert.equal(totals.plaid_transactions_count, 6);
  assert.equal(totals.needs_review_count, 1);
  assert.equal(totals.handled_not_posted_count, 3);
  assert.equal(totals.posted_matched_count, 1);
  assert.equal(totals.exceptions_count, 1);
  assert.equal(totals.explained_count, totals.plaid_transactions_count);
});
