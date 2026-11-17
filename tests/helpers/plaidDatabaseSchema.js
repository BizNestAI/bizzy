import fs from "node:fs";
import assert from "node:assert/strict";
const read = (f) => fs.readFileSync(f,"utf8");
export function plaidDatabaseSchema() {
  const snapshot = read("supabase/live_schema_snapshot.sql");
  const tables = ["business_profiles", "bank_transactions", "transaction_categorizations", "plaid_items", "plaid_accounts", "bank_sync_runs", "qbo_posted_transactions", "plaid_qbo_account_mappings", "quickbooks_tokens", "business_billing", "bookkeeping_post_attempts"];
  let out = `create role anon; create role authenticated; create role service_role bypassrls login;
    grant usage on schema public to service_role;
    create schema extensions; create extension if not exists "uuid-ossp" schema extensions;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    set check_function_bodies = false;\n`;
  // Exact snapshot DDL, not hand-written permissive replicas. External-module
  // foreign keys are omitted; core ownership/identity FKs are retained.
  for (const t of tables) {
    const ddl = snapshot.match(new RegExp(`CREATE TABLE IF NOT EXISTS "public"\\."${t}" \\([\\s\\S]*?\n\\);`));
    assert.ok(ddl, t); out += `${ddl[0]}\n`;
  }
  for (const m of snapshot.matchAll(/ALTER TABLE ONLY "public"\."([^"]+)"[\s\S]*?;/g)) {
    if (!tables.includes(m[1])) continue;
    const ref = m[0].match(/REFERENCES "public"\."([^"]+)"/);
    if (ref && !tables.includes(ref[1])) continue;
    out += `${m[0]}\n`;
  }
  for (const m of snapshot.matchAll(/CREATE (?:UNIQUE )?INDEX [^;]+;/g)) {
    if (["bank_transactions", "transaction_categorizations", "plaid_accounts", "plaid_qbo_account_mappings"].some(t => m[0].includes(`ON "public"."${t}"`))) out += `${m[0]}\n`;
  }
  for (const f of ["set_updated_at", "tc_sync_txn_fields_from_bank_transactions"]) {
    const m = snapshot.match(new RegExp(`CREATE OR REPLACE FUNCTION "public"\\."${f}"\\([\\s\\S]*?\n\\$\\$;`));
    assert.ok(m, f); out += `${m[0]}\n`;
  }
  for (const m of snapshot.matchAll(/CREATE OR REPLACE TRIGGER [^;]+;/g)) {
    if (["bank_transactions", "transaction_categorizations", "plaid_accounts", "plaid_qbo_account_mappings"].some(t => m[0].includes(`ON "public"."${t}"`))) out += `${m[0]}\n`;
  }
  // The installed posting-job trigger is included; it only records database
  // state. No posting worker is started.
  const classifier = read("supabase/migrations/20261024_posted_matched_primary_feed_separation.sql");
  out += classifier.slice(0, classifier.indexOf("$$;") + 3);
  for (const f of [
    "20260908_internal_staff_users.sql", "20260903_credit_card_payment_pairs.sql", "20260824_add_auto_post_to_quickbooks.sql", "20260509_plaid_env_transaction_source.sql", "20260825_plaid_canonical_identity_phase1.sql",
    "20260826_qbo_posting_idempotency_phase2.sql", "20260830_background_bookkeeping_processing.sql", "20261006_plaid_replacement_card_recovery.sql",
    "20261010_bookkeeping_review_posting_state_separation.sql", "20261013090000_pending_transaction_resolution.sql",
    "20261021_transaction_exclusions.sql", "20261023_exclusion_status_constraint.sql",
    "20261101095000_plaid_replacement_recovery_orchestration.sql", "20261101101000_plaid_replacement_recovery_durable_state.sql", "20261101104000_plaid_recovery_preview_rebuild.sql", "20261027_handled_posting_jobs_hardening.sql", "20261101111000_plaid_account_connection_state_contract.sql", "20261109173000_plaid_durable_sync_admission.sql", "20261109190000_plaid_account_recovery_observability.sql",
  ]) out += `\n${read(`supabase/migrations/${f}`)}\n`;
  // Matching evidence uses the exact table DDL; unrelated job-revenue indexes
  // and RPCs from that migration are outside this disposable fixture.
  const matchMigration = read("supabase/migrations/20261009_incoming_deposit_qbo_matches.sql");
  for (const table of ["bank_qbo_matches", "bank_qbo_match_items", "bank_qbo_match_history"]) {
    const ddl=matchMigration.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\n\\);`));
    assert.ok(ddl,table); out+=ddl[0]+"\n";
  }
  const pairEvents=read("supabase/migrations/20260922_atomic_credit_card_payment_pair_lifecycle.sql");
  out+=pairEvents.slice(pairEvents.indexOf("create table"),pairEvents.indexOf("create index"));
  out+=read("supabase/migrations/20261109210000_plaid_residual_reconciliation.sql");
  out+=read("supabase/migrations/20261109230000_plaid_reconnect_shared_recovery.sql");
  out+=read("supabase/migrations/20261110190000_plaid_processing_cohort_observability.sql");
  // Do not blanket-grant functions: that would expose the private hold helper.
  out += "alter table public.transaction_categorizations enable row level security; grant all on all tables in schema public to service_role;";
  return out;
}
