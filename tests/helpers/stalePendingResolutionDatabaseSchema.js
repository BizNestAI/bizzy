import fs from "node:fs";
import { plaidDatabaseSchema } from "./plaidDatabaseSchema.js";
export function stalePendingResolutionDatabaseSchema({ includeMigration = true } = {}) {
  let schema = plaidDatabaseSchema();
  const snapshot = fs.readFileSync("supabase/live_schema_snapshot.sql", "utf8");
  schema += snapshot.match(/CREATE TABLE IF NOT EXISTS "public"\."clarification_requests" \([\s\S]*?\n\);/)[0];
  const canonical = fs.readFileSync("supabase/migrations/20261020_canonical_bookkeeping_primary_feed.sql", "utf8");
  schema += canonical.slice(canonical.indexOf("create or replace function public.classify_bookkeeping_posting_outcome"), canonical.indexOf("create or replace view"));
  schema += fs.readFileSync("supabase/migrations/20260823_add_bookkeeping_start_date.sql", "utf8");
  // External chart/vendor modules are not exercised; retain their feed columns.
  schema += "alter table public.transaction_categorizations add column suggested_canonical_account_key text, add column final_canonical_account_key text; alter table public.bank_transactions add column canonical_vendor_id uuid;";
  schema += fs.readFileSync("supabase/migrations/20260904_operator_requests_answer_review_state.sql", "utf8");
  schema += snapshot.match(/CREATE TABLE IF NOT EXISTS "public"\."user_business_link" \([\s\S]*?\n\);/)[0];
  const chart = fs.readFileSync("supabase/migrations/20260827_canonical_chart_of_accounts.sql", "utf8");
  schema += chart.slice(chart.indexOf("create table if not exists public.qbo_accounts_cache"), chart.indexOf("create table if not exists public.business_canonical_qbo_account_mappings"));
  // Install the actual scheduler and approval contracts, not permissive stubs.
  for (const [file, table] of [["20260603_monthly_review_console.sql", "monthly_review_runs"], ["20260602_financial_monthly_review_stamps.sql", "financial_monthly_review_stamps"], ["20260920_accounting_period_close_authority.sql", "accounting_period_closes"]]) {
    const ddl = fs.readFileSync(`supabase/migrations/${file}`, "utf8").match(new RegExp(`create table if not exists public.${table} \\([\\s\\S]*?\\n\\);`, "i"));
    schema += ddl[0];
  }
  for (const file of ["20260921_auto_post_backlog_safety.sql", "20260922_auto_post_scope_confirmation_rpc.sql", "20260925_atomic_bookkeeping_approval.sql", "20261013170000_settled_credit_card_inflow_approval.sql", "20260517_acquire_posting_lock_rpc.sql", "20261111220000_auto_post_handled_admission.sql", "20260918_books_review_pending_rpc_authority.sql"]) schema += fs.readFileSync(`supabase/migrations/${file}`, "utf8");
  const view = fs.readFileSync("supabase/migrations/20261020_canonical_bookkeeping_primary_feed.sql", "utf8");
  schema += view.slice(view.indexOf("create or replace view"), view.indexOf("-- Keep the deployed bounded"));
  return schema + (includeMigration ? [
    "20261117230000_stale_pending_admin_resolution.sql",
    "20261118220000_stale_pending_global_admin_availability.sql",
    "20261118230000_stale_pending_permanent_admin_capability.sql",
  ].map(file => fs.readFileSync(`supabase/migrations/${file}`, "utf8")).join("\n") : "");
}
