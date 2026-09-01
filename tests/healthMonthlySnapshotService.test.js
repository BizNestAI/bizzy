/* global process */
import test from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const {
  HEALTH_ACCOUNTING_METHOD,
  getLatestAvailableHealthMonth,
  getMonthlyHealthSummary,
  getSelectedHealthWindowCoverage,
  refreshMonthlyQboFinancialSnapshot,
} = await import("../src/services/accounting/healthMonthlySnapshotService.js");

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_BUSINESS_ID = "00000000-0000-4000-8000-000000000002";

function augustCashPnlFixture(overrides = {}) {
  return {
    Header: {
      ReportName: "ProfitAndLoss",
      StartPeriod: "2026-08-01",
      EndPeriod: "2026-08-31",
      Option: [{ Name: "ReportBasis", Value: overrides.basis || "Cash" }],
    },
    Rows: {
      Row: [
        {
          Header: { ColData: [{ value: "Income" }] },
          Rows: { Row: [{ type: "Data", ColData: [{ value: "Services", id: "income-services" }, { value: "1175.00" }] }] },
          Summary: { ColData: [{ value: overrides.totalIncomeLabel || "Total Income" }, { value: "1175.00" }] },
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
          Summary: { ColData: [{ value: overrides.totalExpensesLabel || "Total Expenses" }, { value: "192.90" }] },
        },
        { Summary: { ColData: [{ value: "Net Operating Income" }, { value: "982.10" }] } },
        { Summary: { ColData: [{ value: "Net Income" }, { value: "982.10" }] } },
      ],
    },
  };
}

function decemberCashPnlFixture() {
  const expenseRows = [
    ["Alcohol/Nightlife", "15.75"],
    ["Apple Pay", "25.15"],
    ["Business Expenses", "14.00"],
    ["Coffee", "5.00"],
    ["Entertainment", "33.31"],
    ["Groceries", "24.65"],
    ["Meals", "325.36"],
    ["Payment Processing Fees", "32.20"],
    ["Prime Video", "114.58"],
    ["Rent", "1781.52"],
    ["Utilities", "98.02"],
    ["Venmo", "-553.00"],
  ];
  return {
    Header: {
      ReportName: "ProfitAndLoss",
      StartPeriod: "2025-12-01",
      EndPeriod: "2025-12-31",
      Option: [{ Name: "ReportBasis", Value: "Cash" }],
    },
    Rows: {
      Row: [
        {
          Header: { ColData: [{ value: "Income" }] },
          Rows: { Row: [{ type: "Data", ColData: [{ value: "Services", id: "income-services" }, { value: "1150.00" }] }] },
          Summary: { ColData: [{ value: "Total Income" }, { value: "1150.00" }] },
        },
        { Summary: { ColData: [{ value: "Gross Profit" }, { value: "1150.00" }] } },
        {
          Header: { ColData: [{ value: "Expenses" }] },
          Rows: {
            Row: expenseRows.map(([name, amount], index) => ({
              type: "Data",
              ColData: [{ value: name, id: `expense-${index}` }, { value: amount }],
            })),
          },
          Summary: { ColData: [{ value: "Total Expenses" }, { value: "1916.54" }] },
        },
        { Summary: { ColData: [{ value: "Net Operating Income" }, { value: "-766.54" }] } },
        {
          Header: { ColData: [{ value: "Other Income" }] },
          Rows: { Row: [{ type: "Data", ColData: [{ value: "Credit Card Rewards", id: "other-income-rewards" }, { value: "0.83" }] }] },
          Summary: { ColData: [{ value: "Total Other Income" }, { value: "0.83" }] },
        },
        { Summary: { ColData: [{ value: "Net Other Income" }, { value: "0.83" }] } },
        { Summary: { ColData: [{ value: "Net Income" }, { value: "-765.71" }] } },
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

test("Health monthly snapshot uses one Cash QBO P&L source and replaces stale category rows", async () => {
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
      return { report: augustCashPnlFixture(), reportName: args.reportName, realmId: args.realmId };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].reportName, "ProfitAndLoss");
  assert.equal(calls[0].accountingMethod, HEALTH_ACCOUNTING_METHOD);
  assert.equal(calls[0].accountingMethod, "Cash");
  assert.equal(summary.metrics.totalRevenue, 1175);
  assert.equal(summary.metrics.totalExpenses, 192.9);
  assert.equal(summary.metrics.netProfit, 982.1);
  assert.equal(summary.metrics.profitMargin, 83.58);
  assert.equal(summary.metrics.top_spending_category, "Software");
  assert.deepEqual(summary.metrics.topSpendingCategory, { name: "Software", amount: 160 });
  assert.deepEqual(summary.expense_breakdown, [
    { category: "Software", amount: 160 },
    { category: "Payment Processing Fees", amount: 32.9 },
  ]);
  assert.equal(summary.snapshot.accounting_method, "Cash");
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
      fetchReport: async (args) => ({ report: augustCashPnlFixture(), reportName: args.reportName, realmId: args.realmId }),
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
      { id: "aug", business_id: BUSINESS_ID, review_year: 2026, review_month: 8, is_current: true, status: "current", accounting_method: "Cash", revenue: 1175, expenses: 192.9, net_profit: 982.1, pulled_at: "2026-08-31T00:00:00Z" },
      { id: "bad", business_id: BUSINESS_ID, review_year: 2026, review_month: 7, is_current: false, status: "failed", revenue: 5, expenses: 0, net_profit: 5 },
    ],
  });

  const latest = await getLatestAvailableHealthMonth({ db, businessId: BUSINESS_ID });
  const summary = await getMonthlyHealthSummary({ db, businessId: BUSINESS_ID, year: 2026, month: 8 });

  assert.equal(latest.month, "2026-08-01");
  assert.equal(summary.data_status, "available");
  assert.equal(summary.metrics.totalRevenue, 1175);
  assert.equal(summary.metrics.top_spending_category, null);
  assert.equal(summary.prior_month.period, "2026-07-01");
  assert.equal(summary.prior_month.data_status, "missing");
  assert.equal(summary.series.revenue.at(-1).revenue, 1175);
  assert.equal(summary.series.revenue.at(-2).revenue, null);
});

test("Health summary compares only to the immediate prior calendar month", async () => {
  const db = makeDb({
    monthly_review_qbo_pnl_snapshots: [
      { id: "dec", business_id: BUSINESS_ID, review_year: 2025, review_month: 12, is_current: true, status: "current", accounting_method: "Cash", revenue: 800, expenses: 200, net_profit: 600 },
      { id: "jan", business_id: BUSINESS_ID, review_year: 2026, review_month: 1, is_current: true, status: "current", accounting_method: "Cash", revenue: 1000, expenses: 300, net_profit: 700 },
      { id: "nov", business_id: BUSINESS_ID, review_year: 2025, review_month: 11, is_current: true, status: "current", accounting_method: "Cash", revenue: 9999, expenses: 1, net_profit: 9998 },
    ],
  });

  const summary = await getMonthlyHealthSummary({ db, businessId: BUSINESS_ID, year: 2026, month: 1 });

  assert.equal(summary.data_status, "available");
  assert.equal(summary.prior_month.period, "2025-12-01");
  assert.equal(summary.prior_month.data_status, "available");
  assert.equal(summary.prior_month.metrics.totalRevenue, 800);
  assert.notEqual(summary.prior_month.metrics.totalRevenue, 9999);
});

test("selected Health window coverage uses current Cash snapshots and counts zero-value months", async () => {
  const expectedMonths = [
    "2025-09", "2025-10", "2025-11", "2025-12",
    "2026-01", "2026-02", "2026-03", "2026-04",
    "2026-05", "2026-06", "2026-07", "2026-08",
  ];
  const db = makeDb({
    monthly_review_qbo_pnl_snapshots: [
      ...expectedMonths.map((monthKey, index) => {
        const [yearPart, monthPart] = monthKey.split("-");
        return {
          id: `cash-${monthKey}`,
          business_id: BUSINESS_ID,
          review_year: Number(yearPart),
          review_month: Number(monthPart),
          accounting_method: "Cash",
          status: "current",
          is_current: true,
          revenue: index === 2 ? 0 : 100,
          expenses: index === 2 ? 0 : 20,
          net_profit: index === 2 ? 0 : 80,
        };
      }),
      { id: "accrual-sep", business_id: BUSINESS_ID, review_year: 2026, review_month: 9, accounting_method: "Accrual", status: "current", is_current: true },
      { id: "legacy-only-marker", business_id: BUSINESS_ID, review_year: 2026, review_month: 9, accounting_method: "Cash", status: "failed", is_current: false },
      { id: "other-business", business_id: OTHER_BUSINESS_ID, review_year: 2026, review_month: 9, accounting_method: "Cash", status: "current", is_current: true },
    ],
    financial_metrics: [
      { business_id: BUSINESS_ID, month: "2026-09-01", total_revenue: 5000 },
    ],
    expense_totals_monthly: [
      { business_id: BUSINESS_ID, month: "2026-09-01", category: "Software", amount: 50 },
    ],
  });

  const augustCoverage = await getSelectedHealthWindowCoverage({ db, businessId: BUSINESS_ID, year: 2026, month: 8 });
  const septemberCoverage = await getSelectedHealthWindowCoverage({ db, businessId: BUSINESS_ID, year: 2026, month: 9 });

  assert.equal(augustCoverage.complete, true);
  assert.equal(augustCoverage.covered_count, 12);
  assert.deepEqual(augustCoverage.window.expected_months, expectedMonths);
  assert.deepEqual(augustCoverage.missing_months, []);
  assert.ok(augustCoverage.covered_months.includes("2025-11"));

  assert.equal(septemberCoverage.complete, false);
  assert.equal(septemberCoverage.covered_count, 11);
  assert.deepEqual(septemberCoverage.window.expected_months, [
    "2025-10", "2025-11", "2025-12",
    "2026-01", "2026-02", "2026-03", "2026-04",
    "2026-05", "2026-06", "2026-07", "2026-08", "2026-09",
  ]);
  assert.deepEqual(septemberCoverage.missing_months, ["2026-09"]);
});

test("Health reads ignore current Accrual snapshots and require a current Cash snapshot", async () => {
  const db = makeDb({
    monthly_review_qbo_pnl_snapshots: [
      { id: "accrual-current", business_id: BUSINESS_ID, review_year: 2026, review_month: 8, is_current: true, status: "current", accounting_method: "Accrual", revenue: 975, expenses: 192.9, net_profit: 782.1 },
      { id: "cash-old", business_id: BUSINESS_ID, review_year: 2026, review_month: 8, is_current: false, status: "superseded", accounting_method: "Cash", revenue: 1175, expenses: 192.9, net_profit: 982.1 },
    ],
  });

  const summary = await getMonthlyHealthSummary({ db, businessId: BUSINESS_ID, year: 2026, month: 8 });
  const latest = await getLatestAvailableHealthMonth({ db, businessId: BUSINESS_ID });

  assert.equal(summary.data_status, "missing");
  assert.equal(summary.snapshot, null);
  assert.equal(latest, null);
});

test("Health refresh rejects non-Cash report basis", async () => {
  const db = makeDb();

  await assert.rejects(
    refreshMonthlyQboFinancialSnapshot({
      db,
      businessId: BUSINESS_ID,
      year: 2026,
      month: 8,
      accountingMethod: "Cash",
      loadContext: async () => ({ realmId: "realm-1", qboEnvironment: "production" }),
      fetchReport: async (args) => ({ report: augustCashPnlFixture({ basis: "Accrual" }), reportName: args.reportName, realmId: args.realmId }),
    }),
    /health_cash_basis_required/
  );
});

test("QBO summary parser accepts Total for Income and Total for Expenses labels", async () => {
  const db = makeDb();
  const summary = await refreshMonthlyQboFinancialSnapshot({
    db,
    businessId: BUSINESS_ID,
    year: 2026,
    month: 8,
    loadContext: async () => ({ realmId: "realm-1", qboEnvironment: "production" }),
    fetchReport: async (args) => ({
      report: augustCashPnlFixture({
        totalIncomeLabel: "Total for Income",
        totalExpensesLabel: "Total for Expenses",
      }),
      reportName: args.reportName,
      realmId: args.realmId,
    }),
  });

  assert.equal(summary.metrics.totalRevenue, 1175);
  assert.equal(summary.metrics.totalExpenses, 192.9);
  assert.equal(summary.metrics.netProfit, 982.1);
});

test("Health snapshot promotes zero-revenue Cash month with Other Income and null margin", async () => {
  const db = makeDb();
  const summary = await refreshMonthlyQboFinancialSnapshot({
    db,
    businessId: BUSINESS_ID,
    year: 2025,
    month: 11,
    loadContext: async () => ({ realmId: "realm-1", qboEnvironment: "production" }),
    fetchReport: async () => ({
      report: {
        Header: {
          ReportName: "ProfitAndLoss",
          StartPeriod: "2025-11-01",
          EndPeriod: "2025-11-30",
          Option: [{ Name: "ReportBasis", Value: "Cash" }],
        },
        Rows: {
          Row: [
            { Header: { ColData: [{ value: "Income" }] }, Rows: { Row: [] } },
            {
              Header: { ColData: [{ value: "Expenses" }] },
              Rows: { Row: [{ type: "Data", ColData: [{ value: "Rent", id: "rent" }, { value: "2664.31" }] }] },
              Summary: { ColData: [{ value: "Total Expenses" }, { value: "2664.31" }] },
            },
            { Summary: { ColData: [{ value: "Net Operating Income" }, { value: "-2664.31" }] } },
            {
              Header: { ColData: [{ value: "Other Income" }] },
              Rows: { Row: [{ type: "Data", ColData: [{ value: "Credit Card Rewards", id: "rewards" }, { value: "6.97" }] }] },
              Summary: { ColData: [{ value: "Total Other Income" }, { value: "6.97" }] },
            },
            { Summary: { ColData: [{ value: "Net Other Income" }, { value: "6.97" }] } },
            { Summary: { ColData: [{ value: "Net Income" }, { value: "-2657.34" }] } },
          ],
        },
      },
      reportName: "ProfitAndLoss",
      realmId: "realm-1",
    }),
  });

  assert.equal(summary.data_status, "available");
  assert.equal(summary.metrics.totalRevenue, 0);
  assert.equal(summary.metrics.totalExpenses, 2664.31);
  assert.equal(summary.metrics.netProfit, -2657.34);
  assert.equal(summary.metrics.profitMargin, null);
  assert.equal(summary.snapshot.accounting_method, "Cash");
  assert.equal(db.tables.monthly_review_qbo_pnl_snapshots[0].metadata.pnl_components.other_income, 6.97);
});

test("Health snapshot reconciliation preserves signed contra-expense rows", async () => {
  const db = makeDb();
  const summary = await refreshMonthlyQboFinancialSnapshot({
    db,
    businessId: BUSINESS_ID,
    year: 2025,
    month: 12,
    loadContext: async () => ({ realmId: "realm-1", qboEnvironment: "production" }),
    fetchReport: async (args) => ({
      report: decemberCashPnlFixture(),
      reportName: args.reportName,
      realmId: args.realmId,
    }),
  });

  const accountRows = db.tables.monthly_review_qbo_pnl_accounts;
  const venmo = accountRows.find((row) => row.account_name === "Venmo");
  const signedExpenseTotal = accountRows
    .filter((row) => row.account_type === "Expense")
    .reduce((sum, row) => Math.round((sum + Number(row.total_amount || 0)) * 100) / 100, 0);
  const absoluteExpenseTotal = accountRows
    .filter((row) => row.account_type === "Expense")
    .reduce((sum, row) => Math.round((sum + Math.abs(Number(row.total_amount || 0))) * 100) / 100, 0);

  assert.equal(summary.data_status, "available");
  assert.equal(summary.metrics.totalRevenue, 1150);
  assert.equal(summary.metrics.totalExpenses, 1916.54);
  assert.equal(summary.metrics.netProfit, -765.71);
  assert.equal(summary.metrics.profitMargin, -66.58);
  assert.equal(summary.snapshot.accounting_method, "Cash");
  assert.equal(summary.snapshot.snapshot_complete, true);
  assert.equal(venmo.total_amount, -553);
  assert.equal(signedExpenseTotal, 1916.54);
  assert.equal(absoluteExpenseTotal, 3022.54);
  assert.equal(summary.expense_display_totals.gross_positive_expenses, 2469.54);
  assert.equal(summary.expense_display_totals.refunds_and_credits, -553);
  assert.equal(summary.expense_display_totals.net_expenses, 1916.54);
  assert.deepEqual(summary.expense_adjustments, [{ category: "Venmo", amount: -553 }]);
  assert.equal(db.tables.monthly_review_qbo_pnl_snapshots[0].metadata.reconciliation.account_totals.expenses, 1916.54);
  assert.equal(db.tables.monthly_review_qbo_pnl_snapshots[0].metadata.reconciliation.components.qbo_net_income, -765.71);
});
