import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migration = fs.readFileSync(new URL("../supabase/migrations/20261101114000_monthly_review_close_function_volatility_repair.sql", import.meta.url), "utf8");
const route = fs.readFileSync(new URL("../src/api/admin/monthlyReview.routes.js", import.meta.url), "utf8");
const ui = fs.readFileSync(new URL("../src/pages/Admin/MonthlyReviewConsole.jsx", import.meta.url), "utf8");
const forwardRepair = fs.readFileSync(new URL("../supabase/migrations/20261101115000_monthly_review_close_and_report_fingerprint_repair.sql", import.meta.url), "utf8");

test("pure snapshot validation remains STABLE without a prohibited row lock", () => {
  const validator = migration.slice(migration.indexOf("create or replace function public.validate_accounting_period_close_snapshot"), migration.indexOf("create or replace function public.finalize_monthly_admin_review_close"));
  assert.match(validator, /language plpgsql\s+stable\s+security definer/i);
  assert.doesNotMatch(validator, /for\s+(share|update)/i);
  assert.match(validator, /set search_path = pg_catalog, public/i);
});

test("forward repair qualifies snapshot_id and preserves explicit function contracts", () => {
  assert.match(forwardRepair, /a\.snapshot_id = p_snapshot_id/i);
  assert.match(forwardRepair, /record_accounting_period_close_authority[\s\S]*volatile/i);
  assert.match(forwardRepair, /set search_path = pg_catalog, public/i);
  assert.match(forwardRepair, /owner to postgres/i);
  assert.match(forwardRepair, /revoke all[\s\S]*from public, anon, authenticated/i);
});

test("atomic finalizer is explicit VOLATILE, serialized, idempotent, and service-role only", () => {
  assert.match(migration, /finalize_monthly_admin_review_close[\s\S]*language plpgsql\s+volatile\s+security definer/i);
  assert.match(migration, /monthly_review_runs[\s\S]*for update/i);
  assert.match(migration, /if v_run\.status = 'finalized'/i);
  assert.match(migration, /'idempotent', true/i);
  assert.match(migration, /owner to postgres/i);
  assert.match(migration, /revoke all[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant execute[\s\S]*to service_role/i);
});

test("approval uses one stable request identity and sanitizes unexpected database errors", () => {
  assert.match(ui, /finalizeSubmittingRef\.current/);
  assert.match(ui, /finalizeRequestIdRef/);
  assert.match(ui, /"x-idempotency-key": finalizeRequestIdRef\.current/);
  assert.match(ui, /await loadDetail\(\)/);
  assert.match(ui, /e\?\.code === "NETWORK_ERROR"/);
  assert.match(route, /monthly_books_approval_failed/);
  assert.match(route, /No approval was recorded/);
  assert.doesNotMatch(route.slice(route.indexOf('router.post("/runs/:runId/finalize"'), route.indexOf('router.post("/runs/:runId/reopen"')), /res\.status\(500\)[\s\S]{0,300}message:\s*e\?\.message/);
  assert.doesNotMatch(route.slice(route.indexOf('router.post("/runs/:runId/finalize"'), route.indexOf('router.post("/runs/:runId/reopen"')), /refreshMonthlyQboFinancialSnapshot/);
});
