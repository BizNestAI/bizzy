import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const migration = readFileSync(
  join(root, "supabase/migrations/20260822_simplify_business_onboarding_completion_requirements.sql"),
  "utf8"
);

test("onboarding completion requires profile setup, QuickBooks, and Plaid only", () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.business_profile_onboarding_requirements_met/);
  assert.match(migration, /NULLIF\(btrim\(bp\.business_name\), ''\) IS NOT NULL/);
  assert.match(migration, /NULLIF\(btrim\(bp\.industry\), ''\) IS NOT NULL/);
  assert.match(migration, /NULLIF\(btrim\(bp\.state\), ''\) IS NOT NULL/);
  assert.match(migration, /NULLIF\(btrim\(bp\.services_offered\), ''\) IS NOT NULL/);
  assert.match(migration, /public\.business_profile_has_active_qbo_connection\(bp\.id\)/);
  assert.match(migration, /public\.business_profile_has_active_plaid_connection\(bp\.id\)/);
});

test("viewed integrations page is not an onboarding completion requirement", () => {
  const requirementsFunction = migration.match(
    /CREATE OR REPLACE FUNCTION public\.business_profile_onboarding_requirements_met[\s\S]*?\$\$;/
  )?.[0] || "";
  const triggerFunction = migration.match(
    /CREATE OR REPLACE FUNCTION public\.enforce_business_profile_onboarding_status\(\)[\s\S]*?\$\$;/
  )?.[0] || "";
  const refreshFunction = migration.match(
    /CREATE OR REPLACE FUNCTION public\.refresh_business_profile_onboarding_status[\s\S]*?\$\$;/
  )?.[0] || "";

  assert.doesNotMatch(requirementsFunction, /onboarding_integrations_viewed_at/);
  assert.doesNotMatch(triggerFunction, /onboarding_integrations_viewed_at/);
  assert.doesNotMatch(refreshFunction, /onboarding_integrations_viewed_at/);
  assert.match(migration, /previous onboarding_integrations_viewed_at column is kept\s+-- as non-authoritative historical\/UI telemetry only/);
});

test("business profile trigger no longer fires for integrations-page viewed telemetry", () => {
  const triggerBlock = migration.match(
    /CREATE TRIGGER trg_business_profiles_onboarding_status[\s\S]*?EXECUTE FUNCTION public\.enforce_business_profile_onboarding_status\(\);/
  )?.[0] || "";

  assert.doesNotMatch(triggerBlock, /onboarding_integrations_viewed_at/);
  assert.match(triggerBlock, /business_name/);
  assert.match(triggerBlock, /quickbooks_connected/);
  assert.match(triggerBlock, /plaid_connected/);
});

test("existing business rows are recomputed after the requirement change", () => {
  assert.match(migration, /UPDATE public\.business_profiles AS bp\s+SET onboarding_status_updated_at = now\(\)\s+WHERE bp\.id IS NOT NULL/);
  assert.doesNotMatch(migration, /DELETE FROM public\.business_profiles/);
  assert.doesNotMatch(migration, /DROP TABLE public\.business_profiles/);
});
