/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

import {
  excludeBookkeepingTransaction,
  mapTransactionExclusionDatabaseError,
} from "../src/services/bookkeeping/transactionExclusionService.js";
import { getBookkeepingExclusionEligibility } from "../src/services/bookkeeping/exclusionEligibility.js";

const TXN_ID = "90b9e101-aaaa-4bbb-8ccc-12348fada54c";

function dbFixture({ bank = {}, category = null, rpcData = {} } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          if (table === "bank_transactions") return { data: { id: TXN_ID, plaid_account_id: "checking-8626", pending: false, is_archived: false, ...bank }, error: null };
          return { data: category, error: null };
        },
      };
    },
    async rpc(name, params) {
      calls.push({ name, params });
      return { data: { primary_feed: "excluded", excluded_at: "2026-09-25T12:00:00Z", ...rpcData }, error: null };
    },
  };
}

test("uncategorized September 1 Alliant row excludes by its canonical feed ID without optional metadata", async () => {
  const db = dbFixture({ category: null });
  const result = await excludeBookkeepingTransaction({
    db, businessId: "11111111-1111-4111-8111-111111111111", accountId: "checking-8626",
    transactionId: TXN_ID, actorId: "user-1",
  });
  assert.equal(db.calls[0].params.p_transaction_id, TXN_ID);
  assert.equal(result.transaction.id, TXN_ID);
  assert.equal(result.transaction.plaid_account_id, "checking-8626");
  assert.equal(result.transaction.primary_feed, "excluded");
});

test("external Plaid IDs are rejected instead of guessed as canonical UUIDs", async () => {
  const db = dbFixture();
  await assert.rejects(
    excludeBookkeepingTransaction({ db, businessId: "biz", transactionId: "plaid-external-id" }),
    (error) => error.code === "MALFORMED_TRANSACTION_ID" && error.status === 400
  );
  assert.equal(db.calls.length, 0);
});

test("exclusion is account scoped and optional category fields are not required", async () => {
  const db = dbFixture({ category: { status: "needs_review", meta: {} } });
  await assert.rejects(
    excludeBookkeepingTransaction({ db, businessId: "biz", accountId: "another-account", transactionId: TXN_ID }),
    (error) => error.code === "TRANSACTION_ACCOUNT_MISMATCH" && error.status === 403
  );
  assert.equal(getBookkeepingExclusionEligibility({ status: "needs_review", vendor: null, rule: null, qbo_txn_id: null }).eligible, true);
  assert.equal(getBookkeepingExclusionEligibility({ status: "approved" }).eligible, true);
  assert.equal(getBookkeepingExclusionEligibility({ status: "needs_review", pending: true }).eligible, true);
});

test("repeated authoritative exclusion remains idempotent", async () => {
  const db = dbFixture({ category: { status: "excluded", meta: { excluded_at: "2026-09-25T12:00:00Z" } }, rpcData: { idempotent: true } });
  const first = await excludeBookkeepingTransaction({ db, businessId: "biz", transactionId: TXN_ID });
  const second = await excludeBookkeepingTransaction({ db, businessId: "biz", transactionId: TXN_ID });
  assert.equal(first.idempotent, true);
  assert.equal(second.idempotent, true);
});

test("database failures map to structured 404, 409, and 500 statuses", () => {
  assert.equal(mapTransactionExclusionDatabaseError({ message: "transaction_not_found" }).status, 404);
  assert.equal(mapTransactionExclusionDatabaseError({ message: "posting_in_progress" }).status, 409);
  const schema = mapTransactionExclusionDatabaseError({ code: "23514", message: "transaction_categorizations_status_check" }, "corr-1");
  assert.equal(schema.status, 500);
  assert.equal(schema.code, "EXCLUSION_SCHEMA_NOT_READY");
  assert.equal(schema.details.correlationId, "corr-1");
});

test("migration permits Excluded and endpoint returns canonical structured errors", () => {
  const migration = readFileSync(new URL("../supabase/migrations/20261023_exclusion_status_constraint.sql", import.meta.url), "utf8");
  const route = readFileSync(new URL("../src/api/bookkeeping/routes/bookkeeping.exclusions.routes.js", import.meta.url), "utf8");
  const feedService = readFileSync(new URL("../src/services/bookkeeping/bookkeepingTransactionFeedService.js", import.meta.url), "utf8");
  assert.match(migration, /'excluded'/);
  assert.match(route, /error:\s*\{ code: err\.code, message: err\.message, correlationId:/);
  assert.match(feedService, /transactionId:\s*row\.id/);
});
