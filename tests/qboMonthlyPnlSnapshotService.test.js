import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const {
  createOrReplaceMonthlyPnlSnapshot,
  getLatestMonthlyPnlSnapshot,
  invalidateMonthlyPnlSnapshot,
  linkSnapshotTransactionsToBizzi,
} = await import("../src/services/bookkeeping/qboMonthlyPnlSnapshotService.js");

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_BUSINESS_ID = "00000000-0000-4000-8000-000000000002";
const TXN_ID = "00000000-0000-4000-8000-000000000101";
const OTHER_TXN_ID = "00000000-0000-4000-8000-000000000102";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function makeDb(initial = {}) {
  const tables = {
    monthly_review_qbo_pnl_snapshots: [],
    monthly_review_qbo_pnl_accounts: [],
    monthly_review_qbo_pnl_transactions: [],
    transaction_categorizations: [],
    bank_transactions: [],
    ...initial,
  };
  return {
    tables,
    from(table) {
      return new Query(tables, table);
    },
  };
}

class Query {
  constructor(tables, table) {
    this.tables = tables;
    this.table = table;
    this.filters = [];
    this.orders = [];
    this.limitCount = null;
    this.pendingInsert = null;
    this.pendingUpdate = null;
  }

  select() { return this; }

  eq(column, value) {
    this.filters.push((row) => String(row[column]) === String(value));
    return this;
  }

  in(column, values) {
    const set = new Set((values || []).map(String));
    this.filters.push((row) => set.has(String(row[column])));
    return this;
  }

  order(column, options = {}) {
    this.orders.push({ column, ascending: options.ascending !== false });
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  insert(payload) {
    this.pendingInsert = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  update(payload) {
    this.pendingUpdate = payload;
    return this;
  }

  then(resolve) {
    if (this.pendingInsert) {
      const inserted = this.pendingInsert.map((row) => {
        const id = row.id || nextId(this.table, this.tables[this.table].length + 1);
        const copy = { id, ...structuredClone(row) };
        this.tables[this.table].push(copy);
        return { ...copy };
      });
      return resolve({ data: inserted, error: null });
    }

    if (this.pendingUpdate) {
      const rows = this.rows();
      rows.forEach((row) => Object.assign(row, structuredClone(this.pendingUpdate)));
      return resolve({ data: rows.map((row) => ({ ...row })), error: null });
    }

    return resolve({ data: this.rows().map((row) => ({ ...row })), error: null });
  }

  rows() {
    let rows = this.tables[this.table] || [];
    for (const filter of this.filters) rows = rows.filter(filter);
    for (const { column, ascending } of this.orders) {
      rows = [...rows].sort((a, b) => {
        const av = a[column];
        const bv = b[column];
        if (av === bv) return 0;
        if (av === undefined || av === null) return ascending ? -1 : 1;
        if (bv === undefined || bv === null) return ascending ? 1 : -1;
        return av < bv ? (ascending ? -1 : 1) : (ascending ? 1 : -1);
      });
    }
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    return rows;
  }
}

function nextId(table, offset) {
  const prefixes = {
    monthly_review_qbo_pnl_snapshots: "10000000",
    monthly_review_qbo_pnl_accounts: "20000000",
    monthly_review_qbo_pnl_transactions: "30000000",
  };
  return `${prefixes[table] || "90000000"}-0000-4000-8000-${String(offset).padStart(12, "0")}`;
}

function sampleAccount(overrides = {}) {
  return {
    qbo_account_id: "71",
    account_name: "Meals",
    account_path: "Expenses:Meals",
    account_type: "Expense",
    account_subtype: "MealsEntertainment",
    total_amount: -42.5,
    ...overrides,
  };
}

function sampleTransaction(overrides = {}) {
  return {
    qbo_account_id: "71",
    qbo_account_name: "Meals",
    qbo_txn_id: "123",
    qbo_txn_type: "Purchase",
    txn_date: "2026-08-22",
    payee_name: "Apple",
    description: "Lunch",
    amount: -42.5,
    ...overrides,
  };
}

test("migration creates internal versioned QBO P&L snapshot tables with service-role-only access", () => {
  const migration = read("supabase/migrations/20260910_monthly_review_qbo_pnl_snapshots.sql");
  const promotionMigration = read("supabase/migrations/20260911_monthly_review_qbo_pnl_atomic_promotion.sql");

  assert.match(migration, /create table if not exists public\.monthly_review_qbo_pnl_snapshots/i);
  assert.match(migration, /create table if not exists public\.monthly_review_qbo_pnl_accounts/i);
  assert.match(migration, /create table if not exists public\.monthly_review_qbo_pnl_transactions/i);
  assert.match(migration, /monthly_review_qbo_pnl_snapshots_current_unique[\s\S]*where is_current is true/i);
  assert.match(migration, /unique \(business_id, id\)/i);
  assert.match(migration, /foreign key \(business_id, snapshot_id\)[\s\S]*references public\.monthly_review_qbo_pnl_snapshots \(business_id, id\)/i);
  assert.match(migration, /alter table public\.monthly_review_qbo_pnl_snapshots enable row level security/i);
  assert.match(migration, /revoke all on table public\.monthly_review_qbo_pnl_snapshots from public, anon, authenticated/i);
  assert.match(migration, /grant all on table public\.monthly_review_qbo_pnl_transactions to service_role/i);
  assert.match(migration, /business_id uuid not null references public\.business_profiles/i);
  assert.match(migration, /bizzi_transaction_id uuid null references public\.bank_transactions\(id\)/i);
  assert.doesNotMatch(migration, /create policy/i);
  assert.match(promotionMigration, /create or replace function public\.promote_monthly_review_qbo_pnl_snapshot/i);
  assert.match(promotionMigration, /for update/i);
  assert.match(promotionMigration, /grant execute on function public\.promote_monthly_review_qbo_pnl_snapshot/i);
  assert.match(promotionMigration, /to service_role/i);
});

test("snapshot creation persists current snapshot, account rows, transaction rows, and QBO account identity", async () => {
  const db = makeDb();

  const result = await createOrReplaceMonthlyPnlSnapshot({
    businessId: BUSINESS_ID,
    reviewYear: 2026,
    reviewMonth: 8,
    qboRealmId: "realm-1",
    qboEnvironment: "production",
    revenue: 1000,
    cogs: 100,
    expenses: 250,
    netProfit: 650,
    accounts: [sampleAccount()],
    transactions: [sampleTransaction()],
    linkTransactions: false,
    db,
  });

  assert.equal(result.ok, true);
  assert.equal(result.snapshot.snapshot_version, 1);
  assert.equal(result.snapshot.is_current, true);
  assert.equal(result.snapshot.source_start_date, "2026-08-01");
  assert.equal(result.snapshot.source_end_date, "2026-08-31");
  assert.equal(db.tables.monthly_review_qbo_pnl_accounts[0].business_id, BUSINESS_ID);
  assert.equal(db.tables.monthly_review_qbo_pnl_accounts[0].snapshot_id, result.snapshot.id);
  assert.equal(db.tables.monthly_review_qbo_pnl_accounts[0].qbo_account_id, "71");
  assert.equal(db.tables.monthly_review_qbo_pnl_transactions[0].snapshot_id, result.snapshot.id);
  assert.equal(db.tables.monthly_review_qbo_pnl_transactions[0].qbo_txn_type, "Purchase");
});

test("replacement preserves historical snapshots and marks exactly one current month snapshot", async () => {
  const db = makeDb();

  const first = await createOrReplaceMonthlyPnlSnapshot({
    businessId: BUSINESS_ID,
    reviewYear: 2026,
    reviewMonth: 8,
    transactions: [sampleTransaction({ qbo_txn_id: "old" })],
    linkTransactions: false,
    db,
  });
  const second = await createOrReplaceMonthlyPnlSnapshot({
    businessId: BUSINESS_ID,
    reviewYear: 2026,
    reviewMonth: 8,
    transactions: [sampleTransaction({ qbo_txn_id: "new" })],
    linkTransactions: false,
    db,
  });
  const latest = await getLatestMonthlyPnlSnapshot({
    businessId: BUSINESS_ID,
    reviewYear: 2026,
    reviewMonth: 8,
    includeTransactions: true,
    db,
  });

  assert.equal(first.snapshot.snapshot_version, 1);
  assert.equal(second.snapshot.snapshot_version, 2);
  assert.equal(db.tables.monthly_review_qbo_pnl_snapshots.length, 2);
  assert.equal(db.tables.monthly_review_qbo_pnl_snapshots.find((row) => row.id === first.snapshot.id).status, "superseded");
  assert.equal(db.tables.monthly_review_qbo_pnl_snapshots.filter((row) => row.is_current).length, 1);
  assert.equal(latest.id, second.snapshot.id);
  assert.equal(latest.transactions[0].qbo_txn_id, "new");
});

test("QBO-only, missing, ambiguous, and exact Bizzi transaction linkage are business-scoped", async () => {
  const db = makeDb({
    bank_transactions: [
      { id: TXN_ID, business_id: BUSINESS_ID, is_archived: false },
      { id: OTHER_TXN_ID, business_id: BUSINESS_ID, is_archived: false },
      { id: "00000000-0000-4000-8000-000000000999", business_id: OTHER_BUSINESS_ID, is_archived: false },
    ],
    transaction_categorizations: [
      { business_id: BUSINESS_ID, transaction_id: TXN_ID, qbo_txn_id: "linked", qbo_txn_type: "Purchase", status: "posted" },
      { business_id: BUSINESS_ID, transaction_id: TXN_ID, qbo_txn_id: "ambiguous", qbo_txn_type: "Deposit", status: "posted" },
      { business_id: BUSINESS_ID, transaction_id: OTHER_TXN_ID, qbo_txn_id: "ambiguous", qbo_txn_type: "Deposit", status: "posted" },
      { business_id: OTHER_BUSINESS_ID, transaction_id: "00000000-0000-4000-8000-000000000999", qbo_txn_id: "linked", qbo_txn_type: "Purchase", status: "posted" },
    ],
  });

  const result = await createOrReplaceMonthlyPnlSnapshot({
    businessId: BUSINESS_ID,
    reviewYear: 2026,
    reviewMonth: 8,
    transactions: [
      sampleTransaction({ qbo_txn_id: "linked", qbo_txn_type: "expense" }),
      sampleTransaction({ qbo_txn_id: "outside", qbo_txn_type: "Purchase" }),
      sampleTransaction({ qbo_txn_id: "ambiguous", qbo_txn_type: "Deposit" }),
      sampleTransaction({ qbo_txn_id: null, qbo_txn_type: null }),
    ],
    db,
  });

  const byQboId = Object.fromEntries(db.tables.monthly_review_qbo_pnl_transactions.map((row) => [row.qbo_txn_id || "missing", row]));
  assert.deepEqual(result.linkage, { linked: 1, qboOnly: 1, ambiguous: 1, missingIdentity: 1, skipped: 0 });
  assert.equal(byQboId.linked.bizzi_transaction_id, TXN_ID);
  assert.equal(byQboId.linked.linkage_status, "linked");
  assert.equal(byQboId.outside.bizzi_transaction_id, null);
  assert.equal(byQboId.outside.linkage_status, "qbo_only");
  assert.equal(byQboId.ambiguous.bizzi_transaction_id, null);
  assert.equal(byQboId.ambiguous.linkage_status, "ambiguous");
  assert.equal(byQboId.missing.bizzi_transaction_id, null);
  assert.equal(byQboId.missing.linkage_status, "missing_qbo_identity");
});

test("ambiguous or missing linkage cannot fabricate a Bizzi transaction match", async () => {
  const db = makeDb({
    bank_transactions: [
      { id: TXN_ID, business_id: BUSINESS_ID, is_archived: false },
      { id: OTHER_TXN_ID, business_id: BUSINESS_ID, is_archived: false },
    ],
    transaction_categorizations: [
      { business_id: BUSINESS_ID, transaction_id: TXN_ID, qbo_txn_id: "qbo-1", qbo_txn_type: "Purchase", status: "posted" },
      { business_id: BUSINESS_ID, transaction_id: OTHER_TXN_ID, qbo_txn_id: "qbo-1", qbo_txn_type: "Purchase", status: "posted" },
    ],
  });
  await createOrReplaceMonthlyPnlSnapshot({
    businessId: BUSINESS_ID,
    reviewYear: 2026,
    reviewMonth: 8,
    transactions: [sampleTransaction({ qbo_txn_id: "qbo-1", qbo_txn_type: "Purchase" })],
    db,
  });

  const row = db.tables.monthly_review_qbo_pnl_transactions[0];
  assert.equal(row.linkage_status, "ambiguous");
  assert.equal(row.bizzi_transaction_id, null);
});

test("linkage requires both exact QBO id and exact QBO transaction type", async () => {
  const db = makeDb({
    bank_transactions: [
      { id: TXN_ID, business_id: BUSINESS_ID, is_archived: false },
      { id: OTHER_TXN_ID, business_id: BUSINESS_ID, is_archived: false },
    ],
    transaction_categorizations: [
      { business_id: BUSINESS_ID, transaction_id: TXN_ID, qbo_txn_id: "qbo-1", qbo_txn_type: "Purchase", status: "posted" },
      { business_id: BUSINESS_ID, transaction_id: OTHER_TXN_ID, qbo_txn_id: "qbo-2", qbo_txn_type: "Deposit", status: "posted" },
    ],
  });

  const result = await createOrReplaceMonthlyPnlSnapshot({
    businessId: BUSINESS_ID,
    reviewYear: 2026,
    reviewMonth: 8,
    transactions: [
      sampleTransaction({ qbo_txn_id: "qbo-1", qbo_txn_type: "Purchase" }),
      sampleTransaction({ qbo_txn_id: "qbo-1", qbo_txn_type: null }),
      sampleTransaction({ qbo_txn_id: "qbo-2", qbo_txn_type: "Purchase" }),
    ],
    db,
  });

  const byKey = Object.fromEntries(db.tables.monthly_review_qbo_pnl_transactions.map((row) => [`${row.qbo_txn_id || "missing"}::${row.qbo_txn_type || "missing"}`, row]));
  assert.deepEqual(result.linkage, { linked: 1, qboOnly: 1, ambiguous: 0, missingIdentity: 1, skipped: 0 });
  assert.equal(byKey["qbo-1::Purchase"].bizzi_transaction_id, TXN_ID);
  assert.equal(byKey["qbo-1::missing"].bizzi_transaction_id, null);
  assert.equal(byKey["qbo-1::missing"].linkage_status, "missing_qbo_identity");
  assert.equal(byKey["qbo-2::Purchase"].bizzi_transaction_id, null);
  assert.equal(byKey["qbo-2::Purchase"].linkage_status, "qbo_only");
});

test("missing QBO transaction type remains non-authoritative for future mutation eligibility", async () => {
  const db = makeDb();
  await createOrReplaceMonthlyPnlSnapshot({
    businessId: BUSINESS_ID,
    reviewYear: 2026,
    reviewMonth: 8,
    transactions: [sampleTransaction({
      qbo_txn_id: "has-id",
      qbo_txn_type: null,
      metadata: { mutation_authoritative: false },
    })],
    db,
  });

  const row = db.tables.monthly_review_qbo_pnl_transactions[0];
  assert.equal(row.qbo_txn_id, "has-id");
  assert.equal(row.qbo_txn_type, null);
  assert.equal(row.linkage_status, "missing_qbo_identity");
  assert.equal(row.bizzi_transaction_id, null);
  assert.equal(row.metadata.mutation_authoritative, false);
});

test("invalidation clears current snapshot identity without deleting historical detail", async () => {
  const db = makeDb();
  const result = await createOrReplaceMonthlyPnlSnapshot({
    businessId: BUSINESS_ID,
    reviewYear: 2026,
    reviewMonth: 8,
    accounts: [sampleAccount()],
    transactions: [sampleTransaction()],
    linkTransactions: false,
    db,
  });

  const invalidated = await invalidateMonthlyPnlSnapshot({
    businessId: BUSINESS_ID,
    reviewYear: 2026,
    reviewMonth: 8,
    snapshotId: result.snapshot.id,
    reason: "manual_refresh",
    db,
  });
  const latest = await getLatestMonthlyPnlSnapshot({
    businessId: BUSINESS_ID,
    reviewYear: 2026,
    reviewMonth: 8,
    db,
  });

  assert.equal(invalidated.invalidated.length, 1);
  assert.equal(db.tables.monthly_review_qbo_pnl_snapshots[0].is_current, false);
  assert.equal(db.tables.monthly_review_qbo_pnl_snapshots[0].status, "invalidated");
  assert.equal(db.tables.monthly_review_qbo_pnl_accounts.length, 1);
  assert.equal(db.tables.monthly_review_qbo_pnl_transactions.length, 1);
  assert.equal(latest, null);
});

test("linkage can be rerun safely for an existing snapshot without touching source bookkeeping rows", async () => {
  const db = makeDb({
    monthly_review_qbo_pnl_transactions: [
      {
        id: "30000000-0000-4000-8000-000000000001",
        snapshot_id: "10000000-0000-4000-8000-000000000001",
        business_id: BUSINESS_ID,
        qbo_txn_id: "qbo-1",
        qbo_txn_type: "Purchase",
        bizzi_transaction_id: null,
      },
    ],
    bank_transactions: [{ id: TXN_ID, business_id: BUSINESS_ID, is_archived: false }],
    transaction_categorizations: [
      { business_id: BUSINESS_ID, transaction_id: TXN_ID, qbo_txn_id: "qbo-1", qbo_txn_type: "Purchase", status: "posted" },
    ],
  });
  const before = structuredClone(db.tables.transaction_categorizations);

  const result = await linkSnapshotTransactionsToBizzi({
    businessId: BUSINESS_ID,
    snapshotId: "10000000-0000-4000-8000-000000000001",
    db,
  });

  assert.equal(result.linked, 1);
  assert.equal(db.tables.monthly_review_qbo_pnl_transactions[0].bizzi_transaction_id, TXN_ID);
  assert.deepEqual(db.tables.transaction_categorizations, before);
});

test("snapshot infrastructure introduces no QBO, Plaid, AI, or reclassification authority", () => {
  const source = read("src/services/bookkeeping/qboMonthlyPnlSnapshotService.js");

  assert.doesNotMatch(source, /getQBOClient|node-quickbooks|quickbooks|plaid|openai|reclassifyBookkeepingTransaction|approveBookkeepingTransactions/i);
  assert.match(source, /promote_monthly_review_qbo_pnl_snapshot/);
  assert.doesNotMatch(source, /\.from\("bank_transactions"\)\s*\.update/i);
  assert.doesNotMatch(source, /\.from\("transaction_categorizations"\)\s*\.update/i);
});
