import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync("supabase/migrations/20261101113000_business_evidence_package_authority.sql", "utf8");

test("evidence migration is forward-only, immutable, tenant keyed, and service-role-only", () => {
  assert.match(sql, /create table if not exists public\.business_financial_reporting_config/i);
  assert.match(sql, /create table if not exists public\.qbo_pnl_exact_range_evidence/i);
  assert.match(sql, /create table if not exists public\.business_evidence_packages/i);
  assert.match(sql, /business_id uuid not null references public\.business_profiles/i);
  assert.match(sql, /revoke all on table public\.qbo_pnl_exact_range_evidence from public,\s*anon,\s*authenticated/i);
  assert.match(sql, /grant select,insert on table public\.qbo_pnl_exact_range_evidence to service_role/i);
  assert.match(sql, /security definer set search_path = pg_catalog, public/i);
  assert.match(sql, /immutable_financial_evidence/i);
  assert.doesNotMatch(sql, /grant (insert|update|delete|all).*authenticated/i);
});

test("exact-range cache identity isolates every required dimension and usable rows require Cash reconciliation", () => {
  assert.match(sql, /qbo_pnl_exact_range_request_unique unique \(business_id, ingestion_request_id\)/i);
  assert.match(sql, /qbo_pnl_exact_range_content_idx[\s\S]*source_fingerprint,observed_at desc/i);
  assert.match(sql, /accounting_basis text not null check \(accounting_basis = 'Cash'\)/i);
  assert.match(sql, /completeness_status = 'complete'[\s\S]*reconciliation_status = 'reconciled'[\s\S]*reconciliation_difference is not null/i);
});

test("monthly snapshot hardening removes implicit basis and makes current identity basis-safe", () => {
  assert.match(sql, /alter column accounting_method drop default/i);
  assert.match(sql, /monthly_review_qbo_pnl_snapshots_current_basis_unique/i);
  assert.match(sql, /accounting_method=v_snapshot\.accounting_method/i);
  assert.match(sql, /snapshot_basis_unproven|snapshot_range_invalid|snapshot_reconciliation_incomplete/i);
});

test("verified config, packages, timestamps, and message tenancy are database-enforced", () => {
  assert.match(sql, /qbo_realm_id is not null and btrim\(qbo_realm_id\) <> ''/i);
  assert.match(sql, /home_currency is not null and home_currency ~ '\^\[A-Z\]\{3\}\$'/i);
  assert.match(sql, /provider_schema_version is not null and btrim\(provider_schema_version\) <> ''/i);
  assert.match(sql, /verification_source is not null and btrim\(verification_source\) <> ''/i);
  assert.match(sql, /generated_at <= refreshed_at and observed_at <= refreshed_at and created_at >= observed_at/i);
  assert.match(sql, /provider_generated_at is null or provider_generated_at <= observed_at/i);
  assert.match(sql, /business_evidence_packages_complete_financial_identity/i);
  assert.match(sql, /business_evidence_packages_period_change_identity/i);
  assert.match(sql, /foreign key \(business_id,evidence_package_id\)[\s\S]*references public\.business_evidence_packages\(business_id,id\)/i);
  assert.match(sql, /check \(evidence_package_id is null or business_id is not null\)/i);
});

test("owners, RLS, grants, audit immutability, and service-only RPC are explicit", () => {
  assert.match(sql, /alter table public\.qbo_pnl_exact_range_evidence owner to postgres/i);
  assert.match(sql, /alter function public\.mutate_business_financial_reporting_config[\s\S]*owner to postgres/i);
  assert.match(sql, /business_financial_reporting_config_audit_immutable/i);
  assert.match(sql, /revoke all on function public\.mutate_business_financial_reporting_config[\s\S]*from public,anon,authenticated/i);
  assert.match(sql, /grant execute on function public\.mutate_business_financial_reporting_config[\s\S]*to service_role/i);
  assert.match(sql, /revoke all on function public\.invalidate_reporting_config_on_qbo_realm_change\(\) from service_role/i);
  assert.match(sql, /quickbooks_tokens_invalidate_reporting_config/i);
  assert.match(sql, /from pg_catalog\.pg_timezone_names\(\)/i);
  assert.match(sql, /grant select on table public\.business_financial_reporting_config to service_role/i);
  assert.match(sql, /grant select on table public\.business_financial_reporting_config_audit to service_role/i);
  assert.doesNotMatch(sql, /grant all on table public\.business_financial_reporting_config(?:_audit)? to service_role/i);
});
