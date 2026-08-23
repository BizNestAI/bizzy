import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildAccountingCloseFinalizationGuard,
  buildReconciliationKpis,
  findTrueReconciliationExceptionItems,
  selectedMonthTransactionStillRequiresCanonicalMapping,
} from "../src/api/admin/monthlyReviewCloseGuard.js";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const txn = (id, overrides = {}) => ({
  id,
  date: "2026-08-12",
  payee: id,
  description: id,
  books_review_tab: "needs_review",
  effective_account_id: null,
  effective_account_name: null,
  qbo_sync_status: { key: "not_posted" },
  ...overrides,
});

const ledger = (transactions) => ({
  account_groups: [{ account_name: "Uncategorized", transactions }],
  totals: {
    needs_review_count: transactions.filter((row) => row.books_review_tab === "needs_review").length,
    qbo_sync_counts: {},
  },
  reconciliation_trace: [],
});

test("Monthly Review close guard dedupes multiple reasons for one transaction", () => {
  const guard = buildAccountingCloseFinalizationGuard({
    sourceLedger: ledger([txn("txn-1")]),
  });

  assert.equal(guard.can_finalize, false);
  assert.equal(guard.unique_blocking_item_count, 1);
  assert.equal(guard.blocker_count, 1);
  assert.ok(guard.reason_count >= 3);
  assert.equal(guard.counts.needs_review_transactions, 1);
  assert.equal(guard.counts.missing_gl_account, 1);
  assert.equal(guard.counts.qbo_not_posted, 1);
});

test("Monthly Review close guard counts different transactions independently", () => {
  const guard = buildAccountingCloseFinalizationGuard({
    sourceLedger: ledger([
      txn("txn-1"),
      txn("txn-2", { effective_account_id: "acct-1", effective_account_name: "Meals" }),
    ]),
  });

  assert.equal(guard.unique_blocking_item_count, 2);
  assert.ok(guard.reason_count > guard.unique_blocking_item_count);
});

test("Monthly Review close guard counts selected-month COA mapping as its own item", () => {
  const guard = buildAccountingCloseFinalizationGuard({
    sourceLedger: ledger([]),
    canonicalCoa: {
      needs_review: [{
        mapping_id: "map-august",
        canonical_account_key: "transportation",
        bizzi_account_name: "Transportation",
        selected_month_required: true,
        selected_month_transaction_ids: ["txn-august"],
      }],
    },
  });

  assert.equal(guard.unique_blocking_item_count, 1);
  assert.equal(guard.counts.canonical_coa_needs_review, 1);
});

test("Monthly Review close guard ignores unrelated historical COA mappings omitted from month-scoped needs_review", () => {
  const guard = buildAccountingCloseFinalizationGuard({
    sourceLedger: ledger([]),
    canonicalCoa: {
      needs_review: [],
      all_needs_review: [{ mapping_id: "map-may", canonical_account_key: "equipment_rental" }],
    },
  });

  assert.equal(guard.can_finalize, true);
  assert.equal(guard.unique_blocking_item_count, 0);
  assert.equal(guard.counts.canonical_coa_needs_review || 0, 0);
});

test("Monthly Review COA relevance excludes independently resolved selected-month transactions", () => {
  assert.equal(selectedMonthTransactionStillRequiresCanonicalMapping({
    status: "needs_review",
    suggested_canonical_account_key: "transportation",
    meta: { canonical_mapping_review_required: true },
  }), true);
  assert.equal(selectedMonthTransactionStillRequiresCanonicalMapping({
    status: "approved",
    suggested_canonical_account_key: "transportation",
    final_qbo_account_id: "42",
    final_qbo_account_name: "Travel",
    meta: { canonical_mapping_review_required: true },
  }), false);
  assert.equal(selectedMonthTransactionStillRequiresCanonicalMapping({
    status: "posted",
    suggested_canonical_account_key: "transportation",
    qbo_txn_id: "qbo-1",
    meta: { canonical_mapping_review_required: true },
  }), false);
});

test("Monthly Review reconciliation exceptions exclude ordinary needs-review and unposted states", () => {
  const items = [
    { id: "needs", status: "needs_review", issue_type: "needs_review", reason: "Needs review before posting" },
    { id: "queued", status: "approved_waiting_post", issue_type: "queued", reason: "Queued for posting" },
    { id: "not-posted", status: "not_posted", issue_type: "not_posted", reason: "No QBO transaction yet" },
  ];

  assert.deepEqual(findTrueReconciliationExceptionItems(items), []);
  assert.equal(buildReconciliationKpis(null, items).exceptionCount, 0);
});

test("Monthly Review reconciliation exceptions include failed posting duplicate and mismatch evidence", () => {
  const items = [
    { id: "failed", status: "failed_post", issue_type: "failed_post", reason: "QBO rejected payload" },
    { id: "dup", status: "duplicate_in_qbo", issue_type: "duplicate_in_qbo", reason: "Duplicate QBO post" },
    { id: "mismatch", status: "mismatch", issue_type: "amount_mismatch", reason: "Amount mismatch" },
  ];

  assert.equal(findTrueReconciliationExceptionItems(items).length, 3);
  assert.equal(buildReconciliationKpis(null, items).exceptionCount, 3);
});

test("Monthly Review detail and finalize routes share the accounting close guard", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const detailStart = route.indexOf('router.get("/businesses/:businessId"');
  const finalizeStart = route.indexOf('router.post("/runs/:runId/finalize"');
  assert.notEqual(detailStart, -1);
  assert.notEqual(finalizeStart, -1);
  const detailBody = route.slice(detailStart, route.indexOf("\nrouter.", detailStart + 1));
  const finalizeBody = route.slice(finalizeStart, route.indexOf("\nrouter.", finalizeStart + 1));
  assert.match(detailBody, /buildAccountingCloseFinalizationGuard/);
  assert.match(finalizeBody, /buildAccountingCloseFinalizationGuard/);
});

test("Monthly Review clean accounting-close guard can finalize from blocker perspective", () => {
  const guard = buildAccountingCloseFinalizationGuard({
    sourceLedger: ledger([
      txn("posted-1", {
        books_review_tab: "posted",
        effective_account_id: "acct-1",
        effective_account_name: "Meals",
        qbo_sync_status: { key: "updated_in_qbo" },
      }),
    ]),
    operatorResponses: { rows: [] },
    canonicalCoa: { needs_review: [] },
    reconciliationEvidence: { raw: { exceptionItems: [], exceptionCount: 0 } },
  });

  assert.equal(guard.can_finalize, true);
  assert.equal(guard.unique_blocking_item_count, 0);
  assert.equal(guard.reason_count, 0);
});

test("Monthly Review blocker accuracy source keeps manual posting path and security controls", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const postingRoute = read("src/api/bookkeeping/routes/bookkeeping.posting.routes.js");
  const cron = read("src/jobs/booksPost.cron.js");

  assert.match(route, /router\.use\(requireAuth\)/);
  assert.match(route, /router\.use\(requireInternalRole\(MONTHLY_REVIEW_STAFF_ROLES\)\)/);
  assert.match(route, /financial_monthly_review_stamps/);
  assert.match(route, /monthly_review_audit_events/);
  assert.match(route, /router\.post\("\/runs\/:runId\/reopen"/);
  assert.match(postingRoute, /router\.post\("\/posting\/transactions\/:transactionId"/);
  assert.match(postingRoute, /postSingleBookkeepingTransactionNow\(\{ businessId, transactionId, confirmPostAnyway \}\)/);
  assert.match(cron, /export async function postSingleBookkeepingTransactionNow/);
});
