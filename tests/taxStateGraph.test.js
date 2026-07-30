import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTaxCalculationGraph,
  reproduceTaxCalculationGraph,
} from "../src/services/tax/workpaper/taxCalculationGraph.js";

test("state graph traces flat individual tax, entity tax, PTET, local tax, and business excises", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: stateResult(), workpaper: stateWorkpaper() });

  assert.equal(node(graph, "state_bridge:federal_starting_base").reconciliationStatus, "reconciled");
  assert.equal(node(graph, "state_bridge:state_deduction_exemption").reconciliationStatus, "reconciled");
  assert.equal(node(graph, "state_bridge:state_taxable_income").formulaExpression, "max(0, 100000 + 1000 - 0 - 3500)");
  assert.equal(node(graph, "state_bridge:state_taxable_income").reconciliationStatus, "reconciled");

  const flatTax = node(graph, "state_bridge:state_individual_tax:flat_rate");
  assert.equal(flatTax.formulaExpression, "97500 * 0.04");
  assert.ok(flatTax.ruleRefs.some((ref) => ref.repository === "state_tax_rule_configs" && ref.ruleCode === "individualIncomeTax" && ref.version === "nc-flat-v1"));
  assert.equal(node(graph, "state_bridge:state_individual_tax").reconciliationStatus, "reconciled");

  assert.equal(node(graph, "state_bridge:state_entity_tax:s_corp_entity_tax").formulaExpression, "10000 * 0.03");
  assert.equal(node(graph, "state_bridge:state_entity_tax:s_corp_minimum_tax").formulaExpression, "100");
  assert.equal(node(graph, "state_bridge:state_entity_tax").reconciliationStatus, "reconciled");
  assert.equal(node(graph, "state_bridge:ptet:election_tax").formulaExpression, "10000 * 0.04");
  assert.equal(node(graph, "state_bridge:ptet").reconciliationStatus, "reconciled");
  assert.equal(node(graph, "state_bridge:local_county_tax:local_tax").formulaExpression, "97500 * 0.01");
  assert.equal(node(graph, "total_tax_components:supported_business_excises:gross_receipts_tax").formulaExpression, "50000 * 0.005");
  assert.equal(node(graph, "total_tax_components:supported_business_excises:payroll_excise_tax").formulaExpression, "20000 * 0.005");
  assert.equal(node(graph, "total_tax_components:supported_business_excises").reconciliationStatus, "reconciled");
  assert.equal(node(graph, "state_bridge:state_total_tax").reconciliationStatus, "reconciled");

  const reproduced = reproduceTaxCalculationGraph({ nodes: graph.nodes });
  assert.equal(reproduced.values["state_bridge:state_taxable_income"], 97500);
  assert.equal(reproduced.values["state_bridge:state_individual_tax"], 3900);
  assert.equal(reproduced.values["state_bridge:state_total_tax"], 6025);
});

test("state graph traces progressive bracket children and reconciles to state income tax", () => {
  const graph = buildTaxCalculationGraph({
    canonicalResult: stateResult({
      stateTax: {
        kind: "progressive",
        bracketBreakdown: [
          { lowerBound: 0, upperBound: 10000, taxableInBracket: 10000, rate: 0.02, tax: 200 },
          { lowerBound: 10000, upperBound: null, taxableInBracket: 20000, rate: 0.04, tax: 800 },
        ],
      },
      taxableIncome: 30000,
      individualTax: 1000,
      totalStateTax: 1000,
      standardDeduction: 0,
      stateAdjustment: 0,
      entityTax: { amount: 0, components: {} },
      ptet: null,
      localTax: null,
      excises: {},
      ruleVersions: { individualIncomeTax: "ny-progressive-v1" },
      profile: { primary_tax_state: "NY", metadata: { locality: null, ptet_election: false } },
    }),
    workpaper: stateWorkpaper({
      startingBase: 30000,
      additions: 0,
      deduction: 0,
      taxableIncome: 30000,
      individualTax: 1000,
      stateEntityTax: 0,
      ptet: null,
      localTax: null,
      excises: null,
      totalStateTax: 1000,
      stateCode: "NY",
    }),
  });

  assert.equal(node(graph, "state_bridge:state_individual_tax:bracket:1").formulaExpression, "min(max(30000 - 0, 0), 10000 - 0) * 0.02");
  assert.equal(node(graph, "state_bridge:state_individual_tax:bracket:2").formulaExpression, "max(30000 - 10000, 0) * 0.04");
  assert.equal(node(graph, "state_bridge:state_individual_tax").reconciliationStatus, "reconciled");
  assert.equal(reproduceTaxCalculationGraph({ nodes: graph.nodes }).values["state_bridge:state_individual_tax"], 1000);
});

test("state graph represents no-income-tax states and missing locality without fake local tax", () => {
  const graph = buildTaxCalculationGraph({
    canonicalResult: stateResult({
      stateTax: { kind: "none" },
      taxableIncome: 90000,
      individualTax: 0,
      totalStateTax: 0,
      standardDeduction: 0,
      stateAdjustment: 0,
      entityTax: { amount: 0, components: {} },
      ptet: null,
      localTax: null,
      excises: {},
      ruleVersions: { individualIncomeTax: "tx-no-income-v1" },
      profile: { primary_tax_state: "TX", metadata: { locality: null, ptet_election: false } },
    }),
    workpaper: stateWorkpaper({
      startingBase: 90000,
      additions: 0,
      deduction: 0,
      taxableIncome: 90000,
      individualTax: 0,
      stateEntityTax: 0,
      ptet: null,
      localTax: null,
      excises: null,
      totalStateTax: 0,
      stateCode: "TX",
    }),
  });

  assert.equal(node(graph, "state_bridge:state_individual_tax:no_income_tax").amount, 0);
  assert.equal(node(graph, "state_bridge:state_individual_tax:no_income_tax").formulaExpression, "0");
  assert.equal(node(graph, "state_bridge:local_county_tax:unavailable").amount, null);
  assert.equal(node(graph, "state_bridge:local_county_tax:unavailable").status, "unavailable");
});

test("state graph snapshot is immutable after profile and rule mutation", () => {
  const result = stateResult();
  const graph = buildTaxCalculationGraph({ canonicalResult: result, workpaper: stateWorkpaper() });
  const profileRef = node(graph, "state_bridge:state_profile_snapshot").sourceRefs[0];
  const ruleRef = node(graph, "state_bridge:state_individual_tax:flat_rate").ruleRefs.find((ref) => ref.ruleCode === "individualIncomeTax");

  result.profile.profile.primary_tax_state = "CA";
  result.profile.profile.metadata.locality = "Los Angeles";
  result.state.incomeTax.meta.ruleVersions.individualIncomeTax = "ca-new-rule";

  assert.equal(graph.inputSnapshot.profileFacts.state, "NC");
  assert.equal(profileRef.snapshotValue.stateCode, "NC");
  assert.equal(profileRef.snapshotValue.locality, "Wake");
  assert.equal(ruleRef.version, "nc-flat-v1");
});

function node(graph, code) {
  const found = graph.nodes.find((item) => item.nodeCode === code);
  assert.ok(found, `Expected graph node ${code}`);
  return found;
}

function stateResult(overrides = {}) {
  const stateAdjustment = overrides.stateAdjustment ?? 1000;
  const standardDeduction = overrides.standardDeduction ?? 3500;
  const taxableIncome = overrides.taxableIncome ?? 97500;
  const individualTax = overrides.individualTax ?? 3900;
  const entityTax = overrides.entityTax ?? {
    amount: 400,
    components: {
      sCorpEntityTax: { amount: 300, taxBase: 10000, rate: 0.03, ruleVersion: "nc-entity-v1" },
      sCorpMinimumTax: { amount: 100, minimumTax: 100, status: "calculated", ruleVersion: "nc-minimum-v1" },
    },
  };
  const ptet = Object.prototype.hasOwnProperty.call(overrides, "ptet") ? overrides.ptet : { amount: 400, taxBase: 10000, rate: 0.04, ruleVersion: "nc-ptet-v1" };
  const localTax = Object.prototype.hasOwnProperty.call(overrides, "localTax") ? overrides.localTax : { amount: 975, taxBase: taxableIncome, rate: 0.01, label: "Wake County tax" };
  const excises = overrides.excises ?? {
    grossReceiptsTax: { amount: 250, taxBase: 50000, rate: 0.005, ruleVersion: "gross-receipts-v1" },
    payrollExciseTax: { amount: 100, taxBase: 20000, rate: 0.005, ruleVersion: "payroll-excise-v1" },
  };
  const totalStateTax = overrides.totalStateTax ?? (
    individualTax
    + Number(entityTax.amount || 0)
    + Number(ptet?.amount || 0)
    + Number(localTax?.amount || 0)
    + Number(excises.grossReceiptsTax?.amount || 0)
    + Number(excises.payrollExciseTax?.amount || 0)
  );
  const profileOverrides = overrides.profile || {};
  const ruleVersions = {
    individualIncomeTax: "nc-flat-v1",
    standardDeduction: "nc-std-v1",
    personalExemption: "nc-exempt-v1",
    stateDeductionAdjustment: "nc-mod-v1",
    sCorpEntityTax: "nc-entity-v1",
    sCorpMinimumTax: "nc-minimum-v1",
    passThroughEntityTax: "nc-ptet-v1",
    localIncomeTax: "nc-local-v1",
    grossReceiptsTax: "gross-receipts-v1",
    payrollExciseTax: "payroll-excise-v1",
    ...(overrides.ruleVersions || {}),
  };
  return {
    meta: {
      businessId: "business-state-1",
      taxYear: 2026,
      asOfDate: "2026-07-21",
      engineVersions: { state: "state-engine-v1", orchestrator: "orchestrator-v1" },
    },
    profile: {
      profile: {
        id: "profile-state-1",
        version: "profile-state-v1",
        updated_at: "2026-07-21T12:00:00Z",
        entity_type: "s_corporation",
        filing_status: "single",
        primary_tax_state: "NC",
        accounting_method: "cash",
        state_nexus: { NC: true },
        metadata: { locality: "Wake", county: "Wake", ptet_election: true },
        ...profileOverrides,
        metadata: {
          locality: "Wake",
          county: "Wake",
          ptet_election: true,
          ...(profileOverrides.metadata || {}),
        },
      },
      entityContext: {
        entity: {
          entityPath: "s_corporation",
          entityType: "s_corporation",
          ptetElection: profileOverrides.metadata?.ptet_election ?? true,
          stateNexus: { NC: true },
        },
      },
    },
    state: {
      stateCode: profileOverrides.primary_tax_state || "NC",
      incomeTax: {
        meta: {
          stateCode: profileOverrides.primary_tax_state || "NC",
          taxYear: 2026,
          filingStatus: "single",
          entityPath: "s_corporation",
          engineVersion: "state-engine-v1",
          ruleVersions,
          supportSummary: {
            individualIncomeTax: { supportLevel: "verified", sourceName: "State DOR", sourceUrl: "https://state.example/tax", verifiedAt: "2026-01-01T00:00:00Z" },
            standardDeduction: { supportLevel: "verified", sourceName: "State DOR", sourceUrl: "https://state.example/deductions", verifiedAt: "2026-01-01T00:00:00Z" },
          },
        },
        income: {
          federalAdjustedGrossIncomeInput: overrides.startingBase ?? 100000,
          stateDeductionAdjustment: { amount: stateAdjustment, ruleVersion: ruleVersions.stateDeductionAdjustment },
          stateAdjustments: stateAdjustment,
          stateTaxableIncome: taxableIncome,
        },
        deductions: {
          standardDeduction,
          personalExemption: 0,
        },
        standardDeductionDetails: { amount: standardDeduction, baseAmount: standardDeduction, ruleVersion: ruleVersions.standardDeduction },
        personalExemptionDetails: { amount: 0, status: "not_applicable", notApplicable: true, ruleVersion: ruleVersions.personalExemption },
        stateTax: overrides.stateTax ?? { kind: "flat", rate: 0.04 },
        individualIncomeTax: { amount: individualTax, status: individualTax === 0 ? "verified_zero" : "verified_calculated" },
        entityTax: {
          knownAmount: entityTax.amount,
          amount: entityTax.amount,
          ...(entityTax.components || {}),
        },
        passThroughEntityTax: ptet,
        localTax,
        businessExcises: excises,
        tax: {
          regularStateIncomeTax: individualTax,
          sCorpEntityTax: entityTax.components?.sCorpEntityTax?.amount ?? 0,
          sCorpMinimumTax: entityTax.components?.sCorpMinimumTax?.amount ?? 0,
          passThroughEntityTax: ptet?.amount ?? null,
          localIncomeTax: localTax?.amount ?? null,
          grossReceiptsTax: excises.grossReceiptsTax?.amount ?? null,
          payrollExciseTax: excises.payrollExciseTax?.amount ?? null,
          totalStateTax,
        },
        totalStateTax: { amount: totalStateTax, status: "verified_calculated" },
      },
    },
  };
}

function stateWorkpaper(overrides = {}) {
  const stateCode = overrides.stateCode || "NC";
  const startingBase = overrides.startingBase ?? 100000;
  const additions = overrides.additions ?? 1000;
  const subtractions = overrides.subtractions ?? 0;
  const deduction = overrides.deduction ?? 3500;
  const taxableIncome = overrides.taxableIncome ?? 97500;
  const individualTax = overrides.individualTax ?? 3900;
  const stateEntityTax = overrides.stateEntityTax ?? 400;
  const ptet = Object.prototype.hasOwnProperty.call(overrides, "ptet") ? overrides.ptet : 400;
  const localTax = Object.prototype.hasOwnProperty.call(overrides, "localTax") ? overrides.localTax : 975;
  const excises = Object.prototype.hasOwnProperty.call(overrides, "excises") ? overrides.excises : 350;
  const totalStateTax = overrides.totalStateTax ?? 6025;
  return {
    version: "tax-workpaper-v1",
    lines: [
      line("state_bridge:federal_starting_base", "State starting base", "state_bridge", startingBase, { parentCode: "state_bridge:state_taxable_income" }),
      line("state_bridge:state_additions", "State additions", "state_bridge", additions, { parentCode: "state_bridge:state_taxable_income" }),
      line("state_bridge:state_subtractions", "State subtractions", "state_bridge", subtractions, { parentCode: "state_bridge:state_taxable_income", displaySign: "subtract" }),
      line("state_bridge:state_deduction_exemption", "State deduction and exemption", "state_bridge", deduction, { parentCode: "state_bridge:state_taxable_income", displaySign: "subtract" }),
      line("state_bridge:state_taxable_income", "State taxable income", "state_bridge", taxableIncome),
      line("state_bridge:state_individual_tax", `${stateCode} individual tax`, "state_bridge", individualTax),
      line("state_bridge:state_entity_tax", `${stateCode} entity tax`, "state_bridge", stateEntityTax),
      line("state_bridge:ptet", "PTET", "state_bridge", ptet, { status: ptet == null ? "unavailable" : "calculated" }),
      line("state_bridge:local_county_tax", "Local/county tax", "state_bridge", localTax, { status: localTax == null ? "unavailable" : "calculated" }),
      line("total_tax_components:supported_business_excises", "Supported business excises", "total_tax_components", excises, { status: excises == null ? "unavailable" : "calculated" }),
      line("state_bridge:state_total_tax", `${stateCode} total state-related tax`, "state_bridge", totalStateTax),
      line("total_tax_components:state_individual_income_tax", "State individual income tax", "total_tax_components", individualTax),
      line("total_tax_components:entity_level_tax", "Entity-level tax", "total_tax_components", stateEntityTax + Number(ptet || 0)),
      line("total_tax_components:local_tax", "Local tax", "total_tax_components", localTax),
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
    explanation: `${label} is persisted in the state graph test fixture.`,
    source_refs: [],
    is_projection: true,
    is_actual: false,
    materiality: "high",
    drill_down_params: {},
    metadata: overrides.metadata || {},
  };
}
