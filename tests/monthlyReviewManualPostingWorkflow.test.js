import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* global process */

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");

test("Monthly Review exposes first-attempt and retry manual posting through the shared workflow", () => {
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const table = read("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx");
  const workflow = read("src/components/Accounting/ManualQuickBooksPostingWorkflow.jsx");

  assert.match(page, /ManualQuickBooksPostingWorkflow/);
  assert.match(page, /openManualPostingWorkflow\("post", row\)/);
  assert.match(page, /openManualPostingWorkflow\("retry", row\)/);
  assert.match(page, /postRequest=\{monthlyReviewManualPostRequest\}/);
  assert.match(table, /Retry posting/);
  assert.match(table, /postingAction\.permitted_action/);
  assert.match(table, /onClick=\{\(\) => onPost\?\.\(row\)\}/);
  assert.match(workflow, /activeIds\.current\.has\(source\.id\)/);
  assert.match(workflow, /Posting…/);
});

test("Monthly Review manual posting preserves duplicate and credit-type decisions", () => {
  const workflow = read("src/components/Accounting/ManualQuickBooksPostingWorkflow.jsx");
  const route = read("src/api/admin/monthlyReview.routes.js");

  assert.match(workflow, /possible_qbo_match/);
  assert.match(workflow, /Already in QuickBooks — link transaction/);
  assert.match(workflow, /Different transaction — post anyway/);
  assert.match(workflow, /Confirm duplicate risk and post/);
  assert.match(workflow, /credit_card_inflow_resolution_required/);
  assert.match(workflow, /merchant_refund/);
  assert.match(workflow, /match_credit_card_payment/);
  assert.match(workflow, /credit_card_statement_credit/);
  assert.match(route, /requestInteractiveTransactionPosting/);
  assert.match(route, /signalInteractivePostingCommandWakeup/);
});

test("every Monthly Review Handled row renders the shared eligibility action", () => {
  const table = read("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx");
  assert.match(table, /getProtectedWorkflowReason\(row\)/);
  assert.match(table, /row\.posting_action \|\| deriveBookkeepingPostingAction\(row\)/);
  assert.match(table, /onPost\?\.\(row\)/);
  assert.match(table, /postingAction\.disabled_reason/);
  assert.match(table, /\{genericActionsBlocked \? \(/);
  assert.match(table, /Retry posting/);
});

test("Handled action matrix keeps completion or resolution controls visible", () => {
  const table = read("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx");
  for (const label of ["Post now", "Retry posting", "Confirm type", "Refresh match check", "Fix issue", "Review", "Posting…", "Reconciling…"]) {
    assert.match(table, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${label} must be represented`);
  }
});

test("Monthly Review exposes bounded local recovery without a QuickBooks call", () => {
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const table = read("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx");
  const route = read("src/api/admin/monthlyReview.routes.js");

  assert.match(table, /Recover state/);
  assert.match(table, /onRecover\?\.\(row\)/);
  assert.match(page, /recover-handled-posting-dispositions/);
  assert.match(page, /transaction_ids: \[transactionId\]/);
  assert.match(route, /transactionIds\.length > 25/);
  assert.match(route, /no QuickBooks calls were made/i);
});

test("Monthly Review never mounts transaction modal content for a null selection", () => {
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const workflow = read("src/components/Accounting/ManualQuickBooksPostingWorkflow.jsx");

  assert.match(page, /\{manualPostingRequest\?\.transaction \? \(/);
  assert.match(page, /transaction=\{manualPostingRequest\.transaction\}/);
  assert.match(workflow, /const summary = txn \? summaryFor\(txn\) : null/);
  assert.match(workflow, /if \(!transaction \|\| typeof document === "undefined"\) return null/);
  assert.match(workflow, /manual_post_transaction_required/);
});

test("Monthly Review closes manual posting safely on cancel, month changes, and stale refetch rows", () => {
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");

  assert.match(page, /onClose=\{\(\) => setManualPostingRequest\(null\)\}/);
  assert.match(page, /const selectMonth = useCallback[\s\S]*?setManualPostingRequest\(null\)/);
  assert.match(page, /const selectBusiness = useCallback[\s\S]*?setManualPostingRequest\(null\)/);
  assert.match(page, /const stillPresent = \(handled\.rows \|\| \[\]\)\.some/);
  assert.match(page, /if \(!stillPresent && !requestBusy\)/);
});

test("Monthly Review posting workflow contains malformed rows and active-request unmounts", () => {
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const workflow = read("src/components/Accounting/ManualQuickBooksPostingWorkflow.jsx");

  assert.match(page, /class MonthlyReviewActionsBoundary extends React\.Component/);
  assert.match(page, /Monthly Review could not be displayed\./);
  assert.match(page, /\[monthly-review\.actions\.render\]/);
  assert.match(page, /component_stack/);
  assert.doesNotMatch(page, /transaction[_ ]?(id|date|amount).*component_stack/i);
  assert.match(workflow, /mountedRef\.current = false/);
  assert.match(workflow, /activeRequests\.clear\(\)/);
});
