import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { getTaxRuleConfig, validateTaxRuleConfigRow } from "../src/services/tax/taxRuleConfig.repository.js";
import { getStateTaxConfigSet, getStateTaxRuleConfig } from "../src/services/tax/stateTaxRule.repository.js";
import { findMatchingDeductionRules, validateDeductionRuleRow, explainDeductionRuleMatch } from "../src/services/tax/taxDeductionRule.repository.js";
import { getStateRule } from "../src/services/tax/stateTaxRules.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

test("federal repository selects exact filing/entity, excludes inactive/future/expired, and ranks verified", async () => {
  const rows = [
    federalRow({ id: "general", filing_status: null, entity_type: null, support_level: "supported", version: "1" }),
    federalRow({ id: "inactive", filing_status: "single", is_active: false, support_level: "verified", version: "9" }),
    federalRow({ id: "future", filing_status: "single", support_level: "verified", effective_from: "2026-01-01", version: "9" }),
    federalRow({ id: "expired", filing_status: "single", support_level: "verified", effective_to: "2024-12-31", version: "9" }),
    federalRow({ id: "simplified", filing_status: "single", entity_type: "s_corp", support_level: "simplified", version: "8" }),
    federalRow({ id: "verified", filing_status: "single", entity_type: "s_corp", support_level: "verified", version: "2" }),
  ];
  const selected = await getTaxRuleConfig({
    supabase: makeSupabase({ tax_rule_configs: rows }),
    taxYear: 2025,
    ruleType: "standard_deduction",
    filingStatus: "single",
    entityType: "s_corp",
    asOfDate: "2025-07-01",
  });
  assert.equal(selected.id, "verified");
});

test("missing federal required rule produces structured error", async () => {
  await assert.rejects(
    () => getTaxRuleConfig({
      supabase: makeSupabase({ tax_rule_configs: [] }),
      taxYear: 2025,
      ruleType: "standard_deduction",
      filingStatus: "single",
      entityType: "s_corp",
    }),
    (err) => err.code === "tax_rule_config_missing" && err.details.ruleType === "standard_deduction"
  );
});

test("federal schema rejects malformed brackets and verified configs without source metadata", () => {
  assert.throws(
    () => validateTaxRuleConfigRow(federalRow({
      rule_type: "federal_income_tax_brackets",
      config: { brackets: [{ upTo: 50000, rate: 0.12 }, { upTo: 10000, rate: 0.1 }], annual: true },
    })),
    /Tax brackets must be ordered/
  );
  assert.throws(
    () => validateTaxRuleConfigRow(federalRow({ source_name: null, source_url: null, verified_at: null })),
    /source_name/
  );
});

test("state repository treats explicit no-income-tax as usable and missing config as unsupported", async () => {
  const noTax = stateRow({ id: "fl-none", state_code: "FL", rule_type: "no_individual_income_tax", config: { kind: "none" } });
  const result = await getStateTaxConfigSet({
    supabase: makeSupabase({ state_tax_rule_configs: [noTax] }),
    taxYear: 2025,
    stateCode: "FL",
    filingStatus: "single",
    entityType: "sole_proprietor",
  });
  assert.equal(result.supportLevel, "verified");
  assert.equal(result.isUsableForEstimate, true);

  const missing = await getStateTaxConfigSet({
    supabase: makeSupabase({ state_tax_rule_configs: [] }),
    taxYear: 2025,
    stateCode: "NC",
    filingStatus: "single",
    entityType: "sole_proprietor",
  });
  assert.equal(missing.supportLevel, "unsupported");
  assert.equal(missing.isUsableForEstimate, false);
  assert.equal(missing.missing[0].ruleType, "individual_income_tax");
});

test("state repository rejects unknown state and legacy wrapper has no generic 5 percent fallback", async () => {
  await assert.rejects(
    () => getStateTaxRuleConfig({
      supabase: makeSupabase({ state_tax_rule_configs: [] }),
      taxYear: 2025,
      stateCode: "ZZ",
      ruleType: "individual_income_tax",
    }),
    (err) => err.code === "invalid_state_code"
  );
  const legacy = getStateRule("ZZ");
  assert.equal(legacy.kind, "unsupported");
  assert.equal(legacy.flatRate, null);
});

test("legacy estimate state rule requires explicit compatibility policy", async () => {
  await assert.rejects(
    () => getStateTaxRuleConfig({
      supabase: makeSupabase({ state_tax_rule_configs: [stateRow({ support_level: "legacy_estimate" })] }),
      taxYear: 2025,
      stateCode: "NC",
      ruleType: "individual_income_tax",
      minimumSupportLevel: "simplified",
    }),
    (err) => err.code === "unsupported_state_tax_rule"
  );
});

test("deduction repository ranks business override and QBO subtype specificity", async () => {
  const globalBroad = deductionRow({ id: "global-category", bookkeeping_category: "Meals & Entertainment", priority: 40 });
  const globalSubtype = deductionRow({ id: "global-subtype", qbo_account_subtype: "Meals", priority: 40 });
  const businessOverride = deductionRow({ id: "biz", business_id: BUSINESS_ID, scope: "business_override", qbo_account_subtype: "Meals", priority: 100 });
  const result = await findMatchingDeductionRules({
    supabase: makeSupabase({ tax_deduction_rules: [globalBroad, globalSubtype, businessOverride] }),
    businessId: BUSINESS_ID,
    taxYear: 2025,
    entityType: "sole_proprietor",
    transactionContext: {
      qbo_account_subtype: "Meals",
      bookkeeping_category: "Meals & Entertainment",
    },
  });
  assert.equal(result.selected.id, "biz");
  assert.match(explainDeductionRuleMatch(globalSubtype, { qbo_account_subtype: "Meals", bookkeeping_category: "Meals & Entertainment" }), /qbo_account_subtype=Meals/);
});

test("deduction repository evaluates scope, priority, specificity, and rich match conditions", async () => {
  const result = await findMatchingDeductionRules({
    supabase: makeSupabase({
      tax_deduction_rules: [
        deductionRow({ id: "generic-low-priority", rule_code: "generic", bookkeeping_category: null, priority: 90 }),
        deductionRow({ id: "category-priority", rule_code: "category", bookkeeping_category: "Supplies", priority: 40 }),
        deductionRow({ id: "vendor-same-priority", rule_code: "vendor", bookkeeping_category: "Supplies", match_conditions: { vendor_names: ["Home Depot"], assigned_job_required: true }, priority: 40 }),
        deductionRow({ id: "business-override", business_id: BUSINESS_ID, scope: "business_override", rule_code: "biz", bookkeeping_category: "Supplies", priority: 999 }),
      ],
    }),
    businessId: BUSINESS_ID,
    taxYear: 2025,
    entityType: "sole_proprietor",
    transactionContext: {
      date: "2025-06-01",
      vendor: "HOME DEPOT #123",
      bookkeeping_category: "Supplies",
      job_id: "job-1",
    },
  });
  assert.equal(result.selected.id, "business-override");
  assert.deepEqual(result.rules.map((row) => row.id), ["business-override", "vendor-same-priority", "category-priority", "generic-low-priority"]);
});

test("deduction repository ignores inactive, expired, future, and unverified rules", async () => {
  const result = await findMatchingDeductionRules({
    supabase: makeSupabase({
      tax_deduction_rules: [
        deductionRow({ id: "inactive", is_active: false, priority: 1 }),
        deductionRow({ id: "expired", effective_to: "2025-01-31", priority: 1 }),
        deductionRow({ id: "future", effective_from: "2025-12-01", priority: 1 }),
        deductionRow({ id: "unverified", verified_at: null, source_reference: null, source_url: null, priority: 1 }),
        deductionRow({ id: "current", priority: 99 }),
      ],
    }),
    businessId: BUSINESS_ID,
    taxYear: 2025,
    transactionContext: { date: "2025-06-01", bookkeeping_category: "Meals & Entertainment" },
  });
  assert.deepEqual(result.rules.map((rule) => rule.id), ["current"]);
});

test("deduction repository rejects invalid deductible percent and excludes inactive/wrong-year rules", async () => {
  assert.throws(() => validateDeductionRuleRow(deductionRow({ default_deductible_percent: 1.5 })), /default_deductible_percent/);
  const result = await findMatchingDeductionRules({
    supabase: makeSupabase({
      tax_deduction_rules: [
        deductionRow({ id: "inactive", is_active: false }),
        deductionRow({ id: "wrong-year", tax_year: 2024 }),
        deductionRow({ id: "current" }),
      ],
    }),
    businessId: BUSINESS_ID,
    taxYear: 2025,
    transactionContext: { date: "2025-06-01", bookkeeping_category: "Meals & Entertainment" },
  });
  assert.deepEqual(result.rules.map((rule) => rule.id), ["current"]);
});

test("diagnostics route is read-only and central tax router mounts it behind authenticated router", () => {
  const routes = readFileSync(resolve(__dirname, "../src/api/tax/taxRuleConfig.routes.js"), "utf8");
  assert.match(routes, /router\.get\("\/rule-support"/);
  assert.match(routes, /router\.get\("\/rule-configs\/summary"/);
  assert.doesNotMatch(routes, /router\.(post|patch|put|delete)\("/);

  const server = readFileSync(resolve(__dirname, "../src/server.js"), "utf8");
  assert.match(server, /app\.use\("\/api\/tax", \.\.\.requireCustomerOrAdminView, taxRouter\)/);
});

test("canonical state engine is quarantined from legacy tax_state_rates fallback", () => {
  const stateEngine = readFileSync(resolve(__dirname, "../src/services/tax/state/stateTaxEngine.js"), "utf8");
  const repository = readFileSync(resolve(__dirname, "../src/services/tax/stateTaxRule.repository.js"), "utf8");
  assert.doesNotMatch(stateEngine, /tax_state_rates|stateTaxRules/);
  assert.doesNotMatch(repository, /tax_state_rates|stateTaxRules/);
});

function federalRow(overrides = {}) {
  return {
    id: "fed",
    tax_year: 2025,
    jurisdiction: "federal",
    rule_type: "standard_deduction",
    filing_status: "single",
    entity_type: null,
    config: { amount: 15000, annual: true },
    version: "1",
    support_level: "verified",
    source_name: "IRS",
    source_url: "https://example.test/irs",
    verified_at: "2025-01-01",
    effective_from: "2025-01-01",
    effective_to: null,
    is_active: true,
    created_at: "2025-01-01",
    updated_at: "2025-01-01",
    ...overrides,
  };
}

function stateRow(overrides = {}) {
  return {
    id: "state",
    tax_year: 2025,
    state_code: "NC",
    rule_type: "individual_income_tax",
    entity_type: null,
    filing_status: null,
    config: { kind: "flat", rate: 0.045, annual: true },
    version: "1",
    support_level: "verified",
    source_name: "State DOR",
    source_url: "https://example.test/state",
    verified_at: "2025-01-01",
    effective_from: "2025-01-01",
    effective_to: null,
    is_active: true,
    created_at: "2025-01-01",
    updated_at: "2025-01-01",
    ...overrides,
  };
}

function deductionRow(overrides = {}) {
  return {
    id: "rule",
    business_id: null,
    scope: "global",
    rule_code: "meals_default",
    tax_year: 2025,
    jurisdiction: "federal",
    entity_type: null,
    bookkeeping_category: "Meals & Entertainment",
    qbo_account_type: null,
    qbo_account_subtype: null,
    match_conditions: {},
    tax_category: "meals",
    deductibility_status: "partially_deductible",
    default_deductible_percent: 0.5,
    treatment: {},
    requires_review: false,
    priority: 100,
    explanation: "Meals rule",
    source_reference: "policy",
    source_url: "https://example.test",
    verified_at: "2025-01-01",
    effective_from: "2025-01-01",
    effective_to: null,
    is_active: true,
    version: "1",
    created_at: "2025-01-01",
    updated_at: "2025-01-01",
    ...overrides,
  };
}

function makeSupabase(tables) {
  return {
    from(table) {
      return new Query(tables[table] || []);
    },
  };
}

class Query {
  constructor(rows) {
    this.rows = rows;
  }

  select() {
    return this;
  }

  eq(field, value) {
    this.rows = this.rows.filter((row) => row[field] === value);
    return this;
  }

  then(resolve) {
    return Promise.resolve({ data: this.rows, error: null }).then(resolve);
  }
}
