import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../supabase/migrations/20261101092000_launch_permission_corrections.sql", import.meta.url),
  "utf8"
);

const serviceOnlyFunctions = [
  "acquire_posting_lock\\(uuid, uuid, timestamptz, integer, text\\)",
  "claim_contractor_cfo_insight_run\\(text, timestamptz, text, integer\\)",
  "claim_scheduled_job_lock\\(text, timestamptz, text, integer, jsonb\\)",
  "refresh_billing_identity_summary\\(uuid\\)",
  "recalc_thread_last_message\\(uuid\\)",
  "is_member\\(uuid, uuid\\)",
];

test("backend control functions are explicitly service-role-only with hardened search paths", () => {
  for (const signature of serviceOnlyFunctions) {
    assert.match(migration, new RegExp(`alter function public\\.${signature}[\\s\\S]{0,100}set search_path = pg_catalog, public`, "i"));
    assert.match(migration, new RegExp(`revoke all on function public\\.${signature} from public, anon, authenticated`, "i"));
    assert.match(migration, new RegExp(`grant execute on function public\\.${signature} to service_role`, "i"));
  }
});

test("tax drilldown is service-role-only because the browser uses the protected server route", () => {
  assert.match(migration, /get_tax_deduction_transaction_drilldown[\s\S]+from public, anon, authenticated/i);
  assert.match(migration, /get_tax_deduction_transaction_drilldown[\s\S]+to service_role/i);
});

test("canonical RLS membership helper retains authenticated access but rejects anonymous access", () => {
  assert.match(migration, /revoke all on function public\.bizzi_current_user_is_business_member\(uuid\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.bizzi_current_user_is_business_member\(uuid\) to authenticated, service_role/i);
});

test("unused browser view surfaces are service-role-only", () => {
  for (const view of ["ar_aging", "ar_aging_v2", "insights_history"]) {
    assert.match(migration, new RegExp(`revoke all on table public\\.${view} from public, anon, authenticated`, "i"));
    assert.match(migration, new RegExp(`grant select on table public\\.${view} to service_role`, "i"));
  }
});
