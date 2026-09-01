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
  dueMonthlyBriefTargets,
} = await import("../src/services/accounting/monthlyBriefSchedulerService.js");

const migration = read("supabase/migrations/20260916_monthly_financial_pulse_scheduler.sql");
const scheduler = read("src/services/accounting/monthlyBriefSchedulerService.js");
const cron = read("src/cron/monthlyFinancialPulse.cron.js");
const server = read("src/server.js");
const dashboard = read("src/pages/accounting/AccountingDashboard.jsx");
const pulseGenerator = read("src/api/accounting/monthlyFinancialPulse.js");

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

test("Health selected-window import uses the selected month as durable backfill anchor", () => {
  assert.match(dashboard, /startSelectedWindowImport/);
  assert.match(dashboard, /\/api\/qbo\/backfill\/start/);
  assert.match(dashboard, /anchor_year: year/);
  assert.match(dashboard, /anchor_month: month/);
  assert.match(dashboard, /source: "health_selected_window_import"/);
});
