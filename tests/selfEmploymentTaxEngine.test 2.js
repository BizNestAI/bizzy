/* global process */
import test from "node:test";
import assert from "node:assert/strict";

process.env.TAX_RULE_CACHE_DISABLED = "true";

import { computeSelfEmploymentTaxMath } from "../src/services/tax/selfEmployment/selfEmploymentTaxMath.js";
import { getSelfEmploymentTaxRules } from "../src/services/tax/selfEmployment/selfEmploymentRule.service.js";
import { computeSelfEmploymentTax } from "../src/services/tax/selfEmployment/selfEmploymentTaxEngine.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "99999999-9999-4999-8999-999999999999";

test("SE math applies net earnings factor and computes annual SS and Medicare below wage base", () => {
  const result = computeSelfEmploymentTaxMath(mathInput({ netBusinessIncome: 100000 }));
  assert.equal(result.netEarningsFromSelfEmployment, 92350);
  assert.equal(result.socialSecurity.taxableBase, 92350);
  assert.equal(result.socialSecurity.tax, 11451.4);
  assert.equal(result.medicare.tax, 2678.15);
  assert.equal(result.totalSelfEmploymentTax, 14129.55);
  assert.equal(result.deductibleHalfSelfEmploymentTax, 7064.78);
});

test("SE math caps SS at remaining wage base and other W-2 wages reduce the base", () => {
  const capped = computeSelfEmploymentTaxMath(mathInput({ netBusinessIncome: 300000 }));
  assert.equal(capped.socialSecurity.taxableBase, 160200);
  assert.equal(capped.socialSecurity.tax, 19864.8);

  const withWages = computeSelfEmploymentTaxMath(mathInput({
    netBusinessIncome: 300000,
    otherSocialSecurityWages: 150000,
    otherMedicareWages: 150000,
  }));
  assert.equal(withWages.socialSecurity.remainingWageBase, 10200);
  assert.equal(withWages.socialSecurity.taxableBase, 10200);
  assert.equal(withWages.socialSecurity.tax, 1264.8);
});

test("Medicare is uncapped and Additional Medicare threshold uses combined wage context", () => {
  const result = computeSelfEmploymentTaxMath(mathInput({
    netBusinessIncome: 100000,
    otherMedicareWages: 190000,
    additionalMedicareThreshold: 200000,
  }));
  assert.equal(result.medicare.taxableBase, 92350);
  assert.equal(result.additionalMedicare.taxableBase, 82350);
  assert.equal(result.additionalMedicare.tax, 741.15);
  assert.equal(result.additionalMedicare.applied, true);
});

test("negative income produces zero SE tax and no federal/state tax fields", () => {
  const result = computeSelfEmploymentTaxMath(mathInput({ netBusinessIncome: -5000 }));
  assert.equal(result.netEarningsFromSelfEmployment, 0);
  assert.equal(result.totalSelfEmploymentTax, 0);
  assert.ok(result.warnings.some((warning) => warning.code === "negative_se_income"));
  assert.equal(result.federalTax, undefined);
  assert.equal(result.stateTax, undefined);
});

test("rule loader requires verified configs and returns filing-status threshold", async () => {
  const rules = await getSelfEmploymentTaxRules({
    supabase: makeSupabase(baseStore()),
    taxYear: 2026,
    filingStatus: "single",
  });
  assert.equal(rules.netEarningsFactor, 0.9235);
  assert.equal(rules.socialSecurityWageBase, 160200);
  assert.equal(rules.additionalMedicareThreshold, 200000);
  assert.equal(rules.ruleVersions.selfEmploymentTax, "fixture-se");

  await assert.rejects(
    () => getSelfEmploymentTaxRules({
      supabase: makeSupabase(baseStore({ tax_rule_configs: [seRule(), additionalMedicareRule()] })),
      taxYear: 2026,
      filingStatus: "single",
    }),
    (err) => err.code === "missing_wage_base_config"
  );
});

test("SE engine rejects S-Corp and unknown entity paths", async () => {
  const sCorpContext = entityContext("s_corporation", false);
  await assert.rejects(
    () => computeSelfEmploymentTax({
      supabase: makeSupabase(baseStore({ tax_profiles: [profile({ entity_type: "s_corp", tax_election: "s_corp" })] })),
      businessId: BUSINESS_ID,
      taxYear: 2026,
      entityContext: sCorpContext,
      annualNetBusinessIncome: 100000,
    }),
    (err) => err.code === "s_corp_not_subject_to_se_tax"
  );

  await assert.rejects(
    () => computeSelfEmploymentTax({
      supabase: makeSupabase(baseStore({ tax_profiles: [profile({ entity_type: "unknown", tax_election: "unknown" })] })),
      businessId: BUSINESS_ID,
      taxYear: 2026,
      entityContext: entityContext("unknown", false),
      annualNetBusinessIncome: 100000,
    }),
    (err) => err.code === "entity_not_supported_for_se_tax"
  );
});

test("SE engine returns half-SE adjustment, lowers confidence for unknown wages, and does not include regular tax", async () => {
  const result = await computeSelfEmploymentTax({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    entityContext: entityContext("single_member_llc_disregarded", true),
    annualNetBusinessIncome: 100000,
  });
  assert.equal(result.result.totalSelfEmploymentTax, 14129.55);
  assert.deepEqual(result.federalAdjustmentOutput, {
    type: "half_self_employment_tax_adjustment",
    amount: 7064.78,
    direction: "decrease_taxable_income",
  });
  assert.equal(result.regularFederalIncomeTax, undefined);
  assert.equal(result.stateTax, undefined);
  assert.ok(result.confidence.level !== "high");
  assert.ok(result.warnings.some((warning) => warning.code === "other_fica_wages_unknown"));
});

test("SE engine range cases run full math independently and other wages can eliminate SS base", async () => {
  const result = await computeSelfEmploymentTax({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    entityContext: entityContext("sole_proprietor", true),
    annualNetBusinessIncome: 100000,
    annualNetBusinessIncomeRange: { low: 50000, base: 100000, high: 300000 },
    otherW2Wages: 160200,
  });
  assert.equal(result.detail.socialSecurity.taxableBase, 0);
  assert.equal(result.range.lowIncomeCase.totalSelfEmploymentTax, 1396.45);
  assert.equal(result.range.baseIncomeCase.totalSelfEmploymentTax, 3151.1);
  assert.equal(result.range.highIncomeCase.totalSelfEmploymentTax, 10169.7);
});

test("SE engine scopes profile by business and year and avoids legacy multiplier behavior", async () => {
  const result = await computeSelfEmploymentTax({
    supabase: makeSupabase(baseStore({
      tax_profiles: [
        profile({ business_id: OTHER_BUSINESS_ID, owner_w2_wages_ytd: 160200 }),
        profile({ business_id: BUSINESS_ID, tax_year: 2027, owner_w2_wages_ytd: 160200 }),
        profile({ business_id: BUSINESS_ID, tax_year: 2026 }),
      ],
    })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    entityContext: entityContext("sole_proprietor", true),
    annualNetBusinessIncome: 100000,
  });
  assert.equal(result.input.otherW2Wages, 0);
  assert.equal(result.result.totalSelfEmploymentTax, 14129.55);
});

function mathInput(overrides = {}) {
  return {
    netBusinessIncome: 100000,
    netEarningsFactor: 0.9235,
    socialSecurityRate: 0.124,
    medicareRate: 0.029,
    socialSecurityWageBase: 160200,
    otherSocialSecurityWages: 0,
    otherMedicareWages: 0,
    additionalMedicareRate: 0.009,
    additionalMedicareThreshold: 200000,
    deductiblePortionRate: 0.5,
    ...overrides,
  };
}

function baseStore(overrides = {}) {
  return {
    tax_profiles: [profile()],
    tax_rule_configs: [seRule(), wageBaseRule(), additionalMedicareRule()],
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

function seRule(overrides = {}) {
  return rule({
    id: "se-rule",
    rule_type: "self_employment_tax",
    version: "fixture-se",
    config: {
      netEarningsFactor: 0.9235,
      socialSecurityRate: 0.124,
      medicareRate: 0.029,
      socialSecurityWageBase: 160200,
      deductiblePortionRate: 0.5,
    },
    ...overrides,
  });
}

function wageBaseRule(overrides = {}) {
  return rule({
    id: "wage-base",
    rule_type: "social_security_wage_base",
    version: "fixture-wage-base",
    config: { amount: 160200 },
    ...overrides,
  });
}

function additionalMedicareRule(overrides = {}) {
  return rule({
    id: "additional-medicare",
    rule_type: "additional_medicare_tax",
    version: "fixture-additional-medicare",
    config: {
      rate: 0.009,
      thresholdsByFilingStatus: {
        single: 200000,
        married_filing_jointly: 250000,
      },
    },
    ...overrides,
  });
}

function rule(overrides = {}) {
  return {
    id: "rule-1",
    tax_year: 2026,
    jurisdiction: "federal",
    filing_status: null,
    entity_type: null,
    support_level: "verified",
    source_name: "Fixture",
    source_url: "https://example.test/fixture",
    verified_at: "2026-01-01",
    effective_from: "2026-01-01",
    effective_to: null,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function entityContext(entityPath, runSelfEmploymentTax) {
  return {
    entity: { entityPath },
    routing: { runSelfEmploymentTax },
    inputs: { projectedBusinessTaxableIncome: 100000, businessTaxableIncomeYtd: 50000 },
    confidence: { score: 90, level: "high" },
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
  gte(field, value) {
    this.rows = this.rows.filter((row) => String(row[field] || "") >= String(value));
    return this;
  }
  lte(field, value) {
    this.rows = this.rows.filter((row) => String(row[field] || "") <= String(value));
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
