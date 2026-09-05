import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { sanitizeInitialBusinessPayload } from "../src/api/onboarding/onboardingBusiness.service.js";

test("initial business onboarding requires only minimum business setup fields", () => {
  const payload = sanitizeInitialBusinessPayload({
    business_name: "Pat's Test Account",
    industry: "HVAC",
    state: "NC",
    team_size: "",
    services_offered: "",
  });

  assert.equal(payload.business_name, "Pat's Test Account");
  assert.equal(payload.industry, "HVAC");
  assert.equal(payload.state, "NC");
  assert.equal(payload.team_size, null);
  assert.equal(payload.services_offered, null);
});

test("minimum business fields remain required", () => {
  assert.throws(
    () => sanitizeInitialBusinessPayload({ business_name: "Pat's Test Account", industry: "HVAC" }),
    (err) => {
      assert.equal(err.code, "BUSINESS_PROFILE_REQUIRED");
      assert.deepEqual(err.meta.missing, ["state"]);
      return true;
    }
  );
});

test("forward migration relaxes onboarding personalization requirements and adds profile context classification trigger", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20260927_decouple_onboarding_tax_estimate_readiness.sql", import.meta.url), "utf8");

  assert.match(migration, /ALTER COLUMN services_offered DROP NOT NULL/);
  assert.doesNotMatch(migration, /OR p_team_size IS NULL/);
  assert.doesNotMatch(migration, /NULLIF\(pg_catalog\.BTRIM\(p_services_offered\), ''\) IS NULL/);
  assert.match(migration, /'profile_context_updated'/);
});
