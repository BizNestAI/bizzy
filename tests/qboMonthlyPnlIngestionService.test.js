import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const {
  buildAccountIdentityResolver,
  fetchMonthlyQboPnlAccountTransactions,
  fetchPreferredDetailReport,
  normalizeDetailTransactions,
  normalizeQboPnlSnapshotPayload,
  parseProfitAndLossSummary,
  refreshMonthlyQboPnlSnapshot,
} = await import("../src/services/bookkeeping/qboMonthlyPnlIngestionService.js");
const {
  createOrReplaceMonthlyPnlSnapshot,
  getLatestMonthlyPnlSnapshot,
} = await import("../src/services/bookkeeping/qboMonthlyPnlSnapshotService.js");

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const TXN_ID = "00000000-0000-4000-8000-000000000101";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function pnlSummaryFixture(overrides = {}) {
  const sales = Number(overrides.sales ?? 3217.45);
  const cogs = Number(overrides.cogs ?? 100);
  const expenses = Number(overrides.expenses ?? 42.5);
  const otherIncome = Number(overrides.otherIncome ?? 0);
  const otherExpense = Number(overrides.otherExpense ?? 0);
  const net = Number(overrides.net ?? (sales - cogs - expenses + otherIncome - otherExpense));
  const rows = [
    {
      Header: { ColData: [{ value: "Income" }] },
      Rows: { Row: [{ type: "Data", ColData: [{ value: "Sales of Product Income", id: "1" }, { value: String(sales) }] }] },
      Summary: { ColData: [{ value: "Total Income" }, { value: String(sales) }] },
    },
    {
      Header: { ColData: [{ value: "Cost of Goods Sold" }] },
      Rows: { Row: cogs === 0 ? [] : [{ type: "Data", ColData: [{ value: "Materials", id: "2" }, { value: String(cogs) }] }] },
      Summary: { ColData: [{ value: "Total Cost of Goods Sold" }, { value: String(cogs) }] },
    },
    {
      Header: { ColData: [{ value: "Expenses" }] },
      Rows: { Row: expenses === 0 ? [] : [{ type: "Data", ColData: [{ value: "Meals", id: "3" }, { value: String(expenses) }] }] },
      Summary: { ColData: [{ value: "Total Expenses" }, { value: String(expenses) }] },
    },
  ];
  if (otherIncome !== 0) {
    rows.push({
      Header: { ColData: [{ value: "Other Income" }] },
      Rows: { Row: [{ type: "Data", ColData: [{ value: "Interest Income", id: "5" }, { value: String(otherIncome) }] }] },
      Summary: { ColData: [{ value: "Total Other Income" }, { value: String(otherIncome) }] },
    });
  }
  if (otherExpense !== 0) {
    rows.push({
      Header: { ColData: [{ value: "Other Expenses" }] },
      Rows: { Row: [{ type: "Data", ColData: [{ value: "Bank Penalties", id: "6" }, { value: String(otherExpense) }] }] },
      Summary: { ColData: [{ value: "Total Other Expenses" }, { value: String(otherExpense) }] },
    });
  }
  rows.push({ Summary: { ColData: [{ value: "Net Income" }, { value: String(net) }] } });
  return {
    Header: {
      ReportName: "ProfitAndLoss",
      StartPeriod: "2026-08-01",
      EndPeriod: "2026-08-31",
      Option: [{ Name: "ReportBasis", Value: "Cash" }],
      ...(overrides.Header || {}),
    },
    Rows: {
      Row: rows,
    },
    ...overrides,
  };
}

function pnlDetailFixture(overrides = {}) {
  return {
    Header: {
      ReportName: "ProfitAndLossDetail",
      StartPeriod: "2026-08-01",
      EndPeriod: "2026-08-31",
    },
    Columns: {
      Column: [
        { ColTitle: "Date" },
        { ColTitle: "Transaction Type" },
        { ColTitle: "Name" },
        { ColTitle: "Memo/Description" },
        { ColTitle: "Account" },
        { ColTitle: "Amount" },
      ],
    },
    Rows: {
      Row: [
        {
          Header: { ColData: [{ value: "Sales of Product Income", id: "1" }] },
          Rows: {
            Row: [
              {
                type: "Data",
                ColData: [
                  { value: "2026-08-09" },
                  { value: "Deposit", id: "income-1" },
                  { value: "Intuit" },
                  { value: "ACH credit" },
                  { value: "Sales of Product Income", id: "1" },
                  { value: "3217.45" },
                ],
              },
            ],
          },
        },
        {
          Header: { ColData: [{ value: "Materials", id: "2" }] },
          Rows: {
            Row: [
              {
                type: "Data",
                ColData: [
                  { value: "2026-08-10" },
                  { value: "Expense", id: "cogs-1" },
                  { value: "Supplier" },
                  { value: "Materials" },
                  { value: "Materials", id: "2" },
                  { value: "100.00" },
                ],
              },
            ],
          },
        },
        {
          Header: { ColData: [{ value: "Meals", id: "3" }] },
          Rows: {
            Row: [
              {
                type: "Data",
                ColData: [
                  { value: "2026-08-22" },
                  { value: "Expense", id: "9001" },
                  { value: "Apple" },
                  { value: "Team lunch" },
                  { value: "Meals", id: "3" },
                  { value: "42.50" },
                ],
              },
              {
                type: "Data",
                ColData: [
                  { value: "2026-07-31" },
                  { value: "Expense", id: "older" },
                  { value: "Outside month" },
                  { value: "Outside month" },
                  { value: "Meals", id: "3" },
                  { value: "10.00" },
                ],
              },
            ],
          },
        },
      ],
    },
    ...overrides,
  };
}

function coaFixture(extra = []) {
  return [
    { id: "1", name: "Sales of Product Income", fullyQualifiedName: "Sales of Product Income", type: "Income", subType: "SalesOfProductIncome" },
    { id: "2", name: "Materials", fullyQualifiedName: "Cost of Goods Sold:Materials", type: "Cost of Goods Sold", subType: "SuppliesMaterialsCogs" },
    { id: "3", name: "Meals", fullyQualifiedName: "Expenses:Meals", type: "Expense", subType: "MealsEntertainment" },
    { id: "5", name: "Interest Income", fullyQualifiedName: "Other Income:Interest Income", type: "Other Income", subType: "InterestEarned" },
    { id: "6", name: "Bank Penalties", fullyQualifiedName: "Other Expenses:Bank Penalties", type: "Other Expense", subType: "PenaltiesSettlements" },
    ...extra,
  ];
}

function makeDb(initial = {}) {
  const tables = {
    monthly_review_qbo_pnl_snapshots: [],
    monthly_review_qbo_pnl_accounts: [],
    monthly_review_qbo_pnl_transactions: [],
    bank_transactions: [],
    transaction_categorizations: [],
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
  eq(column, value) { this.filters.push((row) => String(row[column]) === String(value)); return this; }
  in(column, values) { const set = new Set((values || []).map(String)); this.filters.push((row) => set.has(String(row[column]))); return this; }
  order(column, options = {}) { this.orders.push({ column, ascending: options.ascending !== false }); return this; }
  limit(count) { this.limitCount = count; return this; }
  range(start, end) { this.rangeStart = start; this.rangeEnd = end; return this; }
  insert(payload) { this.pendingInsert = Array.isArray(payload) ? payload : [payload]; return this; }
  update(payload) { this.pendingUpdate = payload; return this; }
  then(resolve) {
    if (this.pendingInsert) {
      const inserted = this.pendingInsert.map((row) => {
        const id = row.id || nextId(this.table, this.tables[this.table].length + 1);
        const copy = { id, ...structuredClone(row) };
        this.tables[this.table].push(copy);
        return { ...copy };
      });
      return resolve({ data: inserted, error: null, count: inserted.length });
    }
    if (this.pendingUpdate) {
      const rows = this.rows();
      rows.forEach((row) => Object.assign(row, structuredClone(this.pendingUpdate)));
      return resolve({ data: rows.map((row) => ({ ...row })), error: null, count: rows.length });
    }
    const rows = this.rows();
    return resolve({ data: rows.map((row) => ({ ...row })), error: null, count: rows.length });
  }
  rows() {
    let rows = this.tables[this.table] || [];
    for (const filter of this.filters) rows = rows.filter(filter);
    for (const { column, ascending } of this.orders) {
      rows = [...rows].sort((a, b) => (a[column] < b[column] ? (ascending ? -1 : 1) : (a[column] > b[column] ? (ascending ? 1 : -1) : 0)));
    }
    if (this.rangeStart !== undefined) rows = rows.slice(this.rangeStart, this.rangeEnd + 1);
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

test("ProfitAndLoss summary parsing uses QBO KPIs and selected-month report dates", () => {
  const parsed = parseProfitAndLossSummary(pnlSummaryFixture(), {
    reviewYear: 2026,
    reviewMonth: 8,
    sourceStartDate: "2026-08-01",
    sourceEndDate: "2026-08-31",
  });

  assert.equal(parsed.revenue, 3217.45);
  assert.equal(parsed.cogs, 100);
  assert.equal(parsed.expenses, 42.5);
  assert.equal(parsed.net_profit, 3074.95);
  assert.equal(parsed.accounting_method, "Cash");
  assert.equal(parsed.account_rows.length, 3);
});

test("ProfitAndLoss summary supports zero COGS and Other Income/Other Expense without recomputing Net Profit", () => {
  const parsed = parseProfitAndLossSummary(pnlSummaryFixture({
    cogs: 0,
    otherIncome: 25,
    otherExpense: 5,
    net: 3194.95,
  }), {
    reviewYear: 2026,
    reviewMonth: 8,
    sourceStartDate: "2026-08-01",
    sourceEndDate: "2026-08-31",
  });

  assert.equal(parsed.cogs, 0);
  assert.equal(parsed.other_income, 25);
  assert.equal(parsed.other_expense, 5);
  assert.equal(parsed.net_profit, 3194.95);
});

test("ProfitAndLoss summary fails closed when authoritative QBO totals are missing", () => {
  assert.throws(() => parseProfitAndLossSummary(pnlSummaryFixture({
    Rows: { Row: [{ Summary: { ColData: [{ value: "Net Income" }, { value: "10.00" }] } }] },
  }), {
    reviewYear: 2026,
    reviewMonth: 8,
    sourceStartDate: "2026-08-01",
    sourceEndDate: "2026-08-31",
  }), /qbo_summary_required_total_missing/);
});

test("summary parser rejects report date mismatches", () => {
  assert.throws(() => parseProfitAndLossSummary(pnlSummaryFixture({ Header: { StartPeriod: "2026-07-01", EndPeriod: "2026-07-31" } }), {
    reviewYear: 2026,
    reviewMonth: 8,
    sourceStartDate: "2026-08-01",
    sourceEndDate: "2026-08-31",
  }), /qbo_summary_date_mismatch/);
});

test("account identity is resolved by report id, fully-qualified path, or unique exact name", () => {
  const resolver = buildAccountIdentityResolver(coaFixture());

  assert.equal(resolver.resolve({ id: "3", name: "Meals" }).account.id, "3");
  assert.equal(resolver.resolve({ path: "Expenses:Meals" }).account.id, "3");
  assert.equal(resolver.resolve({ name: "Sales of Product Income" }).account.id, "1");
});

test("ambiguous duplicate account names fail closed during normalization", () => {
  assert.throws(() => normalizeQboPnlSnapshotPayload({
    businessId: BUSINESS_ID,
    reviewYear: 2026,
    reviewMonth: 8,
    realmId: "realm-1",
    sourceStartDate: "2026-08-01",
    sourceEndDate: "2026-08-31",
    summaryReport: pnlSummaryFixture({
      Rows: { Row: [
        pnlSummaryFixture().Rows.Row[0],
        pnlSummaryFixture().Rows.Row[1],
        {
          Header: { ColData: [{ value: "Expenses" }] },
          Rows: { Row: [{ type: "Data", ColData: [{ value: "Meals" }, { value: "42.50" }] }] },
          Summary: { ColData: [{ value: "Total Expenses" }, { value: "42.50" }] },
        },
        pnlSummaryFixture().Rows.Row[3],
      ] },
    }),
    detailReport: pnlDetailFixture(),
    detailReportName: "ProfitAndLossDetail",
    qboAccounts: coaFixture([{ id: "4", name: "Meals", fullyQualifiedName: "Travel:Meals", type: "Expense" }]),
  }), /qbo_account_identity_ambiguous/);
});

test("ProfitAndLossDetail normalization preserves QBO transaction identity and filters selected month", () => {
  const rows = normalizeDetailTransactions(pnlDetailFixture(), {
    detailReportName: "ProfitAndLossDetail",
    sourceStartDate: "2026-08-01",
    sourceEndDate: "2026-08-31",
    resolver: buildAccountIdentityResolver(coaFixture()),
  });

  assert.equal(rows.length, 3);
  const meal = rows.find((row) => row.qbo_txn_id === "9001");
  assert.equal(meal.qbo_txn_type, "Expense");
  assert.equal(meal.qbo_account_id, "3");
  assert.equal(meal.description, "Team lunch");
});

test("ProfitAndLossDetail ignores summary, subtotal, blank, and parent rows as transactions", () => {
  const rows = normalizeDetailTransactions(pnlDetailFixture({
    Rows: {
      Row: [{
        Header: { ColData: [{ value: "Expenses", id: "expense-header" }] },
        Rows: {
          Row: [
            { type: "Section", Header: { ColData: [{ value: "Meals", id: "3" }] }, Summary: { ColData: [{ value: "Total Meals" }, { value: "42.50" }] } },
            { type: "Data", ColData: [] },
            {
              type: "Data",
              ColData: [
                { value: "2026-08-22" },
                { value: "Expense", id: "9001" },
                { value: "Apple" },
                { value: "Team lunch" },
                { value: "Meals", id: "3" },
                { value: "42.50" },
              ],
            },
            { Summary: { ColData: [{ value: "Total Expenses" }, { value: "42.50" }] } },
          ],
        },
      }],
    },
  }), {
    detailReportName: "ProfitAndLossDetail",
    sourceStartDate: "2026-08-01",
    sourceEndDate: "2026-08-31",
    resolver: buildAccountIdentityResolver(coaFixture()),
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].qbo_txn_id, "9001");
  assert.equal(rows[0].qbo_account_id, "3");
});

test("detail normalization rejects dated transaction rows without QBO id/type instead of fabricating identity", () => {
  const detail = pnlDetailFixture({
    Rows: {
      Row: [{
        Rows: { Row: [{ type: "Data", ColData: [{ value: "2026-08-22" }, { value: "Expense" }, { value: "Apple" }, { value: "Team lunch" }, { value: "Meals" }, { value: "42.50" }] }] },
      }],
    },
  });
  assert.throws(() => normalizeDetailTransactions(detail, {
    detailReportName: "ProfitAndLossDetail",
    sourceStartDate: "2026-08-01",
    sourceEndDate: "2026-08-31",
    resolver: buildAccountIdentityResolver(coaFixture()),
  }), /qbo_detail_transaction_identity_missing/);
});

test("detail normalization rejects QBO id with missing transaction type and never uses structural row.type", () => {
  const detail = pnlDetailFixture({
    Columns: {
      Column: [
        { ColTitle: "Date" },
        { ColTitle: "Doc Number" },
        { ColTitle: "Name" },
        { ColTitle: "Memo/Description" },
        { ColTitle: "Account" },
        { ColTitle: "Amount" },
      ],
    },
    Rows: {
      Row: [{
        Header: { ColData: [{ value: "Meals", id: "3" }] },
        Rows: {
          Row: [{
            type: "Data",
            ColData: [
              { value: "2026-08-22" },
              { value: "ABC-123", id: "doc-id-1" },
              { value: "Apple" },
              { value: "Team lunch" },
              { value: "Meals", id: "3" },
              { value: "42.50" },
            ],
          }],
        },
      }],
    },
  });

  assert.throws(() => normalizeDetailTransactions(detail, {
    detailReportName: "ProfitAndLossDetail",
    sourceStartDate: "2026-08-01",
    sourceEndDate: "2026-08-31",
    resolver: buildAccountIdentityResolver(coaFixture()),
  }), /qbo_detail_transaction_identity_missing/);
});

test("structural report row types never become qbo_txn_type", () => {
  for (const structuralType of ["Data", "Section", "Header", "Summary"]) {
    const detail = pnlDetailFixture({
      Rows: {
        Row: [{
          Rows: {
            Row: [{
              type: structuralType,
              ColData: [
                { value: "2026-08-22" },
                { value: "ABC-123", id: `doc-${structuralType}` },
                { value: "Apple" },
                { value: "Team lunch" },
                { value: "Meals", id: "3" },
                { value: "42.50" },
              ],
            }],
          },
        }],
      },
      Columns: {
        Column: [
          { ColTitle: "Date" },
          { ColTitle: "Doc Number" },
          { ColTitle: "Name" },
          { ColTitle: "Memo/Description" },
          { ColTitle: "Account" },
          { ColTitle: "Amount" },
        ],
      },
    });

    const run = () => normalizeDetailTransactions(detail, {
      detailReportName: "ProfitAndLossDetail",
      sourceStartDate: "2026-08-01",
      sourceEndDate: "2026-08-31",
      resolver: buildAccountIdentityResolver(coaFixture()),
    });
    if (structuralType === "Data") {
      assert.throws(run, /qbo_detail_transaction_identity_missing/);
    } else {
      assert.deepEqual(run(), []);
    }
  }
});

test("merchant date amount account and memo do not infer missing qbo transaction type", () => {
  const detail = pnlDetailFixture({
    Columns: {
      Column: [
        { ColTitle: "Date" },
        { ColTitle: "Doc Number" },
        { ColTitle: "Name" },
        { ColTitle: "Memo/Description" },
        { ColTitle: "Account" },
        { ColTitle: "Amount" },
      ],
    },
    Rows: {
      Row: [{
        Rows: {
          Row: [{
            type: "Data",
            ColData: [
              { value: "2026-08-22" },
              { value: "APPLE-42", id: "doc-id-2" },
              { value: "Apple Store" },
              { value: "Purchase of equipment" },
              { value: "Meals", id: "3" },
              { value: "42.50" },
            ],
          }],
        },
      }],
    },
  });

  assert.throws(() => normalizeDetailTransactions(detail, {
    detailReportName: "ProfitAndLossDetail",
    sourceStartDate: "2026-08-01",
    sourceEndDate: "2026-08-31",
    resolver: buildAccountIdentityResolver(coaFixture()),
  }), /qbo_detail_transaction_identity_missing/);
});

test("detail fetch prefers ProfitAndLossDetail and falls back only to GeneralLedger when unsupported", async () => {
  const calls = [];
  const result = await fetchPreferredDetailReport({
    businessId: BUSINESS_ID,
    realmId: "realm-1",
    startDate: "2026-08-01",
    endDate: "2026-08-31",
    accountingMethod: "Cash",
    fetchReport: async ({ reportName }) => {
      calls.push(reportName);
      if (reportName === "ProfitAndLossDetail") {
        const err = new Error("unsupported");
        err.status = 400;
        throw err;
      }
      return { report: pnlDetailFixture(), reportName };
    },
  });

  assert.deepEqual(calls, ["ProfitAndLossDetail", "GeneralLedger"]);
  assert.equal(result.reportName, "GeneralLedger");
});

test("detail fetch does not use GeneralLedger fallback for arbitrary ProfitAndLossDetail 400 errors", async () => {
  const calls = [];
  await assert.rejects(() => fetchPreferredDetailReport({
    businessId: BUSINESS_ID,
    realmId: "realm-1",
    startDate: "2026-08-01",
    endDate: "2026-08-31",
    accountingMethod: "Cash",
    fetchReport: async ({ reportName }) => {
      calls.push(reportName);
      const err = new Error("malformed date");
      err.status = 400;
      err.details = { provider_error: "Bad Request: malformed date" };
      throw err;
    },
  }), /malformed date/);

  assert.deepEqual(calls, ["ProfitAndLossDetail"]);
});

test("GeneralLedger fallback keeps only QBO COA P&L accounts", () => {
  const gl = pnlDetailFixture({
    Header: { ReportName: "GeneralLedger", StartPeriod: "2026-08-01", EndPeriod: "2026-08-31" },
    Rows: {
      Row: [{
        Rows: {
          Row: [
            {
              type: "Data",
              ColData: [
                { value: "2026-08-01" },
                { value: "Deposit", id: "bank-1" },
                { value: "Bank" },
                { value: "Balance sheet row" },
                { value: "Checking", id: "10" },
                { value: "500.00" },
              ],
            },
            {
              type: "Data",
              ColData: [
                { value: "2026-08-02" },
                { value: "Journal Entry", id: "equity-1" },
                { value: "Owner" },
                { value: "Equity row" },
                { value: "Owner's Equity", id: "11" },
                { value: "250.00" },
              ],
            },
            {
              type: "Data",
              ColData: [
                { value: "2026-08-03" },
                { value: "Expense", id: "expense-1" },
                { value: "Apple" },
                { value: "P&L row" },
                { value: "Meals", id: "3" },
                { value: "42.50" },
              ],
            },
          ],
        },
      }],
    },
  });
  const qboAccounts = coaFixture([
    { id: "10", name: "Checking", fullyQualifiedName: "Checking", type: "Bank" },
    { id: "11", name: "Owner's Equity", fullyQualifiedName: "Owner's Equity", type: "Equity" },
  ]);
  const rows = normalizeDetailTransactions(gl, {
    detailReportName: "GeneralLedger",
    sourceStartDate: "2026-08-01",
    sourceEndDate: "2026-08-31",
    resolver: buildAccountIdentityResolver(qboAccounts),
    qboAccounts,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].qbo_txn_id, "expense-1");
  assert.equal(rows[0].qbo_account_id, "3");
});

test("incomplete account detail is explicit metadata and does not block QBO-authoritative snapshot", async () => {
  const db = makeDb();

  const result = await refreshMonthlyQboPnlSnapshot({
    businessId: BUSINESS_ID,
    year: 2026,
    month: 8,
    db,
    loadContext: async () => ({ realmId: "realm-1", qboEnvironment: "production" }),
    fetchAccounts: async () => coaFixture(),
    fetchReport: async ({ reportName }) => reportName === "ProfitAndLoss"
      ? { report: pnlSummaryFixture(), reportName }
      : { report: pnlDetailFixture({
          Rows: {
            Row: [{
              Header: { ColData: [{ value: "Sales of Product Income", id: "1" }] },
              Rows: { Row: [pnlDetailFixture().Rows.Row[0].Rows.Row[0]] },
            }],
          },
        }), reportName },
  });

  assert.equal(result.snapshot.revenue, 3217.45);
  assert.equal(db.tables.monthly_review_qbo_pnl_snapshots.length, 1);
  const meals = db.tables.monthly_review_qbo_pnl_accounts.find((row) => row.account_name === "Meals");
  assert.equal(meals.metadata.detail_completeness, "unavailable");
  assert.equal(result.snapshot.metadata.reconciliation.detail_status, "incomplete");
});

test("realistic August 2026 QBO P&L summary ingests with incomplete detail semantics", async () => {
  const db = makeDb();
  const result = await refreshMonthlyQboPnlSnapshot({
    businessId: BUSINESS_ID,
    year: 2026,
    month: 8,
    db,
    loadContext: async () => ({ realmId: "realm-1", qboEnvironment: "production" }),
    fetchAccounts: async () => coaFixture(),
    fetchReport: async ({ reportName }) => reportName === "ProfitAndLoss"
      ? { report: pnlSummaryFixture({
          sales: 1175,
          cogs: 0,
          expenses: 192.9,
          net: 982.1,
        }), reportName }
      : { report: pnlDetailFixture({
          Rows: {
            Row: [{
              Header: { ColData: [{ value: "Sales of Product Income", id: "1" }] },
              Rows: {
                Row: [{
                  type: "Data",
                  ColData: [
                    { value: "2026-08-10" },
                    { value: "Deposit", id: "income-aug-1" },
                    { value: "Intuit" },
                    { value: "ACH credit" },
                    { value: "Sales of Product Income", id: "1" },
                    { value: "1175.00" },
                  ],
                }],
              },
            }],
          },
        }), reportName },
  });

  assert.equal(Number(result.snapshot.revenue), 1175);
  assert.equal(Number(result.snapshot.expenses), 192.9);
  assert.equal(Number(result.snapshot.net_profit), 982.1);
  assert.equal(result.snapshot.metadata.reconciliation.status, "valid");
  assert.equal(result.snapshot.metadata.reconciliation.detail_status, "incomplete");
  assert.equal(result.transactions.length, 1);
  const meals = db.tables.monthly_review_qbo_pnl_accounts.find((row) => row.account_name === "Meals");
  assert.equal(meals.metadata.detail_completeness, "unavailable");
});

test("material summary/account reconciliation mismatch fails before snapshot persistence", async () => {
  const db = makeDb();

  await assert.rejects(() => refreshMonthlyQboPnlSnapshot({
    businessId: BUSINESS_ID,
    year: 2026,
    month: 8,
    db,
    loadContext: async () => ({ realmId: "realm-1", qboEnvironment: "production" }),
    fetchAccounts: async () => coaFixture(),
    fetchReport: async ({ reportName }) => reportName === "ProfitAndLoss"
      ? { report: pnlSummaryFixture({
          Rows: { Row: [
            {
              Header: { ColData: [{ value: "Income" }] },
              Rows: { Row: [{ type: "Data", ColData: [{ value: "Sales of Product Income", id: "1" }, { value: "1000.00" }] }] },
              Summary: { ColData: [{ value: "Total Income" }, { value: "1175.00" }] },
            },
            pnlSummaryFixture().Rows.Row[2],
            { Summary: { ColData: [{ value: "Net Income" }, { value: "1132.50" }] } },
          ] },
        }), reportName }
      : { report: pnlDetailFixture(), reportName },
  }), (err) => {
    assert.equal(err.error, "qbo_pnl_reconciliation_failed");
    assert.ok(Array.isArray(err.details.checks));
    assert.equal(err.details.diagnostics.detail_report, "ProfitAndLossDetail");
    assert.equal(err.details.diagnostics.summary_totals.revenue, 1175);
    assert.equal(err.details.diagnostics.account_totals.revenue, 1000);
    assert.ok(err.details.diagnostics.failed_checks.some((check) => check.name === "summary_vs_accounts.revenue"));
    assert.equal(err.details.diagnostics.raw_qbo_payload, undefined);
    return true;
  });

  assert.equal(db.tables.monthly_review_qbo_pnl_snapshots.length, 0);
});

test("failed promotion leaves previous current snapshot intact", async () => {
  const db = makeDb();
  const previous = await createOrReplaceMonthlyPnlSnapshot({
    businessId: BUSINESS_ID,
    reviewYear: 2026,
    reviewMonth: 8,
    revenue: 1,
    accounts: [],
    transactions: [],
    linkTransactions: false,
    db,
  });

  await assert.rejects(() => refreshMonthlyQboPnlSnapshot({
    businessId: BUSINESS_ID,
    year: 2026,
    month: 8,
    db,
    loadContext: async () => ({ realmId: "realm-1", qboEnvironment: "production" }),
    fetchAccounts: async () => coaFixture(),
    fetchReport: async ({ reportName }) => reportName === "ProfitAndLoss"
      ? { report: pnlSummaryFixture(), reportName }
      : { report: pnlDetailFixture(), reportName },
    promoteSnapshot: async () => {
      throw new Error("simulated promotion failure");
    },
  }), /qbo_pnl_snapshot_refresh_failed/);

  const latest = await getLatestMonthlyPnlSnapshot({ businessId: BUSINESS_ID, reviewYear: 2026, reviewMonth: 8, db });
  assert.equal(latest.id, previous.snapshot.id);
  assert.equal(db.tables.monthly_review_qbo_pnl_snapshots.filter((row) => row.is_current).length, 1);
  assert.equal(db.tables.monthly_review_qbo_pnl_snapshots.find((row) => row.id !== previous.snapshot.id).status, "failed");
});

test("refresh builds a QBO-authoritative snapshot, preserves QBO-only rows, and links exact Bizzi rows", async () => {
  const db = makeDb({
    bank_transactions: [{ id: TXN_ID, business_id: BUSINESS_ID, is_archived: false }],
    transaction_categorizations: [
      { business_id: BUSINESS_ID, transaction_id: TXN_ID, qbo_txn_id: "9001", qbo_txn_type: "Purchase", status: "posted" },
    ],
  });
  const reportsCalled = [];
  const result = await refreshMonthlyQboPnlSnapshot({
    businessId: BUSINESS_ID,
    year: 2026,
    month: 8,
    db,
    loadContext: async () => ({ realmId: "realm-1", qboEnvironment: "production" }),
    fetchAccounts: async () => coaFixture(),
    fetchReport: async ({ reportName }) => {
      reportsCalled.push(reportName);
      if (reportName === "ProfitAndLoss") return { report: pnlSummaryFixture({ sales: 3267.45, net: 3124.95 }), reportName };
      return {
        report: pnlDetailFixture({
          Rows: {
            Row: [{
              Rows: {
                Row: [
                  ...pnlDetailFixture().Rows.Row.flatMap((section) => section.Rows.Row),
                  {
                    type: "Data",
                    ColData: [
                      { value: "2026-08-23" },
                      { value: "Deposit", id: "qbo-only-1" },
                      { value: "Outside QBO" },
                      { value: "QBO-only sale" },
                      { value: "Sales of Product Income", id: "1" },
                      { value: "50.00" },
                    ],
                  },
                ],
              },
            }],
          },
        }),
        reportName,
      };
    },
  });

  assert.deepEqual(reportsCalled, ["ProfitAndLoss", "ProfitAndLossDetail"]);
  assert.equal(result.snapshot.is_current, true);
  assert.equal(result.snapshot.revenue, 3267.45);
  assert.equal(result.linkage.linked, 1);
  assert.equal(result.linkage.qboOnly, 3);
  assert.equal(db.tables.monthly_review_qbo_pnl_transactions.length, 4);
  assert.equal(db.tables.monthly_review_qbo_pnl_transactions.find((row) => row.qbo_txn_id === "qbo-only-1").bizzi_transaction_id, null);
  assert.equal(db.tables.bank_transactions.length, 1);
});

test("persisted QBO P&L account detail reads by QBO account id or snapshot account row id without provider calls", async () => {
  const db = makeDb();
  const created = await createOrReplaceMonthlyPnlSnapshot({
    businessId: BUSINESS_ID,
    reviewYear: 2026,
    reviewMonth: 8,
    qboRealmId: "realm-1",
    accounts: [
      { qbo_account_id: "3", account_name: "Meals", account_type: "Expense", total_amount: 42.5 },
      { qbo_account_id: null, account_name: "Unresolved Income", account_type: "Income", total_amount: 100 },
    ],
    transactions: [
      { qbo_account_id: "3", qbo_account_name: "Meals", qbo_txn_id: "qbo-1", qbo_txn_type: "Purchase", txn_date: "2026-08-22", amount: 42.5 },
      { qbo_account_id: null, qbo_account_name: "Unresolved Income", qbo_txn_id: "qbo-2", qbo_txn_type: "Deposit", txn_date: "2026-08-23", amount: 100 },
    ],
    linkTransactions: false,
    db,
  });

  const byQboId = await fetchMonthlyQboPnlAccountTransactions({
    businessId: BUSINESS_ID,
    year: 2026,
    month: 8,
    accountId: "3",
    db,
  });
  assert.equal(byQboId.rows.length, 1);
  assert.equal(byQboId.rows[0].qbo_txn_id, "qbo-1");

  const unresolvedAccount = created.accounts.find((row) => row.account_name === "Unresolved Income");
  const bySnapshotAccountId = await fetchMonthlyQboPnlAccountTransactions({
    businessId: BUSINESS_ID,
    year: 2026,
    month: 8,
    accountId: unresolvedAccount.id,
    db,
  });
  assert.equal(bySnapshotAccountId.rows.length, 1);
  assert.equal(bySnapshotAccountId.rows[0].qbo_txn_id, "qbo-2");
});

test("failed refresh before persistence leaves previous current snapshot intact", async () => {
  const db = makeDb();
  const previous = await createOrReplaceMonthlyPnlSnapshot({
    businessId: BUSINESS_ID,
    reviewYear: 2026,
    reviewMonth: 8,
    revenue: 1,
    accounts: [],
    transactions: [],
    linkTransactions: false,
    db,
  });

  await assert.rejects(() => refreshMonthlyQboPnlSnapshot({
    businessId: BUSINESS_ID,
    year: 2026,
    month: 8,
    db,
    loadContext: async () => ({ realmId: "realm-1", qboEnvironment: "production" }),
    fetchAccounts: async () => coaFixture([{ id: "4", name: "Meals", fullyQualifiedName: "Travel:Meals", type: "Expense" }]),
    fetchReport: async ({ reportName }) => reportName === "ProfitAndLoss"
      ? { report: pnlSummaryFixture({
          Rows: { Row: [
            pnlSummaryFixture().Rows.Row[0],
            pnlSummaryFixture().Rows.Row[1],
            {
              Header: { ColData: [{ value: "Expenses" }] },
              Rows: { Row: [{ type: "Data", ColData: [{ value: "Meals" }, { value: "42.50" }] }] },
              Summary: { ColData: [{ value: "Total Expenses" }, { value: "42.50" }] },
            },
            pnlSummaryFixture().Rows.Row[3],
          ] },
        }), reportName }
      : { report: pnlDetailFixture(), reportName },
  }), /qbo_account_identity_ambiguous/);

  const latest = await getLatestMonthlyPnlSnapshot({ businessId: BUSINESS_ID, reviewYear: 2026, reviewMonth: 8, db });
  assert.equal(latest.id, previous.snapshot.id);
  assert.equal(latest.is_current, true);
  assert.equal(db.tables.monthly_review_qbo_pnl_snapshots.length, 1);
});

test("admin routes are internal-only; GET reads persisted snapshots and POST refresh is QBO-read-only", () => {
  const routes = read("src/api/admin/monthlyReview.routes.js");
  const ingestion = read("src/services/bookkeeping/qboMonthlyPnlIngestionService.js");

  assert.match(routes, /router\.use\(requireAuth\)/);
  assert.match(routes, /router\.use\(requireInternalRole\(MONTHLY_REVIEW_STAFF_ROLES\)\)/);
  assert.match(routes, /post\("\/businesses\/:businessId\/qbo-pnl\/refresh"/);
  assert.match(routes, /get\("\/businesses\/:businessId\/qbo-pnl"/);
  assert.match(routes, /getMonthlyQboPnlSnapshot/);
  assert.match(routes, /refreshMonthlyQboPnlSnapshot/);
  assert.match(routes, /qbo_reads: false/);
  assert.match(routes, /qbo_reads: true/);
  assert.doesNotMatch(ingestion, /createQbo|updateQbo|postSingleBookkeepingTransactionNow|reclassifyBookkeepingTransaction|approveBookkeepingTransactions|plaid|OpenAI|new OpenAI/i);
});
