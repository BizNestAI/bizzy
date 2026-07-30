import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTaxCalculationGraph,
  reproduceTaxCalculationGraph,
  TAX_GRAPH_TRACEABILITY_STATUSES,
} from "../src/services/tax/workpaper/taxCalculationGraph.js";
import {
  buildTaxTrajectoryPoints,
  THROUGH_DATE_TAX_METHODS,
  THROUGH_DATE_TAX_METHOD_VERSION,
} from "../src/services/tax/throughDate/throughDateTaxAttribution.js";

test("through-date graph reconciles parent from direct and component-level allocated attribution", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: canonicalResult(), workpaper: workpaper() });
  const root = node(graph, "through_date_tax:tax_attributable_through_date");
  const direct = node(graph, "through_date_tax:directly_calculated_components");
  const allocated = node(graph, "through_date_tax:allocated_components");

  assert.equal(root.reconciliationStatus, "reconciled");
  assert.equal(root.reconciliationExpectedAmount, 10800);
  assert.equal(root.amount, 10800);
  assert.equal(direct.reconciliationStatus, "reconciled");
  assert.equal(allocated.reconciliationStatus, "reconciled");
  assert.equal(direct.childNodeCodes.includes("through_date_tax:component:self_employment_tax"), true);
  assert.equal(allocated.childNodeCodes.includes("through_date_tax:component:federal_income_tax"), true);
  assert.equal(allocated.childNodeCodes.includes("through_date_tax:component:entity_minimum_tax"), true);
  assert.equal(root.inputValues.find((input) => input.nodeCode === "through_date_tax:projected_annual_tax").displaySign, "exclude");
});

test("through-date graph persists allocation math, taxable-income bases, and rule treatment", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: canonicalResult(), workpaper: workpaper() });
  const percentage = node(graph, "through_date_tax:allocation_percentage:formula");
  const federal = node(graph, "through_date_tax:component:federal_income_tax");
  const actualBase = node(graph, "through_date_tax:actual_ytd_taxable_income_base:source");
  const annualBase = node(graph, "through_date_tax:projected_annual_taxable_income_base:source");
  const reproduced = reproduceTaxCalculationGraph({ nodes: graph.nodes });

  assert.equal(percentage.formulaOperator, "ratio");
  assert.equal(percentage.formulaExpression, "50000 / 100000");
  assert.equal(reproduced.values[percentage.nodeCode], 0.5);
  assert.deepEqual(federal.inputValues.map((input) => [input.code, input.amount, input.nodeCode]), [
    ["annual_component_amount", 10000, "total_tax_components:federal_income_tax"],
    ["allocation_percentage", 0.5, "through_date_tax:allocation_percentage"],
  ]);
  assert.equal(federal.formulaExpression, "10000 * 0.5");
  assert.equal(federal.metadata.attributionMapping, "allocated_by_taxable_income_share");
  assert.equal(actualBase.sourceRefs.some((ref) => ref.sourceId === "source_period_income:actual_business_revenue_ytd"), true);
  assert.equal(annualBase.sourceRefs.some((ref) => ref.sourceId === "business_taxable_income_bridge:projected_business_taxable_profit"), true);
  assert.equal(federal.ruleRefs.some((ref) => ref.repository === "through_date_annual_rule_treatment_registry" && ref.ruleCode === "progressive_brackets"), true);
  assert.equal(reproduced.values["through_date_tax:tax_attributable_through_date"], 10800);
});

test("through-date graph discloses annual minimums, excluded components, and limitations", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: canonicalResult(), workpaper: workpaper() });
  const minimum = node(graph, "through_date_tax:component:entity_minimum_tax");
  const qbi = node(graph, "through_date_tax:excluded_component:qbi");
  const method = node(graph, "through_date_tax:method_snapshot");

  assert.equal(minimum.metadata.attributionMapping, "annual_minimum_applied_fully");
  assert.equal(minimum.amount, 800);
  assert.equal(qbi.status, "unavailable");
  assert.equal(qbi.displaySign, "exclude");
  assert.equal(method.metadata.limitations.includes("QBI is not included in the through-date amount."), true);
});

test("through-date graph keeps missing YTD base unavailable and never falls back to elapsed time", () => {
  const canonical = canonicalResult({
    attribution: {
      amount: null,
      methodCode: THROUGH_DATE_TAX_METHODS.UNAVAILABLE,
      methodVersion: THROUGH_DATE_TAX_METHOD_VERSION,
      formula: null,
      actualYtdTaxableIncomeBase: null,
      projectedAnnualTaxableIncomeBase: 100000,
      allocationPercentage: null,
      directlyCalculatedComponents: [],
      allocatedComponents: [],
      excludedComponents: [],
      assumptions: ["Through-date tax requires actual YTD taxable-income base."],
      limitations: ["Actual YTD taxable-income base is unavailable."],
      confidence: { score: 0.25, level: "low", status: "unavailable" },
    },
    throughDateAmount: null,
  });
  const graph = buildTaxCalculationGraph({ canonicalResult: canonical, workpaper: workpaper({ canonical }) });
  const root = node(graph, "through_date_tax:tax_attributable_through_date");
  const actualBase = node(graph, "through_date_tax:actual_ytd_taxable_income_base:source");

  assert.equal(root.amount, null);
  assert.equal(actualBase.status, "unavailable");
  assert.equal(actualBase.amount, null);
  assert.notEqual(root.formulaCode, THROUGH_DATE_TAX_METHODS.ELAPSED_TIME);
  assert.equal(graph.validation.nodeResults[root.nodeCode].status, TAX_GRAPH_TRACEABILITY_STATUSES.TRACEABLE_WITH_LIMITATIONS);
});

test("through-date graph is reproducible after source objects mutate later", () => {
  const canonical = canonicalResult();
  const graph = buildTaxCalculationGraph({ canonicalResult: canonical, workpaper: workpaper({ canonical }) });
  const originalHash = graph.inputSnapshot.hash;
  const originalMethod = node(graph, "through_date_tax:method_snapshot").metadata.methodCode;

  canonical.liability.taxAttributableThroughToday.amount = 999999;
  canonical.liability.taxAttributableThroughToday.methodCode = THROUGH_DATE_TAX_METHODS.ELAPSED_TIME;
  canonical.projection.actual.taxableBusinessIncome = 1;

  const reproduced = reproduceTaxCalculationGraph({ nodes: graph.nodes });
  assert.equal(graph.inputSnapshot.hash, originalHash);
  assert.equal(originalMethod, THROUGH_DATE_TAX_METHODS.ANNUALIZED_ACTUAL_YTD);
  assert.equal(reproduced.values["through_date_tax:tax_attributable_through_date"], 10800);
});

test("trajectory current point links to the through-date graph node and source period", () => {
  const canonical = canonicalResult();
  const points = buildTaxTrajectoryPoints({ canonical });
  const current = points.find((point) => point.isCurrent);

  assert.equal(current.month, "2026-07");
  assert.equal(current.method, THROUGH_DATE_TAX_METHODS.ANNUALIZED_ACTUAL_YTD);
  assert.equal(current.graphNodeCode, "through_date_tax:tax_attributable_through_date");
  assert.deepEqual(current.sourcePeriod, { startDate: "2026-01-01", throughDate: "2026-07-21" });
  assert.equal(current.workpaperDeepLink, "/api/tax/calculations/run-through-date-1/workpaper?section=through_date_tax");
});

function node(graph, code) {
  const found = graph.nodes.find((item) => item.nodeCode === code);
  assert.ok(found, `Expected graph node ${code}`);
  return found;
}

function canonicalResult(overrides = {}) {
  const attribution = overrides.attribution || {
    amount: 10800,
    methodCode: THROUGH_DATE_TAX_METHODS.ANNUALIZED_ACTUAL_YTD,
    methodVersion: THROUGH_DATE_TAX_METHOD_VERSION,
    formula: "sum(directly calculated YTD components) + sum(projected annual components * actual YTD taxable-income share)",
    actualYtdTaxableIncomeBase: 50000,
    projectedAnnualTaxableIncomeBase: 100000,
    allocationPercentage: 0.5,
    directlyCalculatedComponents: [{
      code: "self_employment_tax",
      label: "Self-employment tax",
      annualAmount: 7000,
      amount: 3000,
      method: THROUGH_DATE_TAX_METHODS.ANNUALIZED_ACTUAL_YTD,
      treatment: "threshold_tested_against_annualized_income",
      formulaOperator: "sum",
      formulaExpression: "2200 + 800",
      inputValues: [
        { code: "social_security_tax", amount: 2200 },
        { code: "medicare_tax", amount: 800 },
      ],
    }],
    allocatedComponents: [
      {
        code: "federal_income_tax",
        label: "Federal income tax",
        annualAmount: 10000,
        amount: 5000,
        method: THROUGH_DATE_TAX_METHODS.TAXABLE_INCOME_SHARE,
        treatment: "annualized_using_projected_annual_income",
      },
      {
        code: "state_individual_income_tax",
        label: "State individual income tax",
        annualAmount: 4000,
        amount: 2000,
        method: THROUGH_DATE_TAX_METHODS.TAXABLE_INCOME_SHARE,
        treatment: "allocated_by_actual_ytd_share",
      },
      {
        code: "entity_minimum_tax",
        label: "Entity minimum tax",
        annualAmount: 800,
        amount: 800,
        method: THROUGH_DATE_TAX_METHODS.ANNUALIZED_ACTUAL_YTD,
        treatment: "annual_minimum_applied_fully",
      },
    ],
    excludedComponents: [{
      code: "qbi",
      label: "QBI deduction",
      annualAmount: null,
      amount: null,
      treatment: "unavailable",
      reason: "QBI is not supported in the current canonical calculation.",
    }],
    assumptions: [
      "Tax attributable through today is a planning attribution, not an amount currently due.",
    ],
    limitations: ["QBI is not included in the through-date amount."],
    confidence: { score: 0.78, level: "medium", status: "planning_estimate" },
  };

  return {
    meta: { businessId: "business-1", taxYear: 2026, asOfDate: "2026-07-21", runId: "run-through-date-1" },
    profile: {
      profile: {
        id: "profile-v1",
        updated_at: "2026-07-01T00:00:00Z",
        entity_type: "s_corporation",
        filing_status: "single",
        primary_tax_state: "NC",
        accounting_method: "cash",
      },
    },
    actuals: {
      taxableIncome: {
        revenue: { totalIncludedRevenue: 60000 },
        businessTaxableIncome: { finalBusinessTaxableIncome: 50000 },
      },
    },
    projection: {
      actual: {
        throughDate: "2026-07-21",
        taxableBusinessIncome: 50000,
        monthly: { "2026-07": { taxableBusinessIncome: 50000 } },
      },
      projectedAnnual: {
        taxableBusinessIncome: 100000,
        monthly: { "2026-07": { taxableBusinessIncome: 50000 } },
      },
    },
    liability: {
      projectedTotalTax: 22600,
      paymentsAndWithholdingYtd: 0,
      taxAttributableThroughToday: attribution,
    },
    federal: {
      incomeTax: {
        meta: { ruleVersions: { federalIncomeTaxBrackets: "fed-2026-v1", standardDeduction: "std-2026-v1" } },
        tax: { federalIncomeTax: 10000 },
      },
      selfEmploymentTax: {
        result: { totalSelfEmploymentTax: 7000 },
        detail: {
          socialSecurity: { rate: 0.124, wageBase: 168600 },
          medicare: { rate: 0.029 },
        },
      },
    },
    state: {
      stateCode: "NC",
      incomeTax: {
        meta: { ruleVersions: { individualIncomeTax: "nc-income-2026-v1", entityTax: "nc-entity-2026-v1" } },
        tax: { regularStateIncomeTax: 4000, sCorpMinimumTax: 800 },
      },
    },
    confidence: { level: "medium" },
    warnings: [],
  };
}

function workpaper({ canonical = canonicalResult() } = {}) {
  const attribution = canonical.liability.taxAttributableThroughToday;
  const throughDateAmount = attribution.amount ?? null;
  return {
    version: "tax-workpaper-v1",
    lines: [
      line("source_period_income:actual_business_revenue_ytd", "Business revenue through July 21", "source_period_income", 60000, {
        sourceRefs: [source("qbo-revenue-ytd", 60000, "qbo_profit_and_loss_line")],
        isActual: true,
      }),
      line("deductions:confirmed_deductible_expenses", "Confirmed deductible expenses", "deductions", 10000, {
        displaySign: "subtract",
        sourceRefs: [source("classification-expense-1", 10000, "transaction_tax_classification")],
        ruleRefs: [rule("tax_deduction_rules", "ordinary_expense", "deduction-v1")],
      }),
      line("business_taxable_income_bridge:nondeductible_addbacks", "Nondeductible addbacks", "business_taxable_income_bridge", 0, {
        sourceRefs: [source("tax-adjustment-snapshot", 0, "tax_adjustment")],
      }),
      line("business_taxable_income_bridge:other_tax_adjustments", "Other tax adjustments", "business_taxable_income_bridge", 0, {
        sourceRefs: [source("tax-adjustment-snapshot", 0, "tax_adjustment")],
      }),
      line("business_taxable_income_bridge:projected_business_taxable_profit", "Projected business taxable profit", "business_taxable_income_bridge", 100000, {
        sourceRefs: [source("taxable-income-snapshot", 100000, "calculation_input_snapshot")],
      }),
      line("annual_income_bridge:projected_annual_income", "Projected annual income", "annual_income_bridge", 110000, {
        sourceRefs: [source("projection-snapshot", 110000, "projection_input_snapshot")],
      }),
      line("deductions:total_deductible_expenses", "Total deductible expenses", "deductions", 10000, {
        sourceRefs: [source("deduction-snapshot", 10000, "calculation_input_snapshot")],
        ruleRefs: [rule("tax_deduction_rules", "deduction_total", "deduction-v1")],
      }),
      line("total_tax_components:federal_income_tax", "Federal income tax", "total_tax_components", 10000, {
        sourceRefs: [source("federal-engine-snapshot", 10000, "tax_profile_snapshot")],
        ruleRefs: [rule("tax_rule_configs", "federalIncomeTaxBrackets", "fed-2026-v1")],
      }),
      line("total_tax_components:self_employment_tax", "Self-employment tax", "total_tax_components", 7000, {
        sourceRefs: [source("se-engine-snapshot", 7000, "tax_rule_config")],
        ruleRefs: [rule("tax_rule_configs", "selfEmploymentTax", "se-2026-v1")],
      }),
      line("total_tax_components:state_individual_income_tax", "State individual income tax", "total_tax_components", 4000, {
        sourceRefs: [source("state-engine-snapshot", 4000, "state_tax_rule_config")],
        ruleRefs: [rule("state_tax_rule_configs", "individualIncomeTax", "nc-income-2026-v1")],
      }),
      line("total_tax_components:entity_level_tax", "Entity-level tax", "total_tax_components", 1600, {
        sourceRefs: [source("state-entity-snapshot", 1600, "state_tax_rule_config")],
        ruleRefs: [rule("state_tax_rule_configs", "entityTax", "nc-entity-2026-v1")],
      }),
      line("total_tax_components:projected_annual_tax", "Projected annual tax", "total_tax_components", 22600, {
        sourceRefs: [source("annual-tax-total", 22600, "calculation_node")],
      }),
      line("through_date_tax:projected_annual_tax", "Projected annual tax", "through_date_tax", 22600, { parentCode: "through_date_tax:tax_attributable_through_date" }),
      line("through_date_tax:actual_ytd_taxable_income_base", "Actual YTD taxable-income base", "through_date_tax", attribution.actualYtdTaxableIncomeBase ?? null, { parentCode: "through_date_tax:tax_attributable_through_date" }),
      line("through_date_tax:projected_annual_taxable_income_base", "Projected annual taxable-income base", "through_date_tax", attribution.projectedAnnualTaxableIncomeBase ?? null, { parentCode: "through_date_tax:tax_attributable_through_date" }),
      line("through_date_tax:allocation_percentage", "Allocation percentage", "through_date_tax", null, { parentCode: "through_date_tax:tax_attributable_through_date", metadata: { percentage: attribution.allocationPercentage ?? null } }),
      line("through_date_tax:directly_calculated_components", "Directly calculated components", "through_date_tax", sumAmounts(attribution.directlyCalculatedComponents), { parentCode: "through_date_tax:tax_attributable_through_date", metadata: { components: attribution.directlyCalculatedComponents } }),
      line("through_date_tax:allocated_components", "Allocated components", "through_date_tax", sumAmounts(attribution.allocatedComponents), { parentCode: "through_date_tax:tax_attributable_through_date", metadata: { components: attribution.allocatedComponents } }),
      line("through_date_tax:excluded_components", "Excluded components", "through_date_tax", null, { parentCode: "through_date_tax:tax_attributable_through_date", status: "excluded", metadata: { components: attribution.excludedComponents } }),
      line("through_date_tax:tax_attributable_through_date", "Tax attributable through today", "through_date_tax", throughDateAmount, {
        formulaCode: attribution.methodCode,
        metadata: {
          calculationMethod: attribution.methodCode,
          methodVersion: attribution.methodVersion,
          actualYtdTaxableIncomeBase: attribution.actualYtdTaxableIncomeBase,
          projectedAnnualTaxableIncomeBase: attribution.projectedAnnualTaxableIncomeBase,
          allocationPercentage: attribution.allocationPercentage,
        },
      }),
    ],
    ruleVersionMap: { throughDate: { method: attribution.methodVersion } },
    sourceLineageSummary: {},
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
    rule_refs: overrides.ruleRefs || [],
    rule_versions: {},
    explanation: overrides.explanation || `${label} is persisted in the through-date graph test fixture.`,
    source_type: null,
    source_refs: overrides.sourceRefs || [],
    is_projection: overrides.isProjection === true,
    is_actual: overrides.isActual === true,
    materiality: overrides.materiality || "high",
    drill_down_type: null,
    drill_down_params: {},
    metadata: overrides.metadata || {},
  };
}

function source(id, amount, type = "manual_input") {
  return {
    type,
    id,
    amount,
    field: "amount",
    value: amount,
    treatment: "included",
    label: id,
  };
}

function rule(repository, ruleCode, version) {
  return { repository, ruleCode, version, supportLevel: "supported" };
}

function sumAmounts(rows = []) {
  if (!rows.length) return null;
  return Math.round(rows.reduce((total, row) => total + Number(row.amount || 0), 0) * 100) / 100;
}
