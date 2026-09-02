/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const {
  FORECAST_MODEL_VERSION,
  buildForecastV1Months,
  ensureForecastV1Run,
  getForecastV1Status,
  loadContiguousCashHistory,
} = await import("../src/services/accounting/forecastV1Service.js");

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_BUSINESS_ID = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-09-02T12:00:00Z");

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

function historyRows(overrides = {}) {
  const values = [
    ["2025-09", 2657, 2228.37, 1000.3],
    ["2025-10", 975, 2204.38, -1227.65],
    ["2025-11", 0, 2664.31, -2657.34],
    ["2025-12", 1150, 1916.54, -765.71],
    ["2026-01", 1475, 334.29, 1140.71],
    ["2026-02", 475, 297.15, 177.85],
    ["2026-03", 475, 549.15, -74.15],
    ["2026-04", 2075, 175.55, 1899.45],
    ["2026-05", 675, 18.9, 656.1],
    ["2026-06", 500, 14, 486],
    ["2026-07", 1450, 40.6, 1409.4],
    ["2026-08", 1175, 192.9, 982.1],
  ];
  return values.map(([monthKey, revenue, expenses, netProfit], index) => {
    const [year, month] = monthKey.split("-").map(Number);
    return {
      id: `snapshot-${index + 1}`,
      business_id: BUSINESS_ID,
      review_year: year,
      review_month: month,
      accounting_method: "Cash",
      status: "current",
      is_current: true,
      revenue,
      expenses,
      net_profit: netProfit,
      metadata: { completeness: { snapshot_complete: false, compatibility_tables_written: false } },
      ...overrides[monthKey],
    };
  });
}

function makeDb(initial = {}) {
  const tables = {
    monthly_review_qbo_pnl_snapshots: [],
    forecast_runs: [],
    forecast_months: [],
    forecast_overrides: [],
    quickbooks_tokens: [{ business_id: BUSINESS_ID, is_active: true, status: "active" }],
    __selects: [],
    ...initial,
  };
  return {
    tables,
    rpc(name, args) {
      if (name !== "finalize_forecast_v1_run") return Promise.resolve({ data: null, error: { message: "unknown rpc" } });
      if (tables.__failFinalize) return Promise.resolve({ data: null, error: { message: "forced finalizer failure" } });
      const run = tables.forecast_runs.find((row) => row.id === args.p_forecast_run_id && row.business_id === args.p_business_id);
      if (!run) return Promise.resolve({ data: null, error: { message: "forecast_run_not_found" } });
      if (run.status !== "generating") return Promise.resolve({ data: null, error: { message: "forecast_run_not_generating" } });
      const rows = Array.isArray(args.p_months) ? args.p_months : [];
      if (rows.length !== args.p_expected_months) return Promise.resolve({ data: null, error: { message: "forecast_month_count_invalid" } });
      tables.__statusDuringFinalize = run.status;
      tables.forecast_months = tables.forecast_months.filter((row) => row.forecast_run_id !== run.id || row.business_id !== run.business_id);
      rows.forEach((row, index) => {
        tables.forecast_months.push({
          id: nextId("forecast_months", tables.forecast_months.length + index + 1),
          forecast_run_id: run.id,
          business_id: args.p_business_id,
          ...structuredClone(row),
        });
      });
      if (tables.forecast_months.filter((row) => row.forecast_run_id === run.id && row.business_id === run.business_id).length !== args.p_expected_months) {
        return Promise.resolve({ data: null, error: { message: "forecast_month_persistence_verification_failed" } });
      }
      Object.assign(run, {
        status: "completed",
        generated_at: new Date("2026-09-02T12:00:00Z").toISOString(),
        generation_lease_expires_at: null,
        updated_at: new Date("2026-09-02T12:00:00Z").toISOString(),
      });
      return Promise.resolve({ data: run.id, error: null });
    },
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
  select(columns = "*") {
    this.selectColumns = String(columns);
    this.tables.__selects.push({ table: this.table, columns: this.selectColumns });
    return this;
  }
  eq(column, value) {
    const key = String(column).includes(".") ? String(column).split(".").at(-1) : column;
    this.filters.push((row) => String(row[key]) === String(value));
    return this;
  }
  lte(column, value) { this.filters.push((row) => String(row[column]).slice(0, 10) <= String(value).slice(0, 10)); return this; }
  order(column, options = {}) { this.orders.push({ column, ascending: options.ascending !== false }); return this; }
  limit(count) { this.limitCount = count; return this; }
  insert(payload) { this.pendingInsert = Array.isArray(payload) ? payload : [payload]; return this; }
  upsert(payload, options = {}) { this.pendingInsert = Array.isArray(payload) ? payload : [payload]; this.upsertConflict = options.onConflict || null; return this; }
  update(payload) { this.pendingUpdate = payload; return this; }
  delete() { this.pendingDelete = true; return this; }
  maybeSingle() { this.singleMode = "maybe"; return this; }
  single() { this.singleMode = "single"; return this; }
  then(resolve) {
    if (this.tables.__errors?.[this.table]) {
      return resolve({ data: null, error: this.tables.__errors[this.table], count: 0 });
    }
    if (this.pendingDelete) {
      const rows = this.rows();
      this.tables[this.table] = (this.tables[this.table] || []).filter((row) => !rows.includes(row));
      return resolveResult(resolve, rows, this.singleMode);
    }
    if (this.pendingInsert) {
      const inserted = this.pendingInsert.map((row) => this.insertOne(row));
      return resolveResult(resolve, inserted, this.singleMode);
    }
    if (this.pendingUpdate) {
      const rows = this.rows();
      rows.forEach((row) => Object.assign(row, structuredClone(this.pendingUpdate)));
      return resolveResult(resolve, rows, this.singleMode);
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
    const copy = { id: row.id || nextId(this.table, table.length + 1), ...structuredClone(row) };
    table.push(copy);
    this.tables[this.table] = table;
    return { ...copy };
  }
  rows() {
    let rows = this.tables[this.table] || [];
    for (const filter of this.filters) rows = rows.filter(filter);
    for (const { column, ascending } of this.orders) {
      rows = [...rows].sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (ascending ? 1 : -1));
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
  const prefixes = { forecast_runs: "40000000", forecast_months: "50000000", forecast_overrides: "60000000" };
  return `${prefixes[table] || "90000000"}-0000-4000-8000-${String(offset).padStart(12, "0")}`;
}

test("Forecasts V1 uses Sep 2025-Aug 2026 Cash snapshots to produce Sep 2026-Aug 2027", async () => {
  const db = makeDb({ monthly_review_qbo_pnl_snapshots: historyRows() });
  const result = await ensureForecastV1Run({ db, businessId: BUSINESS_ID, now: NOW });

  assert.equal(result.data_status, "available");
  assert.equal(result.source, "qbo_cash_health_snapshots");
  assert.equal(result.is_sample, false);
  assert.equal(result.model_version, FORECAST_MODEL_VERSION);
  assert.equal(result.history.start, "2025-09-01");
  assert.equal(result.history.end, "2026-08-01");
  assert.equal(result.forecast.start, "2026-09-01");
  assert.equal(result.forecast.end, "2027-08-01");
  assert.equal(result.forecast.months.length, 12);
  assert.equal(result.forecast.months[0].month, "2026-09-01");
  assert.equal(result.forecast.months.at(-1).month, "2027-08-01");
  assert.equal(result.cash_balance.status, "unavailable");
  assert.equal(result.cash_balance.starting_cash, null);
  assert.equal(result.cash_balance.ending_cash, null);
  assert.equal(db.tables.forecast_months.some((row) => Object.hasOwn(row, "month_label")), false);
});

test("Forecasts V1 requires contiguous current Cash snapshots and treats zero revenue as valid", async () => {
  const rows = historyRows({ "2025-12": { status: "failed", is_current: false } });
  rows.push({ id: "accrual-dec", business_id: BUSINESS_ID, review_year: 2025, review_month: 12, accounting_method: "Accrual", status: "current", is_current: true, revenue: 9999, expenses: 1, net_profit: 9998 });
  rows.push({ id: "other", business_id: OTHER_BUSINESS_ID, review_year: 2025, review_month: 12, accounting_method: "Cash", status: "current", is_current: true, revenue: 9999, expenses: 1, net_profit: 9998 });
  const db = makeDb({ monthly_review_qbo_pnl_snapshots: rows });
  const history = await loadContiguousCashHistory({ db, businessId: BUSINESS_ID, cutoffYear: 2026, cutoffMonth: 8 });
  const status = await getForecastV1Status({ db, businessId: BUSINESS_ID, now: NOW });

  assert.equal(history.complete, false);
  assert.equal(history.months_available, 11);
  assert.deepEqual(history.missing_months, ["2025-12"]);
  assert.equal(status.data_status, "insufficient_history");
  assert.ok(history.months.some((row) => row.month_key === "2025-11-01" && row.revenue === 0));
});

test("Forecasts V1 snapshot loader includes business_id and accepts production-shaped Cash history", async () => {
  const db = makeDb({ monthly_review_qbo_pnl_snapshots: historyRows() });
  const history = await loadContiguousCashHistory({ db, businessId: BUSINESS_ID, cutoffYear: 2026, cutoffMonth: 8 });
  const status = await getForecastV1Status({ db, businessId: BUSINESS_ID, now: NOW });
  const snapshotSelect = db.tables.__selects.find((entry) => entry.table === "monthly_review_qbo_pnl_snapshots")?.columns || "";

  assert.match(snapshotSelect, /\bbusiness_id\b/);
  assert.equal(history.complete, true);
  assert.equal(history.months_available, 12);
  assert.deepEqual(history.missing_months, []);
  assert.equal(history.window.start, "2025-09-01");
  assert.equal(history.window.end, "2026-08-01");
  assert.equal(status.data_status, "generation_required");
});

test("Forecasts V1 treats malformed snapshot scope as a query failure, not missing history", async () => {
  const missingBusinessRows = historyRows().map((row) => {
    const copy = { ...row };
    delete copy.business_id;
    return copy;
  });
  const wrongBusinessRows = historyRows({ "2026-08": { business_id: OTHER_BUSINESS_ID } });
  const unscopedDb = (rows) => ({
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        then(resolve) { return resolve({ data: rows, error: null }); },
      };
    },
  });

  await assert.rejects(
    () => loadContiguousCashHistory({
      db: unscopedDb(missingBusinessRows),
      businessId: BUSINESS_ID,
      cutoffYear: 2026,
      cutoffMonth: 8,
    }),
    /forecast_snapshot_scope_contract_violation/
  );

  await assert.rejects(
    () => loadContiguousCashHistory({
      db: unscopedDb(wrongBusinessRows),
      businessId: BUSINESS_ID,
      cutoffYear: 2026,
      cutoffMonth: 8,
    }),
    /forecast_snapshot_scope_contract_violation/
  );
});

test("Forecasts V1 keeps true empty history distinct from snapshot query errors", async () => {
  const emptyStatus = await getForecastV1Status({
    db: makeDb({ monthly_review_qbo_pnl_snapshots: [] }),
    businessId: BUSINESS_ID,
    now: NOW,
  });
  assert.equal(emptyStatus.data_status, "insufficient_history");
  assert.equal(emptyStatus.history.months_available, 0);

  await assert.rejects(
    () => getForecastV1Status({
      db: makeDb({
        monthly_review_qbo_pnl_snapshots: [],
        __errors: {
          monthly_review_qbo_pnl_snapshots: { code: "42703", message: "column missing" },
        },
      }),
      businessId: BUSINESS_ID,
      now: NOW,
    }),
    /forecast_query_failed/
  );
});

test("Forecasts V1 generation is deterministic and idempotent for identical source snapshots", async () => {
  const db = makeDb({ monthly_review_qbo_pnl_snapshots: historyRows() });
  const first = await ensureForecastV1Run({ db, businessId: BUSINESS_ID, now: NOW });
  const second = await ensureForecastV1Run({ db, businessId: BUSINESS_ID, now: NOW });

  assert.equal(first.run_id, second.run_id);
  assert.deepEqual(first.forecast.months, second.forecast.months);
  assert.equal(db.tables.forecast_runs.length, 1);
  assert.equal(db.tables.forecast_runs[0].status, "completed");
  assert.equal(db.tables.__statusDuringFinalize, "generating");
  assert.equal(db.tables.forecast_months.length, 12);
});

test("Forecasts V1 never exposes generating or incomplete completed runs as available", async () => {
  const db = makeDb({
    monthly_review_qbo_pnl_snapshots: historyRows(),
    forecast_runs: [{
      id: "active-run",
      business_id: BUSINESS_ID,
      status: "generating",
      model_version: FORECAST_MODEL_VERSION,
      accounting_method: "Cash",
      history_start: "2025-09-01",
      history_end: "2026-08-01",
      forecast_start: "2026-09-01",
      forecast_end: "2027-08-01",
      historical_months_count: 12,
      source_snapshot_ids: historyRows().map((row) => row.id),
      source_snapshot_ids_hash: "ignored",
      input_fingerprint: "",
      cash_balance_status: "unavailable",
      confidence: {},
      generation_started_at: "2026-09-02T11:58:00Z",
      generation_lease_expires_at: "2026-09-02T12:08:00Z",
    }],
  });
  const history = await loadContiguousCashHistory({ db, businessId: BUSINESS_ID, cutoffYear: 2026, cutoffMonth: 8 });
  const sourceHash = history.months.map((row) => row.snapshot_id).join("|");
  const fingerprint = createHashForTest([
    BUSINESS_ID,
    FORECAST_MODEL_VERSION,
    "Cash",
    "2025-09-01",
    "2026-08-01",
    "2026-09-01",
    "2027-08-01",
    createHashForTest(sourceHash),
    createHashForTest('{"expenseTrendCap":{"max":0.02,"min":-0.02},"fullYearWeight":0.2,"priorYearPatternWeight":0.5,"recent3Weight":0.5,"recent6Weight":0.3,"revenueTrendCap":{"max":0.03,"min":-0.03},"trendAdjustedWeight":0.5,"winsorMadMultiplier":2.5}'),
  ].join("|"));
  db.tables.forecast_runs[0].source_snapshot_ids_hash = createHashForTest(sourceHash);
  db.tables.forecast_runs[0].input_fingerprint = fingerprint;

  const status = await getForecastV1Status({ db, businessId: BUSINESS_ID, now: NOW });

  assert.equal(status.data_status, "generation_in_progress");
  assert.equal(status.run_id, "active-run");
  assert.equal(status.forecast.months.length, 0);
});

test("Forecasts V1 failed finalization rolls back availability and marks claim failed", async () => {
  const db = makeDb({ monthly_review_qbo_pnl_snapshots: historyRows(), __failFinalize: true });

  await assert.rejects(
    () => ensureForecastV1Run({ db, businessId: BUSINESS_ID, now: NOW }),
    /forecast_finalization_failed/
  );

  assert.equal(db.tables.forecast_runs.length, 1);
  assert.equal(db.tables.forecast_runs[0].status, "failed");
  assert.equal(db.tables.forecast_months.length, 0);
  const status = await getForecastV1Status({ db, businessId: BUSINESS_ID, now: NOW });
  assert.equal(status.data_status, "generation_required");
});

test("Forecasts V1 GET does not return a completed run from stale source snapshots", async () => {
  const db = makeDb({
    monthly_review_qbo_pnl_snapshots: historyRows(),
    forecast_runs: [{
      id: "stale-run",
      business_id: BUSINESS_ID,
      status: "completed",
      model_version: FORECAST_MODEL_VERSION,
      accounting_method: "Cash",
      history_start: "2025-09-01",
      history_end: "2026-08-01",
      forecast_start: "2026-09-01",
      forecast_end: "2027-08-01",
      historical_months_count: 12,
      source_snapshot_ids: ["old-snapshot"],
      source_snapshot_ids_hash: "old-hash",
      cash_balance_status: "unavailable",
      confidence: {},
      generated_at: "2026-09-01T00:00:00Z",
    }],
    forecast_months: [{
      id: "stale-month",
      forecast_run_id: "stale-run",
      business_id: BUSINESS_ID,
      month: "2026-09-01",
      baseline_revenue: 999,
      baseline_expenses: 111,
      baseline_operating_net_cash_flow: 888,
      effective_revenue: 999,
      effective_expenses: 111,
      effective_operating_net_cash_flow: 888,
    }],
  });
  const status = await getForecastV1Status({ db, businessId: BUSINESS_ID, now: NOW });

  assert.equal(status.data_status, "generation_required");
  assert.equal(status.run_id, null);
  assert.equal(status.history.months_available, 12);
});

test("Forecasts V1 overrides layer effective values without changing baseline", async () => {
  const { upsertForecastV1Overrides, resetForecastV1Overrides } = await import("../src/services/accounting/forecastV1Service.js");
  const db = makeDb({ monthly_review_qbo_pnl_snapshots: historyRows() });
  const base = await ensureForecastV1Run({ db, businessId: BUSINESS_ID, now: NOW });
  const original = base.forecast.months[0];
  const changed = await upsertForecastV1Overrides({
    db,
    businessId: BUSINESS_ID,
    forecastRunId: base.run_id,
    rows: [{ month: original.month, revenue_override: 12345, expense_override: 2345 }],
  });
  const updated = changed.forecast.months[0];

  assert.equal(updated.baseline_revenue, original.baseline_revenue);
  assert.equal(updated.baseline_expenses, original.baseline_expenses);
  assert.equal(updated.revenue, 12345);
  assert.equal(updated.expenses, 2345);
  assert.equal(updated.operating_net_cash_flow, 10000);
  assert.equal(updated.has_override, true);

  const reset = await resetForecastV1Overrides({ db, businessId: BUSINESS_ID, forecastRunId: base.run_id, month: original.month });
  assert.equal(reset.forecast.months[0].revenue, original.baseline_revenue);
  assert.equal(reset.forecast.months[0].has_override, false);
});

test("Forecasts V1 model caps trend and clamps revenue/expenses while preserving input history externally", () => {
  const history = historyRows().map((row) => ({
    year: row.review_year,
    month: row.review_month,
    month_key: `${row.review_year}-${String(row.review_month).padStart(2, "0")}-01`,
    snapshot_id: row.id,
    revenue: row.review_month === 7 ? 1000000 : Number(row.revenue),
    expenses: Number(row.expenses),
    net_profit: Number(row.net_profit),
  }));
  const first = buildForecastV1Months({ history });
  const second = buildForecastV1Months({ history });
  assert.deepEqual(first, second);
  assert.equal(first.length, 12);
  assert.ok(first.every((row) => row.revenue >= 0 && row.expenses >= 0));
});

test("Forecasts V1 migration creates versioned authority tables and leaves legacy forecast table intact", () => {
  const migration = read("supabase/migrations/20260919_forecast_v1_authority.sql");
  assert.match(migration, /create table if not exists public\.forecast_runs/i);
  assert.match(migration, /create table if not exists public\.forecast_months/i);
  assert.match(migration, /create table if not exists public\.forecast_overrides/i);
  assert.match(migration, /accounting_method = 'Cash'/i);
  assert.match(migration, /status in \('generating', 'completed', 'failed'\)/i);
  assert.match(migration, /input_fingerprint text/i);
  assert.match(migration, /forecast_runs_active_input_unique/i);
  assert.match(migration, /create or replace function public\.finalize_forecast_v1_run/i);
  assert.match(migration, /forecast_months_run_business_fkey/i);
  assert.match(migration, /forecast_overrides_run_business_fkey/i);
  assert.doesNotMatch(migration, /drop table/i);
  assert.doesNotMatch(migration, /month_label/i);
});

test("Forecasts Live frontend and routes do not silently persist sample data", () => {
  const route = read("src/api/accounting/forecast.js");
  const accuracyRoute = read("src/api/accounting/forecastAccuracy.js");
  const editor = read("src/components/Accounting/ForecastEditorChart.jsx");
  const service = read("src/services/accounting/forecastV1Service.js");
  const scenarios = read("src/pages/accounting/Scenarios.jsx");
  const affordability = read("src/pages/accounting/Affordability.jsx");
  const affordabilityCard = read("src/components/Accounting/AffordabilityInsightCard.jsx");

  assert.doesNotMatch(route, /generateCashFlowForecast/);
  assert.doesNotMatch(route, /cashflow_forecast/);
  assert.doesNotMatch(route, /financial_metrics/);
  assert.match(route, /router\.post\("\/generate"/);
  assert.match(route, /router\.get\("\/"/);
  assert.match(editor, /No sample data is shown in Live Mode/);
  assert.match(editor, /forecast_run_id: forecastRunId/);
  assert.match(editor, /forecastMeta\?\.is_sample/);
  assert.match(route, /generation_in_progress/);
  assert.match(accuracyRoute, /run:forecast_runs!forecast_months_run_business_fkey/);
  assert.match(accuracyRoute, /no_completed_forecast_samples/);
  assert.match(accuracyRoute, /generatedAt >= targetMonthClosedAt/);
  assert.doesNotMatch(accuracyRoute, /forecast_runs!inner/);
  assert.doesNotMatch(accuracyRoute, /usingMock:\s*true/);
  assert.doesNotMatch(accuracyRoute, /MAPE 0|100%/);
  assert.doesNotMatch(service, /Math\.random/);
  assert.doesNotMatch(service, /month_label/);
  assert.doesNotMatch(service, /financial_metrics/);
  assert.doesNotMatch(scenarios, /catch\s*\{[\s\S]*setBaseline\(MOCK_BASELINE\)/);
  assert.doesNotMatch(scenarios, /return rows\.length \? rows : MOCK_BASELINE/);
  assert.doesNotMatch(affordability, /catch\s*\{[\s\S]*return MOCK_FORECAST/);
  assert.doesNotMatch(affordability, /return MOCK_FORECAST;\n\s*\}/);
  assert.doesNotMatch(affordability, /ending_cash:\s*r\.ending_cash == null \? null : Number\(r\.ending_cash \|\| 0\)/);
  assert.doesNotMatch(affordabilityCard, /endCashAfterHorizon \|\| 0/);
});

function createHashForTest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
