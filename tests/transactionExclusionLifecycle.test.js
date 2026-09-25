import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyBookkeepingLifecycle } from "../src/services/bookkeeping/bookkeepingLifecycleClassifier.js";
import {
  buildOptimisticallyExcludedRow,
  patchFeedCacheForExclusion,
} from "../src/services/bookkeeping/bookkeepingFeedMirrorLocalState.js";

const page = readFileSync(new URL("../src/pages/accounting/BookkeepingCleanup.jsx", import.meta.url), "utf8");
const feed = readFileSync(new URL("../src/components/Accounting/BookkeepingFeed.jsx", import.meta.url), "utf8");
const worker = readFileSync(new URL("../src/jobs/booksPost.cron.js", import.meta.url), "utf8");
const plaid = readFileSync(new URL("../src/services/plaid/plaidSyncService.js", import.meta.url), "utf8");
const routes = readFileSync(new URL("../src/api/bookkeeping/routes/bookkeeping.exclusions.routes.js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20261021_transaction_exclusions.sql", import.meta.url), "utf8");

test("Books Review replaces the Reconciled navigation button with Excluded", () => {
  assert.match(page, /key: "excluded", label: "Excluded"/);
  assert.doesNotMatch(page, />\s*Reconciled\s*</);
  assert.match(page, /excludedTransaction|restoreExcludedTransaction|excludeTransaction/);
});

test("excluded is one authoritative primary feed and reconciliation stays secondary", () => {
  assert.equal(classifyBookkeepingLifecycle({ status: "excluded", pending: true }).bucket, "excluded");
  assert.equal(classifyBookkeepingLifecycle({ status: "posted", posted_at: "2026-09-01", qbo_txn_id: "qbo-1" }).bucket, "posted");
  assert.equal(classifyBookkeepingLifecycle({ status: "matched_existing_qbo", reconciled_at: "2026-09-01", meta: { matched_existing_qbo: true } }).bucket, "matched");
});

test("eligible expanded row details expose Exclude and excluded rows expose Restore", () => {
  assert.match(feed, /allowExclude/);
  assert.match(feed, /Full bank memo[\s\S]*Exclude transaction/);
  assert.match(feed, /showRestoreExcluded/);
  assert.match(feed, />\s*Restore\s*</);
  assert.match(feed, /allowExclude && getBookkeepingExclusionEligibility\(txn\)\.eligible/);
  assert.match(feed, /disabled=\{readOnly \|\| isPosting\}/);
});

test("exclusion RPCs are exact-ID, idempotent, audited, and do no QBO work", () => {
  assert.match(migration, /exclude_bookkeeping_transaction/);
  assert.match(migration, /for update/);
  assert.match(migration, /transaction_already_posted/);
  assert.match(migration, /posting_in_progress/);
  assert.match(migration, /transaction_already_matched/);
  assert.match(migration, /bookkeeping_exclusion_events/);
  assert.match(migration, /if v_cat\.status = 'excluded'/);
  assert.doesNotMatch(migration, /createQbo|createPurchase|createDeposit|createTransfer/);
  assert.match(routes, /requireAuth/);
  assert.match(routes, /ensureBusinessId/);
});

test("workers recheck exclusion before external QBO creation", () => {
  assert.match(worker, /await assertTransactionNotExcluded[\s\S]*return createQboDeposit/);
  assert.match(worker, /postBankOutflowPurchase[\s\S]*await assertTransactionNotExcluded[\s\S]*createQboPurchase/);
  assert.match(worker, /postCreditCardOutflowCharge[\s\S]*await assertTransactionNotExcluded[\s\S]*createQboPurchase/);
});

test("pending finalization does not silently retain a material same-ID exclusion", () => {
  assert.match(plaid, /excludedFinalizedReopens/);
  assert.match(plaid, /material_pending_to_posted_change/);
  assert.match(plaid, /pending_exclusion_snapshot/);
  assert.match(plaid, /finalized_replacement_reopened/);
  assert.match(plaid, /pending_authorization_replaced/);
  assert.match(plaid, /finalized_transaction_imported_independently/);
  assert.match(plaid, /excludedRemovedIds/);
});

test("migration performs no exclusion backfill", () => {
  assert.doesNotMatch(migration, /update\s+public\.transaction_categorizations\s+set\s+status\s*=\s*'excluded'/i);
  assert.doesNotMatch(migration, /where[\s\S]{0,120}(merchant|amount|memo)[\s\S]{0,120}status\s*=\s*'excluded'/i);
});

test("Exclude is immediate, guarded against duplicates, and never asks for confirmation", () => {
  const handler = page.slice(page.indexOf("const handleExclude"), page.indexOf("const handleRestoreExcluded"));
  assert.doesNotMatch(handler, /window\.confirm|\bconfirm\s*\(/);
  assert.match(handler, /exclusionInFlightRef\.current\.has/);
  assert.match(handler, /setExcludingTransactionIds/);
  assert.match(handler, /setTransactions\(\(rows\) => rows\.filter/);
  assert.match(handler, /excluded:\s*Number\(counts\.excluded \|\| 0\) \+ 1/);
  assert.match(handler, /rollbackCaches\(\)/);
  assert.match(handler, /next\.splice/);
  assert.match(feed, /if \(excluded\) setExpandedRowId\(null\)/);
});

test("Restore is immediate and never asks for confirmation", () => {
  const handler = page.slice(page.indexOf("const handleRestoreExcluded"), page.indexOf("const handleRejectCreditCardPayment"));
  assert.doesNotMatch(handler, /window\.confirm|\bconfirm\s*\(/);
  assert.match(handler, /restoreExcludedTransaction\(businessId, id\)/);
});

test("Needs Review, Handled, and Pending caches move only the exact row into Excluded", () => {
  const transaction = { id: "txn-1", plaid_account_id: "account-a", status: "approved" };
  for (const sourceTab of ["needs_review", "handled", "pending"]) {
    const source = patchFeedCacheForExclusion({ rows: [transaction, { id: "txn-2" }], totalCount: 2 }, {
      transaction, sourceTab, targetTab: sourceTab, page: 1, pageSize: 25,
    });
    const excluded = patchFeedCacheForExclusion({ rows: [], totalCount: 0 }, {
      transaction, sourceTab, targetTab: "excluded", page: 1, pageSize: 25,
    });
    assert.deepEqual(source.rows.map((row) => row.id), ["txn-2"]);
    assert.equal(source.totalCount, 1);
    assert.equal(excluded.totalCount, 1);
    assert.equal(excluded.rows[0].id, "txn-1");
    assert.equal(excluded.rows[0].plaid_account_id, "account-a");
    assert.equal(excluded.rows[0].status, "excluded");
  }
});

test("cache synchronization is scoped to the selected business and financial account", () => {
  assert.match(page, /cachedAccount !== String\(accountId\)/);
  assert.match(page, /BOOKS_TXN_CACHE_PREFIX.*businessId/);
  assert.match(page, /\[sourceTab, "excluded"\]\.includes\(cachedTab\)/);
});

test("repeated exclusion state patches are idempotent", () => {
  const transaction = buildOptimisticallyExcludedRow({ id: "txn-1", plaid_account_id: "account-a" });
  const first = patchFeedCacheForExclusion({ rows: [], totalCount: 0 }, {
    transaction, sourceTab: "handled", targetTab: "excluded", page: 1, pageSize: 25,
  });
  const second = patchFeedCacheForExclusion(first, {
    transaction, sourceTab: "handled", targetTab: "excluded", page: 1, pageSize: 25,
  });
  assert.equal(second.totalCount, 1);
  assert.equal(second.rows.length, 1);
});

test("exclude remains isolated from QBO, matching, categorization, and rule operations", () => {
  const handler = page.slice(page.indexOf("const handleExclude"), page.indexOf("const handleRestoreExcluded"));
  assert.doesNotMatch(handler, /createQbo|ManualPost|matchTransaction|categorize|createRule|learnRule/);
  assert.match(handler, /excludeTransaction\(businessId, id, null, accountFilter\)/);
  assert.match(handler, /action:\s*\{ label: "Undo"/);
  assert.equal(classifyBookkeepingLifecycle({ status: "excluded", pre_exclusion_lifecycle: "handled" }).bucket, "excluded");
  assert.equal(classifyBookkeepingLifecycle({ status: "approved" }).bucket, "handled");
});
