import test from "node:test";
import assert from "node:assert/strict";

import { reconsiderNeedsReviewTransactions } from "../src/services/bookkeeping/routineExpenseReconsiderationService.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
const REALM_ID = "realm-1";

function makeQbo(accounts = []) {
  const state = { findCount: 0, createCount: 0 };
  const qbo = {
    findAccounts(_query, cb) {
      state.findCount += 1;
      cb(null, {
        QueryResponse: {
          Account: accounts.map((account) => ({
            Id: account.id,
            Name: account.name,
            AccountType: account.type || "Expense",
            AccountSubType: account.subType || null,
            Active: account.active !== false,
            SyncToken: "0",
          })),
        },
      });
    },
    account: {
      create(_payload, cb) {
        state.createCount += 1;
        cb(new Error("create_should_not_be_called"));
      },
    },
  };
  return { qbo, state };
}

function makeDb() {
  const rows = {
    business_profiles: [{ id: BUSINESS_ID, bookkeeping_start_date: "2026-01-01", auto_post_to_quickbooks: false }],
    transaction_categorizations: [],
    bank_transactions: [],
    business_canonical_qbo_account_mappings: [],
    qbo_accounts_cache: [],
    qbo_account_mapping_events: [],
    qbo_account_creation_intents: [],
  };
  return {
    rows,
    from(table) {
      return new Query(rows, table);
    },
    async rpc() {
      throw new Error("rpc_should_not_be_called");
    },
  };
}

class Query {
  constructor(rows, table) {
    this.rowsByTable = rows;
    this.table = table;
    this.filters = [];
    this.inFilters = [];
    this.nullFilters = [];
    this.gtFilters = [];
    this.gteFilters = [];
    this.lteFilters = [];
    this.orderBy = null;
    this.limitCount = null;
    this.patch = null;
    this.upsertRows = null;
  }
  select() { return this; }
  order(column, options = {}) {
    this.orderBy = { column, ascending: options.ascending !== false };
    return this;
  }
  limit(n) {
    this.limitCount = Number(n);
    return this;
  }
  eq(column, value) {
    this.filters.push({ column, value });
    return this;
  }
  in(column, values) {
    this.inFilters.push({ column, values });
    return this;
  }
  is(column, value) {
    this.nullFilters.push({ column, value });
    return this;
  }
  gt(column, value) {
    this.gtFilters.push({ column, value });
    return this;
  }
  gte(column, value) {
    this.gteFilters.push({ column, value });
    return this;
  }
  lte(column, value) {
    this.lteFilters.push({ column, value });
    return this;
  }
  update(patch) {
    this.patch = patch;
    return this;
  }
  insert(rows) {
    const list = Array.isArray(rows) ? rows : [rows];
    this.rowsByTable[this.table].push(...list.map((row) => ({ ...row })));
    return Promise.resolve({ data: list, error: null });
  }
  upsert(rows) {
    this.upsertRows = Array.isArray(rows) ? rows : [rows];
    const keyFor = (row) => {
      if (this.table === "transaction_categorizations") return `${row.business_id}|${row.transaction_id}`;
      if (this.table === "business_canonical_qbo_account_mappings") return `${row.business_id}|${row.qbo_env}|${row.realm_id}|${row.canonical_account_key}`;
      if (this.table === "qbo_accounts_cache") return `${row.business_id}|${row.qbo_env}|${row.realm_id}|${row.qbo_account_id}`;
      return JSON.stringify(row);
    };
    for (const row of this.upsertRows) {
      const existing = this.rowsByTable[this.table].find((item) => keyFor(item) === keyFor(row));
      if (existing) Object.assign(existing, row);
      else this.rowsByTable[this.table].push({ ...row });
    }
    return this;
  }
  maybeSingle() {
    return Promise.resolve({ data: this.resultRows()[0] || null, error: null });
  }
  then(resolve, reject) {
    try {
      if (this.patch) {
        const rows = this.resultRows();
        rows.forEach((row) => Object.assign(row, this.patch));
        resolve({ data: rows, error: null });
        return;
      }
      resolve({ data: this.resultRows(), error: null });
    } catch (error) {
      if (reject) reject(error);
    }
  }
  resultRows() {
    let out = [...(this.rowsByTable[this.table] || [])].filter((row) => {
      const eqOk = this.filters.every((filter) => row[filter.column] === filter.value);
      const inOk = this.inFilters.every((filter) => filter.values.includes(row[filter.column]));
      const nullOk = this.nullFilters.every((filter) => row[filter.column] === filter.value);
      const gtOk = this.gtFilters.every((filter) => String(row[filter.column]) > String(filter.value));
      const gteOk = this.gteFilters.every((filter) => String(row[filter.column]) >= String(filter.value));
      const lteOk = this.lteFilters.every((filter) => String(row[filter.column]) <= String(filter.value));
      return eqOk && inOk && nullOk && gtOk && gteOk && lteOk;
    });
    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      out.sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (ascending ? 1 : -1));
    }
    if (Number.isFinite(this.limitCount)) out = out.slice(0, this.limitCount);
    return out;
  }
}

function deps(db, qbo) {
  return {
    supabase: db,
    getQBOClient: async () => qbo,
    getLatestQuickBooksTokenRow: async () => ({ realm_id: REALM_ID, qbo_env: "production" }),
  };
}

function addMapping(db, overrides = {}) {
  db.rows.business_canonical_qbo_account_mappings.push({
    business_id: BUSINESS_ID,
    realm_id: REALM_ID,
    qbo_env: "production",
    canonical_account_key: "software",
    qbo_account_id: "software-current",
    qbo_account_name: "Software",
    qbo_account_type: "Expense",
    qbo_account_subtype: "DuesSubscriptions",
    status: "existing_exact",
    ...overrides,
  });
}

function addRoutineRow(db, id, overrides = {}) {
  db.rows.bank_transactions.push({
    id,
    business_id: BUSINESS_ID,
    date: "2026-08-01",
    name: "APPLE.COM/BILL",
    merchant_name: "Apple",
    merchant_entity_id: `ent-${id}`,
    amount: -12.99,
    signed_amount: -12.99,
    direction: "OUTFLOW",
    pending: false,
    accounting_review_required: false,
    is_archived: false,
    canonical_vendor_id: `vendor-${id}`,
    ...overrides.bankTxn,
  });
  db.rows.transaction_categorizations.push({
    business_id: BUSINESS_ID,
    transaction_id: id,
    status: "needs_review",
    suggested_qbo_account_id: "old-subscriptions",
    suggested_qbo_account_name: "Subscriptions",
    suggested_canonical_account_key: "software",
    confidence: "medium",
    meta: { suggestion_source: "universal_hint", universal_hint: { canonical_account_key: "software" } },
    qbo_txn_id: null,
    ...overrides.cat,
  });
}

test("backlog reconsideration drains three batches through cursor continuation", async () => {
  const db = makeDb();
  const { qbo, state } = makeQbo([{ id: "software-current", name: "Software", type: "Expense", subType: "DuesSubscriptions" }]);
  addMapping(db);
  for (let i = 1; i <= 7; i += 1) addRoutineRow(db, `txn-${String(i).padStart(2, "0")}`);

  let cursor = null;
  let promoted = 0;
  for (let i = 0; i < 4; i += 1) {
    const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, {
      db,
      limit: 2,
      cursor,
      range: "all",
      dependencies: deps(db, qbo),
    });
    promoted += result.promoted;
    cursor = result.next_cursor;
    if (!cursor) break;
  }

  assert.equal(promoted, 7);
  assert.equal(cursor, null);
  assert.equal(state.createCount, 0);
  assert.equal(db.rows.transaction_categorizations.every((row) => row.status === "auto_approved"), true);
});

test("backlog reconsideration is idempotent and skips already promoted rows", async () => {
  const db = makeDb();
  const { qbo } = makeQbo([{ id: "software-current", name: "Software", type: "Expense", subType: "DuesSubscriptions" }]);
  addMapping(db);
  addRoutineRow(db, "txn-01");

  const first = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
  const second = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });

  assert.equal(first.promoted, 1);
  assert.equal(second.promoted, 0);
  assert.equal(db.rows.transaction_categorizations.length, 1);
});

test("old stale suggestion is replaced by current canonical COA mapping before promotion", async () => {
  const db = makeDb();
  const { qbo } = makeQbo([{ id: "software-current", name: "Software", type: "Expense", subType: "DuesSubscriptions" }]);
  addMapping(db);
  addRoutineRow(db, "txn-01");

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
  const row = db.rows.transaction_categorizations[0];

  assert.equal(result.promoted, 1);
  assert.equal(row.final_qbo_account_id, "software-current");
  assert.equal(row.final_qbo_account_name, "Software");
  assert.equal(row.suggested_qbo_account_name, "Software");
  assert.equal(row.post_after, null);
});

test("unresolved or inactive canonical COA mapping remains Needs Review with reason", async () => {
  const db = makeDb();
  const { qbo } = makeQbo([{ id: "software-current", name: "Software", type: "Expense", subType: "DuesSubscriptions", active: false }]);
  addMapping(db);
  addRoutineRow(db, "txn-01");

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
  const row = db.rows.transaction_categorizations[0];

  assert.equal(result.promoted, 0);
  assert.equal(row.status, "needs_review");
  assert.equal(row.final_qbo_account_id, null);
  assert.equal(row.meta.canonical_coa_resolved, false);
  assert.equal(row.meta.auto_handle_decision.eligible, false);
});

test("account/date/business filters are enforced across cursor batches", async () => {
  const db = makeDb();
  const { qbo } = makeQbo([{ id: "software-current", name: "Software", type: "Expense", subType: "DuesSubscriptions" }]);
  addMapping(db);
  addRoutineRow(db, "txn-01", { bankTxn: { plaid_account_id: "acct-a", date: "2026-08-02" } });
  addRoutineRow(db, "txn-02", { bankTxn: { plaid_account_id: "acct-b", date: "2026-08-02" } });
  addRoutineRow(db, "txn-03", { bankTxn: { plaid_account_id: "acct-a", date: "2026-07-01" } });
  db.rows.bank_transactions.push({
    id: "other-01",
    business_id: OTHER_BUSINESS_ID,
    date: "2026-08-02",
    plaid_account_id: "acct-a",
    direction: "OUTFLOW",
    amount: -5,
    pending: false,
    is_archived: false,
  });
  db.rows.transaction_categorizations.push({
    business_id: OTHER_BUSINESS_ID,
    transaction_id: "other-01",
    status: "needs_review",
    suggested_canonical_account_key: "software",
    suggested_qbo_account_id: "software-current",
    suggested_qbo_account_name: "Software",
    qbo_txn_id: null,
    meta: {},
  });

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, {
    db,
    accountId: "acct-a",
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    limit: 2,
    dependencies: deps(db, qbo),
  });

  assert.equal(result.promoted, 1);
  assert.equal(db.rows.transaction_categorizations.find((row) => row.transaction_id === "txn-01").status, "auto_approved");
  assert.equal(db.rows.transaction_categorizations.find((row) => row.transaction_id === "txn-02").status, "needs_review");
  assert.equal(db.rows.transaction_categorizations.find((row) => row.transaction_id === "txn-03").status, "needs_review");
  assert.equal(db.rows.transaction_categorizations.find((row) => row.transaction_id === "other-01").status, "needs_review");
});

test("transactionIds option scopes reconsideration to explicit worker requests", async () => {
  const db = makeDb();
  const { qbo } = makeQbo([{ id: "software-current", name: "Software", type: "Expense", subType: "DuesSubscriptions" }]);
  addMapping(db);
  addRoutineRow(db, "txn-01");
  addRoutineRow(db, "txn-02");

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, {
    db,
    range: "all",
    transactionIds: ["txn-02"],
    dependencies: deps(db, qbo),
  });

  assert.equal(result.promoted, 1);
  assert.equal(result.next_cursor, null);
  assert.equal(db.rows.transaction_categorizations.find((row) => row.transaction_id === "txn-01").status, "needs_review");
  assert.equal(db.rows.transaction_categorizations.find((row) => row.transaction_id === "txn-02").status, "auto_approved");
});
