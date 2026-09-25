/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

import {
  classifyBookkeepingLifecycle,
  PRIMARY_BOOKKEEPING_BUCKETS,
} from "../src/services/bookkeeping/bookkeepingLifecycleClassifier.js";
const servicePromise = import("../src/services/bookkeeping/bookkeepingTransactionFeedService.js");

const migration = readFileSync(new URL("../supabase/migrations/20261024_posted_matched_primary_feed_separation.sql", import.meta.url), "utf8");
const service = readFileSync(new URL("../src/services/bookkeeping/bookkeepingTransactionFeedService.js", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/pages/accounting/BookkeepingCleanup.jsx", import.meta.url), "utf8");
const feed = readFileSync(new URL("../src/components/Accounting/BookkeepingFeed.jsx", import.meta.url), "utf8");

test("Bizzi-created QBO expenses and deposits belong only to Posted", async () => {
  const { matchesTransactionStatusFilter } = await servicePromise;
  for (const row of [
    { id: "costco", status: "posted", qbo_txn_id: "expense-1", qbo_txn_type: "Expense", posted_at: "2026-09-16T12:00:00Z", final_qbo_account_name: "Meals" },
    { id: "deposit", status: "posted", qbo_txn_id: "deposit-1", qbo_txn_type: "Deposit", posted_at: "2026-09-17T12:00:00Z", final_qbo_account_name: "Sales" },
  ]) {
    assert.equal(classifyBookkeepingLifecycle(row).bucket, "posted");
    assert.equal(matchesTransactionStatusFilter("posted", row), true);
    assert.equal(matchesTransactionStatusFilter("matched", row), false);
  }
});

test("existing-QBO deposit and fee matches remain only in Matched", async () => {
  const { matchesTransactionStatusFilter } = await servicePromise;
  for (const row of [
    { id: "intuit-deposit", status: "matched_existing_qbo", qbo_txn_id: "existing-deposit", meta: { matched_existing_qbo: true, incoming_deposit_match_status: "confirmed", match_type: "qbo_existing_transaction" } },
    { id: "intuit-fee", status: "matched_existing_qbo", qbo_txn_id: "existing-purchase", meta: { matched_existing_qbo: true, incoming_deposit_match_status: "confirmed", match_type: "qbo_existing_transaction" } },
  ]) {
    assert.equal(classifyBookkeepingLifecycle(row).bucket, "matched");
    assert.equal(matchesTransactionStatusFilter("matched", row), true);
    assert.equal(matchesTransactionStatusFilter("posted", row), false);
  }
});

test("confirmed two-sided card-payment legs remain Matched in their respective accounts", () => {
  const pair = { taxonomy_type: "cc_payment", cc_payment_pair_id: "pair-1", cc_payment_pair_status: "confirmed" };
  assert.equal(classifyBookkeepingLifecycle({ id: "bank-leg", plaid_account_id: "checking", status: "matched", meta: { ...pair, cc_payment_pair_role: "bank" } }).bucket, "matched");
  assert.equal(classifyBookkeepingLifecycle({ id: "card-leg", plaid_account_id: "card", status: "matched", meta: { ...pair, cc_payment_pair_role: "credit_card" } }).bucket, "matched");
});

test("QBO identity and category alone never establish Matched provenance", async () => {
  const { matchesTransactionStatusFilter } = await servicePromise;
  const row = { status: "posted", qbo_txn_id: "purchase-1", qbo_txn_type: "Purchase", final_qbo_account_name: "Supplies", meta: {} };
  assert.equal(classifyBookkeepingLifecycle(row).bucket, "posted");
  assert.equal(classifyBookkeepingLifecycle({ ...row, status: "approved" }).bucket, "handled");
  assert.equal(matchesTransactionStatusFilter("matched", row), false);
});

test("nonterminal and exceptional states retain their canonical feed", () => {
  const fixtures = [
    [{ status: "failed", post_error: "qbo_rejected" }, "handled"],
    [{ status: "approved", meta: { post_block_reason: "weak_memo_evidence" } }, "handled"],
    [{ status: "approved", posting_status: "scheduled", post_after: "2026-09-26T00:00:00Z" }, "handled"],
    [{ status: "needs_review" }, "needs_review"],
    [{ status: "approved", pending: true }, "pending"],
    [{ status: "excluded", qbo_txn_id: "legacy-id" }, "excluded"],
  ];
  for (const [row, expected] of fixtures) assert.equal(classifyBookkeepingLifecycle(row).bucket, expected);
});

test("Posted and Matched predicates are mutually exclusive for every fixture", async () => {
  const { matchesTransactionStatusFilter } = await servicePromise;
  const fixtures = [
    { status: "posted", qbo_txn_id: "qbo-1", posted_at: "2026-09-01T00:00:00Z" },
    { status: "matched_existing_qbo", qbo_txn_id: "qbo-2", meta: { matched_existing_qbo: true } },
    { status: "approved" }, { status: "needs_review" }, { pending: true }, { status: "excluded" },
  ];
  for (const row of fixtures) {
    assert.notEqual(matchesTransactionStatusFilter("posted", row) && matchesTransactionStatusFilter("matched", row), true);
    assert.equal(PRIMARY_BOOKKEEPING_BUCKETS.includes(classifyBookkeepingLifecycle(row).bucket), true);
  }
});

test("server count and row queries use exclusive Matched rather than legacy Reconciled", () => {
  assert.match(service, /if \(statusKey === "reconciled"\) return "matched"/);
  assert.doesNotMatch(service, /if \(statusKey === "matched"\) return "reconciled"/);
  assert.match(migration, /when 'reconciled' then[\s\S]*= 'matched'/);
  assert.doesNotMatch(migration, /when 'reconciled' then[^\n]*in \('matched','posted'\)/);
  assert.match(migration, /audit_posted_matched_feed_separation/);
  assert.doesNotMatch(migration, /\b(update|insert|delete)\s+public\.(bank_transactions|transaction_categorizations)/i);
});

test("cache keys isolate business, account, lifecycle, date, page, and page size", () => {
  assert.match(page, /\[businessId, accountFilter, activeTab, dateRange, page, rowsPerPage\]/);
});

test("only genuine reversible matches receive match Undo while Posted renders Posted", () => {
  assert.match(feed, /\{isPosted \? \([\s\S]*>Posted<\/span>/);
  assert.match(feed, /incomingMatch\.confirmed && allowIncomingDepositUndo && incomingMatch\.matchId/);
  assert.match(feed, /onUndoIncomingDepositMatch/);
});
