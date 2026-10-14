import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  filterPlaidSyncEventsForEligibleAccounts,
  isPlaidAccountSyncEligible,
  projectPlaidAccountConnectionState,
  sortPlaidAccountsByConnectionState,
  summarizePlaidInstitutionConnection,
} from "../src/services/plaid/plaidAccountConnectionState.js";

test("projects intentional disconnect separately from repair-required state", () => {
  assert.equal(projectPlaidAccountConnectionState({ account: { is_active: true }, item: { is_active: true, status: "reauth_required" } }), "attention_required");
  assert.equal(projectPlaidAccountConnectionState({ account: { is_active: false, disconnected_at: "2026-10-14T00:00:00Z" }, item: { is_active: true, status: "connected" } }), "disconnected");
  assert.equal(projectPlaidAccountConnectionState({ account: { connection_state: "closed_historical" }, item: { is_active: true, status: "error" } }), "closed_historical");
  assert.equal(isPlaidAccountSyncEligible({ account: { is_active: false }, item: { is_active: true, status: "connected" } }), false);
});

test("filters only the disconnected sibling while preserving Item cursor payload order", () => {
  const result = filterPlaidSyncEventsForEligibleAccounts([
    { transaction_id: "a", account_id: "checking" },
    { transaction_id: "b", account_id: "card" },
    { transaction_id: "c", account_id: "checking" },
  ], new Set(["card"]));
  assert.deepEqual(result.eligible.map((row) => row.transaction_id), ["a", "c"]);
  assert.equal(result.skippedByAccount.get("card"), 1);
});

test("sorts active before attention and historical accounts while preserving order within a state", () => {
  const result = sortPlaidAccountsByConnectionState([
    { id: "d", connection_state: "disconnected" },
    { id: "c2", connection_state: "connected" },
    { id: "c1", connection_state: "connected" },
    { id: "a", connection_state: "attention_required" },
  ]);
  assert.deepEqual(result.map((row) => row.id), ["c2", "c1", "a", "d"]);
  assert.deepEqual(summarizePlaidInstitutionConnection(result), { state: "attention_required", syncing: 2, total: 4 });
});

test("Books Review retains inactive accounts and posting eligibility does not depend on Plaid activity", () => {
  const accountsRoute = fs.readFileSync("src/api/bookkeeping/routes/bookkeeping.accounts.routes.js", "utf8");
  const posting = fs.readFileSync("src/services/bookkeeping/postingEligibilityRecheckService.js", "utf8");
  assert.doesNotMatch(accountsRoute, /\.eq\("is_active", true\)/);
  assert.match(accountsRoute, /connection_state/);
  assert.doesNotMatch(posting, /sourceItem\.is_active === false/);
  assert.match(posting, /independently validated QBO mapping/);
});

test("account state routes are tenant-derived, rate limited, and do not call Plaid", () => {
  const routes = fs.readFileSync("src/api/integrations/plaid.routes.js", "utf8");
  assert.match(routes, /accounts\/:plaidAccountId\/disconnect.*plaidMutationRateLimit.*primaryOwner.*providerDisconnect/s);
  assert.match(routes, /accounts\/:plaidAccountId\/reconnect.*plaidMutationRateLimit.*primaryOwner.*integrationAdmin/s);
  assert.match(routes, /provider_called: false/);
  assert.match(routes, /const businessId = ensureBusinessId\(req, res\)/);
});

test("migration preserves existing rows and separates audit authority from browser roles", () => {
  const migration = fs.readFileSync("supabase/migrations/20261101111000_plaid_account_connection_state_contract.sql", "utf8");
  assert.match(migration, /default 'connected'/);
  assert.match(migration, /revoke all on public\.plaid_account_connection_audit from anon, authenticated/);
  assert.match(migration, /security definer set search_path = public, pg_temp/);
  assert.match(migration, /plaid_item_relink_required/);
  assert.match(migration, /plaid_account_connection_audit audit[\s\S]*audit\.request_id = p_request_id/);
});

test("reconnect identity never treats a shared mask as authoritative lineage", () => {
  const integration = fs.readFileSync("src/services/plaid/plaidIntegrationService.js", "utf8");
  assert.match(integration, /linked_existing_provider_identity/);
  assert.match(integration, /const needsConfirmation = identity\.strong && candidateIds\.length > 0/);
  assert.doesNotMatch(integration, /relink_status: "linked_existing",/);
  assert.match(integration, /provider_identity_changed_requires_confirmation/);
  assert.match(integration, /is_active: physical\.relink_status !== "probable_duplicate_requires_confirmation"/);
});
