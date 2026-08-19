import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const migration = read("supabase/migrations/20260815_harden_views_rpc_functions.sql");
const harness = read("scripts/runStagingTwoTenantRlsAttackTest.js");

const SERVER_ONLY_VIEWS = [
  "ar_aging",
  "ar_aging_v2",
  "billing_customer_overview",
  "expense_categories",
  "insights_history",
  "jobs_profitability",
  "positions_view",
];

const BACKEND_ONLY_FUNCTION_SIGNATURES = [
  "public.acquire_posting_lock(uuid, uuid, timestamp with time zone, integer, text)",
  "public.apply_tax_classification_override",
  "public.claim_contractor_cfo_insight_run(text, timestamp with time zone, text, integer)",
  "public.claim_scheduled_job_lock(text, timestamp with time zone, text, integer, jsonb)",
  "public.claim_tax_recalculation_requests(text, integer, timestamp with time zone)",
  "public.billing_effective_bool(boolean, boolean, boolean)",
  "public.billing_effective_status(text, text, text)",
  "public.billing_effective_text(text, text, text)",
  "public.billing_effective_timestamptz(timestamp with time zone, timestamp with time zone, timestamp with time zone)",
  "public.compute_days_overdue(date)",
  "public.finalize_tax_calculation_run",
  "public.get_tax_deduction_transaction_drilldown",
  "public.handle_confirmed_auth_user_profile()",
  "public.is_member(uuid, uuid)",
  "public.match_bizzy_memory(uuid, public.vector, double precision, integer, text[])",
  "public.match_memories(public.vector, uuid, integer)",
  "public.prevent_business_profile_identity_reassignment()",
  "public.recalc_thread_last_message(uuid)",
  "public.prevent_notification_tenant_reassignment()",
  "public.prevent_user_business_link_identity_reassignment()",
  "public.refresh_billing_identity_summary(uuid)",
  "public.create_initial_business_for_user(uuid, text, text, text, integer, text, text, text, text, integer, text)",
];

const RLS_HELPERS = [
  "public.tax_user_owns_business(uuid)",
  "public.bizzi_current_user_is_business_member(uuid)",
  "public.bizzi_current_user_can_manage_business(uuid)",
];

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function viewStatements(view) {
  return migration
    .split(/\n(?=(?:ALTER|REVOKE|GRANT|COMMIT|BEGIN)\b)/)
    .filter((stmt) => stmt.includes(`public.${view}`))
    .join("\n");
}

function escapedSignature(signature) {
  return signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\(/g, "\\(").replace(/\\\)/g, "\\)");
}

test("view/RPC migration makes all public aggregate views server-only and security invoker", () => {
  for (const view of SERVER_ONLY_VIEWS) {
    const statements = viewStatements(view);
    assert.match(statements, new RegExp(`ALTER VIEW public\\.${view} SET \\(security_invoker = true\\);`));
    assert.match(statements, new RegExp(`REVOKE ALL ON TABLE public\\.${view} FROM PUBLIC;`));
    assert.match(statements, new RegExp(`REVOKE ALL ON TABLE public\\.${view} FROM anon;`));
    assert.match(statements, new RegExp(`REVOKE ALL ON TABLE public\\.${view} FROM authenticated;`));
    assert.match(statements, new RegExp(`GRANT ALL ON TABLE public\\.${view} TO service_role;`));
    assert.doesNotMatch(statements, /GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)\b[^;]*\bTO authenticated/i);
    assert.doesNotMatch(statements, /GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)\b[^;]*\bTO anon/i);
  }
});

test("backend-only RPCs revoke browser execution and retain service role execution", () => {
  for (const signature of BACKEND_ONLY_FUNCTION_SIGNATURES) {
    const re = escapedSignature(signature);
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION ${re}[\\s\\S]*?FROM PUBLIC;`));
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION ${re}[\\s\\S]*?FROM anon;`));
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION ${re}[\\s\\S]*?FROM authenticated;`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION ${re}[\\s\\S]*?TO service_role;`));
  }
});

test("SECURITY DEFINER functions have hardened search_path", () => {
  const hardened = [
    "public.acquire_posting_lock(uuid, uuid, timestamp with time zone, integer, text)",
    "public.claim_contractor_cfo_insight_run(text, timestamp with time zone, text, integer)",
    "public.claim_scheduled_job_lock(text, timestamp with time zone, text, integer, jsonb)",
    "public.claim_tax_recalculation_requests(text, integer, timestamp with time zone)",
    "public.handle_confirmed_auth_user_profile()",
    "public.refresh_billing_identity_summary(uuid)",
    "public.refresh_billing_identity_summary_from_billing()",
    "public.refresh_billing_identity_summary_from_business_profile()",
    "public.refresh_billing_identity_summary_from_user_profile()",
    "public.tax_user_owns_business(uuid)",
    "public.bizzi_current_user_is_business_member(uuid)",
    "public.bizzi_current_user_can_manage_business(uuid)",
    "public.create_initial_business_for_user(uuid, text, text, text, integer, text, text, text, text, integer, text)",
  ];
  for (const signature of hardened) {
    assert.match(migration, new RegExp(`ALTER FUNCTION ${escapedSignature(signature)}\\s+SET search_path = pg_catalog, public;`));
  }
});

test("reviewed RLS helpers remain authenticated-callable but not anonymous-callable", () => {
  for (const signature of RLS_HELPERS) {
    const re = escapedSignature(signature);
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION ${re} FROM PUBLIC;`));
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION ${re} FROM anon;`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION ${re} TO authenticated;`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION ${re} TO service_role;`));
  }
});

test("migration does not change table RLS policies, default privileges, sequences, or storage", () => {
  const executableSql = migration
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.doesNotMatch(executableSql, /CREATE POLICY/i);
  assert.doesNotMatch(executableSql, /DROP POLICY/i);
  assert.doesNotMatch(executableSql, /ALTER DEFAULT PRIVILEGES/i);
  assert.doesNotMatch(executableSql, /ON SEQUENCE/i);
  assert.doesNotMatch(executableSql, /storage\./i);
});

test("runtime harness includes view and RPC attack coverage", () => {
  assert.match(harness, /async function runViewRpcFunctionTests/);
  for (const view of SERVER_ONLY_VIEWS) {
    assert.match(harness, new RegExp(`"${view}"`));
  }
  for (const fn of [
    "bizzi_current_user_is_business_member",
    "bizzi_current_user_can_manage_business",
    "tax_user_owns_business",
    "acquire_posting_lock",
    "claim_contractor_cfo_insight_run",
    "claim_scheduled_job_lock",
    "refresh_billing_identity_summary",
    "get_tax_deduction_transaction_drilldown",
    "is_member",
    "recalc_thread_last_message",
    "create_initial_business_for_user",
  ]) {
    assert.match(harness, new RegExp(`"${fn}"`));
  }
  assert.match(harness, /await runViewRpcFunctionTests\(userA, bizA, userB, bizB\);/);
});
