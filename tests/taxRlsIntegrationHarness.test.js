import test from "node:test";
import assert from "node:assert/strict";
import {
  getTaxRlsIntegrationConfig,
  looksProductionLike,
} from "./integration/tax/taxRlsHarness.js";

test("Tax RLS integration harness is disabled unless explicitly enabled", () => {
  const config = getTaxRlsIntegrationConfig({});
  assert.equal(config.runnable, false);
  assert.match(config.reason, /TAX_RLS_INTEGRATION_ENABLED/);
});

test("Tax RLS integration harness requires all real-session credentials", () => {
  const config = getTaxRlsIntegrationConfig({
    TAX_RLS_INTEGRATION_ENABLED: "true",
    TEST_SUPABASE_URL: "https://tax-rls-test.supabase.co",
  });
  assert.equal(config.runnable, false);
  assert.deepEqual(config.missing.sort(), [
    "TEST_API_BASE_URL",
    "TEST_SUPABASE_ANON_KEY",
    "TEST_SUPABASE_SERVICE_ROLE_KEY",
  ].sort());
});

test("Tax RLS integration harness blocks production-like targets by default", () => {
  const config = getTaxRlsIntegrationConfig({
    TAX_RLS_INTEGRATION_ENABLED: "true",
    TEST_SUPABASE_URL: "https://prod-project.supabase.co",
    TEST_SUPABASE_ANON_KEY: "anon",
    TEST_SUPABASE_SERVICE_ROLE_KEY: "service",
    TEST_API_BASE_URL: "https://api.bizzi.app",
  });
  assert.equal(config.runnable, false);
  assert.equal(config.appearsProduction, true);
  assert.match(config.reason, /production-like/);
});

test("Tax RLS production-like detector is conservative", () => {
  assert.equal(looksProductionLike("https://prod-project.supabase.co"), true);
  assert.equal(looksProductionLike("https://api.bizzi.app"), true);
  assert.equal(looksProductionLike("https://tax-rls-staging.supabase.co"), false);
});
