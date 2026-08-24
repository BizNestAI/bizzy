import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

const bookkeepingAccountsSource = read("src/api/bookkeeping/routes/bookkeeping.accounts.routes.js");
const paymentAccountsSource = read("src/api/bookkeeping/routes/bookkeeping.qboPaymentAccounts.routes.js");
const arControllerSource = read("src/api/ar/ar.controller.js");
const accountMappingsSource = read("src/api/bookkeeping/routes/bookkeeping.accountMappings.routes.js");
const mappingStatusSource = read("src/api/bookkeeping/routes/bookkeeping.mappingStatus.routes.js");

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
const BUSINESS_B = "22222222-2222-4222-8222-222222222222";

test("Admin View QBO COA GET is blocked before live QuickBooks account fetch", () => {
  const routeStart = bookkeepingAccountsSource.indexOf('router.get("/qbo/coa"');
  const adminBranch = bookkeepingAccountsSource.indexOf("if (isAdminViewRequest(req))", routeStart);
  const providerCall = bookkeepingAccountsSource.indexOf("fetchChartOfAccounts(businessId)", routeStart);

  assert.ok(routeStart > 0, "QBO COA GET route must exist");
  assert.ok(adminBranch > routeStart, "QBO COA GET must branch for Admin View");
  assert.ok(providerCall > adminBranch, "Admin View must branch before live QBO COA fetch");
  assert.match(
    bookkeepingAccountsSource.slice(adminBranch, providerCall),
    /admin_view_provider_refresh_blocked/
  );
});

test("Admin View QBO payment accounts GET is blocked before live QuickBooks account fetch", () => {
  const routeStart = paymentAccountsSource.indexOf('router.get("/qbo/payment-accounts"');
  const adminBranch = paymentAccountsSource.indexOf("if (isAdminViewRequest(req))", routeStart);
  const providerCall = paymentAccountsSource.indexOf("fetchPaymentAccounts(businessId)", routeStart);

  assert.ok(routeStart > 0, "QBO payment accounts GET route must exist");
  assert.ok(adminBranch > routeStart, "QBO payment accounts GET must branch for Admin View");
  assert.ok(providerCall > adminBranch, "Admin View must branch before live QBO payment account fetch");
  assert.match(
    paymentAccountsSource.slice(adminBranch, providerCall),
    /admin_view_provider_refresh_blocked/
  );
});

test("Admin View AR invoice detail uses business-scoped persisted open item before QBO fetch", () => {
  const handlerStart = arControllerSource.indexOf("export async function getInvoiceDetailsHandler");
  const adminBranch = arControllerSource.indexOf("if (isAdminViewRequest(req))", handlerStart);
  const providerCall = arControllerSource.indexOf("fetchInvoiceDetails({ businessId, qboInvoiceId })", handlerStart);
  const adminBlock = arControllerSource.slice(adminBranch, providerCall);

  assert.ok(handlerStart > 0, "AR invoice detail handler must exist");
  assert.ok(adminBranch > handlerStart, "AR invoice detail must branch for Admin View");
  assert.ok(providerCall > adminBranch, "Admin View must branch before live QBO invoice detail fetch");
  assert.match(adminBlock, /\.from\("ar_open_items"\)/);
  assert.match(adminBlock, /\.eq\("business_id", businessId\)/);
  assert.match(adminBlock, /\.eq\("qbo_invoice_id", qboInvoiceId\)/);
  assert.match(adminBlock, /admin_view_cache_only: true/);
  assert.doesNotMatch(adminBlock, /fetchInvoiceDetails|fetchInvoiceById|getQBOClient|fetchChartOfAccounts|fetchPaymentAccounts/);
});

test("Admin View account-mappings GET reads persisted mappings before live QBO COA", () => {
  const routeStart = accountMappingsSource.indexOf('router.get("/account-mappings"');
  const adminBranch = accountMappingsSource.indexOf("if (isAdminViewRequest(req))", routeStart);
  const providerCall = accountMappingsSource.indexOf("fetchChartOfAccounts(businessId)", routeStart);

  assert.ok(routeStart > 0, "account-mappings GET route must exist");
  assert.ok(adminBranch > routeStart, "account-mappings GET must branch for Admin View");
  assert.ok(providerCall > adminBranch, "Admin View must branch before live QBO COA fetch");
  assert.match(accountMappingsSource.slice(adminBranch, providerCall), /fetchAdminViewPersistedAccountMappings/);
});

test("Admin View mapping-status GET reads persisted rows before live QBO COA or mapping upsert", () => {
  const routeStart = mappingStatusSource.indexOf('router.get("/mapping-status"');
  const adminBranch = mappingStatusSource.indexOf("if (isAdminViewRequest(req))", routeStart);
  const providerCall = mappingStatusSource.indexOf("fetchChartOfAccounts(businessId)", routeStart);
  const mutationCall = mappingStatusSource.indexOf(".upsert(autoRows", routeStart);

  assert.ok(routeStart > 0, "mapping-status GET route must exist");
  assert.ok(adminBranch > routeStart, "mapping-status GET must branch for Admin View");
  assert.ok(providerCall > adminBranch, "Admin View must branch before live QBO COA fetch");
  assert.ok(mutationCall > adminBranch, "Admin View must branch before mapping auto-upsert");
  assert.match(mappingStatusSource.slice(adminBranch, providerCall), /fetchAdminViewPersistedMappingStatus/);
});

test("Admin View account mapping helpers are runtime cache-only and business scoped", async () => {
  const { fetchAdminViewPersistedAccountMappings } = await import(
    "../src/api/bookkeeping/routes/bookkeeping.accountMappings.routes.js"
  );
  const db = makeFakeSupabase({
    plaid_accounts: [
      { business_id: BUSINESS_A, plaid_account_id: "plaid-a", name: "Checking", type: "depository", subtype: "checking", mask: "1111", is_active: true },
      { business_id: BUSINESS_B, plaid_account_id: "plaid-b", name: "Other", type: "depository", subtype: "checking", mask: "2222", is_active: true },
    ],
    plaid_qbo_account_mappings: [
      { business_id: BUSINESS_A, plaid_account_id: "plaid-a", qbo_account_id: "qbo-a", qbo_account_name: "Checking", qbo_account_type: "Bank" },
      { business_id: BUSINESS_B, plaid_account_id: "plaid-b", qbo_account_id: "qbo-b", qbo_account_name: "Other", qbo_account_type: "Bank" },
    ],
  });

  const result = await fetchAdminViewPersistedAccountMappings({ db, businessId: BUSINESS_A });

  assert.equal(result.ok, true);
  assert.equal(result.admin_view_cache_only, true);
  assert.deepEqual(result.accounts.map((row) => row.plaid_account_id), ["plaid-a"]);
  assert.equal(result.accounts[0].qbo_account_id, "qbo-a");
  assert.equal(db.mutations.length, 0);
});

test("Admin View mapping-status helper is runtime cache-only and never auto-upserts mappings", async () => {
  const { fetchAdminViewPersistedMappingStatus } = await import(
    "../src/api/bookkeeping/routes/bookkeeping.mappingStatus.routes.js"
  );
  const db = makeFakeSupabase({
    transaction_categorizations: [
      {
        business_id: BUSINESS_A,
        transaction_id: "txn-a",
        status: "approved",
        post_after: "2026-08-24T00:00:00.000Z",
        qbo_txn_id: null,
      },
      {
        business_id: BUSINESS_B,
        transaction_id: "txn-b",
        status: "approved",
        post_after: "2026-08-24T00:00:00.000Z",
        qbo_txn_id: null,
      },
    ],
    bank_transactions: [
      { business_id: BUSINESS_A, id: "txn-a", plaid_account_id: "plaid-a", date: "2026-08-24", is_archived: false },
      { business_id: BUSINESS_B, id: "txn-b", plaid_account_id: "plaid-b", date: "2026-08-24", is_archived: false },
    ],
    plaid_qbo_account_mappings: [
      { business_id: BUSINESS_B, plaid_account_id: "plaid-b", source: "manual" },
    ],
    plaid_accounts: [
      { business_id: BUSINESS_A, plaid_account_id: "plaid-a", type: "depository", subtype: "checking" },
      { business_id: BUSINESS_B, plaid_account_id: "plaid-b", type: "depository", subtype: "checking" },
    ],
  });

  const result = await fetchAdminViewPersistedMappingStatus({
    db,
    businessId: BUSINESS_A,
    bookkeepingStartDate: null,
    nowIso: "2026-08-24T12:00:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.admin_view_cache_only, true);
  assert.equal(result.needs_mapping, true);
  assert.deepEqual(result.unmapped_plaid_account_ids, ["plaid-a"]);
  assert.equal(result.affected_txn_count, 1);
  assert.equal(db.mutations.length, 0);
});

function makeFakeSupabase(tables = {}) {
  const mutations = [];
  return {
    mutations,
    from(table) {
      return new FakeQuery(table, tables[table] || [], mutations);
    },
  };
}

class FakeQuery {
  constructor(table, rows, mutations) {
    this.table = table;
    this.rows = [...rows];
    this.mutations = mutations;
  }

  select() {
    return this;
  }

  eq(field, value) {
    this.rows = this.rows.filter((row) => row[field] === value);
    return this;
  }

  neq(field, value) {
    this.rows = this.rows.filter((row) => row[field] !== value);
    return this;
  }

  in(field, values) {
    const allowed = new Set(values || []);
    this.rows = this.rows.filter((row) => allowed.has(row[field]));
    return this;
  }

  not(field, operator, value) {
    if (operator === "is" && value === null) {
      this.rows = this.rows.filter((row) => row[field] !== null && row[field] !== undefined);
    }
    return this;
  }

  is(field, value) {
    this.rows = this.rows.filter((row) => row[field] === value);
    return this;
  }

  insert(payload) {
    this.mutations.push({ table: this.table, op: "insert", payload });
    throw new Error("unexpected insert");
  }

  update(payload) {
    this.mutations.push({ table: this.table, op: "update", payload });
    throw new Error("unexpected update");
  }

  upsert(payload) {
    this.mutations.push({ table: this.table, op: "upsert", payload });
    throw new Error("unexpected upsert");
  }

  delete() {
    this.mutations.push({ table: this.table, op: "delete" });
    throw new Error("unexpected delete");
  }

  then(resolve, reject) {
    return Promise.resolve({ data: this.rows, error: null }).then(resolve, reject);
  }
}
