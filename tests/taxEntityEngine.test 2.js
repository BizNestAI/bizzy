import test from "node:test";
import assert from "node:assert/strict";

import { evaluateTaxEntity } from "../src/services/tax/entity/entityEngine.js";
import { resolveEntityPath } from "../src/services/tax/entity/entityResolver.js";
import { ENTITY_PATHS } from "../src/services/tax/entity/entityDomain.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "99999999-9999-4999-8999-999999999999";

test("sole proprietor and disregarded single-member LLC route to self-employment tax", async () => {
  const sole = await evaluateTaxEntity({
    supabase: makeSupabase(baseStore({ tax_profiles: [profile({ entity_type: "sole_proprietor", tax_election: "sole_proprietor" })] })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    taxableIncomeContext: taxableIncome(25000),
    projectionContext: projection(50000),
    memories: [],
  });
  assert.equal(sole.entity.entityPath, ENTITY_PATHS.SOLE_PROPRIETOR);
  assert.equal(sole.routing.runSelfEmploymentTax, true);
  assert.equal(sole.routing.runSCorpEngine, false);

  const smllc = await evaluateTaxEntity({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    taxableIncomeContext: taxableIncome(30000),
    projectionContext: projection(60000),
    memories: [],
  });
  assert.equal(smllc.entity.entityPath, ENTITY_PATHS.SINGLE_MEMBER_LLC_DISREGARDED);
  assert.equal(smllc.routing.runSelfEmploymentTax, true);
});

test("SMLLC with S-Corp election routes to S-Corp and pass-through profit avoids SE routing", async () => {
  const result = await evaluateTaxEntity({
    supabase: makeSupabase(baseStore({ tax_profiles: [profile({
      tax_election: "s_corp",
      self_employment_tax_applies: false,
      owner_reasonable_salary: 80000,
      owner_w2_wages_ytd: 40000,
      federal_withholding_ytd: 7000,
      state_withholding_ytd: 1500,
    })] })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    taxableIncomeContext: taxableIncome(90000),
    projectionContext: projection(180000),
    memories: [],
  });
  assert.equal(result.entity.entityPath, ENTITY_PATHS.S_CORPORATION);
  assert.equal(result.routing.runSelfEmploymentTax, false);
  assert.equal(result.routing.runSCorpEngine, true);
  assert.ok(result.supportedButDeferred.includes("qbi_candidate"));
  assert.ok(result.supportedButDeferred.includes("state_income_tax"));
});

test("single-member LLC without election is blocked and unknown entity does not default", async () => {
  const missingElection = await evaluateTaxEntity({
    supabase: makeSupabase(baseStore({ tax_profiles: [profile({ tax_election: "unknown" })] })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    taxableIncomeContext: taxableIncome(10000),
    projectionContext: projection(20000),
    memories: [],
  });
  assert.equal(missingElection.entity.entityPath, ENTITY_PATHS.UNKNOWN);
  assert.equal(missingElection.routing.runFederalIncomeTax, false);
  assert.ok(missingElection.blockers.some((blocker) => blocker.code === "missing_tax_election"));

  const unknown = resolveEntityPath({ entityType: "unknown", taxElection: "unknown" });
  assert.equal(unknown.entityPath, ENTITY_PATHS.UNKNOWN);
  assert.ok(unknown.blockers.some((blocker) => blocker.code === "missing_entity_type"));
});

test("unsupported partnership returns unsupported status", async () => {
  const result = await evaluateTaxEntity({
    supabase: makeSupabase(baseStore({ tax_profiles: [profile({ entity_type: "partnership", tax_election: "unknown" })] })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    taxableIncomeContext: taxableIncome(10000),
    projectionContext: projection(20000),
    memories: [],
  });
  assert.equal(result.entity.entityPath, ENTITY_PATHS.UNSUPPORTED);
  assert.equal(result.entity.supportStatus, "unsupported");
  assert.equal(result.routing.runFederalIncomeTax, false);
});

test("contradictory entity/election and S-Corp missing salary are surfaced", async () => {
  const conflict = await evaluateTaxEntity({
    supabase: makeSupabase(baseStore({ tax_profiles: [profile({ entity_type: "sole_proprietor", tax_election: "s_corp" })] })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    taxableIncomeContext: taxableIncome(10000),
    projectionContext: projection(20000),
    memories: [],
  });
  assert.ok(conflict.conflicts.some((row) => row.code === "sole_prop_s_corp_conflict"));

  const sCorp = await evaluateTaxEntity({
    supabase: makeSupabase(baseStore({ tax_profiles: [profile({ entity_type: "s_corp", tax_election: "s_corp", self_employment_tax_applies: false })] })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    taxableIncomeContext: taxableIncome(50000),
    projectionContext: projection(100000),
    memories: [],
  });
  assert.ok(sCorp.requirements.missingInputs.includes("owner_reasonable_salary"));
  assert.ok(sCorp.blockers.some((blocker) => blocker.code === "missing_required_s_corp_inputs"));
  assert.equal(sCorp.confidence.level, "unavailable");
});

test("scenario override does not persist profile and business/year isolation is enforced", async () => {
  const store = baseStore({
    tax_profiles: [
      profile({ id: "p-2026", business_id: BUSINESS_ID, tax_year: 2026, entity_type: "single_member_llc", tax_election: "disregarded_entity" }),
      profile({ id: "p-2027", business_id: BUSINESS_ID, tax_year: 2027, entity_type: "s_corp", tax_election: "s_corp" }),
      profile({ id: "p-other", business_id: OTHER_BUSINESS_ID, tax_year: 2026, entity_type: "s_corp", tax_election: "s_corp" }),
    ],
  });
  const result = await evaluateTaxEntity({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    scenarioOverrides: { entity_type: "single_member_llc", tax_election: "s_corp", self_employment_tax_applies: false },
    taxableIncomeContext: taxableIncome(10000),
    projectionContext: projection(20000),
    memories: [],
  });
  assert.equal(result.entity.entityPath, ENTITY_PATHS.S_CORPORATION);
  assert.equal(store.tax_profiles.find((row) => row.id === "p-2026").tax_election, "disregarded_entity");
});

test("Entity Engine performs no tax amount calculations", async () => {
  const result = await evaluateTaxEntity({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    taxableIncomeContext: taxableIncome(10000),
    projectionContext: projection(20000),
    memories: [],
  });
  assert.equal(result.diagnostics.noFinalTaxMath, true);
  assert.equal(result.tax, undefined);
  assert.equal(result.federalTax, undefined);
  assert.equal(result.selfEmploymentTax, undefined);
});

function baseStore(overrides = {}) {
  return {
    tax_profiles: [profile()],
    tax_profile_memory: [],
    ...overrides,
  };
}

function profile(overrides = {}) {
  return {
    id: "profile-1",
    business_id: BUSINESS_ID,
    tax_year: 2026,
    entity_type: "single_member_llc",
    tax_election: "disregarded_entity",
    filing_status: "single",
    primary_tax_state: "NC",
    accounting_method: "cash",
    safe_harbor_method: "current_year_90",
    self_employment_tax_applies: true,
    qbi_eligible: true,
    profile_status: "active",
    metadata: {},
    ...overrides,
  };
}

function taxableIncome(amount) {
  return {
    businessTaxableIncome: {
      finalBusinessTaxableIncome: amount,
    },
  };
}

function projection(amount) {
  return {
    projectedAnnual: {
      taxableBusinessIncome: amount,
    },
  };
}

function makeSupabase(store) {
  return {
    store,
    from(table) {
      return new Query(table, store);
    },
  };
}

class Query {
  constructor(table, store) {
    this.table = table;
    this.store = store;
    this.rows = [...(store[table] || [])];
  }
  select() { return this; }
  eq(field, value) {
    this.rows = this.rows.filter((row) => row[field] === value);
    return this;
  }
  lte(field, value) {
    this.rows = this.rows.filter((row) => String(row[field] || "") <= String(value));
    return this;
  }
  is(field, value) {
    this.rows = this.rows.filter((row) => row[field] === value);
    return this;
  }
  order() { return this; }
  maybeSingle() {
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  then(resolve) {
    return Promise.resolve({ data: this.rows, error: null }).then(resolve);
  }
}
