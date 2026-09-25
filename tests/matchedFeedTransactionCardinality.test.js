/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const servicePromise = import("../src/services/bookkeeping/bookkeepingTransactionFeedService.js");
const serviceSource = readFileSync(new URL("../src/services/bookkeeping/bookkeepingTransactionFeedService.js", import.meta.url), "utf8");
const feedSource = readFileSync(new URL("../src/components/Accounting/BookkeepingFeed.jsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../src/pages/accounting/BookkeepingCleanup.jsx", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20261025_matched_feed_transaction_cardinality.sql", import.meta.url), "utf8");
const integrityMigration = readFileSync(new URL("../supabase/migrations/20261026_credit_card_payment_pair_integrity.sql", import.meta.url), "utf8");

function rpcRow(id, accountId, overrides = {}) {
  return {
    id,
    plaid_transaction_id: `plaid-${id}`,
    plaid_account_id: accountId,
    date: "2026-09-08",
    name: "CARD PAYMENT",
    amount: -40,
    signed_amount: -40,
    direction: "OUTFLOW",
    cat_status: "handled",
    cat_meta: {
      taxonomy_type: "cc_payment",
      cc_payment_pair_id: "pair-1",
      cc_payment_pair_status: "confirmed",
      cc_payment_pair_role: "checking",
      cc_payment_pair_txn_id: "txn-card",
    },
    total_count: 1,
    ...overrides,
  };
}

function feedDb(rows) {
  const tables = [];
  return {
    tables,
    rpc: async (name) => name === "count_bookkeeping_transactions_bounded"
      ? { data: new Set(rows.map((row) => row.id)).size, error: null }
      : { data: rows, error: null },
    from: (table) => {
      tables.push(table);
      return {
        select: () => ({
          eq: () => ({
            in: async () => ({ data: [], error: null }),
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      };
    },
  };
}

test("Matched feed emits each canonical transaction ID once and never appends pair-table legs", async () => {
  const { fetchBookkeepingTransactions } = await servicePromise;
  const duplicate = rpcRow("txn-checking", "checking-account");
  const db = feedDb([duplicate, { ...duplicate }]);
  const result = await fetchBookkeepingTransactions({
    db, businessId: "business-1", accountId: "checking-account", statusFilter: "matched", rangeParam: "all",
  });

  assert.deepEqual(result.rows.map((row) => row.id), ["txn-checking"]);
  assert.equal(result.totalCount, 1);
  assert.equal(db.tables.includes("credit_card_payment_pairs"), false);
});

test("same-day same-amount Plaid transactions remain distinct by stable ID", async () => {
  const { fetchBookkeepingTransactions } = await servicePromise;
  const db = feedDb([
    rpcRow("txn-a", "checking-account", { plaid_transaction_id: "plaid-a", total_count: 2 }),
    rpcRow("txn-b", "checking-account", { plaid_transaction_id: "plaid-b", total_count: 2 }),
  ]);
  const result = await fetchBookkeepingTransactions({
    db, businessId: "business-1", accountId: "checking-account", statusFilter: "matched", rangeParam: "all",
  });
  assert.deepEqual(result.rows.map((row) => row.id), ["txn-a", "txn-b"]);
  assert.equal(result.totalCount, 2);
});

test("Matched rows, counts, and pagination use only the bounded transaction RPC", () => {
  assert.doesNotMatch(serviceSource, /fetchMatchedCreditCardPaymentRows|countMatchedCreditCardPairLegs|fetchMatchedCreditCardPairLegs/);
  assert.match(serviceSource, /new Map\(pageRows\.map/);
  assert.match(serviceSource, /p_limit: safePageSize/);
  assert.match(serviceSource, /p_offset: \(safePage - 1\) \* safePageSize/);
});

test("database prevents normalized duplicate pairs and multiple active membership", () => {
  assert.match(integrityMigration, /active_normalized_pair_uq/);
  assert.match(integrityMigration, /least\(checking_transaction_id, credit_card_transaction_id\)/);
  assert.match(integrityMigration, /greatest\(checking_transaction_id, credit_card_transaction_id\)/);
  assert.match(integrityMigration, /active_credit_card_payment_pair_membership/);
  assert.match(integrityMigration, /pg_advisory_xact_lock/);
  assert.match(integrityMigration, /credit_card_payment_pair_leg_already_consumed/);
  assert.match(integrityMigration, /credit_card_payment_pairs_idempotency_uq/);
});

test("duplicate audit is exact-ID, read-only, and identifies both legacy source branches", () => {
  assert.match(migration, /audit_matched_feed_cardinality/);
  assert.match(migration, /canonical_transaction_id/);
  assert.match(migration, /bounded_rpc','credit_card_payment_pairs_append/);
  assert.match(migration, /duplicate_pairs/);
  assert.match(migration, /multi_pair_legs/);
  assert.doesNotMatch(migration, /\b(delete|update)\s+(from\s+)?public\.(bank_transactions|transaction_categorizations|credit_card_payment_pairs)/i);
  assert.doesNotMatch(migration, /create unique index|create trigger/i);
});

test("rendering and cache identity remain canonical transaction-ID scoped", () => {
  assert.match(feedSource, /<React\.Fragment key=\{txn\.id\}>/);
  assert.match(pageSource, /\[businessId, accountFilter, activeTab, dateRange, page, rowsPerPage\]/);
  assert.doesNotMatch(feedSource, /key=\{index\}/);
});
