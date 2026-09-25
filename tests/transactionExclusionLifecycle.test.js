import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyBookkeepingLifecycle } from "../src/services/bookkeeping/bookkeepingLifecycleClassifier.js";

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
  assert.equal(classifyBookkeepingLifecycle({ status: "approved", reconciled_at: "2026-09-01", qbo_txn_id: "qbo-1" }).bucket, "posted");
  assert.equal(classifyBookkeepingLifecycle({ status: "matched", reconciled_at: "2026-09-01" }).bucket, "matched");
});

test("eligible expanded row details expose Exclude and excluded rows expose Restore", () => {
  assert.match(feed, /allowExclude/);
  assert.match(feed, /Full bank memo[\s\S]*Exclude transaction/);
  assert.match(feed, /showRestoreExcluded/);
  assert.match(feed, />\s*Restore\s*</);
  assert.match(feed, /allowExclude && !isPosted && !incomingMatch\.confirmed && !hasCcPair/);
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
