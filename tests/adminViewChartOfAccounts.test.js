/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { build } from "esbuild";
import { create, act } from "react-test-renderer";
import { useBookkeepingChartOfAccounts } from "../src/hooks/bookkeeping/useBookkeepingChartOfAccounts.js";

process.env.SUPABASE_URL = "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "local-test-only";
process.env.QB_PROD_CLIENT_ID = "local-test-only";
process.env.QB_PROD_CLIENT_SECRET = "local-test-only";
process.env.QB_PROD_REDIRECT_URI = "http://127.0.0.1/test";
const { readBookkeepingChartOfAccounts } = await import("../src/services/bookkeeping/bookkeepingChartOfAccounts.js");
const { createChartOfAccountsHandler } = await import("../src/api/bookkeeping/routes/bookkeeping.accounts.routes.js");

function database({ active = true, failure = false, realm = "realm-a" } = {}) {
  const calls = [];
  const tables = {
    internal_staff_users: [{ user_id: "staff", role: "owner_admin", active }],
    business_profiles: [{ id: "a", user_id: "customer" }, { id: "b", user_id: "other" }],
    quickbooks_tokens: [
      { business_id: "a", realm_id: realm, qbo_env: "production", is_active: true, status: "active" },
      { business_id: "b", realm_id: "realm-b", qbo_env: "production", is_active: true, status: "active" },
    ],
    qbo_accounts_cache: [
      { business_id: "a", realm_id: "realm-a", qbo_env: "production", qbo_account_id: "11", name: "Subscriptions", account_type: "Expense", account_subtype: "DuesSubscriptions", active: true, raw: { Id: "wrong", AccountType: "wrong" } },
      { business_id: "b", realm_id: "realm-b", qbo_env: "production", qbo_account_id: "22", name: "Supplies", account_type: "Expense", active: true },
      { business_id: "a", realm_id: "old-realm", qbo_env: "production", qbo_account_id: "33", name: "Wrong company", account_type: "Expense", active: true },
      { business_id: "a", realm_id: "realm-a", qbo_env: "sandbox", qbo_account_id: "44", name: "Wrong environment", account_type: "Expense", active: true },
      { business_id: "a", realm_id: "realm-a", qbo_env: "production", qbo_account_id: "55", name: "Inactive", account_type: "Expense", active: false },
    ],
  };
  return { calls, from(table) {
    const filters = {}; let from = 0, to = Infinity;
    const result = () => ({ data: (tables[table] || []).filter(row => Object.entries(filters).every(([key, value]) => row[key] === value)).slice(from, to + 1), error: failure && table === "qbo_accounts_cache" ? { message: "db unavailable" } : null });
    const query = { select() { return query; }, eq(key, value) { filters[key] = value; return query; }, order() { return query; }, limit() { return query; }, range(a, b) { from = a; to = b; return query; }, maybeSingle() { const r = result(); return Promise.resolve({ ...r, data: r.data[0] || null }); }, then(resolve, reject) { calls.push({ table, filters }); return Promise.resolve(result()).then(resolve, reject); } };
    return query;
  } };
}
function admin(businessId = "a", overrides = {}) {
  return { auth: { userId: "staff" }, business: { id: businessId }, query: {}, tenantContext: {
    mode: "admin_view", businessId, staffUserId: "staff", adminViewSessionId: "verified-session",
    expiresAt: new Date(Date.now() + 60000).toISOString(), capabilities: ["admin_bookkeeping_write"], ...overrides,
  } };
}
async function request(req, db, readAccounts = args => readBookkeepingChartOfAccounts({ ...args, environment: "production", provider: () => { throw Error("provider must not run"); } })) {
  const res = { statusCode: 200, set() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await createChartOfAccountsHandler({ db, readAccounts })(req, res);
  return res;
}

test("customer and verified Admin View share authoritative accounts, types, subtype and real QBO ID", async () => {
  const db = database();
  const customer = await request({ auth: { userId: "customer", businessId: "a" }, query: {} }, db);
  const staff = await request(admin(), db);
  assert.equal(customer.statusCode, 200); assert.equal(staff.statusCode, 200);
  assert.deepEqual(staff.body.accounts, customer.body.accounts);
  assert.equal(staff.body.accounts.length, 1);
  assert.deepEqual([staff.body.accounts[0].id, staff.body.accounts[0].type, staff.body.accounts[0].subType, staff.body.accounts[0].active], ["11", "Expense", "DuesSubscriptions", true]);
});
test("target is server-verified context; realms, environments and businesses never leak", async () => {
  const db = database(); const req = admin("b"); req.business.id = "a"; req.query.business_id = "a";
  const result = await request(req, db);
  assert.equal(result.body.meta.business_id, "b"); assert.equal(result.body.meta.realm_id, "realm-b");
  assert.deepEqual(result.body.accounts.map(a => a.id), ["22"]);
  const reconnected = await request(admin(), database({ realm: "new-company" }));
  assert.equal(reconnected.statusCode, 503); // No previous company's cached accounts.
});
test("ordinary customers/owners cannot spoof Admin View; expired/missing/invalid authority and deactivated staff fail closed", async () => {
  for (const req of [
    { auth: { userId: "customer", businessId: "a", adminViewRequested: true }, query: {} },
    { ...admin(), auth: { userId: "customer" } },
    admin("a", { expiresAt: "2000-01-01" }), admin("a", { adminViewSessionId: null }),
    admin("a", { capabilities: [] }),
  ]) assert.equal((await request(req, database())).statusCode, 403);
  assert.equal((await request(admin(), database({ active: false }))).statusCode, 403);
  assert.equal((await request({ auth: { userId: "customer", businessId: "b" }, query: {} }, database())).statusCode, 403);
});
test("Admin View never refreshes QBO; cache errors are retryable failures without fallback", async () => {
  const req = admin(); req.query.refresh = "true";
  assert.equal((await request(req, database())).statusCode, 403);
  const result = await request(admin(), database({ failure: true }));
  assert.equal(result.statusCode, 503); assert.equal(result.body.error, "coa_unavailable");
  assert.equal(result.body.accounts, undefined);
});

test("hook disables categorization on failures and ignores obsolete responses across businesses/access sessions", async () => {
  let hook; let rejectA, resolveA;
  const load = id => id === "a" ? new Promise((resolve, reject) => { resolveA = resolve; rejectA = reject; }) : Promise.resolve({ ok: true, accounts: [{ id: "22" }], meta: { realm_id: "realm-b" } });
  function Harness(props) { hook = useBookkeepingChartOfAccounts({ ...props, load }); return null; }
  let renderer;
  await act(async () => { renderer = create(React.createElement(Harness, { businessId: "a" })); });
  await act(async () => { void hook.reload(); });
  await act(async () => { rejectA(Error("401")); });
  assert.equal(hook.ready, false); assert.deepEqual(hook.accounts, []); assert.match(hook.error, /Retry/);
  await act(async () => { void hook.reload(); });
  await act(async () => { renderer.update(React.createElement(Harness, { businessId: "b", accessScope: "verified-admin-b" })); });
  assert.deepEqual(hook.accounts, []); assert.equal(hook.ready, false);
  await act(async () => { await hook.reload(); });
  await act(async () => { resolveA({ accounts: [{ id: "11" }] }); });
  assert.deepEqual(hook.accounts.map(a => a.id), ["22"]);
  await act(async () => { renderer.unmount(); });
});
test("UI never synthesizes final categories; approval persists the selected canonical QBO ID", () => {
  const page = readFileSync("src/pages/accounting/BookkeepingCleanup.jsx", "utf8");
  const feed = readFileSync("src/components/Accounting/BookkeepingFeed.jsx", "utf8");
  assert.doesNotMatch(page, /derivePersistedChartAccountsFromTransactions|persisted:/);
  assert.match(page, /load: fetchQboCoa/); assert.match(page, /categorizationDisabled=\{!coaReady\}/);
  assert.match(page, /if \(!glAccount\) return/);
  assert.match(page, /newAccountId: glAccountId/);
  assert.match(feed, /handleAccountSelect\(txn.id, id\)/);
  assert.match(feed, /isApproving \|\|\s+categorizationDisabled/);
});

test("canonical account selection reaches the unchanged categorization client as an ID, never a label", async () => {
  const bundled = await build({ entryPoints: ["src/services/bookkeeping/bookkeepingClient.js"], bundle: true,
    write: false, platform: "node", format: "esm", plugins: [{ name: "capture-http", setup(builder) {
      builder.onResolve({ filter: /utils\/safeFetch$/ }, () => ({ path: "capture-http", namespace: "capture-http" }));
      builder.onLoad({ filter: /.*/, namespace: "capture-http" }, () => ({ contents: `
        export const apiUrl = path => path;
        export async function safeFetch(path, options) { globalThis.__coaTestRequest = {path,options}; return {ok:true}; }
      ` }));
    } }] });
  const client = await import(`data:text/javascript,${encodeURIComponent(bundled.outputFiles[0].text)}`);
  const catalog = await request(admin(), database());
  const selected = catalog.body.accounts[0];
  await client.approveTransactions("a", [{ txnId: "txn", resolution: "categorize_new", newAccountId: selected.id, newAccountName: selected.name, newAccountType: selected.type }]);
  // The same client is used by both sessions; preserve its ID payload contract.
  const captured = globalThis.__coaTestRequest;
  delete globalThis.__coaTestRequest;
  assert.equal(captured.path, "/api/bookkeeping/approve");
  assert.equal(JSON.parse(captured.options.body).items[0].newAccountId, "11");
  assert.equal(JSON.parse(captured.options.body).items[0].newAccountName, "Subscriptions");
  assert.equal(captured.options.headers.get("x-business-id"), "a");
});
