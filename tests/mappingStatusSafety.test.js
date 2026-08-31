import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

test("mapping-status route is business scoped and does not call QBO posting", () => {
  const route = read("src/api/bookkeeping/routes/bookkeeping.mappingStatus.routes.js");

  assert.match(route, /router\.get\("\/mapping-status", requireAuth/);
  assert.match(route, /ensureBusinessId\(req, res\)/);
  assert.match(route, /assertTaxBusinessAccess\(\{ req, businessId, supabase \}\)/);
  assert.match(route, /\.eq\("business_id", businessId\)/);
  assert.doesNotMatch(route, /postToQbo|runBooksPostOnce|postSingleBookkeepingTransactionNow|createPurchase|createDeposit|createCreditCardCharge/);
});

test("mapping-status succeeds with large scheduled handled datasets by batching IN queries", async () => {
  const { fetchMappingStatus } = await import("../src/api/bookkeeping/routes/bookkeeping.mappingStatus.routes.js");
  const txns = Array.from({ length: 125 }, (_, i) => `txn-${i + 1}`);
  const db = makeSupabase(
    {
      transaction_categorizations: txns.map((id) => ({
        business_id: "biz-1",
        transaction_id: id,
        status: "auto_approved",
        post_after: "2026-08-31T12:00:00.000Z",
        qbo_txn_id: null,
      })),
      bank_transactions: txns.map((id, i) => ({
        id,
        business_id: "biz-1",
        plaid_account_id: `plaid-${(i % 3) + 1}`,
        is_archived: false,
        date: "2026-08-31",
      })),
      plaid_qbo_account_mappings: [
        { business_id: "biz-1", plaid_account_id: "plaid-1", source: "manual" },
        { business_id: "biz-1", plaid_account_id: "plaid-2", source: "manual" },
        { business_id: "biz-1", plaid_account_id: "plaid-3", source: "manual" },
      ],
      plaid_accounts: [
        { business_id: "biz-1", plaid_account_id: "plaid-1", type: "depository", subtype: "checking" },
        { business_id: "biz-1", plaid_account_id: "plaid-2", type: "credit", subtype: "credit card" },
        { business_id: "biz-1", plaid_account_id: "plaid-3", type: "depository", subtype: "savings" },
      ],
    },
    { failOversizedIn: true, maxInValues: 50 }
  );

  const result = await fetchMappingStatus({
    db,
    businessId: "biz-1",
    bookkeepingStartDate: "2026-01-01",
    nowIso: "2026-08-31T12:00:00.000Z",
    allowAutoMap: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.needs_mapping, false);
  assert.equal(result.affected_txn_count, 0);
  assert.ok(db.calls.some((call) => call.table === "bank_transactions" && call.op === "in" && call.valuesLength <= 50));
  assert.equal(db.calls.some((call) => call.op === "oversized_in_throw"), false);
});

test("mapping-status reports unmapped postable Plaid accounts without reading other businesses", async () => {
  const { fetchMappingStatus } = await import("../src/api/bookkeeping/routes/bookkeeping.mappingStatus.routes.js");
  const db = makeSupabase({
    transaction_categorizations: [
      { business_id: "biz-1", transaction_id: "txn-1", status: "approved", post_after: "2026-08-31T12:00:00.000Z", qbo_txn_id: null },
      { business_id: "biz-2", transaction_id: "txn-other", status: "approved", post_after: "2026-08-31T12:00:00.000Z", qbo_txn_id: null },
    ],
    bank_transactions: [
      { id: "txn-1", business_id: "biz-1", plaid_account_id: "plaid-unmapped", is_archived: false, date: "2026-08-31" },
      { id: "txn-other", business_id: "biz-2", plaid_account_id: "plaid-other", is_archived: false, date: "2026-08-31" },
    ],
    plaid_qbo_account_mappings: [
      { business_id: "biz-2", plaid_account_id: "plaid-other", source: "manual" },
    ],
    plaid_accounts: [
      { business_id: "biz-1", plaid_account_id: "plaid-unmapped", type: "depository", subtype: "checking" },
      { business_id: "biz-2", plaid_account_id: "plaid-other", type: "depository", subtype: "checking" },
    ],
  });

  const result = await fetchMappingStatus({
    db,
    businessId: "biz-1",
    bookkeepingStartDate: "2026-01-01",
    nowIso: "2026-08-31T12:00:00.000Z",
    allowAutoMap: false,
  });

  assert.deepEqual(result.unmapped_plaid_account_ids, ["plaid-unmapped"]);
  assert.equal(result.unmapped_account_count, 1);
  assert.equal(result.affected_txn_count, 1);
  assert.equal(db.calls.every((call) => call.businessId === undefined || call.businessId === "biz-1"), true);
});

test("mapping-status source batches optional mapping reads and degrades QBO auto-mapping", () => {
  const route = read("src/api/bookkeeping/routes/bookkeeping.mappingStatus.routes.js");

  assert.match(route, /POSTGREST_IN_BATCH_SIZE = 50/);
  assert.match(route, /for \(const ids of chunk\(txnIds\)\)/);
  assert.match(route, /for \(const ids of chunk\(plaidIds\)\)/);
  assert.match(route, /for \(const batch of chunk\(rows\)\)/);
  assert.match(route, /auto-mapping degraded/);
  assert.match(route, /fetchChartOfAccountsForAutoMapping\(businessId\)/);
});

function makeSupabase(tables = {}, options = {}) {
  const state = Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]));
  const calls = [];
  return {
    calls,
    from(table) {
      return new Query(state, table, calls, options);
    },
  };
}

class Query {
  constructor(state, table, calls, options) {
    this.state = state;
    this.table = table;
    this.calls = calls;
    this.options = options;
    this.rows = [...(state[table] || [])];
    this.patch = null;
  }
  select() {
    this.calls.push({ table: this.table, op: "select" });
    return this;
  }
  update(patch) {
    this.patch = { ...(patch || {}) };
    this.calls.push({ table: this.table, op: "update" });
    return this;
  }
  upsert(rows) {
    this.calls.push({ table: this.table, op: "upsert", count: rows?.length || 0 });
    const existing = this.state[this.table] || [];
    for (const row of rows || []) {
      const found = existing.find((item) => item.business_id === row.business_id && item.plaid_account_id === row.plaid_account_id);
      if (found) Object.assign(found, row);
      else existing.push({ ...row });
    }
    this.state[this.table] = existing;
    return Promise.resolve({ data: rows || [], error: null });
  }
  eq(field, value) {
    if (field === "business_id") this.calls.push({ table: this.table, op: "business_scope", businessId: value });
    this.rows = this.rows.filter((row) => row[field] === value);
    return this;
  }
  neq(field, value) {
    this.rows = this.rows.filter((row) => row[field] !== value);
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
  lte(field, value) {
    this.rows = this.rows.filter((row) => String(row[field] || "") <= String(value || ""));
    return this;
  }
  gte(field, value) {
    this.rows = this.rows.filter((row) => String(row[field] || "") >= String(value || ""));
    return this;
  }
  in(field, values) {
    this.calls.push({ table: this.table, op: "in", field, valuesLength: values?.length || 0 });
    if (this.options.failOversizedIn && (values?.length || 0) > (this.options.maxInValues || 50)) {
      this.calls.push({ table: this.table, op: "oversized_in_throw", field, valuesLength: values.length });
      throw new TypeError("fetch failed");
    }
    const set = new Set(values || []);
    this.rows = this.rows.filter((row) => set.has(row[field]));
    return this;
  }
  maybeSingle() {
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  then(resolve, reject) {
    return Promise.resolve({ data: this.rows, error: null }).then(resolve, reject);
  }
}
