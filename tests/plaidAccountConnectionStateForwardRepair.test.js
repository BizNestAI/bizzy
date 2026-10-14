import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migrationPath = "supabase/migrations/20261101112000_plaid_account_connection_state_forward_repair.sql";
const migration = fs.readFileSync(migrationPath, "utf8");

const legacyDisconnect = "2026-03-29T02:09:07.679+00:00";

function applyRepair(row, manifest) {
  const listedItem = manifest.get(row.plaid_account_id);
  const eligible = listedItem === row.plaid_item_id
    && row.business_id === "353c9baa-c202-469d-9f4f-90742de6b13a"
    && row.plaid_env === "production"
    && row.connection_state === "connected"
    && row.connection_state_version === 0
    && row.is_active === false
    && row.disconnected_at === legacyDisconnect;

  if (!eligible) return { row, audit: null };
  return {
    row: {
      ...row,
      connection_state: "disconnected",
      connection_state_version: 1,
      disconnect_metadata: {
        ...(row.disconnect_metadata || {}),
        source: "20261101112000_forward_repair",
      },
    },
    audit: {
      previous_state: {
        connection_state: row.connection_state,
        is_active: row.is_active,
        disconnected_at: row.disconnected_at,
        connection_state_version: row.connection_state_version,
      },
      next_state: "disconnected",
      action_type: "legacy_connection_state_repair",
    },
  };
}

function manifestFromSql(sql) {
  const entries = [...sql.matchAll(/\('([^']+)', '([^']+)'\)/g)];
  return new Map(entries.map(([, accountId, itemId]) => [accountId, itemId]));
}

test("forward repair hardens the exact transition RPC authority boundary", () => {
  const original = fs.readFileSync("supabase/migrations/20261101111000_plaid_account_connection_state_contract.sql", "utf8");
  assert.match(original, /create or replace function public\.set_plaid_account_connection_state\([\s\S]*?security definer/s);
  assert.match(migration, /alter function public\.set_plaid_account_connection_state\(uuid, text, text, uuid, text, text, bigint\)\s+set search_path = pg_catalog, public/);
  assert.match(migration, /owner to postgres/);
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function[\s\S]*to service_role/);
});

test("repair is restricted to the classified 24-row manifest and durable evidence", () => {
  const manifest = manifestFromSql(migration);
  assert.equal(manifest.size, 24);
  assert.match(migration, /pa\.business_id = '353c9baa-c202-469d-9f4f-90742de6b13a'::uuid/);
  assert.match(migration, /pa\.plaid_env = 'production'/);
  assert.match(migration, /pa\.connection_state = 'connected'/);
  assert.match(migration, /pa\.connection_state_version = 0/);
  assert.match(migration, /pa\.is_active is false/);
  assert.match(migration, /pa\.disconnected_at = '2026-03-29T02:09:07\.679\+00:00'::timestamptz/);
  assert.match(migration, /for update of pa/);
  assert.doesNotMatch(migration, /closed_historical/);
});

test("active accounts and newer explicit states cannot be overwritten", () => {
  const manifest = manifestFromSql(migration);
  const [accountId, itemId] = manifest.entries().next().value;
  const base = {
    business_id: "353c9baa-c202-469d-9f4f-90742de6b13a",
    plaid_account_id: accountId,
    plaid_item_id: itemId,
    plaid_env: "production",
    disconnected_at: legacyDisconnect,
  };
  const active = { ...base, connection_state: "connected", connection_state_version: 0, is_active: true };
  const newer = { ...base, connection_state: "attention_required", connection_state_version: 4, is_active: false };
  assert.strictEqual(applyRepair(active, manifest).row, active);
  assert.strictEqual(applyRepair(newer, manifest).row, newer);
});

test("eligible legacy rows retain bookkeeping identity, mapping, auto-post and history", () => {
  const manifest = manifestFromSql(migration);
  const [accountId, itemId] = manifest.entries().next().value;
  const original = {
    business_id: "353c9baa-c202-469d-9f4f-90742de6b13a",
    plaid_account_id: accountId,
    plaid_item_id: itemId,
    plaid_env: "production",
    connection_state: "connected",
    connection_state_version: 0,
    is_active: false,
    disconnected_at: legacyDisconnect,
    account_id: "durable-account-identity",
    qbo_account_id: "35",
    auto_post_enabled: true,
    historical_transaction_ids: ["txn-1"],
  };
  const result = applyRepair(original, manifest);
  assert.equal(result.row.connection_state, "disconnected");
  assert.equal(result.row.connection_state_version, 1);
  assert.equal(result.row.disconnected_at, original.disconnected_at);
  assert.equal(result.row.account_id, original.account_id);
  assert.equal(result.row.qbo_account_id, original.qbo_account_id);
  assert.equal(result.row.auto_post_enabled, original.auto_post_enabled);
  assert.deepEqual(result.row.historical_transaction_ids, original.historical_transaction_ids);
  assert.deepEqual(result.audit.previous_state, {
    connection_state: "connected",
    is_active: false,
    disconnected_at: legacyDisconnect,
    connection_state_version: 0,
  });
});

test("a second application is a no-op and the migration never invokes sync or posting", () => {
  const manifest = manifestFromSql(migration);
  const [accountId, itemId] = manifest.entries().next().value;
  const original = {
    business_id: "353c9baa-c202-469d-9f4f-90742de6b13a",
    plaid_account_id: accountId,
    plaid_item_id: itemId,
    plaid_env: "production",
    connection_state: "connected",
    connection_state_version: 0,
    is_active: false,
    disconnected_at: legacyDisconnect,
  };
  const first = applyRepair(original, manifest);
  const second = applyRepair(first.row, manifest);
  assert.strictEqual(second.row, first.row);
  assert.equal(second.audit, null);
  assert.doesNotMatch(migration, /plaidClient|transactionsSync|quickbooks|qbo_post|auto_post/i);
});

