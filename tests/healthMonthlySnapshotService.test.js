import test from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const {
  HEALTH_ACCOUNTING_METHOD,
  getLatestAvailableHealthMonth,
  getMonthlyHealthSummary,
  refreshMonthlyQboFinancialSnapshot,
} = await import("../src/services/accounting/healthMonthlySnapshotService.js");

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_BUSINESS_ID = "00000000-0000-4000-8000-000000000002";

function augustAccrualPnlFixture() {
  return {
    Header: {
      ReportName: "ProfitAndLoss",
      StartPeriod: "2026-08-01",
      EndPeriod: "2026-08-31",
      Option: [{ Name: "ReportBasis", Value: "Accrual" }],
    },
    Rows: {
      Row: [
        {
          Header: { ColData: [{ value: "Income" }] },
          Rows: { Row: [{ type: "Data", ColData: [{ value: "Services", id: "income-services" }, { value: "975.00" }] }] },
          Summary: { ColData: [{ value: "Total Income" }, { value: "975.00" }] },
        },
        {
          Header: { ColData: [{ value: "Cost of Goods Sold" }] },
          Rows: { Row: [] },
          Summary: { ColData: [{ value: "Total Cost of Goods Sold" }, { value: "0.00" }] },
        },
        {
          Header: { ColData: [{ value: "Expenses" }] },
          Rows: {
            Row: [
              { type: "Data", ColData: [{ value: "Payment Processing Fees", id: "expense-fees" }, { value: "32.90" }] },
              { type: "Data", ColData: [{ value: "Software", id: "expense-software" }, { value: "160.00" }] },
            ],
          },
          Summary: { ColData: [{ value: "Total Expenses" }, { value: "192.90" }] },
        },
        { Summary: { ColData: [{ value: "Net Operating Income" }, { value: "782.10" }] } },
        { Summary: { ColData: [{ value: "Net Income" }, { value: "782.10" }] } },
      ],
    },
  };
}

function makeDb(initial = {}) {
  const tables = {
    monthly_review_qbo_pnl_snapshots: [],
    monthly_review_qbo_pnl_accounts: [],
    monthly_review_qbo_pnl_transactions: [],
    transaction_categorizations: [],
    bank_transactions: [],
    financial_metrics: [],
    account_breakdown: [],
    expense_totals_monthly: [],
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
    this.pendingDelete = false;
    this.upsertConflict = null;
  }
  select() { return this; }
  eq(column, value) { this.filters.push((row) => String(row[column]) === String(value)); return this; }
  in(column, values) { const set = new Set((values || []).map(String)); this.filters.push((row) => set.has(String(row[column]))); return this; }
  order(column, options = {}) { this.orders.push({ column, ascending: options.ascending !== false }); return this; }
  limit(count) { this.limitCount = count; return this; }
  insert(payload) { this.pendingInsert = Array.isArray(payload) ? payload : [payload]; return this; }
  upsert(payload, options = {}) { this.pendingInsert = Array.isArray(payload) ? payload : [payload]; this.upsertConflict = options.onConflict || null; return this; }
  update(payload) { this.pendingUpdate = payload; return this; }
  delete() { this.pendingDelete = true; return this; }
  maybeSingle() { this.singleMode = "maybe"; return this; }
  single() { this.singleMode = "single"; return this; }
  then(resolve) {
    if (this.pendingDelete) {
      const rows = this.rows();
      this.tables[this.table] = (this.tables[this.table] || []).filter((row) => !rows.includes(row));
      return resolve({ data: rows, error: null, count: rows.length });
    }
    if (this.pendingInsert) {
      const inserted = this.pendingInsert.map((row) => this.insertOne(row));
      return resolveResult(resolve, inserted, this.singleMode);
    }
    if (this.pendingUpdate) {
      const rows = this.rows();
      rows.forEach((row) => Object.assign(row, structuredClone(this.pendingUpdate)));
      return resolveResult(resolve, rows.map((row) => ({ ...row })), this.singleMode);
    }
    return resolveResult(resolve, this.rows().map((row) => ({ ...row })), this.singleMode);
  }
  insertOne(row) {
    const table = this.tables[this.table] || [];
    if (this.upsertConflict) {
      const keys = this.upsertConflict.split(",").map((key) => key.trim());
      const existing = table.find((candidate) => keys.every((key) => String(candidate[key]) === String(row[key])));
      if (existing) {
        Object.assign(existing, structuredClone(row));
        return { ...existing };
      }
    }
    const id = row.id || nextId(this.table, table.length + 1);
    const copy = { id, ...structuredClone(row) };
    table.push(copy);
    this.tables[this.table] = table;
    return { ...copy };
  }
  rows() {
    let rows = this.tables[this.table] || [];
    for (const filter of this.filters) rows = rows.filter(filter);
    for (const { column, ascending } of this.orders) {
      rows = [...rows].sort((a, b) => (a[column] < b[column] ? (ascending ? -1 : 1) : (a[column] > b[column] ? (ascending ? 1 : -1) : 0)));
    }
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    return rows;
  }
}

function resolveResult(resolve, rows, singleMode) {
  if (singleMode) return resolve({ data: rows[0] || null, error: null, count: rows.length });
  return resolve({ data: rows, error: null, count: rows.length });
}

function nextId(table, offset) {
  const prefixes = {
    monthly_review_qbo_pnl_snapshots: "10000000",
    monthly_review_qbo_pnl_accounts: "20000000",
    monthly_review_qbo_pnl_transactions: "30000000",
  };
  return `${prefixes[table] || "90000000"}-0000-4000-8000-${String(offset).padStart(12, "0")}`;
}

test("Health monthly snapshot uses one Accrual QBO P&L source and replaces stale category rows", async () => {
  const db = makeDb({
    expense_totals_monthly: [
      { business_id: BUSINESS_ID, month: "2026-08-01", category: "Payment Processing Fees", amount: 14, source: "stale" },
      { business_id: OTHER_BUSINESS_ID, month: "2026-08-01", category: "Payment Processing Fees", amount: 14, source: "other" },
    ],
  });
  const calls = [];

  const summary = await refreshMonthlyQboFinancialSnapshot({
    db,
    businessId: BUSINESS_ID,
    year: 2026,
    month: 8,
    loadContext: async () => ({ realmId: "realm-1", qboEnvironment: "production" }),
    fetchReport: async (args) => {
      calls.push(args);
      return { report: augustAccrualPnlFixture(), reportName: args.reportName, realmId: args.realmId };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].reportName, "ProfitAndLoss");
  assert.equal(calls[0].accountingMethod, HEALTH_ACCOUNTING_METHOD);
  assert.equal(summary.metrics.totalRevenue, 975);
  assert.equal(summary.metrics.totalExpenses, 192.9);
  assert.equal(summary.metrics.netProfit, 782.1);
  assert.equal(summary.metrics.profitMargin, 80.22);
  assert.deepEqual(summary.expense_breakdown, [
    { category: "Software", amount: 160 },
    { category: "Payment Processing Fees", amount: 32.9 },
  ]);
  assert.equal(summary.snapshot.accounting_method, "Accrual");
  assert.equal(summary.snapshot.snapshot_complete, true);

  const rows = db.tables.expense_totals_monthly.filter((row) => row.business_id === BUSINESS_ID && row.month === "2026-08-01");
  assert.deepEqual(rows.map((row) => [row.category, row.amount]), [
    ["Software", 160],
    ["Payment Processing Fees", 32.9],
  ]);
  assert.equal(db.tables.expense_totals_monthly.find((row) => row.business_id === OTHER_BUSINESS_ID)?.amount, 14);
});

test("failed compatibility persistence does not promote a new current snapshot", async () => {
  const db = makeDb();
  const brokenDb = {
    tables: db.tables,
    from(table) {
      if (table === "expense_totals_monthly") return new FailingDeleteQuery(db.tables, table);
      return new Query(db.tables, table);
    },
  };

  await assert.rejects(
    refreshMonthlyQboFinancialSnapshot({
      db: brokenDb,
      businessId: BUSINESS_ID,
      year: 2026,
      month: 8,
      loadContext: async () => ({ realmId: "realm-1", qboEnvironment: "production" }),
      fetchReport: async (args) => ({ report: augustAccrualPnlFixture(), reportName: args.reportName, realmId: args.realmId }),
    }),
    /expense_totals_monthly_delete_failed/
  );

  assert.equal(db.tables.monthly_review_qbo_pnl_snapshots.some((row) => row.is_current === true), false);
});

class FailingDeleteQuery extends Query {
  then(resolve) {
    if (this.pendingDelete) return resolve({ data: null, error: { message: "delete failed" } });
    return super.then(resolve);
  }
}

test("available/latest Health months are derived from completed current snapshots", async () => {
  const db = makeDb({
    monthly_review_qbo_pnl_snapshots: [
      { id: "old", business_id: BUSINESS_ID, review_year: 2026, review_month: 9, is_current: true, status: "current", revenue: 0, expenses: 0, net_profit: 0, pulled_at: "2026-09-01T00:00:00Z" },
      { id: "aug", business_id: BUSINESS_ID, review_year: 2026, review_month: 8, is_current: true, status: "current", revenue: 975, expenses: 192.9, net_profit: 782.1, pulled_at: "2026-08-31T00:00:00Z" },
      { id: "bad", business_id: BUSINESS_ID, review_year: 2026, review_month: 7, is_current: false, status: "failed", revenue: 5, expenses: 0, net_profit: 5 },
    ],
  });

  const latest = await getLatestAvailableHealthMonth({ db, businessId: BUSINESS_ID });
  const summary = await getMonthlyHealthSummary({ db, businessId: BUSINESS_ID, year: 2026, month: 8 });

  assert.equal(latest.month, "2026-08-01");
  assert.equal(summary.data_status, "available");
  assert.equal(summary.metrics.totalRevenue, 975);
});
