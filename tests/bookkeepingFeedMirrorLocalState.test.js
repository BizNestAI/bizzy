import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBookkeepingRowFromOperatorResponse,
  buildLocallyPatchedBookkeepingRow,
  patchBookkeepingFeedsAfterApprovalState,
  patchOperatorResponseApprovalInDetail,
  patchBookkeepingFeedsAfterReclassificationState,
  patchSourceLedgerTransaction,
} from "../src/services/bookkeeping/bookkeepingFeedMirrorLocalState.js";

const sourceLedger = {
  chart_accounts: [
    { id: "24", name: "Software", type: "Expense" },
    { id: "42", name: "Meals", type: "Expense" },
  ],
  reconciliation_trace: [
    {
      id: "trace-txn-1",
      transaction_id: "txn-1",
      bizzi_gl_account: "Uncategorized",
      pipeline_status: { key: "needs_review", label: "Needs Review", tone: "warning" },
      pipeline_status_key: "needs_review",
    },
    {
      id: "trace-txn-2",
      transaction_id: "txn-2",
      bizzi_gl_account: "Software",
      pipeline_status: { key: "handled_not_posted", label: "Handled · Not Posted", tone: "neutral" },
      pipeline_status_key: "handled_not_posted",
    },
  ],
};

test("approval removes a row from Needs Review, adds it to Handled, and updates counts locally", () => {
  const row = { id: "txn-1", status: "needs_review", amount: -12.34, pending: false, glAccountName: "Uncategorized" };
  const feeds = {
    needs_review: { rows: [row], totalCount: 90, loaded: true, expanded: true },
    handled: { rows: [{ id: "existing", status: "approved" }], totalCount: 29, loaded: true, expanded: true },
  };

  const next = patchBookkeepingFeedsAfterApprovalState(feeds, row, "42", {
    categorization: { status: "approved", final_qbo_account_id: "42", final_qbo_account_name: "Meals" },
    target_account: { id: "42", name: "Meals" },
  }, sourceLedger);

  assert.deepEqual(next.needs_review.rows.map((item) => item.id), []);
  assert.equal(next.needs_review.totalCount, 89);
  assert.equal(next.handled.totalCount, 30);
  assert.equal(next.handled.rows[0].id, "txn-1");
  assert.equal(next.handled.rows[0].final_qbo_account_id, "42");
  assert.equal(next.handled.rows[0].final_qbo_account_name, "Meals");
  assert.equal(next.handled.rows[0].pipeline_status_key, "handled_not_posted");
});

test("approval increments Handled count without inserting hidden rows into a collapsed unloaded feed", () => {
  const row = { id: "txn-1", status: "needs_review", amount: -12.34 };
  const feeds = {
    needs_review: { rows: [row], totalCount: 1, loaded: true, expanded: true },
    handled: { rows: [], totalCount: 0, loaded: false, expanded: false },
  };

  const next = patchBookkeepingFeedsAfterApprovalState(feeds, row, "42", {
    categorization: { status: "approved", final_qbo_account_id: "42", final_qbo_account_name: "Meals" },
  }, sourceLedger);

  assert.equal(next.handled.totalCount, 1);
  assert.deepEqual(next.handled.rows, []);
});

test("reclassification updates only the existing handled row and does not move sections", () => {
  const row = { id: "txn-2", status: "approved", final_qbo_account_id: "24", final_qbo_account_name: "Software" };
  const feeds = {
    needs_review: { rows: [{ id: "txn-1", status: "needs_review" }], totalCount: 90, loaded: true },
    handled: { rows: [row], totalCount: 29, loaded: true },
  };

  const next = patchBookkeepingFeedsAfterReclassificationState(feeds, row, "42", {
    categorization: { status: "approved", final_qbo_account_id: "42", final_qbo_account_name: "Meals" },
    target_account: { id: "42", name: "Meals" },
  }, sourceLedger);

  assert.deepEqual(next.needs_review.rows.map((item) => item.id), ["txn-1"]);
  assert.equal(next.needs_review.totalCount, 90);
  assert.equal(next.handled.totalCount, 29);
  assert.equal(next.handled.rows[0].id, "txn-2");
  assert.equal(next.handled.rows[0].final_qbo_account_name, "Meals");
});

test("source ledger trace category and pipeline totals patch without a full ledger reload", () => {
  const patchedRow = buildLocallyPatchedBookkeepingRow({
    id: "txn-1",
    status: "needs_review",
    pending: false,
  }, {
    accountId: "42",
    targetAccount: { id: "42", name: "Meals" },
    categorization: { status: "approved", final_qbo_account_id: "42", final_qbo_account_name: "Meals" },
    pipelineStatusKey: "handled_not_posted",
  });

  const next = patchSourceLedgerTransaction(sourceLedger, patchedRow);
  const traceRow = next.reconciliation_trace.find((item) => item.transaction_id === "txn-1");

  assert.equal(traceRow.bizzi_gl_account, "Meals");
  assert.equal(traceRow.pipeline_status_key, "handled_not_posted");
  assert.equal(next.reconciliation_totals.handled_not_posted_count, 2);
});

test("operator response approval can build the same transaction row and remove only the resolved response", () => {
  const response = {
    request_id: "request-1",
    transaction_id: "txn-1",
    date: "2026-08-23",
    amount: -13.97,
    merchant: "Amelies",
    description: "APLPay TST AMELIES",
    source_account: "Blue Cash Everyday",
    status: "needs_review",
    suggested_qbo_account_id: "42",
    suggested_qbo_account_name: "Meals",
    pending: false,
  };
  const row = buildBookkeepingRowFromOperatorResponse(response);
  assert.equal(row.id, "txn-1");
  assert.equal(row.transaction_id, "txn-1");
  assert.equal(row.status, "needs_review");
  assert.equal(row.effective_account_name, "Meals");

  const detail = {
    operator_responses: {
      count: 2,
      rows: [response, { request_id: "request-2", transaction_id: "txn-2" }],
    },
  };
  const next = patchOperatorResponseApprovalInDetail(detail, "request-1");
  assert.equal(next.operator_responses.count, 1);
  assert.deepEqual(next.operator_responses.rows.map((item) => item.request_id), ["request-2"]);
});
