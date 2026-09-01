/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

const { trailingMonthWindow } = await import("../src/utils/monthKey.js");

const runner = read("src/services/qboBackfillRunner.js");
const route = read("src/api/accounting/qbo-backfill.routes.js");
const jobs = read("src/services/qboBackfillJobsService.js");
const qboAuth = read("src/api/auth/quickbooksAuth.js");
const settings = read("src/pages/Settings/SettingsHome.jsx");
const dashboard = read("src/pages/accounting/AccountingDashboard.jsx");
const migration = read("supabase/migrations/20260915_qbo_health_backfill_job_progress.sql");

test("canonical trailing window is chronological and one-based", () => {
  assert.deepEqual(
    trailingMonthWindow({ anchorYear: 2026, anchorMonth: 8, count: 12 }).map((row) => row.monthKey.slice(0, 7)),
    [
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
    ]
  );
});

test("canonical trailing window handles January year boundary", () => {
  assert.deepEqual(
    trailingMonthWindow({ anchorYear: 2026, anchorMonth: 1, count: 3 }).map((row) => row.monthKey.slice(0, 7)),
    ["2025-11", "2025-12", "2026-01"]
  );
});

test("canonical trailing window rejects invalid one-based months", () => {
  assert.throws(() => trailingMonthWindow({ anchorYear: 2026, anchorMonth: 0, count: 12 }), /invalid_anchor_month/);
  assert.throws(() => trailingMonthWindow({ anchorYear: 2026, anchorMonth: 13, count: 12 }), /invalid_anchor_month/);
});

test("durable job migration records truthful Health backfill progress", () => {
  assert.match(migration, /add column if not exists job_type text not null default 'health_snapshot_backfill'/);
  assert.match(migration, /add column if not exists accounting_method text not null default 'Cash'/);
  assert.match(migration, /add column if not exists force boolean not null default false/);
  assert.match(migration, /add column if not exists expected_months jsonb/);
  assert.match(migration, /add column if not exists result_details jsonb/);
  assert.match(migration, /status in \('queued', 'running', 'completed', 'partial', 'failed', 'canceled', 'cancelled'\)/);
  assert.match(migration, /where status in \('queued', 'running'\)/);
});

test("backfill route accepts explicit anchor, honors force, and returns queued work as 202", () => {
  assert.match(route, /readAnchor\(req\)/);
  assert.match(route, /anchor_year/);
  assert.match(route, /anchor_month/);
  assert.match(route, /const force = readBool/);
  assert.match(route, /trailingMonthWindow\(\{ anchorYear: anchor\.year, anchorMonth: anchor\.month, count: months \}\)/);
  assert.match(route, /return res\.status\(202\)\.json\(normalizeStatus\(job\)\)/);
  assert.match(route, /getLatestActiveJob/);
});

test("runner processes anchor first but reports chronological expected months", () => {
  assert.match(runner, /function processAnchorFirst/);
  assert.match(runner, /return \[anchor, \.\.\.months\.slice\(0, -1\)\]/);
  assert.match(runner, /const expectedMonths = months\.map/);
  assert.match(runner, /result_details: details/);
});

test("runner skips only verified current Cash snapshots and treats legacy rows as insufficient", () => {
  assert.match(runner, /verifyEligibleHealthSnapshot/);
  assert.match(runner, /accountingMethod: HEALTH_ACCOUNTING_METHOD/);
  assert.match(runner, /snapshot\.status !== "current"/);
  assert.match(runner, /snapshot\.is_current !== true/);
  assert.match(runner, /snapshot\.accounting_method !== HEALTH_ACCOUNTING_METHOD/);
  assert.doesNotMatch(runner, /financial_metrics/);
  assert.doesNotMatch(runner, /expense_totals_monthly/);
});

test("runner honors force and preserves prior valid snapshots after a failed force refresh", () => {
  assert.match(runner, /force = false/);
  assert.match(runner, /if \(!force\)/);
  assert.match(runner, /const afterFailure = await verifyEligibleHealthSnapshot/);
  assert.match(runner, /status: "skipped", snapshotId: afterFailure\.id, reused: true/);
  assert.match(runner, /finalJobStatus/);
  assert.match(runner, /"partial"/);
});

test("OAuth bootstrap creates a tracked job instead of untracked Health history work", () => {
  assert.match(qboAuth, /createTrackedQboHealthBackfill/);
  assert.match(qboAuth, /runQboBackfill/);
  assert.doesNotMatch(qboAuth, /bootstrapMissingHealthHistory/);
  assert.match(qboAuth, /bootstrap job ready/);
});

test("job service stores Cash progress metadata and active job lookup", () => {
  assert.match(jobs, /status = "queued"/);
  assert.match(jobs, /accounting_method = "Cash"/);
  assert.match(jobs, /expected_months/);
  assert.match(jobs, /succeeded_months/);
  assert.match(jobs, /failed_months/);
  assert.match(jobs, /getLatestActiveJob/);
  assert.match(jobs, /\.in\("status", \["queued", "running"\]\)/);
  assert.match(jobs, /patch: \{ last_log: message \|\| null \}/);
});

test("Settings UI uses recovery-oriented labels and truthful progress", () => {
  assert.match(settings, /Import missing history/);
  assert.match(settings, /Re-import 12 months/);
  assert.match(settings, /Imports missing monthly reports from QuickBooks/);
  assert.match(settings, /snapshot_coverage_count/);
  assert.match(settings, /Imported \$\{coverage\} of \$\{total\}/);
  assert.doesNotMatch(settings, /Backfill last 12 months/);
  assert.doesNotMatch(settings, /Force re-sync/);
});

test("Health page shows non-blocking historical import progress", () => {
  assert.match(dashboard, /\["queued", "running"\]\.includes\(backfillStatus\?\.status\)/);
  assert.match(dashboard, /Importing QuickBooks history/);
  assert.match(dashboard, /snapshot_coverage_count/);
  assert.match(dashboard, /This runs in the background\. You can keep browsing\./);
});
