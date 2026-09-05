import test from "node:test";
import assert from "node:assert/strict";

import {
  computeTaxProfileReadiness,
  createTaxProfile,
} from "../src/services/tax/taxProfile.service.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

test("readiness exposes separate profile, classification, and calculation states", () => {
  const readiness = computeTaxProfileReadiness({
    business_id: BUSINESS_ID,
    tax_year: 2026,
    entity_type: "sole_proprietor",
    primary_tax_state: "NC",
    accounting_method: null,
    filing_status: null,
    safe_harbor_method: null,
    self_employment_tax_applies: null,
  }, { financialDataReady: true, taxClassificationReady: false });

  assert.equal(readiness.business_onboarding_state, "business_setup_complete");
  assert.equal(readiness.tax_profile_state, "profile_draft");
  assert.equal(readiness.classification_state, "ready_to_classify");
  assert.equal(readiness.calculation_state, "blocked_by_profile");
  assert.equal(readiness.calculation_ready, false);
});

test("complete six-field profile transitions profile readiness to ready", () => {
  const readiness = computeTaxProfileReadiness({
    business_id: BUSINESS_ID,
    tax_year: 2026,
    entity_type: "sole_proprietor",
    primary_tax_state: "NC",
    accounting_method: "cash",
    filing_status: "single",
    safe_harbor_method: "current_year_90",
    self_employment_tax_applies: false,
  }, { financialDataReady: true, taxClassificationReady: true });

  assert.equal(readiness.tax_profile_state, "profile_ready");
  assert.equal(readiness.classification_state, "classification_complete");
  assert.equal(readiness.calculation_state, "calculation_queued");
  assert.equal(readiness.calculation_ready, true);
});

test("first-save Tax Profile does not silently persist Cash as authoritative", async () => {
  const supabase = makeSupabase();

  const profile = await createTaxProfile({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    input: { entity_type: "sole_proprietor", source: "onboarding" },
  });

  assert.equal(profile.entity_type, "sole_proprietor");
  assert.equal(profile.accounting_method, null);
  assert.equal(profile.profile_status, "incomplete");
});

function makeSupabase() {
  const store = { tax_profiles: [] };
  return {
    store,
    from(table) {
      return tableApi(store, table);
    },
  };
}

function tableApi(store, table) {
  const state = { filters: [] };
  const api = {
    upsert(row) {
      const rows = store[table] ||= [];
      const existing = rows.find((candidate) => candidate.business_id === row.business_id && candidate.tax_year === row.tax_year);
      if (existing) Object.assign(existing, row);
      else rows.push({ id: `${table}-1`, ...row });
      state.pending = existing || rows[rows.length - 1];
      return api;
    },
    select() {
      return api;
    },
    single() {
      return Promise.resolve({ data: state.pending, error: null });
    },
  };
  return api;
}
