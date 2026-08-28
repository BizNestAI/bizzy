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
    clarification_requests: [],
    vendor_rules: [],
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
    this.notNullFilters = [];
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
  not(column, op, value) {
    if (op === "is" && value === null) this.notNullFilters.push({ column });
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
    if (this.table === "transaction_categorizations") {
      const missingProvenance = this.upsertRows.find((row) => row.decided_by === null || row.decided_by === undefined || row.decided_by === "");
      if (missingProvenance) {
        throw new Error("null value in column \"decided_by\" of relation \"transaction_categorizations\" violates not-null constraint");
      }
    }
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
      const notNullOk = this.notNullFilters.every((filter) => row[filter.column] !== null && row[filter.column] !== undefined);
      const gtOk = this.gtFilters.every((filter) => String(row[filter.column]) > String(filter.value));
      const gteOk = this.gteFilters.every((filter) => String(row[filter.column]) >= String(filter.value));
      const lteOk = this.lteFilters.every((filter) => String(row[filter.column]) <= String(filter.value));
      return eqOk && inOk && nullOk && notNullOk && gtOk && gteOk && lteOk;
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

test("approval-backed same-business vendor rule promotes stale Needs Review row to auto-approved", async () => {
  const db = makeDb();
  const { qbo, state } = makeQbo([{ id: "transportation-current", name: "Transportation", type: "Expense", subType: "Travel" }]);
  addRoutineRow(db, "txn-park", {
    bankTxn: {
      name: "PARK MOBILE CDOT PAY",
      merchant_name: "Parkmobile",
      merchant_entity_id: "ent-parkmobile",
      amount: -3.12,
      signed_amount: -3.12,
    },
    cat: {
      suggested_qbo_account_id: null,
      suggested_qbo_account_name: null,
      suggested_canonical_account_key: null,
      meta: { suggestion_source: "fallback" },
    },
  });
  db.rows.vendor_rules.push({
    id: "rule-parkmobile",
    business_id: BUSINESS_ID,
    match_type: "merchant_entity_id",
    match_value: "ent-parkmobile",
    counterparty_name: "Parkmobile",
    default_qbo_account_id: "transportation-current",
    default_qbo_account_name: "Transportation",
    direction_hint: "OUTFLOW",
    confidence: "high",
    rule_kind: "category_default",
    usage_count: 1,
  });

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
  const row = db.rows.transaction_categorizations[0];

  assert.equal(result.promoted, 1);
  assert.equal(result.bucket_counts.reviewed, 1);
  assert.equal(result.bucket_counts.moved_to_handled, 1);
  assert.equal(result.bucket_counts.still_needs_review, 0);
  assert.equal(row.status, "auto_approved");
  assert.equal(row.final_qbo_account_id, "transportation-current");
  assert.equal(row.final_qbo_account_name, "Transportation");
  assert.equal(row.meta.evidence_source, "approved_business_rule");
  assert.equal(row.meta.confidence_tier, "very_high");
  assert.equal(row.decided_by, "bizzi");
  assert.ok(row.decided_at);
  assert.equal(row.post_after, null);
  assert.equal(row.qbo_txn_id || null, null);
  assert.equal(state.createCount, 0);
});

test("old Needs Review ParkMobile Transportation row is reconsidered to Parking/Tolls", async () => {
  const db = makeDb();
  const { qbo, state } = makeQbo([{ id: "parking-current", name: "Parking/Tolls", type: "Expense", subType: "ParkingTolls" }]);
  addMapping(db, {
    canonical_account_key: "parking_tolls",
    qbo_account_id: "parking-current",
    qbo_account_name: "Parking/Tolls",
    qbo_account_subtype: "ParkingTolls",
  });
  addRoutineRow(db, "txn-park", {
    bankTxn: {
      name: "PARK MOBILE CDOT PAY",
      merchant_name: "Parkmobile",
      merchant_entity_id: "ent-parkmobile",
      amount: -3.12,
      signed_amount: -3.12,
    },
    cat: {
      suggested_qbo_account_id: "transportation-old",
      suggested_qbo_account_name: "Transportation",
      suggested_canonical_account_key: "transportation",
      meta: { suggestion_source: "plaid_baseline", canonical_account_key: "transportation" },
    },
  });

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
  const row = db.rows.transaction_categorizations[0];

  assert.equal(result.promoted, 1);
  assert.equal(row.status, "auto_approved");
  assert.equal(row.suggested_canonical_account_key, "parking_tolls");
  assert.equal(row.final_qbo_account_name, "Parking/Tolls");
  assert.equal(row.final_qbo_account_name !== "Transportation", true);
  assert.equal(row.decided_by, "bizzi");
  assert.ok(row.decided_at);
  assert.equal(state.createCount, 0);
});

test("old exact restaurant Select account row is reconsidered and auto-handled when canonical mapping exists", async () => {
  const db = makeDb();
  const { qbo } = makeQbo([{ id: "meals-current", name: "Meals", type: "Expense", subType: "Meals" }]);
  addMapping(db, {
    canonical_account_key: "meals",
    qbo_account_id: "meals-current",
    qbo_account_name: "Meals",
    qbo_account_subtype: "Meals",
  });
  addRoutineRow(db, "txn-meals", {
    bankTxn: {
      name: "MICRO MART 650000013ATLANTA",
      merchant_name: "Micromart",
      merchant_entity_id: "ent-micro-mart",
      amount: -5.4,
      signed_amount: -5.4,
    },
    cat: {
      suggested_qbo_account_id: null,
      suggested_qbo_account_name: null,
      suggested_canonical_account_key: null,
      meta: { suggestion_source: "plaid_baseline" },
    },
  });

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
  const row = db.rows.transaction_categorizations[0];

  assert.equal(result.promoted, 1);
  assert.equal(row.status, "auto_approved");
  assert.equal(row.suggested_canonical_account_key, "meals");
  assert.equal(row.final_qbo_account_name, "Meals");
  assert.equal(row.post_after, null);
});

test("specific SaaS universal merchant evidence can promote OpenAI to existing Software account", async () => {
  const db = makeDb();
  const { qbo, state } = makeQbo([{ id: "software-current", name: "Software", type: "Expense", subType: "DuesSubscriptions" }]);
  addRoutineRow(db, "txn-openai", {
    bankTxn: {
      name: "OPENAI *CHATGPT SUBSCR",
      merchant_name: "OpenAI",
      merchant_entity_id: "ent-openai",
      amount: -20,
      signed_amount: -20,
    },
    cat: {
      suggested_qbo_account_id: null,
      suggested_qbo_account_name: null,
      suggested_canonical_account_key: null,
      confidence: "medium",
      meta: { suggestion_source: "plaid_baseline" },
    },
  });

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
  const row = db.rows.transaction_categorizations[0];

  assert.equal(result.promoted, 1);
  assert.equal(row.status, "auto_approved");
  assert.equal(row.final_qbo_account_id, "software-current");
  assert.equal(row.final_qbo_account_name, "Software");
  assert.equal(row.meta.evidence_source, "specific_universal_vendor");
  assert.equal(row.meta.original_confidence, "medium");
  assert.equal(row.decided_by, "bizzi");
  assert.ok(row.decided_at);
  assert.equal(row.post_after, null);
  assert.equal(row.qbo_txn_id || null, null);
  assert.equal(state.createCount, 0);
});

test("strong universal merchant can resolve to an existing semantically compatible QBO account", async () => {
  const db = makeDb();
  const { qbo, state } = makeQbo([{ id: "rideshare", name: "Lyft/Uber", type: "Expense" }]);
  addRoutineRow(db, "txn-uber", {
    bankTxn: {
      name: "UBER TRIP",
      merchant_name: "Uber",
      merchant_entity_id: "ent-uber",
      amount: -18.25,
      signed_amount: -18.25,
    },
    cat: {
      suggested_qbo_account_id: null,
      suggested_qbo_account_name: null,
      suggested_canonical_account_key: null,
      meta: { suggestion_source: "plaid_baseline" },
    },
  });

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
  const row = db.rows.transaction_categorizations[0];

  assert.equal(result.promoted, 1);
  assert.equal(row.status, "auto_approved");
  assert.equal(row.final_qbo_account_id, "rideshare");
  assert.equal(row.final_qbo_account_name, "Lyft/Uber");
  assert.equal(row.suggested_canonical_account_key, "transportation");
  assert.equal(row.meta.semantic_coa_resolved, true);
  assert.equal(row.decided_by, "bizzi");
  assert.ok(row.decided_at);
  assert.equal(state.createCount, 0);
});

test("ParkMobile can resolve to existing Transportation account when canonical Parking/Tolls is absent", async () => {
  const db = makeDb();
  const { qbo, state } = makeQbo([{ id: "transportation-current", name: "Transportation", type: "Expense", subType: "Travel" }]);
  addRoutineRow(db, "txn-parkmobile-semantic", {
    bankTxn: {
      name: "PARK MOBILE CDOT PAY",
      merchant_name: "Parkmobile",
      merchant_entity_id: "ent-parkmobile",
      amount: -3.12,
      signed_amount: -3.12,
    },
    cat: {
      suggested_qbo_account_id: null,
      suggested_qbo_account_name: null,
      suggested_canonical_account_key: null,
      meta: { suggestion_source: "plaid_baseline" },
    },
  });

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
  const row = db.rows.transaction_categorizations[0];

  assert.equal(result.promoted, 1);
  assert.equal(row.status, "auto_approved");
  assert.equal(row.suggested_canonical_account_key, "parking_tolls");
  assert.equal(row.final_canonical_account_key, null);
  assert.equal(row.final_qbo_account_id, "transportation-current");
  assert.equal(row.final_qbo_account_name, "Transportation");
  assert.equal(row.meta.semantic_coa_resolved, true);
  assert.equal(row.meta.semantic_coa_match.matched_intent, "transportation");
  assert.equal(row.decided_by, "bizzi");
  assert.ok(row.decided_at);
  assert.equal(state.createCount, 0);
});

test("suspense intent can resolve to an active compatible QBO account before fallback", async () => {
  const db = makeDb();
  const { qbo, state } = makeQbo([{ id: "bank-fees-current", name: "Bank Fees", type: "Expense", subType: "BankCharges" }]);
  addRoutineRow(db, "txn-intuit-fee", {
    bankTxn: {
      name: "TRAN FEE INTUIT 24557023 OPTIMIST BOOKKEEPING ACH CORP DEBIT",
      merchant_name: null,
      merchant_entity_id: null,
      canonical_vendor_id: null,
      amount: -13.3,
      signed_amount: -13.3,
    },
    cat: {
      suggested_qbo_account_id: "4",
      suggested_qbo_account_name: "Uncategorized Expense",
      suggested_canonical_account_key: null,
      confidence: "low",
      meta: { suggestion_source: "fallback" },
    },
  });

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
  const row = db.rows.transaction_categorizations[0];

  assert.equal(result.promoted, 1);
  assert.equal(row.status, "auto_approved");
  assert.equal(row.final_qbo_account_id, "bank-fees-current");
  assert.equal(row.final_qbo_account_name, "Bank Fees");
  assert.equal(row.meta.semantic_coa_resolved, true);
  assert.equal(row.decided_by, "bizzi");
  assert.equal(state.createCount, 0);
});

test("late fee suspense row can resolve to one compatible fee account before fallback", async () => {
  const db = makeDb();
  const { qbo, state } = makeQbo([{ id: "cc-fees-current", name: "CC Fees", type: "Expense", subType: "BankCharges" }]);
  addRoutineRow(db, "txn-late-fee", {
    bankTxn: {
      name: "LATE FEE",
      merchant_name: null,
      merchant_entity_id: null,
      canonical_vendor_id: null,
      amount: -40,
      signed_amount: -40,
      category_primary: "BANK_FEES",
      category_detailed: "BANK_FEES_LATE_PAYMENT",
    },
    cat: {
      suggested_qbo_account_id: "4",
      suggested_qbo_account_name: "Uncategorized Expense",
      suggested_canonical_account_key: null,
      confidence: "low",
      meta: { suggestion_source: "fallback" },
    },
  });

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
  const row = db.rows.transaction_categorizations[0];

  assert.equal(result.promoted, 1);
  assert.equal(row.status, "auto_approved");
  assert.equal(row.final_qbo_account_id, "cc-fees-current");
  assert.equal(row.final_qbo_account_name, "CC Fees");
  assert.equal(row.meta.evidence_source, "semantic_coa_fallback");
  assert.equal(row.meta.semantic_intent, "bank_fees");
  assert.equal(row.decided_by, "bizzi");
  assert.equal(state.createCount, 0);
});

test("prior business final history bridges normalized merchant suffix variants", async () => {
  const db = makeDb();
  const { qbo } = makeQbo([{ id: "meals-current", name: "Meals", type: "Expense", subType: "Meals" }]);
  addRoutineRow(db, "txn-prior-exchange", {
    bankTxn: {
      name: "THE EXCHANGE UPTOWN LLC",
      merchant_name: "The Exchange Uptown LLC",
      merchant_entity_id: null,
      canonical_vendor_id: null,
      amount: -24.5,
      signed_amount: -24.5,
    },
    cat: {
      status: "approved",
      suggested_qbo_account_id: "meals-current",
      suggested_qbo_account_name: "Meals",
      final_qbo_account_id: "meals-current",
      final_qbo_account_name: "Meals",
      decided_by: "accountant",
      decided_at: "2026-08-14T12:00:00.000Z",
    },
  });
  addRoutineRow(db, "txn-stale-exchange", {
    bankTxn: {
      name: "THE EXCHANGE UPTOWN",
      merchant_name: "The Exchange Uptown",
      merchant_entity_id: null,
      canonical_vendor_id: null,
      amount: -4.32,
      signed_amount: -4.32,
    },
    cat: {
      suggested_qbo_account_id: "4",
      suggested_qbo_account_name: "Uncategorized Expense",
      suggested_canonical_account_key: null,
      confidence: "low",
      meta: { suggestion_source: "fallback" },
    },
  });

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
  const row = db.rows.transaction_categorizations.find((item) => item.transaction_id === "txn-stale-exchange");

  assert.equal(result.promoted, 1);
  assert.equal(row.status, "auto_approved");
  assert.equal(row.final_qbo_account_id, "meals-current");
  assert.equal(row.meta.evidence_source, "business_history");
  assert.equal(row.meta.confidence_tier, "very_high");
});

test("statement credit can promote to Credit Card Rewards without opening transfer payments", async () => {
  const db = makeDb();
  const { qbo } = makeQbo([{ id: "rewards-current", name: "Credit Card Rewards", type: "Other Income", subType: "OtherMiscellaneousIncome" }]);
  addRoutineRow(db, "txn-statement-credit", {
    bankTxn: {
      name: "AUTOMATIC STATEMENT CREDIT",
      merchant_name: "Automatic Statement Credit",
      merchant_entity_id: null,
      canonical_vendor_id: null,
      amount: 1.63,
      signed_amount: 1.63,
      direction: "INFLOW",
    },
    cat: {
      suggested_qbo_account_id: "rewards-current",
      suggested_qbo_account_name: "Credit Card Rewards",
      suggested_canonical_account_key: "other_income",
      confidence: "medium",
      meta: { suggestion_source: "plaid_mapping", taxonomy_type: "transfer_internal" },
    },
  });
  addRoutineRow(db, "txn-card-payment", {
    bankTxn: {
      name: "MOBILE PAYMENT - THANK YOU",
      merchant_name: "Mobile Payment",
      merchant_entity_id: null,
      canonical_vendor_id: null,
      amount: 322.57,
      signed_amount: 322.57,
      direction: "INFLOW",
    },
    cat: {
      suggested_qbo_account_id: "rewards-current",
      suggested_qbo_account_name: "Credit Card Rewards",
      confidence: "medium",
      meta: { suggestion_source: "plaid_mapping", taxonomy_type: "transfer_internal" },
    },
  });

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
  const credit = db.rows.transaction_categorizations.find((row) => row.transaction_id === "txn-statement-credit");
  const payment = db.rows.transaction_categorizations.find((row) => row.transaction_id === "txn-card-payment");

  assert.equal(result.promoted, 1);
  assert.equal(credit.status, "auto_approved");
  assert.equal(credit.final_qbo_account_name, "Credit Card Rewards");
  assert.equal(credit.meta.taxonomy_auto_handle_reason, "statement_credit_rewards_income");
  assert.equal(payment.status, "needs_review");
  assert.equal(payment.final_qbo_account_id, null);
  assert.match(payment.meta.auto_handle_decision.reason, /transfer_internal|review/);
});

test("Plaid medium Meals row with deterministic restaurant evidence auto-approves", async () => {
  const db = makeDb();
  const { qbo } = makeQbo([{ id: "meals-current", name: "Meals", type: "Expense", subType: "Meals" }]);
  addMapping(db, {
    canonical_account_key: "meals",
    qbo_account_id: "meals-current",
    qbo_account_name: "Meals",
    qbo_account_subtype: "Meals",
  });
  addRoutineRow(db, "txn-medium-meals-promote", {
    bankTxn: {
      name: "TST* CANOPY COCKTAILS",
      merchant_name: "Canopy Cocktails",
      merchant_entity_id: null,
      canonical_vendor_id: null,
      amount: -79.52,
      signed_amount: -79.52,
    },
    cat: {
      suggested_qbo_account_id: "meals-current",
      suggested_qbo_account_name: "Meals",
      suggested_canonical_account_key: "meals",
      confidence: "medium",
      meta: { suggestion_source: "plaid_mapping" },
    },
  });

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
  const row = db.rows.transaction_categorizations[0];

  assert.equal(result.promoted, 1);
  assert.equal(row.status, "auto_approved");
  assert.equal(row.final_qbo_account_id, "meals-current");
  assert.equal(row.final_qbo_account_name, "Meals");
  assert.equal(row.decided_by, "bizzi");
  assert.equal(row.post_after, null);
  assert.equal(row.qbo_txn_id || null, null);
  assert.equal(row.meta.deterministic_medium_evidence, true);
});

test("medium deterministic suggestion with conflicting evidence remains Needs Review", async () => {
  const db = makeDb();
  const { qbo } = makeQbo([{ id: "meals-current", name: "Meals", type: "Expense", subType: "Meals" }]);
  addRoutineRow(db, "txn-conflict", {
    bankTxn: {
      name: "TST* CANOPY COCKTAILS",
      merchant_name: "Canopy Cocktails",
      merchant_entity_id: null,
      canonical_vendor_id: null,
      amount: -79.52,
      signed_amount: -79.52,
    },
    cat: {
      suggested_qbo_account_id: "meals-current",
      suggested_qbo_account_name: "Meals",
      suggested_canonical_account_key: "meals",
      confidence: "medium",
      meta: {
        suggestion_source: "plaid_mapping",
        conflicting_categorization_evidence: true,
      },
    },
  });

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
  const row = db.rows.transaction_categorizations[0];

  assert.equal(result.promoted, 0);
  assert.equal(row.status, "needs_review");
  assert.equal(row.final_qbo_account_id, null);
  assert.equal(row.meta.auto_handle_decision.reason, "conflicting_categorization_evidence");
});

test("Plaid medium Transportation row with deterministic parking evidence auto-approves", async () => {
  const db = makeDb();
  const { qbo } = makeQbo([{ id: "transportation-current", name: "Transportation", type: "Expense", subType: "Travel" }]);
  addRoutineRow(db, "txn-medium-parking-promote", {
    bankTxn: {
      name: "PPS - SURFACE LOT",
      merchant_name: "PPS",
      merchant_entity_id: null,
      canonical_vendor_id: null,
      amount: -17,
      signed_amount: -17,
    },
    cat: {
      suggested_qbo_account_id: "transportation-current",
      suggested_qbo_account_name: "Transportation",
      suggested_canonical_account_key: "transportation",
      confidence: "medium",
      meta: { suggestion_source: "plaid_mapping" },
    },
  });

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
  const row = db.rows.transaction_categorizations[0];

  assert.equal(result.promoted, 1);
  assert.equal(row.status, "auto_approved");
  assert.equal(row.final_qbo_account_id, "transportation-current");
  assert.equal(row.final_qbo_account_name, "Transportation");
  assert.equal(row.meta.semantic_coa_resolved, true);
  assert.equal(row.meta.safe_to_auto_handle, true);
});

test("Plaid-only ambiguous medium suggestion can remain visible while lifecycle stays Needs Review", async () => {
  const db = makeDb();
  const { qbo } = makeQbo([{ id: "meals-current", name: "Meals", type: "Expense", subType: "Meals" }]);
  addMapping(db, {
    canonical_account_key: "meals",
    qbo_account_id: "meals-current",
    qbo_account_name: "Meals",
    qbo_account_subtype: "Meals",
  });
  addRoutineRow(db, "txn-medium-meals", {
    bankTxn: {
      name: "LOCAL MARKET",
      merchant_name: "Local Market",
      merchant_entity_id: null,
      canonical_vendor_id: null,
      amount: -14.95,
      signed_amount: -14.95,
    },
    cat: {
      suggested_qbo_account_id: "meals-current",
      suggested_qbo_account_name: "Meals",
      suggested_canonical_account_key: "meals",
      confidence: "medium",
      meta: { suggestion_source: "plaid_mapping" },
    },
  });

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
  const row = db.rows.transaction_categorizations[0];

  assert.equal(result.promoted, 0);
  assert.equal(row.status, "needs_review");
  assert.equal(row.suggested_qbo_account_name, "Meals");
  assert.equal(row.final_qbo_account_id, null);
  assert.equal(row.decided_by, "plaid_mapping");
  assert.equal(row.meta.deterministic_medium_evidence, false);
  assert.equal(row.meta.auto_handle_decision.eligible, false);
});

test("suspense fallback accounts never become Handled during reconsideration", async () => {
  for (const suspenseName of ["Uncategorized Expense", "Uncategorized Income", "Ask My Accountant"]) {
    const db = makeDb();
    const { qbo } = makeQbo([{ id: `suspense-${suspenseName}`, name: suspenseName, type: "Expense" }]);
    addMapping(db, {
      canonical_account_key: "software",
      qbo_account_id: `suspense-${suspenseName}`,
      qbo_account_name: suspenseName,
    });
    addRoutineRow(db, `txn-${suspenseName}`, {
      bankTxn: {
        name: "OPENAI CHATGPT SUBSCR",
        merchant_name: "OpenAI",
        merchant_entity_id: "ent-openai",
        amount: -20,
        signed_amount: -20,
      },
    });

    const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
    const row = db.rows.transaction_categorizations[0];

    assert.equal(result.promoted, 0, suspenseName);
    assert.equal(result.bucket_counts.suspense_no_specific_gl, 1, suspenseName);
    assert.equal(row.status, "needs_review", suspenseName);
    assert.equal(row.final_qbo_account_id, null, suspenseName);
  }
});

test("pending and true credit-card payment rows remain protected", async () => {
  const db = makeDb();
  const { qbo } = makeQbo([{ id: "transportation-current", name: "Transportation", type: "Expense", subType: "Travel" }]);
  addRoutineRow(db, "txn-pending", {
    bankTxn: {
      name: "PARK MOBILE CDOT PAY",
      merchant_name: "Parkmobile",
      merchant_entity_id: "ent-pending",
      pending: true,
      amount: -3.12,
      signed_amount: -3.12,
    },
  });
  addRoutineRow(db, "txn-card-payment", {
    bankTxn: {
      name: "EPAY CHASE CREDIT CRD",
      merchant_name: "Chase",
      merchant_entity_id: "ent-chase",
      amount: -2196.7,
      signed_amount: -2196.7,
    },
    cat: {
      meta: { taxonomy_type: "cc_payment", suggestion_source: "vendor_rule" },
    },
  });
  db.rows.vendor_rules.push({
    id: "rule-card-payment",
    business_id: BUSINESS_ID,
    match_type: "merchant_entity_id",
    match_value: "ent-chase",
    counterparty_name: "Chase",
    default_qbo_account_id: "transportation-current",
    default_qbo_account_name: "Transportation",
    direction_hint: "OUTFLOW",
    confidence: "high",
    rule_kind: "category_default",
  });

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });

  assert.equal(result.promoted, 0);
  assert.equal(result.bucket_counts.pending, 1);
  assert.equal(result.bucket_counts.protected_workflow, 1);
  assert.equal(db.rows.transaction_categorizations.find((row) => row.transaction_id === "txn-pending").status, "needs_review");
  assert.equal(db.rows.transaction_categorizations.find((row) => row.transaction_id === "txn-card-payment").status, "needs_review");
});

test("ordinary merchant purchase on a credit card remains eligible for normal categorization", async () => {
  const db = makeDb();
  const { qbo } = makeQbo([{ id: "meals-current", name: "Meals", type: "Expense", subType: "Meals" }]);
  db.rows.vendor_rules.push({
    id: "rule-cava",
    business_id: BUSINESS_ID,
    match_type: "merchant_entity_id",
    match_value: "ent-cava",
    counterparty_name: "Cava",
    default_qbo_account_id: "meals-current",
    default_qbo_account_name: "Meals",
    direction_hint: "OUTFLOW",
    confidence: "high",
    rule_kind: "category_default",
  });
  addRoutineRow(db, "txn-credit-card-purchase", {
    bankTxn: {
      plaid_account_id: "credit-card-account",
      name: "10093 CAVA SOUTHEND",
      merchant_name: "Cava",
      merchant_entity_id: "ent-cava",
      amount: -12.62,
      signed_amount: -12.62,
    },
    cat: {
      suggested_qbo_account_id: null,
      suggested_qbo_account_name: null,
      suggested_canonical_account_key: null,
      meta: { suggestion_source: "fallback" },
    },
  });

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
  const row = db.rows.transaction_categorizations[0];

  assert.equal(result.promoted, 1);
  assert.equal(row.status, "auto_approved");
  assert.equal(row.final_qbo_account_name, "Meals");
});

test("manual, already auto-approved, and posted categorizations are never overwritten", async () => {
  const db = makeDb();
  const { qbo } = makeQbo([{ id: "software-current", name: "Software", type: "Expense", subType: "DuesSubscriptions" }]);
  addMapping(db);
  addRoutineRow(db, "txn-manual", {
    cat: {
      status: "approved",
      final_qbo_account_id: "manual-account",
      final_qbo_account_name: "Manual Account",
      decided_by: "accountant",
    },
  });
  addRoutineRow(db, "txn-auto", {
    cat: {
      status: "auto_approved",
      final_qbo_account_id: "auto-account",
      final_qbo_account_name: "Auto Account",
    },
  });
  addRoutineRow(db, "txn-posted", {
    cat: {
      status: "needs_review",
      qbo_txn_id: "qbo-posted-1",
      suggested_qbo_account_id: "old",
      suggested_qbo_account_name: "Old",
    },
  });

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });

  assert.equal(result.processed, 0);
  assert.equal(result.promoted, 0);
  assert.equal(db.rows.transaction_categorizations.find((row) => row.transaction_id === "txn-manual").final_qbo_account_id, "manual-account");
  assert.equal(db.rows.transaction_categorizations.find((row) => row.transaction_id === "txn-auto").final_qbo_account_id, "auto-account");
  assert.equal(db.rows.transaction_categorizations.find((row) => row.transaction_id === "txn-posted").qbo_txn_id, "qbo-posted-1");
});

test("answered awaiting accountant review rows are protected during backlog reconsideration", async () => {
  const db = makeDb();
  const { qbo } = makeQbo([{ id: "meals-current", name: "Meals", type: "Expense", subType: "Meals" }]);
  addMapping(db, {
    canonical_account_key: "meals",
    qbo_account_id: "meals-current",
    qbo_account_name: "Meals",
    qbo_account_subtype: "Meals",
  });
  addRoutineRow(db, "txn-answered", {
    bankTxn: {
      name: "CHICK-FIL-A",
      merchant_name: "Chick-fil-A",
      merchant_entity_id: "ent-chick",
      amount: -12.1,
      signed_amount: -12.1,
    },
  });
  db.rows.clarification_requests.push({
    business_id: BUSINESS_ID,
    transaction_id: "txn-answered",
    status: "answered",
  });

  const result = await reconsiderNeedsReviewTransactions(BUSINESS_ID, { db, range: "all", dependencies: deps(db, qbo) });
  const row = db.rows.transaction_categorizations[0];

  assert.equal(result.promoted, 0);
  assert.equal(row.status, "needs_review");
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

test("date-scoped reconsideration reads and paginates only selected-month transactions", async () => {
  const db = makeDb();
  const { qbo } = makeQbo([{ id: "software-current", name: "Software", type: "Expense", subType: "DuesSubscriptions" }]);
  addMapping(db);
  addRoutineRow(db, "aug-01", { bankTxn: { date: "2026-08-02" } });
  addRoutineRow(db, "aug-02", { bankTxn: { date: "2026-08-03" } });
  addRoutineRow(db, "jul-01", { bankTxn: { date: "2026-07-31" } });
  addRoutineRow(db, "sep-01", { bankTxn: { date: "2026-09-01" } });

  const first = await reconsiderNeedsReviewTransactions(BUSINESS_ID, {
    db,
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    limit: 1,
    dependencies: deps(db, qbo),
  });
  const second = await reconsiderNeedsReviewTransactions(BUSINESS_ID, {
    db,
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    cursor: first.next_cursor,
    limit: 1,
    dependencies: deps(db, qbo),
  });

  assert.equal(first.processed, 1);
  assert.equal(first.promoted, 1);
  assert.ok(first.next_cursor);
  assert.equal(second.processed, 1);
  assert.equal(second.promoted, 1);
  assert.equal(db.rows.transaction_categorizations.find((row) => row.transaction_id === "aug-01").status, "auto_approved");
  assert.equal(db.rows.transaction_categorizations.find((row) => row.transaction_id === "aug-02").status, "auto_approved");
  assert.equal(db.rows.transaction_categorizations.find((row) => row.transaction_id === "jul-01").status, "needs_review");
  assert.equal(db.rows.transaction_categorizations.find((row) => row.transaction_id === "sep-01").status, "needs_review");
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
