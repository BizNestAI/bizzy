/* global process */
import test from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("tax profile initializes incomplete profile safely and scopes by business/year", async () => {
  const { getOrInitializeTaxProfile } = await import("../src/services/tax/taxProfile.service.js");
  const supabase = makeSupabase({
    business_profiles: [{ id: BUSINESS_ID, user_id: USER_ID, state: "CA" }],
    tax_profiles: [],
  });

  const profile = await getOrInitializeTaxProfile({ supabase, businessId: BUSINESS_ID, taxYear: 2026, userId: USER_ID });

  assert.equal(profile.business_id, BUSINESS_ID);
  assert.equal(profile.tax_year, 2026);
  assert.equal(profile.entity_type, "unknown");
  assert.equal(profile.filing_status, "unknown");
  assert.equal(profile.profile_status, "incomplete");
  assert.equal(profile.primary_tax_state, "CA");
  assert.equal(profile.metadata.inferred.primary_tax_state.confirmed, false);
});

test("tax profile initialization does not overwrite existing confirmed profile", async () => {
  const { getOrInitializeTaxProfile } = await import("../src/services/tax/taxProfile.service.js");
  const existing = {
    id: "profile-1",
    business_id: BUSINESS_ID,
    tax_year: 2026,
    entity_type: "s_corp",
    filing_status: "single",
    primary_tax_state: "NY",
    metadata: { confirmed: true },
  };
  const supabase = makeSupabase({
    business_profiles: [{ id: BUSINESS_ID, state: "CA" }],
    tax_profiles: [existing],
  });

  const profile = await getOrInitializeTaxProfile({ supabase, businessId: BUSINESS_ID, taxYear: 2026, userId: USER_ID });

  assert.equal(profile.entity_type, "s_corp");
  assert.equal(profile.primary_tax_state, "NY");
  assert.equal(supabase.store.tax_profiles.length, 1);
});

test("tax profile completeness handles unknown, S-Corp, and safe harbor requirements", async () => {
  const { computeTaxProfileCompleteness } = await import("../src/services/tax/taxProfile.service.js");

  const unknown = computeTaxProfileCompleteness({ tax_year: 2026, entity_type: "unknown", filing_status: "unknown" });
  assert.equal(unknown.isCompleteForEstimate, false);
  assert.ok(unknown.missingRequired.includes("entity_type"));
  assert.ok(unknown.missingRequired.includes("filing_status"));

  const sCorp = computeTaxProfileCompleteness({
    tax_year: 2026,
    entity_type: "s_corp",
    tax_election: "s_corp",
    filing_status: "single",
    primary_tax_state: "CA",
    accounting_method: "cash",
    safe_harbor_method: "current_year_90",
  });
  assert.equal(sCorp.isCompleteForEstimate, false);
  assert.ok(sCorp.missingRequired.includes("owner_reasonable_salary"));
  assert.ok(sCorp.missingRequired.includes("owner_w2_wages_ytd"));

  const prior = computeTaxProfileCompleteness({
    tax_year: 2026,
    entity_type: "sole_proprietor",
    filing_status: "single",
    primary_tax_state: "CA",
    accounting_method: "cash",
    safe_harbor_method: "prior_year_110",
    self_employment_tax_applies: true,
  });
  assert.ok(prior.missingRequired.includes("prior_year_total_tax"));
  assert.ok(prior.missingRecommended.includes("prior_year_agi"));
});

test("tax profile patch cannot mutate business_id or tax_year", async () => {
  const { updateTaxProfile } = await import("../src/services/tax/taxProfile.service.js");
  const supabase = makeSupabase({
    tax_profiles: [{ id: "p1", business_id: BUSINESS_ID, tax_year: 2026, metadata: {} }],
  });

  await assert.rejects(
    () => updateTaxProfile({ supabase, businessId: BUSINESS_ID, taxYear: 2026, patch: { tax_year: 2027 }, userId: USER_ID }),
    (err) => err.code === "protected_tax_profile_field"
  );
});

test("tax profile draft saves partial valid fields without requiring prior-year safe-harbor facts", async () => {
  const { computeTaxProfileReadiness, createTaxProfile } = await import("../src/services/tax/taxProfile.service.js");
  const supabase = makeSupabase({ tax_profiles: [] });

  const profile = await createTaxProfile({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    userId: USER_ID,
    input: {
      entity_type: "sole_proprietor",
      tax_election: "sole_proprietor",
      filing_status: "single",
      primary_tax_state: "NC",
      accounting_method: "cash",
      safe_harbor_method: "current_year_90",
      self_employment_tax_applies: true,
      prior_year_total_tax: "",
      prior_year_agi: "",
      federal_withholding_ytd: "0",
      reserve_buffer_percent: "",
    },
  });
  const readiness = computeTaxProfileReadiness(profile, {
    financialDataReady: false,
    taxClassificationReady: false,
  });

  assert.equal(profile.prior_year_total_tax, null);
  assert.equal(profile.prior_year_agi, null);
  assert.equal(profile.federal_withholding_ytd, 0);
  assert.equal(profile.reserve_buffer_percent, null);
  assert.equal(readiness.profile_status, "calculation_ready");
  assert.equal(readiness.calculation_ready, false);
  assert.equal(readiness.missing_fields.includes("prior_year_total_tax"), false);
  assert.equal(readiness.missing_fields.includes("prior_year_agi"), false);
  assert.ok(readiness.blockers.includes("financial_data"));
  assert.ok(readiness.blockers.includes("tax_classifications"));
});

test("tax profile mutable body rejects unsupported fields before persistence", async () => {
  const { assertTaxProfileMutableBody } = await import("../src/services/tax/taxProfile.service.js");

  assert.doesNotThrow(() => assertTaxProfileMutableBody({
    entityType: "sole_proprietor",
    safeHarborMethod: "current_year_90",
    federalWithholdingYtd: "",
  }));
  assert.throws(
    () => assertTaxProfileMutableBody({ businessId: BUSINESS_ID, filingStatus: "single" }),
    (err) => err.code === "protected_tax_profile_field"
  );
  assert.throws(
    () => assertTaxProfileMutableBody({ random_tax_fact: "unsafe" }),
    (err) => err.code === "unsupported_tax_profile_field"
  );
});

test("tax business authorization denies another business", async () => {
  const { assertTaxBusinessAccess } = await import("../src/api/tax/taxRouteUtils.js");
  const supabase = makeSupabase({
    business_profiles: [{ id: OTHER_BUSINESS_ID, user_id: "other-user" }],
  });

  await assert.rejects(
    () => assertTaxBusinessAccess({ req: { user: { id: USER_ID } }, businessId: OTHER_BUSINESS_ID, supabase }),
    (err) => err.code === "business_access_denied"
  );
});

test("tax memory inserts active memory and replacement expires prior row", async () => {
  const { setTaxMemory, listTaxMemoryHistory } = await import("../src/services/tax/taxProfileMemory.service.js");
  const supabase = makeSupabase({ tax_profile_memory: [] });

  const first = await setTaxMemory({
    supabase,
    businessId: BUSINESS_ID,
    memoryKey: "vehicle_deduction_method",
    value: "standard_mileage",
    source: "user",
    effectiveFrom: "2026-01-01",
  });
  const second = await setTaxMemory({
    supabase,
    businessId: BUSINESS_ID,
    memoryKey: "vehicle_deduction_method",
    value: "actual_expense",
    source: "user",
    effectiveFrom: "2026-06-01",
  });
  const history = await listTaxMemoryHistory({ supabase, businessId: BUSINESS_ID, memoryKey: "vehicle_deduction_method" });

  assert.equal(first.value_json, "standard_mileage");
  assert.equal(second.value_json, "actual_expense");
  assert.equal(history.length, 2);
  assert.equal(history.find((row) => row.id === first.id).effective_to, "2026-06-01");
  assert.equal(history.find((row) => row.id === second.id).effective_to, null);
});

test("tax memory rejects lower-trust inferred replacement of confirmed memory", async () => {
  const { setTaxMemory } = await import("../src/services/tax/taxProfileMemory.service.js");
  const supabase = makeSupabase({ tax_profile_memory: [] });
  await setTaxMemory({
    supabase,
    businessId: BUSINESS_ID,
    memoryKey: "hsa_eligible",
    value: true,
    source: "user",
    confirmedBy: USER_ID,
  });

  await assert.rejects(
    () => setTaxMemory({ supabase, businessId: BUSINESS_ID, memoryKey: "hsa_eligible", value: false, source: "inferred" }),
    (err) => err.code === "confirmed_tax_memory_protected"
  );
});

test("tax memory validates percent, enum, and state-array keys", async () => {
  const { validateTaxMemoryValue } = await import("../src/services/tax/taxMemoryKeys.js");

  assert.equal(validateTaxMemoryValue("vehicle_business_use_percent", 75), 75);
  assert.throws(() => validateTaxMemoryValue("vehicle_business_use_percent", 120), /at most 100/);
  assert.equal(validateTaxMemoryValue("vehicle_deduction_method", "standard_mileage"), "standard_mileage");
  assert.throws(() => validateTaxMemoryValue("vehicle_deduction_method", "random"), /not allowed/);
  assert.deepEqual(validateTaxMemoryValue("multi_state_operations", ["ca", "NY", "CA"]), ["CA", "NY"]);
});

test("legacy adapter maps canonical fields without inventing missing state", async () => {
  const { adaptCanonicalTaxProfileForLegacyCalculator } = await import("../src/services/tax/legacyTaxProfileAdapter.js");

  const legacy = adaptCanonicalTaxProfileForLegacyCalculator({
    primary_tax_state: "CA",
    self_employment_tax_applies: true,
    safe_harbor_method: "prior_year_110",
    qbi_eligible: false,
    filing_status: "single",
    prior_year_total_tax: 12000,
  });
  assert.equal(legacy.state, "CA");
  assert.equal(legacy.se_tax_applies, true);
  assert.equal(legacy.safe_harbor_mode, "110pct_prior");
  assert.equal(legacy.qbi_eligible, false);

  const missing = adaptCanonicalTaxProfileForLegacyCalculator({});
  assert.equal(missing.state, null);
});

function makeSupabase(initial = {}) {
  const store = { __id: 1, business_profiles: [], tax_profiles: [], tax_profile_memory: [], ...clone(initial) };
  return {
    store,
    from(table) {
      return new Query(store, table);
    },
  };
}

class Query {
  constructor(store, table) {
    this.store = store;
    this.table = table;
    this.filters = [];
    this.operation = "select";
    this.payload = null;
    this.sort = null;
    this.rangeArgs = null;
    this.limitCount = null;
  }
  select() { return this; }
  eq(field, value) { this.filters.push((row) => String(row[field]) === String(value)); return this; }
  is(field, value) { this.filters.push((row) => row[field] === value); return this; }
  lte(field, value) { this.filters.push((row) => String(row[field]) <= String(value)); return this; }
  gte(field, value) { this.filters.push((row) => row[field] == null || String(row[field]) >= String(value)); return this; }
  or() { return this; }
  order(field, opts = {}) { this.sort = { field, ascending: opts.ascending !== false }; return this; }
  range(from, to) { this.rangeArgs = [from, to]; return this; }
  limit(count) { this.limitCount = count; return this; }
  insert(payload) { this.operation = "insert"; this.payload = Array.isArray(payload) ? payload : [payload]; return this; }
  update(payload) { this.operation = "update"; this.payload = payload; return this; }
  async maybeSingle() { const r = await this._execute(); return { data: r.data[0] || null, error: r.error }; }
  async single() { const r = await this._execute(); return { data: r.data[0] || null, error: r.error }; }
  then(resolve, reject) { return this._execute().then(resolve, reject); }
  async _execute() {
    this.store[this.table] ||= [];
    const rows = this.store[this.table];
    if (this.operation === "insert") {
      const inserted = this.payload.map((row) => {
        const next = { id: row.id || `${this.table}-${this.store.__id++}`, ...clone(row) };
        rows.push(next);
        return clone(next);
      });
      return { data: inserted, error: null };
    }
    if (this.operation === "update") {
      const updated = [];
      for (const row of rows) {
        if (this.filters.every((filter) => filter(row))) {
          Object.assign(row, clone(this.payload));
          updated.push(clone(row));
        }
      }
      return { data: updated, error: null };
    }
    let selected = rows.filter((row) => this.filters.every((filter) => filter(row))).map(clone);
    if (this.sort) {
      const dir = this.sort.ascending ? 1 : -1;
      selected.sort((a, b) => String(a[this.sort.field] ?? "").localeCompare(String(b[this.sort.field] ?? "")) * dir);
    }
    if (this.rangeArgs) selected = selected.slice(this.rangeArgs[0], this.rangeArgs[1] + 1);
    if (this.limitCount != null) selected = selected.slice(0, this.limitCount);
    return { data: selected, error: null };
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
