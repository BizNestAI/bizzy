import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTaxCalculationGraph,
  reproduceTaxCalculationGraph,
} from "../src/services/tax/workpaper/taxCalculationGraph.js";

test("federal graph traces taxable-income bridge, standard deduction, brackets, credits, and federal income tax", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: federalResult(), workpaper: federalWorkpaper() });

  assert.equal(node(graph, "federal_bridge:business_pass_through_income").amount, 220000);
  assert.equal(node(graph, "federal_bridge:gross_income").reconciliationStatus, "reconciled");
  assert.equal(node(graph, "federal_bridge:adjusted_income_before_personal_deductions").formulaExpression, "225000 - 10000");
  assert.equal(node(graph, "federal_bridge:standard_deduction:base").amount, 14000);
  assert.equal(node(graph, "federal_bridge:standard_deduction:additional").amount, 1000);
  assert.equal(node(graph, "federal_bridge:standard_or_itemized_deduction").reconciliationStatus, "reconciled");
  assert.equal(node(graph, "federal_bridge:qbi_deduction:engine_output").amount, 20000);
  assert.equal(node(graph, "federal_bridge:federal_taxable_income").formulaExpression, "215000 - 15000 - 20000 + 0");
  assert.equal(node(graph, "federal_bridge:federal_taxable_income").reconciliationStatus, "reconciled");

  const bracket3 = node(graph, "federal_bridge:tax_by_bracket:3");
  assert.equal(bracket3.formulaExpression, "max(180000 - 50000, 0) * 0.3");
  assert.deepEqual(bracket3.inputValues.map((input) => [input.code, input.amount]), [
    ["taxable_amount_in_bracket", 130000],
    ["rate", 0.3],
  ]);
  assert.ok(bracket3.ruleRefs.some((ref) => ref.ruleCode === "federalIncomeTaxBrackets" && ref.version === "fed-brackets-v1"));
  assert.equal(node(graph, "federal_bridge:federal_income_tax").reconciliationStatus, "reconciled");

  const reproduced = reproduceTaxCalculationGraph({ nodes: graph.nodes });
  assert.equal(reproduced.values["federal_bridge:federal_taxable_income"], 180000);
  assert.equal(reproduced.values["federal_bridge:federal_income_tax"], 47500);
});

test("federal graph exposes unsupported QBI, itemized deductions, and credits without fake deduction amounts", () => {
  const graph = buildTaxCalculationGraph({
    canonicalResult: federalResult({ qbiDeduction: 0, creditsApplied: 0, taxableIncomeAfterQbi: 200000, federalIncomeTax: 54000 }),
    workpaper: federalWorkpaper({ qbiDeduction: null, creditsApplied: 0, taxableIncomeAfterQbi: 200000, federalIncomeTax: 54000 }),
  });

  assert.equal(node(graph, "federal_bridge:qbi_deduction").amount, null);
  assert.equal(node(graph, "federal_bridge:qbi_deduction:unavailable").status, "unavailable");
  assert.equal(node(graph, "federal_bridge:itemized_deduction:unsupported").status, "unavailable");
  assert.equal(node(graph, "federal_bridge:federal_credits:unsupported").status, "unavailable");
});

test("federal total compares graph reproduction to federal engine output", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: federalResult(), workpaper: federalWorkpaper() });
  const reproduced = reproduceTaxCalculationGraph({ nodes: graph.nodes });
  const engineOutput = federalResult().federal.incomeTax.tax.federalIncomeTax;

  assert.equal(reproduced.values["federal_bridge:federal_income_tax"], engineOutput);
  assert.equal(node(graph, "total_tax_components:total_federal_tax").amount, engineOutput);
});

test("federal profile snapshot is immutable after profile and rule mutation", () => {
  const result = federalResult();
  const graph = buildTaxCalculationGraph({ canonicalResult: result, workpaper: federalWorkpaper() });
  const profileRef = node(graph, "federal_bridge:filing_profile_snapshot").sourceRefs[0];
  const bracketRef = node(graph, "federal_bridge:tax_by_bracket:1").ruleRefs[0];

  result.profile.profile.filing_status = "married_filing_jointly";
  result.federal.incomeTax.meta.ruleVersions.federalIncomeTaxBrackets = "fed-brackets-v2";

  assert.equal(graph.inputSnapshot.profileFacts.filingStatus, "single");
  assert.equal(profileRef.snapshotValue.filingStatus, "single");
  assert.equal(bracketRef.version, "fed-brackets-v1");
});

function node(graph, code) {
  const found = graph.nodes.find((item) => item.nodeCode === code);
  assert.ok(found, `Expected graph node ${code}`);
  return found;
}

function federalResult(overrides = {}) {
  const qbiDeduction = overrides.qbiDeduction ?? 20000;
  const creditsApplied = overrides.creditsApplied ?? 500;
  const taxableIncomeAfterQbi = overrides.taxableIncomeAfterQbi ?? 180000;
  const federalIncomeTax = overrides.federalIncomeTax ?? 47500;
  return {
    meta: {
      businessId: "business-fed-1",
      taxYear: 2026,
      asOfDate: "2026-07-21",
      engineVersions: { federal: "federal-engine-v1", orchestrator: "orchestrator-v1" },
    },
    profile: {
      profile: {
        id: "profile-fed-1",
        version: "profile-v1",
        updated_at: "2026-07-21T12:00:00Z",
        entity_type: "s_corporation",
        filing_status: "single",
        primary_tax_state: "NC",
        accounting_method: "cash",
        qbi_eligible: true,
        metadata: { standardDeductionAdditional: 1000, taxpayer_age: 67 },
      },
    },
    federal: {
      incomeTax: {
        meta: {
          taxYear: 2026,
          filingStatus: "single",
          entityType: "s_corporation",
          engineVersion: "federal-engine-v1",
          ruleVersions: {
            federalIncomeTaxBrackets: "fed-brackets-v1",
            standardDeduction: "fed-standard-v1",
            qbi: qbiDeduction ? "qbi-v1" : undefined,
          },
          supportSummary: {
            federalIncomeTaxBrackets: { supportLevel: "verified", sourceName: "IRS", sourceUrl: "https://irs.example/rates", verifiedAt: "2026-01-01T00:00:00Z" },
            standardDeduction: { supportLevel: "verified", sourceName: "IRS", sourceUrl: "https://irs.example/std", verifiedAt: "2026-01-01T00:00:00Z" },
          },
        },
        standardDeductionDetails: { amount: 15000, baseAmount: 14000, additionalAmount: 1000 },
        income: {
          annualBusinessTaxableIncome: 220000,
          otherIncome: 5000,
          grossIncome: 225000,
          adjustedGrossIncome: 215000,
          taxableIncomeBeforeQbi: 200000,
          qbiDeduction,
          taxableIncomeAfterQbi,
        },
        deductions: {
          aboveTheLineAdjustments: 10000,
          standardDeduction: 15000,
          itemizedDeductionUsed: 0,
        },
        tax: {
          regularIncomeTax: federalIncomeTax + creditsApplied,
          bracketBreakdown: [
            { lowerBound: 0, upperBound: 10000, taxableInBracket: 10000, rate: 0.1, tax: 1000 },
            { lowerBound: 10000, upperBound: 50000, taxableInBracket: 40000, rate: 0.2, tax: 8000 },
            { lowerBound: 50000, upperBound: null, taxableInBracket: taxableIncomeAfterQbi - 50000, rate: 0.3, tax: federalIncomeTax + creditsApplied - 9000 },
          ],
          creditsApplied,
          federalIncomeTax,
        },
        unsupportedItems: qbiDeduction ? ["itemized_deductions", "dependents"] : ["qbi_deduction", "itemized_deductions", "credits", "dependents"],
        warnings: [],
      },
    },
  };
}

function federalWorkpaper(overrides = {}) {
  const qbiDeduction = Object.prototype.hasOwnProperty.call(overrides, "qbiDeduction") ? overrides.qbiDeduction : 20000;
  const creditsApplied = overrides.creditsApplied ?? 500;
  const taxableIncomeAfterQbi = overrides.taxableIncomeAfterQbi ?? 180000;
  const federalIncomeTax = overrides.federalIncomeTax ?? 47500;
  const bracket3Tax = federalIncomeTax + creditsApplied - 9000;
  return {
    version: "tax-workpaper-v1",
    lines: [
      line("federal_bridge:adjusted_income_before_personal_deductions", "Adjusted income before personal deductions", "federal_bridge", 215000, { parentCode: "federal_bridge:federal_taxable_income" }),
      line("federal_bridge:standard_or_itemized_deduction", "Standard or itemized deduction", "federal_bridge", 15000, { parentCode: "federal_bridge:federal_taxable_income", displaySign: "subtract" }),
      line("federal_bridge:qbi_deduction", "QBI deduction", "federal_bridge", qbiDeduction, { parentCode: "federal_bridge:federal_taxable_income", displaySign: "subtract", status: qbiDeduction == null ? "unavailable" : "calculated" }),
      line("federal_bridge:other_adjustments", "Other federal adjustments", "federal_bridge", 0, { parentCode: "federal_bridge:federal_taxable_income" }),
      line("federal_bridge:federal_taxable_income", "Federal taxable income", "federal_bridge", taxableIncomeAfterQbi, { formulaCode: "agi_minus_deductions_qbi_plus_adjustments" }),
      line("federal_bridge:tax_by_bracket:1", "Federal tax bracket 1", "federal_bridge", 1000, { parentCode: "federal_bridge:federal_income_tax", formulaCode: "taxable_in_bracket_times_rate", metadata: { lowerBound: 0, upperBound: 10000, taxableInBracket: 10000, rate: 0.1, tax: 1000 } }),
      line("federal_bridge:tax_by_bracket:2", "Federal tax bracket 2", "federal_bridge", 8000, { parentCode: "federal_bridge:federal_income_tax", formulaCode: "taxable_in_bracket_times_rate", metadata: { lowerBound: 10000, upperBound: 50000, taxableInBracket: 40000, rate: 0.2, tax: 8000 } }),
      line("federal_bridge:tax_by_bracket:3", "Federal tax bracket 3", "federal_bridge", bracket3Tax, { parentCode: "federal_bridge:federal_income_tax", formulaCode: "taxable_in_bracket_times_rate", metadata: { lowerBound: 50000, upperBound: null, taxableInBracket: taxableIncomeAfterQbi - 50000, rate: 0.3, tax: bracket3Tax } }),
      line("federal_bridge:federal_credits", "Federal credits", "federal_bridge", creditsApplied, { parentCode: "federal_bridge:federal_income_tax", displaySign: "subtract" }),
      line("federal_bridge:federal_income_tax", "Federal income tax", "federal_bridge", federalIncomeTax),
    ],
  };
}

function line(code, label, section, amount, overrides = {}) {
  return {
    code,
    label,
    section,
    parent_code: overrides.parentCode || null,
    sort_order: overrides.sortOrder || 10,
    amount,
    display_sign: overrides.displaySign || null,
    status: overrides.status || "calculated",
    support_level: "supported",
    confidence: 0.9,
    formula_code: overrides.formulaCode || null,
    formula_description: overrides.formulaDescription || null,
    rule_refs: [],
    rule_versions: {},
    explanation: `${label} is persisted in the federal graph test fixture.`,
    source_refs: [],
    is_projection: true,
    is_actual: false,
    materiality: "high",
    drill_down_params: {},
    metadata: overrides.metadata || {},
  };
}
