import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const migration = readFileSync(
  join(root, "supabase/migrations/20260821_add_business_onboarding_status.sql"),
  "utf8"
);

test("onboarding status is stored on business_profiles, not user_profiles", () => {
  assert.match(migration, /ALTER TABLE public\.business_profiles/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS onboarding_integrations_viewed_at/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS onboarding_completed_at/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS onboarding_status text NOT NULL DEFAULT 'in_progress'/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS quickbooks_connected boolean NOT NULL DEFAULT false/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS plaid_connected boolean NOT NULL DEFAULT false/);
  assert.doesNotMatch(migration, /ALTER TABLE public\.user_profiles/);
});

test("completed onboarding is derived from canonical business prerequisites", () => {
  assert.match(migration, /business_profiles_onboarding_status_check/);
  assert.match(migration, /CHECK \(onboarding_status IN \('in_progress', 'complete'\)\)/);
  assert.match(migration, /NULLIF\(btrim\(NEW\.business_name\), ''\) IS NOT NULL/);
  assert.match(migration, /NULLIF\(btrim\(NEW\.industry\), ''\) IS NOT NULL/);
  assert.match(migration, /NULLIF\(btrim\(NEW\.state\), ''\) IS NOT NULL/);
  assert.match(migration, /NULLIF\(btrim\(NEW\.services_offered\), ''\) IS NOT NULL/);
  assert.match(migration, /NEW\.onboarding_integrations_viewed_at IS NOT NULL/);
  assert.match(migration, /AND v_quickbooks_connected/);
  assert.match(migration, /AND v_plaid_connected/);
  assert.match(migration, /IF v_requirements_met THEN\s+NEW\.onboarding_status := 'complete'/);
  assert.match(migration, /ELSE\s+NEW\.onboarding_status := 'in_progress'/);
});

test("QBO and Plaid connection truth remains derived from integration tables", () => {
  assert.match(migration, /FROM public\.quickbooks_tokens AS qt/);
  assert.match(migration, /qt\.business_id = p_business_id/);
  assert.match(migration, /qt\.is_active IS TRUE/);
  assert.match(migration, /qt\.status = 'active'/);
  assert.match(migration, /FROM public\.plaid_items AS pi/);
  assert.match(migration, /FROM public\.plaid_accounts AS pa/);
  assert.match(migration, /pi\.business_id = p_business_id/);
  assert.match(migration, /pa\.business_id = p_business_id/);
  assert.match(migration, /NEW\.quickbooks_connected := v_quickbooks_connected/);
  assert.match(migration, /NEW\.plaid_connected := v_plaid_connected/);
  assert.match(migration, /v_quickbooks_connected := public\.business_profile_has_active_qbo_connection\(NEW\.id\)/);
  assert.match(migration, /v_plaid_connected := public\.business_profile_has_active_plaid_connection\(NEW\.id\)/);
});

test("helper functions are security-definer and not browser-callable RPCs", () => {
  for (const fn of [
    "business_profile_has_active_qbo_connection",
    "business_profile_has_active_plaid_connection",
    "business_profile_onboarding_requirements_met",
    "enforce_business_profile_onboarding_status",
    "refresh_business_profile_onboarding_status",
    "refresh_business_profile_onboarding_status_from_integration",
  ]) {
    assert.match(migration, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`));
    assert.match(migration, /SECURITY DEFINER/);
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC`));
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM anon`));
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM authenticated`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role`));
  }
});

test("trigger handles inserts without reading OLD and validates NEW row values", () => {
  assert.match(
    migration,
    /IF TG_OP = 'INSERT' THEN\s+NEW\.onboarding_status_updated_at := now\(\);\s+ELSIF/
  );
  assert.match(migration, /BEFORE INSERT OR UPDATE OF/);
  assert.match(migration, /EXECUTE FUNCTION public\.enforce_business_profile_onboarding_status\(\)/);
});

test("integration table changes refresh denormalized onboarding connection status", () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.refresh_business_profile_onboarding_status\(/);
  assert.match(migration, /UPDATE public\.business_profiles AS bp/);
  assert.match(migration, /quickbooks_connected = v_quickbooks_connected/);
  assert.match(migration, /plaid_connected = v_plaid_connected/);
  assert.match(migration, /DROP TRIGGER IF EXISTS trg_quickbooks_tokens_refresh_business_onboarding_status ON public\.quickbooks_tokens/);
  assert.match(migration, /AFTER INSERT OR UPDATE OR DELETE ON public\.quickbooks_tokens/);
  assert.match(migration, /AFTER INSERT OR UPDATE OR DELETE ON public\.plaid_items/);
  assert.match(migration, /AFTER INSERT OR UPDATE OR DELETE ON public\.plaid_accounts/);
  assert.match(migration, /IF TG_OP = 'DELETE' THEN\s+v_business_id := OLD\.business_id;/);
  assert.match(migration, /ELSE\s+v_business_id := NEW\.business_id;/);
});
