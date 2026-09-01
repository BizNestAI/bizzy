import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* global process */

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
process.env.OPENAI_API_KEY ||= "test-openai-key";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

const {
  discoverEligibleQboBusinesses,
  dueMonthlyBriefTargets,
  ensureMonthlyBriefForTarget,
  runMonthlyBriefSchedulerSweepOnce,
} = await import("../src/services/accounting/monthlyBriefSchedulerService.js");

const migration = read("supabase/migrations/20260916_monthly_financial_pulse_scheduler.sql");
const scheduler = read("src/services/accounting/monthlyBriefSchedulerService.js");
const cron = read("src/cron/monthlyFinancialPulse.cron.js");
const server = read("src/server.js");
const dashboard = read("src/pages/accounting/AccountingDashboard.jsx");
const pulseGenerator = read("src/api/accounting/monthlyFinancialPulse.js");
const sweepScript = read("src/scripts/runMonthlyFinancialPulseSweep.js");

test("Monthly Brief schedule targets previous month final on the 1st in New York", () => {
  const targets = dueMonthlyBriefTargets({
    now: new Date("2026-09-01T16:00:00.000Z"),
    lookbackDays: 0,
  });
  assert.deepEqual(targets, [
    { target_month: "2026-08-01", cadence: "final", due_on: "2026-09-01" },
  ]);
});

test("Monthly Brief schedule targets current month mid-month on the 15th", () => {
  const targets = dueMonthlyBriefTargets({
    now: new Date("2026-09-15T16:00:00.000Z"),
    lookbackDays: 0,
  });
  assert.deepEqual(targets, [
    { target_month: "2026-09-01", cadence: "mid_month", due_on: "2026-09-15" },
  ]);
});

test("Monthly Brief catch-up sweep includes recent missed due dates", () => {
  const targets = dueMonthlyBriefTargets({
    now: new Date("2026-09-20T16:00:00.000Z"),
    lookbackDays: 20,
  });
  assert.ok(targets.some((row) => row.target_month === "2026-08-01" && row.cadence === "final"));
  assert.ok(targets.some((row) => row.target_month === "2026-09-01" && row.cadence === "mid_month"));
});

test("Monthly Brief migration stores cadence, status, source snapshot, and durable job identity", () => {
  assert.match(migration, /add column if not exists cadence text not null default 'manual'/);
  assert.match(migration, /add column if not exists status text not null default 'available'/);
  assert.match(migration, /add column if not exists source_snapshot_id uuid/);
  assert.match(migration, /monthly_financial_pulse_business_month_cadence_idx/);
  assert.match(migration, /create table if not exists public\.monthly_financial_pulse_jobs/);
  assert.match(migration, /monthly_financial_pulse_jobs_identity_idx/);
});

test("Monthly Brief scheduler requires Cash Health snapshots and records waiting state", () => {
  assert.match(scheduler, /getMonthlyHealthSummary/);
  assert.match(scheduler, /HEALTH_ACCOUNTING_METHOD/);
  assert.match(scheduler, /current_cash_snapshot_required/);
  assert.match(scheduler, /waiting_for_snapshot/);
  assert.match(scheduler, /business_id,target_month,cadence/);
});

test("Monthly Brief generation hydrates from Health snapshots instead of legacy financial metrics", () => {
  assert.match(pulseGenerator, /getMonthlyHealthSummary/);
  assert.match(pulseGenerator, /monthly_brief_cash_snapshot_required/);
  assert.doesNotMatch(pulseGenerator, /\.from\("financial_metrics"\)/);
  assert.doesNotMatch(pulseGenerator, /\.from\("kpi_metrics"\)/);
  assert.doesNotMatch(pulseGenerator, /\.from\("account_breakdown"\)/);
});

test("Monthly Brief sweep is started by the server", () => {
  assert.match(cron, /runMonthlyBriefSchedulerSweepOnce/);
  assert.match(cron, /DISABLE_MONTHLY_FINANCIAL_PULSE_CRON/);
  assert.match(server, /startMonthlyFinancialPulseCron/);
});

test("Monthly Brief standalone sweep command exits nonzero only on infrastructure failure", () => {
  assert.match(sweepScript, /runMonthlyBriefSchedulerSweepOnce/);
  assert.match(sweepScript, /process\.exitCode = 1/);
  assert.doesNotMatch(sweepScript, /result\?\.failed > 0/);
});

test("Health selected-window import uses the selected month as durable backfill anchor", () => {
  assert.match(dashboard, /startSelectedWindowImport/);
  assert.match(dashboard, /\/api\/qbo\/backfill\/start/);
  assert.match(dashboard, /anchor_year: year/);
  assert.match(dashboard, /anchor_month: month/);
  assert.match(dashboard, /source: "health_selected_window_import"/);
});

test("Monthly Brief business discovery does not require quickbooks_tokens.user_id", async () => {
  const db = createFakePulseDb();
  const result = await discoverEligibleQboBusinesses({ db });
  assert.equal(result.discovered, 2);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.businesses.map((row) => row.business_id).sort(), ["biz-a", "biz-b"]);
  assert.deepEqual(result.businesses.map((row) => row.user_id).sort(), ["owner-a", "owner-b"]);
  assert.ok(!db.selects.quickbooks_tokens.some((cols) => cols.includes("user_id")));
});

test("Monthly Brief September 1 catch-up creates job, persists pulse, and completes with pulse_id", async () => {
  const db = createFakePulseDb();
  const result = await runMonthlyBriefSchedulerSweepOnce({
    db,
    now: new Date("2026-09-01T16:00:00.000Z"),
    lookbackDays: 0,
    generatePulse: async ({ db: pulseDb, business_id, user_id, month, cadence, sourceSnapshotId }) => {
      const { data, error } = await pulseDb.from("monthly_financial_pulse").upsert({
        business_id,
        user_id,
        month,
        cadence,
        status: "available",
        accounting_method: "Cash",
        source_snapshot_id: sourceSnapshotId,
        generated_at: "2026-09-01T16:00:01.000Z",
        data_through_date: month,
        generation_metadata: { embedding_status: "disabled" },
        revenue_summary: "Revenue was steady.",
        spending_trend: "Spending was controlled.",
        variance_from_forecast: "No forecast data.",
        business_insights: ["Cash-basis snapshot available."],
        motivational_message: "Keep reviewing the books.",
      }, { onConflict: "business_id,month,cadence" }).select("*").maybeSingle();
      if (error) throw error;
      return { persisted: true, pulse_id: data.id };
    },
  });

  assert.equal(result.failed, 0);
  assert.equal(result.completed, 2);
  const job = db.tables.monthly_financial_pulse_jobs.find((row) => row.business_id === "biz-a" && row.target_month === "2026-08-01");
  const pulse = db.tables.monthly_financial_pulse.find((row) => row.business_id === "biz-a" && row.month === "2026-08-01");
  assert.equal(job.status, "completed");
  assert.equal(job.source_snapshot_id, "snap-a-aug");
  assert.equal(job.result.pulse_id, pulse.id);
  assert.ok(job.result.pulse_id);
});

test("Monthly Brief job fails when generator does not persist a readable pulse row", async () => {
  const db = createFakePulseDb();
  const result = await ensureMonthlyBriefForTarget({
    db,
    business: { business_id: "biz-a", user_id: "owner-a" },
    target: { target_month: "2026-08-01", cadence: "final", due_on: "2026-09-01" },
    generatePulse: async () => ({ revenueSummary: "Generated but not persisted." }),
    now: new Date("2026-09-01T16:00:00.000Z"),
  });

  assert.equal(result.status, "failed");
  const job = db.tables.monthly_financial_pulse_jobs.find((row) => row.business_id === "biz-a" && row.target_month === "2026-08-01");
  assert.equal(job.status, "failed");
  assert.match(job.last_error, /monthly_brief_pulse_persistence_verification_failed/);
  assert.match(job.result?.error, /monthly_brief_pulse_persistence_verification_failed/);
});

test("Monthly Brief completed job without persisted pulse is retried", async () => {
  const db = createFakePulseDb({
    tables: {
      monthly_financial_pulse_jobs: [
        {
          id: "stale-completed-job",
          business_id: "biz-a",
          user_id: "owner-a",
          target_month: "2026-08-01",
          cadence: "final",
          status: "completed",
          due_on: "2026-09-01",
          result: { pulse_id: "missing-pulse" },
          attempts: 1,
          started_at: "2026-09-01T01:00:00.000Z",
          finished_at: "2026-09-01T01:01:00.000Z",
        },
      ],
    },
  });
  const result = await ensureMonthlyBriefForTarget({
    db,
    business: { business_id: "biz-a", user_id: "owner-a" },
    target: { target_month: "2026-08-01", cadence: "final", due_on: "2026-09-01" },
    generatePulse: async ({ db: pulseDb, business_id, user_id, month, cadence, sourceSnapshotId }) => {
      const { data } = await pulseDb.from("monthly_financial_pulse").upsert({
        business_id,
        user_id,
        month,
        cadence,
        status: "available",
        accounting_method: "Cash",
        source_snapshot_id: sourceSnapshotId,
        generated_at: "2026-09-01T16:00:01.000Z",
        data_through_date: month,
        generation_metadata: { embedding_status: "disabled" },
        revenue_summary: "Revenue was steady.",
        spending_trend: "Spending was controlled.",
        variance_from_forecast: "No forecast data.",
        business_insights: ["Cash-basis snapshot available."],
        motivational_message: "Keep reviewing the books.",
      }, { onConflict: "business_id,month,cadence" }).select("*").maybeSingle();
      return { persisted: true, pulse_id: data.id };
    },
    now: new Date("2026-09-01T16:00:00.000Z"),
  });

  const job = db.tables.monthly_financial_pulse_jobs.find((row) => row.id === "stale-completed-job");
  const pulse = db.tables.monthly_financial_pulse.find((row) => row.business_id === "biz-a" && row.month === "2026-08-01");
  assert.equal(result.status, "completed");
  assert.equal(job.status, "completed");
  assert.equal(job.attempts, 2);
  assert.equal(job.result.pulse_id, pulse.id);
  assert.ok(job.finished_at);
});

test("Monthly Brief scheduler skips stale malformed business and continues others", async () => {
  const db = createFakePulseDb({
    quickbooks_tokens: [
      { business_id: "biz-a", qbo_env: "production", is_active: true, status: "active" },
      { business_id: "biz-missing-owner", qbo_env: "production", is_active: true, status: "active" },
    ],
    business_profiles: [
      { id: "biz-a", user_id: "owner-a", business_name: "A" },
      { id: "biz-missing-owner", user_id: null, business_name: "Missing owner" },
    ],
  });
  const result = await discoverEligibleQboBusinesses({ db });
  assert.equal(result.discovered, 2);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.businesses.map((row) => row.business_id), ["biz-a"]);
});

test("Monthly Brief completed jobs always require an existing pulse", () => {
  assert.match(scheduler, /monthly_brief_pulse_persistence_verification_failed/);
  assert.match(scheduler, /saved\.id/);
  assert.doesNotMatch(scheduler, /status: "completed",[\\s\\S]{0,240}pulse_id: saved\?\.id \|\| null/);
});

test("Monthly Brief generator throws on required pulse persistence failure and records optional embedding failures", () => {
  assert.match(pulseGenerator, /monthly_brief_pulse_upsert_failed/);
  assert.match(pulseGenerator, /monthly_brief_pulse_upsert_returned_no_row/);
  assert.match(pulseGenerator, /generationMetadata\.embedding_status = "failed"/);
  assert.match(pulseGenerator, /saving brief without embedding/);
  assert.doesNotMatch(pulseGenerator, /Pulse upsert error:[\\s\\S]{0,160}console\\.error[\\s\\S]{0,160}return parsed/);
});

function createFakePulseDb(overrides = {}) {
  const tables = {
    quickbooks_tokens: overrides.quickbooks_tokens || [
      { business_id: "biz-a", qbo_env: "production", is_active: true, status: "active" },
      { business_id: "biz-a", qbo_env: "production", is_active: true, status: "active" },
      { business_id: "biz-b", qbo_env: "production", is_active: true, status: "active" },
      { business_id: "biz-inactive", qbo_env: "production", is_active: false, status: "active" },
    ],
    business_profiles: overrides.business_profiles || [
      { id: "biz-a", user_id: "owner-a", business_name: "A" },
      { id: "biz-b", user_id: "owner-b", business_name: "B" },
      { id: "biz-inactive", user_id: "owner-inactive", business_name: "Inactive" },
    ],
    monthly_review_qbo_pnl_snapshots: overrides.monthly_review_qbo_pnl_snapshots || [
      {
        id: "snap-a-aug",
        business_id: "biz-a",
        review_year: 2026,
        review_month: 8,
        accounting_method: "Cash",
        status: "current",
        is_current: true,
        revenue: 1175,
        cogs: 0,
        expenses: 192.9,
        net_profit: 982.1,
        pulled_at: "2026-09-01T01:45:32.402Z",
        metadata: { pnl_components: { profit_margin: 83.58 } },
      },
      {
        id: "snap-b-aug",
        business_id: "biz-b",
        review_year: 2026,
        review_month: 8,
        accounting_method: "Cash",
        status: "current",
        is_current: true,
        revenue: 0,
        cogs: 0,
        expenses: 0,
        net_profit: 0,
        pulled_at: "2026-09-01T01:45:32.402Z",
        metadata: { pnl_components: { profit_margin: null } },
      },
    ],
    monthly_review_qbo_pnl_accounts: overrides.monthly_review_qbo_pnl_accounts || [
      { id: "acct-a-1", snapshot_id: "snap-a-aug", business_id: "biz-a", account_name: "Services", account_type: "Income", total_amount: 1175, display_order: 0, row_order: 0 },
      { id: "acct-a-2", snapshot_id: "snap-a-aug", business_id: "biz-a", account_name: "Software", account_type: "Expense", total_amount: 160, display_order: 1, row_order: 1 },
      { id: "acct-a-3", snapshot_id: "snap-a-aug", business_id: "biz-a", account_name: "Payment Processing Fees", account_type: "Expense", total_amount: 32.9, display_order: 2, row_order: 2 },
    ],
    monthly_financial_pulse: [],
    monthly_financial_pulse_jobs: [],
    ...(overrides.tables || {}),
  };
  const selects = {};
  return {
    tables,
    selects,
    from(table) {
      selects[table] ||= [];
      return new FakeQuery(tables, selects, table);
    },
  };
}

class FakeQuery {
  constructor(tables, selects, table) {
    this.tables = tables;
    this.selects = selects;
    this.table = table;
    this.filters = [];
    this.inFilters = [];
    this.orders = [];
    this.limitCount = null;
    this.pendingInsert = null;
    this.pendingUpsert = null;
  }

  select(columns = "*") {
    this.selects[this.table].push(columns);
    this.selectedColumns = columns;
    return this;
  }

  eq(column, value) {
    this.filters.push({ column, value });
    return this;
  }

  not(column, operator, value) {
    if (operator === "is" && value === null) {
      this.filters.push({ column, value: "__NOT_NULL__" });
    }
    return this;
  }

  in(column, values) {
    this.inFilters.push({ column, values });
    return this;
  }

  order(column, { ascending = true } = {}) {
    this.orders.push({ column, ascending });
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  insert(rows) {
    this.pendingInsert = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  upsert(row, { onConflict } = {}) {
    this.pendingUpsert = { row, onConflict };
    return this;
  }

  async maybeSingle() {
    const { data, error, status } = await this;
    if (error) return { data: null, error, status };
    return { data: Array.isArray(data) ? data[0] || null : data || null, error: null, status: 200 };
  }

  then(resolve) {
    resolve(this.execute());
  }

  execute() {
    if (this.pendingInsert) {
      const rows = this.pendingInsert.map((row) => ({ id: row.id || `${this.table}-${this.tables[this.table].length + 1}`, ...row }));
      this.tables[this.table].push(...rows);
      return { data: rows, error: null, status: 201 };
    }
    if (this.pendingUpsert) {
      const { row, onConflict } = this.pendingUpsert;
      const keys = String(onConflict || "id").split(",").map((key) => key.trim()).filter(Boolean);
      const idx = this.tables[this.table].findIndex((existing) => keys.every((key) => existing[key] === row[key]));
      const saved = { id: row.id || (idx >= 0 ? this.tables[this.table][idx].id : `${this.table}-${this.tables[this.table].length + 1}`), ...row };
      if (idx >= 0) this.tables[this.table][idx] = { ...this.tables[this.table][idx], ...saved };
      else this.tables[this.table].push(saved);
      return { data: [saved], error: null, status: 200 };
    }
    let rows = [...(this.tables[this.table] || [])];
    for (const filter of this.filters) {
      rows = rows.filter((row) => filter.value === "__NOT_NULL__" ? row[filter.column] != null : row[filter.column] === filter.value);
    }
    for (const filter of this.inFilters) {
      rows = rows.filter((row) => filter.values.includes(row[filter.column]));
    }
    for (const order of [...this.orders].reverse()) {
      rows.sort((a, b) => {
        if (a[order.column] === b[order.column]) return 0;
        const result = a[order.column] > b[order.column] ? 1 : -1;
        return order.ascending ? result : -result;
      });
    }
    if (this.limitCount != null) rows = rows.slice(0, this.limitCount);
    return { data: rows, error: null, status: 200 };
  }
}
