import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveQboPostingLifecycle } from "../src/services/bookkeeping/qboPostingLifecycle.js";
import {
  deriveTraceReconciliationStatus,
  formatPlaidAccountDisplayLabel,
} from "../src/services/bookkeeping/postingTraceDisplay.js";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} missing`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} missing`);
  return source.slice(start, end);
}

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

  const route = read("src/api/admin/monthlyReview.routes.js");
  assert.match(route, /\.from\("plaid_accounts"\)[\s\S]*\.eq\("business_id", businessId\)[\s\S]*\.in\("plaid_account_id", ids\)/);
  assert.match(route, /bank_account:\s*plaidAccountLabels\.get\(String\(row\.plaid_account_id\)\) \|\| "Financial account"/);
  assert.match(route, /bank_account:\s*plaidAccountLabels\.get\(String\(row\.plaid_account_id\)\) \|\| "Financial account"/);
  assert.doesNotMatch(route, /bank_account:\s*txn\.plaid_account_id \|\| "Plaid account"/);
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
  assert.equal(deriveQboPostingLifecycle({ status: "auto_approved", post_after: "2026-08-24T17:00:00Z" }).key, "queued");
  assert.equal(deriveQboPostingLifecycle({ status: "approved", post_error: "QBO rejected payload" }).key, "failed");
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
  const traceBody = sliceBetween(route, "const reconciliationTrace = authoritativePlaidRows", "const reconciliationTotals = reconciliationTrace.reduce");
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const guard = read("src/api/admin/monthlyReviewCloseGuard.js");

  assert.match(ui, /Posted to QBO/);
  assert.match(ui, /Awaiting QBO/);
  assert.match(ui, /Needs Review/);
  assert.match(ui, /Recon Exceptions/);
  assert.match(ui, /<div>Reconciliation<\/div>/);
  assert.doesNotMatch(ui, /Matched QBO|<div>Match<\/div>|ReconciliationMatchBadge/);

  assert.match(route, /posted_to_qbo_count/);
  assert.match(route, /awaiting_qbo_count/);
  assert.match(route, /needs_review_count/);
  assert.match(route, /reconciliation_exception_count/);
  assert.doesNotMatch(traceBody, /matched_qbo_count \+=|pending_count \+=|exception_count \+=|match_confidence:/);
  assert.match(guard, /row\.reconciliation_status\?\.exception !== true/);
});
