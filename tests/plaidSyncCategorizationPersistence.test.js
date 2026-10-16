import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import dotenv from "dotenv";

import {
  isPlaidReauthenticationRequired,
  projectPlaidAccountConnectionState,
  projectPlaidSyncAvailability,
} from "../src/services/plaid/plaidAccountConnectionState.js";

const read = (path) => fs.readFileSync(path, "utf8");
dotenv.config({ path: ".env" });

async function syncService() {
  return import("../src/services/plaid/plaidSyncService.js");
}

test("new and previously persisted transactions use the idempotent categorization authority", async () => {
  const { ensurePlaidTransactionCategorizations } = await syncService();
  const calls = [];
  const db = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: [{ expected_count: 2, categorization_count: 2, inserted_count: 1 }], error: null };
    },
  };
  const result = await ensurePlaidTransactionCategorizations({
    db,
    businessId: "business-a",
    transactionIds: ["txn-existing", "txn-new", "txn-new"],
  });
  assert.equal(result.inserted_count, 1);
  assert.deepEqual(calls, [{
    name: "ensure_plaid_transaction_categorizations",
    args: { p_business_id: "business-a", p_transaction_ids: ["txn-existing", "txn-new"] },
  }]);
});

test("categorization failure is stage-specific and prevents cursor commit", async () => {
  const { classifyPlaidSyncFailure, ensurePlaidTransactionCategorizations } = await syncService();
  const db = { rpc: async () => ({ data: null, error: { code: "23514", message: "sensitive detail" } }) };
  await assert.rejects(
    ensurePlaidTransactionCategorizations({ db, businessId: "business-a", transactionIds: ["txn-new"] }),
    (error) => error.code === "plaid_categorization_persistence_failed" && error.supabase.code === "23514",
  );
  assert.equal(classifyPlaidSyncFailure({ supabase: { code: "23514" } }), "database_persistence_failure");
  const source = read("src/services/plaid/plaidSyncService.js");
  assert.ok(source.indexOf("failureStage = \"categorization_persistence\"") < source.indexOf("failureStage = \"cursor_commit\""));
  assert.ok(source.indexOf("await ensurePlaidTransactionCategorizations") < source.indexOf(".update({\n        cursor,"));
  assert.match(source, /source_error_code: safeDiagnosticCode\(error\)/);
  const failureMeta = source.slice(
    source.indexOf("meta: {", source.indexOf("catch (error)")),
    source.indexOf("} finally {", source.indexOf("catch (error)")),
  );
  assert.doesNotMatch(failureMeta, /error\.message/);
});

test("provider reauthentication is distinct from retryable internal synchronization failure", async () => {
  const { classifyPlaidSyncFailure } = await syncService();
  const internal = { status: "connected", is_active: true, error_code: "transaction_sync_failed" };
  assert.equal(isPlaidReauthenticationRequired(internal), false);
  assert.equal(projectPlaidAccountConnectionState({ account: { is_active: true }, item: internal }), "connected");
  assert.equal(projectPlaidSyncAvailability(internal), "temporarily_unavailable");

  const reauth = { status: "connected", is_active: true, error_code: "ITEM_LOGIN_REQUIRED" };
  assert.equal(isPlaidReauthenticationRequired(reauth), true);
  assert.equal(projectPlaidAccountConnectionState({ account: { is_active: true }, item: reauth }), "attention_required");
  assert.equal(projectPlaidSyncAvailability(reauth), "reauthentication_required");
  assert.equal(classifyPlaidSyncFailure({ response: { data: { error_code: "ITEM_LOGIN_REQUIRED" } } }), "provider_reauthentication_required");
});

test("migration recovers only missing categorizations and preserves existing decisions and posting evidence", () => {
  const migration = read("supabase/migrations/20261101118000_plaid_sync_categorization_persistence.sql");
  assert.match(migration, /on conflict \(business_id, transaction_id\) do nothing/i);
  assert.match(migration, /plaid_categorization_transaction_scope_mismatch/);
  assert.match(migration, /v_after <> v_expected/);
  assert.match(migration, /revoke all.*anon, authenticated/i);
  assert.doesNotMatch(migration, /delete from|qbo_posted_transactions|posting_jobs/i);
});

test("cron synchronizes one selected Item instead of amplifying each Item into a business-wide run", () => {
  const cron = read("src/cron/plaidSync.cron.js");
  assert.match(cron, /runPlaidSyncForItemForBusiness\(item\.business_id, item\.plaid_item_id/);
  assert.doesNotMatch(cron, /runPlaidSyncForBusiness\(item\.business_id/);
});

test("customer surfaces reserve reconnect actions for actual reauthentication", () => {
  const settings = read("src/pages/Settings/SettingsHome.jsx");
  const books = read("src/pages/accounting/BookkeepingCleanup.jsx");
  assert.match(settings, /inst\.sync_health\?\.status === "reauthentication_required"/);
  assert.match(settings, /Sync temporarily unavailable — retrying automatically/);
  assert.match(books, /sync_availability === "temporarily_unavailable"/);
  assert.match(books, /Reconnect in Settings/);
  assert.doesNotMatch(books, /Repair in Settings/);
});
