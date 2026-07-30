/* global process */
import test from "node:test";
import assert from "node:assert/strict";

process.env.TAX_RULE_CACHE_DISABLED = "true";

import { computeProgressiveTax, validateProgressiveBrackets } from "../src/services/tax/federal/progressiveTax.js";
import { getStandardDeduction } from "../src/services/tax/federal/standardDeduction.service.js";
import { computeFederalIncomeTax } from "../src/services/tax/federal/federalTaxEngine.js";
import { toLegacyFederalTaxFields } from "../src/services/tax/federal/legacyFederalTaxAdapter.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "99999999-9999-4999-8999-999999999999";

const BRACKETS = [
  { upTo: 10000, rate: 0.1 },
  { upTo: 40000, rate: 0.2 },
  { upTo: null, rate: 0.3 },
];

test("progressive tax handles zero, first bracket, multiple brackets, top bracket, and negative income", () => {
  assert.equal(computeProgressiveTax({ taxableIncome: 0, brackets: BRACKETS }).totalTax, 0);
  assert.equal(computeProgressiveTax({ taxableIncome: -100, brackets: BRACKETS }).totalTax, 0);
  assert.equal(computeProgressiveTax({ taxableIncome: 5000, brackets: BRACKETS }).totalTax, 500);
  const crossed = computeProgressiveTax({ taxableIncome: 50000, brackets: BRACKETS });
  assert.equal(crossed.totalTax, 10000);
  assert.equal(crossed.marginalRate, 0.3);
  assert.equal(crossed.effectiveRate, 0.2);
  assert.equal(round2(crossed.bracketBreakdown.reduce((sum, row) => sum + row.tax, 0)), crossed.totalTax);
});

test("malformed progressive brackets are rejected and annual math is explicit", () => {
  assert.throws(() => validateProgressiveBrackets([{ upTo: 10000, rate: 0.1 }, { upTo: 9000, rate: 0.2 }]), /ordered/);
  assert.equal(computeProgressiveTax({ taxableIncome: 12000, brackets: BRACKETS }).totalTax, 1400);
});

test("standard deduction resolves by filing status and rejects unknown status", () => {
  const standard = getStandardDeduction({
    config: { amount: 1000, amountByFilingStatus: { single: 1000, married_filing_jointly: 2000 }, annual: true },
    filingStatus: "married_filing_jointly",
    profile: {},
    taxYear: 2026,
  });
  assert.equal(standard.amount, 2000);
  assert.throws(() => getStandardDeduction({ config: { amount: 1000 }, filingStatus: "unknown", profile: {}, taxYear: 2026 }), /Filing status/);
});

test("federal engine calculates regular federal income tax from verified rules only", async () => {
  const result = await computeFederalIncomeTax({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    filingStatus: "single",
    entityType: "single_member_llc",
    annualBusinessTaxableIncome: 60000,
  });
  assert.equal(result.income.adjustedGrossIncome, 60000);
  assert.equal(result.deductions.standardDeduction, 10000);
  assert.equal(result.income.taxableIncomeAfterQbi, 50000);
  assert.equal(result.tax.regularIncomeTax, 10000);
  assert.equal(result.tax.federalIncomeTax, 10000);
  assert.equal(result.tax.creditsApplied, 0);
  assert.ok(!("selfEmploymentTax" in result.tax));
  assert.ok(!("stateTax" in result.tax));
  assert.ok(result.warnings.some((warning) => warning.code === "qbi_not_applied"));
});

test("federal range runs low/base/high independently through progressive brackets", async () => {
  const result = await computeFederalIncomeTax({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    filingStatus: "single",
    entityType: "single_member_llc",
    annualBusinessTaxableIncome: 60000,
    annualBusinessTaxableIncomeRange: { low: 20000, base: 60000, high: 100000 },
  });
  assert.deepEqual(result.range, {
    lowIncomeCaseTax: 1000,
    baseIncomeCaseTax: 10000,
    highIncomeCaseTax: 22000,
  });
});

test("unknown filing status and missing verified configs fail safely", async () => {
  await assert.rejects(
    () => computeFederalIncomeTax({
      supabase: makeSupabase(baseStore({ tax_profiles: [taxProfile({ filing_status: "unknown" })] })),
      businessId: BUSINESS_ID,
      taxYear: 2026,
      entityType: "single_member_llc",
      annualBusinessTaxableIncome: 10000,
    }),
    (err) => err.code === "missing_filing_status"
  );
  await assert.rejects(
    () => computeFederalIncomeTax({
      supabase: makeSupabase(baseStore({ tax_rule_configs: [standardRule()] })),
      businessId: BUSINESS_ID,
      taxYear: 2026,
      filingStatus: "single",
      entityType: "single_member_llc",
      annualBusinessTaxableIncome: 10000,
    }),
    (err) => err.code === "missing_brackets"
  );
  await assert.rejects(
    () => computeFederalIncomeTax({
      supabase: makeSupabase(baseStore({ tax_rule_configs: [bracketRule({ support_level: "unverified", verified_at: null, source_name: null, source_url: null }), standardRule()] })),
      businessId: BUSINESS_ID,
      taxYear: 2026,
      filingStatus: "single",
      entityType: "single_member_llc",
      annualBusinessTaxableIncome: 10000,
    }),
    (err) => err.code === "missing_brackets"
  );
});

test("unsupported credits are disclosed, QBI is not silently applied, and business profile isolation holds", async () => {
  const result = await computeFederalIncomeTax({
    supabase: makeSupabase(baseStore({
      tax_profiles: [
        taxProfile({ business_id: BUSINESS_ID, filing_status: "single" }),
        taxProfile({ business_id: OTHER_BUSINESS_ID, filing_status: "married_filing_jointly" }),
      ],
    })),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    entityType: "single_member_llc",
    annualBusinessTaxableIncome: 60000,
  });
  assert.equal(result.meta.filingStatus, "single");
  assert.ok(result.unsupportedItems.includes("credits"));
  assert.equal(result.income.qbiDeduction, 0);
  const legacy = toLegacyFederalTaxFields(result);
  assert.equal(legacy.federal, result.tax.federalIncomeTax);
  assert.equal(legacy.taxableBase, result.income.taxableIncomeAfterQbi);
});

function baseStore(overrides = {}) {
  return {
    tax_profiles: [taxProfile()],
    tax_rule_configs: [bracketRule(), standardRule()],
    ...overrides,
  };
}

function taxProfile(overrides = {}) {
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

function bracketRule(overrides = {}) {
  return rule({
    id: "brackets",
    rule_type: "federal_income_tax_brackets",
    config: { brackets: BRACKETS, currency: "USD", annual: true },
    ...overrides,
  });
}

function standardRule(overrides = {}) {
  return rule({
    id: "standard",
    rule_type: "standard_deduction",
    config: { amount: 10000, amountByFilingStatus: { single: 10000, married_filing_jointly: 20000 }, annual: true },
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
    version: "fixture-v1",
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

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}
