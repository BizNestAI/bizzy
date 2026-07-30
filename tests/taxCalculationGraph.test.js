import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTaxCalculationGraph,
  certifyTaxCalculationGraph,
  reproduceTaxCalculationGraph,
  validateTaxCalculationGraph,
  TAX_CALCULATION_GRAPH_VERSION,
  TAX_GRAPH_TRACEABILITY_STATUSES,
} from "../src/services/tax/workpaper/taxCalculationGraph.js";

test("calculation graph builds recursive nodes with persisted formula inputs", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: canonicalResult(), workpaper: workpaper() });
  const projectedAnnualRevenue = node(graph, "annual_income_bridge:projected_annual_income");

  assert.equal(graph.version, TAX_CALCULATION_GRAPH_VERSION);
  assert.deepEqual(projectedAnnualRevenue.childNodeCodes, [
    "annual_income_bridge:actual_ytd_income",
    "annual_income_bridge:projected_remaining_income",
  ]);
  assert.deepEqual(projectedAnnualRevenue.inputValues.map((input) => [input.code, input.amount]), [
    ["actual_ytd_income", 182000],
    ["projected_remaining_income", 130000],
  ]);
  assert.equal(projectedAnnualRevenue.formulaOperator, "sum_signed");
  assert.equal(projectedAnnualRevenue.formulaExpression, "182000 + 130000");
  assert.equal(projectedAnnualRevenue.reconciliationStatus, "reconciled");
});

test("calculation graph persists source refs, rule refs, and immutable snapshot hash", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: canonicalResult(), workpaper: workpaper() });
  const meals = node(graph, "deductions:category:meals");
  const federalTax = node(graph, "total_tax_components:federal_income_tax");

  assert.equal(graph.inputSnapshot.version, TAX_CALCULATION_GRAPH_VERSION);
  assert.ok(graph.inputSnapshot.hash);
  assert.equal(meals.sourceRefs[0].sourceType, "transaction_tax_classification");
  assert.equal(meals.sourceRefs[0].sourceId, "classification-meals-1");
  assert.equal(meals.sourceRefs[0].amountUsed, 1150);
  assert.equal(meals.ruleRefs[0].repository, "tax_deduction_rules");
  assert.equal(meals.ruleRefs[0].ruleCode, "meals_50_percent");
  assert.equal(meals.ruleRefs[0].version, "deduction-v1");
  assert.ok(meals.sourceRefs[0].immutableHash);
  assert.ok(federalTax.ruleRefs.some((ref) => ref.ruleCode === "federalIncomeTaxBrackets"));
});

test("calculation graph reproduces original aggregate results without live data", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: canonicalResult(), workpaper: workpaper() });
  const reproduced = reproduceTaxCalculationGraph({ nodes: graph.nodes });

  assert.equal(reproduced.values["annual_income_bridge:projected_annual_income"], 312000);
  assert.equal(reproduced.values["deductions:estimated_deductible_expenses"], 14200);
  assert.equal(reproduced.values["remaining_liability:remaining_projected_liability"], 12400);
});

test("calculation graph preserves null as unavailable instead of zero", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: canonicalResult(), workpaper: workpaper() });
  const qbi = node(graph, "federal_bridge:qbi_deduction");
  const result = graph.validation.nodeResults[qbi.nodeCode];

  assert.equal(qbi.amount, null);
  assert.equal(qbi.nodeType, "unavailable");
  assert.equal(result.status, TAX_GRAPH_TRACEABILITY_STATUSES.TRACEABLE_WITH_LIMITATIONS);
  assert.equal(result.material, false);
});

test("calculation graph validator rejects monetary nodes without lineage", () => {
  const validation = validateTaxCalculationGraph({
    snapshot: { hash: "snapshot-hash" },
    nodes: [{
      nodeCode: "annual_income_bridge:display_only_amount",
      sectionCode: "annual_income_bridge",
      amount: 100,
      childNodeCodes: [],
      inputValues: [],
      sourceRefs: [],
      ruleRefs: [],
      metadata: { materiality: "high" },
    }],
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.nodeResults["annual_income_bridge:display_only_amount"].status, TAX_GRAPH_TRACEABILITY_STATUSES.INCOMPLETE_LINEAGE);
  assert.ok(validation.nodeResults["annual_income_bridge:display_only_amount"].reasons.includes("missing_formula_or_engine_path"));
  assert.ok(validation.nodeResults["annual_income_bridge:display_only_amount"].reasons.includes("missing_source_refs"));
});

test("calculation graph validator rejects rule-dependent monetary nodes without rule refs", () => {
  const validation = validateTaxCalculationGraph({
    snapshot: { hash: "snapshot-hash" },
    nodes: [{
      nodeCode: "federal_bridge:federal_income_tax",
      sectionCode: "federal_bridge",
      amount: 100,
      formulaCode: "federal_income_tax_engine_output",
      calculationEnginePath: "federal.incomeTax.total",
      sourceRefs: [{ sourceType: "tax_profile_snapshot", sourceId: "profile-v1" }],
      inputValues: [{ code: "taxable_income", amount: 1000 }],
      childNodeCodes: [],
      ruleRefs: [],
      description: "Federal income tax engine output.",
      metadata: { materiality: "high" },
    }],
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.nodeResults["federal_bridge:federal_income_tax"].reasons.includes("missing_rule_refs"));
});

test("calculation graph validator rejects unreconciled subtotal nodes", () => {
  const graph = buildTaxCalculationGraph({
    canonicalResult: canonicalResult(),
    workpaper: workpaper({
      lines: [
        line("annual_income_bridge:actual_ytd_income", "Actual YTD income", "annual_income_bridge", 40, { sourceRefs: [source("source-a", 40)] }),
        line("annual_income_bridge:projected_remaining_income", "Projected remaining income", "annual_income_bridge", 50, { sourceRefs: [source("source-b", 50)] }),
        line("annual_income_bridge:projected_annual_income", "Projected annual income", "annual_income_bridge", 99),
      ],
    }),
  });

  const result = graph.validation.nodeResults["annual_income_bridge:projected_annual_income"];
  assert.equal(result.status, TAX_GRAPH_TRACEABILITY_STATUSES.UNRECONCILED);
  assert.ok(result.reasons.includes("subtotal_out_of_balance"));
  assert.equal(graph.validation.ok, false);
});

test("calculation graph certifier prevents full traceability when a material monetary node is incomplete", () => {
  const node = {
    nodeCode: "total_tax_components:display_only_tax",
    nodeType: "engine_output",
    sectionCode: "total_tax_components",
    amount: 24800,
    inputValues: [],
    childNodeCodes: [],
    sourceRefs: [],
    ruleRefs: [],
    metadata: { materiality: "material" },
  };

  const certification = certifyTaxCalculationGraph({
    snapshot: { hash: "snapshot-hash" },
    nodes: [node],
    intendedRunStatus: "completed",
  });

  assert.equal(certification.certificationStatus, "failed");
  assert.equal(certification.canClaimFullTraceability, false);
  assert.equal(certification.productionCompleteAllowed, false);
  assert.equal(certification.diagnostics.totalMonetaryNodes, 1);
  assert.equal(certification.diagnostics.failedNodes, 1);
});

test("calculation graph validator treats source lineage through children as fully traceable", () => {
  const children = [
    {
      nodeCode: "income:service_revenue",
      nodeType: "source_value",
      sectionCode: "income",
      parentNodeCode: "income:total",
      amount: 700,
      formulaOperator: "source_value",
      sourceRefs: [source("qbo-service", 700)],
      ruleRefs: [],
      description: "Persisted source value.",
      metadata: { materiality: "material" },
    },
    {
      nodeCode: "income:other_revenue",
      nodeType: "source_value",
      sectionCode: "income",
      parentNodeCode: "income:total",
      amount: 300,
      formulaOperator: "source_value",
      sourceRefs: [source("qbo-other", 300)],
      ruleRefs: [],
      description: "Persisted source value.",
      metadata: { materiality: "material" },
    },
  ];
  const parent = {
    nodeCode: "income:total",
    nodeType: "subtotal",
    sectionCode: "income",
    amount: 1000,
    formulaOperator: "sum",
    childNodeCodes: children.map((child) => child.nodeCode),
    sourceRefs: [],
    ruleRefs: [],
    description: "Revenue subtotal from source children.",
    metadata: { materiality: "material" },
  };

  const validation = validateTaxCalculationGraph({
    snapshot: { hash: "snapshot-hash" },
    nodes: [parent, ...children],
  });

  assert.equal(validation.ok, true);
  assert.equal(validation.fullyTraceable, true);
  assert.equal(validation.nodeResults["income:total"].status, TAX_GRAPH_TRACEABILITY_STATUSES.FULLY_TRACEABLE);
});

test("calculation graph reproduction reports mismatches, circular dependencies, and orphans", () => {
  const mismatch = {
    nodeCode: "income:bad_total",
    nodeType: "formula",
    sectionCode: "income",
    amount: 1200,
    formulaOperator: "sum",
    inputValues: [{ code: "a", amount: 500 }, { code: "b", amount: 500 }],
    sourceRefs: [source("projection-snapshot", 1200)],
    description: "Bad persisted formula.",
    metadata: { materiality: "material" },
  };
  const cycleA = {
    nodeCode: "cycle:a",
    nodeType: "subtotal",
    sectionCode: "income",
    amount: 1,
    formulaOperator: "sum",
    childNodeCodes: ["cycle:b"],
    sourceRefs: [],
    description: "Cycle A.",
  };
  const cycleB = {
    nodeCode: "cycle:b",
    nodeType: "subtotal",
    sectionCode: "income",
    amount: 1,
    formulaOperator: "sum",
    childNodeCodes: ["cycle:a"],
    sourceRefs: [],
    description: "Cycle B.",
  };
  const orphan = {
    nodeCode: "income:orphan_parent",
    nodeType: "subtotal",
    sectionCode: "income",
    amount: 1,
    formulaOperator: "sum",
    childNodeCodes: ["income:missing_child"],
    sourceRefs: [],
    description: "Missing child.",
  };

  const reproduced = reproduceTaxCalculationGraph({ nodes: [mismatch, cycleA, cycleB, orphan] });
  const validation = validateTaxCalculationGraph({
    snapshot: { hash: "snapshot-hash" },
    nodes: [mismatch, cycleA, cycleB, orphan],
  });

  assert.equal(reproduced.ok, false);
  assert.ok(reproduced.failures.some((failure) => failure.nodeCode === "income:bad_total"));
  assert.ok(validation.nodeResults["cycle:a"].reasons.includes("circular_dependency"));
  assert.ok(validation.nodeResults["income:orphan_parent"].reasons.includes("orphan_child_node"));
});

test("calculation graph validator detects rule refs without versions and live data dependencies", () => {
  const validation = validateTaxCalculationGraph({
    snapshot: { hash: "snapshot-hash" },
    nodes: [{
      nodeCode: "state_bridge:state_individual_tax",
      nodeType: "tax_rule_application",
      sectionCode: "state_bridge",
      amount: 100,
      formulaOperator: "multiply",
      inputValues: [{ code: "taxable_income", amount: 1000 }, { code: "rate", amount: 0.1 }],
      sourceRefs: [{ sourceType: "current_transaction", sourceId: "live", amountUsed: 100 }],
      ruleRefs: [{ repository: "state_tax_rule_configs", ruleCode: "income_tax" }],
      description: "State tax from persisted inputs.",
      metadata: { materiality: "material" },
    }],
  });

  const reasons = validation.nodeResults["state_bridge:state_individual_tax"].reasons;
  assert.ok(reasons.includes("rule_ref_missing_version"));
  assert.ok(reasons.includes("live_data_dependency"));
  assert.equal(validation.diagnostics.liveDataDependencies, 1);
});

test("calculation graph snapshot is immutable after live source and rule objects mutate", () => {
  const canonical = canonicalResult();
  const graph = buildTaxCalculationGraph({ canonicalResult: canonical, workpaper: workpaper() });
  const originalHash = graph.inputSnapshot.hash;
  const originalFederalRuleVersion = node(graph, "total_tax_components:federal_income_tax").ruleRefs[0].version;
  const originalSourceAmount = node(graph, "deductions:category:meals").sourceRefs[0].amountUsed;

  canonical.federal.incomeTax.meta.ruleVersions.federalIncomeTaxBrackets = "fed-2026-v2";
  canonical.actuals.deductions.categories[0].deductibleAmount = 999999;

  assert.equal(graph.inputSnapshot.hash, originalHash);
  assert.equal(node(graph, "total_tax_components:federal_income_tax").ruleRefs[0].version, originalFederalRuleVersion);
  assert.equal(node(graph, "deductions:category:meals").sourceRefs[0].amountUsed, originalSourceAmount);
});

function node(graph, code) {
  const found = graph.nodes.find((item) => item.nodeCode === code);
  assert.ok(found, `Expected graph node ${code}`);
  return found;
}

function canonicalResult() {
  return {
    meta: { businessId: "business-1", taxYear: 2026, asOfDate: "2026-07-21" },
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
      taxableIncome: { actualYtdIncome: 182000 },
      deductions: {
        categories: [{ code: "meals", deductibleAmount: 1150 }],
      },
    },
    projection: {
      actual: { throughDate: "2026-07-21" },
      projectedRemainingIncome: 130000,
    },
    federal: {
      incomeTax: {
        meta: { ruleVersions: { federalIncomeTaxBrackets: "fed-2026-v1", standardDeduction: "standard-2026-v1" } },
      },
    },
    state: {
      stateCode: "NC",
      incomeTax: { meta: { ruleVersions: { individualIncomeTax: "nc-2026-v1" } } },
    },
    reserve: { policy: { strategy: "remaining_liability", version: "reserve-policy-v1" } },
  };
}

function workpaper(overrides = {}) {
  const defaultLines = [
    line("annual_income_bridge:actual_ytd_income", "Actual YTD income", "annual_income_bridge", 182000, {
      sourceRefs: [source("qbo-pl-revenue-ytd", 182000, { sourceType: "qbo_profit_and_loss_line", field: "revenue" })],
      isActual: true,
    }),
    line("annual_income_bridge:projected_remaining_income", "Projected remaining income", "annual_income_bridge", 130000, {
      status: "projected",
      isProjection: true,
      sourceRefs: [source("projection-input-v1", 130000, { sourceType: "projection_input_snapshot", field: "projectedRemainingRevenue" })],
      formulaCode: "projection_run_rate_v1",
    }),
    line("annual_income_bridge:projected_annual_income", "Projected annual income", "annual_income_bridge", 312000),
    line("deductions:category:meals", "Meals", "deductions", 1150, {
      parentCode: "deductions:estimated_deductible_expenses",
      displaySign: "subtract",
      sourceRefs: [source("classification-meals-1", 1150, { sourceType: "transaction_tax_classification", field: "deductible_amount" })],
      ruleRefs: [{ repository: "tax_deduction_rules", ruleCode: "meals_50_percent", version: "deduction-v1", supportLevel: "supported" }],
    }),
    line("deductions:category:materials", "Materials", "deductions", 13050, {
      parentCode: "deductions:estimated_deductible_expenses",
      displaySign: "subtract",
      sourceRefs: [source("classification-materials-1", 13050, { sourceType: "transaction_tax_classification", field: "deductible_amount" })],
      ruleRefs: [{ repository: "tax_deduction_rules", ruleCode: "materials_ordinary", version: "deduction-v1", supportLevel: "supported" }],
    }),
    line("deductions:estimated_deductible_expenses", "Estimated deductible expenses", "deductions", 14200, {
      displaySign: "subtract",
      ruleRefs: [{ repository: "tax_deduction_rules", ruleCode: "deduction_category_rollup", version: "deduction-v1" }],
    }),
    line("federal_bridge:qbi_deduction", "QBI deduction", "federal_bridge", null, {
      status: "unavailable",
      materiality: "high",
      explanation: "QBI deduction is unavailable until supported.",
    }),
    line("total_tax_components:federal_income_tax", "Federal income tax", "total_tax_components", 18000, {
      sourceRefs: [source("federal-engine-inputs-v1", 18000, { sourceType: "tax_profile_snapshot", field: "federal_income_tax" })],
    }),
    line("total_tax_components:state_individual_income_tax", "State individual income tax", "total_tax_components", 6800, {
      sourceRefs: [source("state-engine-inputs-v1", 6800, { sourceType: "tax_profile_snapshot", field: "state_income_tax" })],
      ruleRefs: [{ repository: "state_tax_rule_configs", ruleCode: "individualIncomeTax", jurisdiction: "NC", version: "nc-2026-v1" }],
    }),
    line("total_tax_components:projected_annual_tax", "Projected annual tax", "total_tax_components", 24800),
    line("remaining_liability:projected_annual_tax", "Projected annual tax", "remaining_liability", 24800, {
      sourceRefs: [source("tax-component-total", 24800, { sourceType: "calculation_node", field: "projected_annual_tax" })],
    }),
    line("remaining_liability:confirmed_applicable_payments", "Confirmed applicable payments", "remaining_liability", 12400, {
      displaySign: "subtract",
      sourceRefs: [source("payment-snapshot-v1", 12400, { sourceType: "tax_payment_snapshot", field: "applied_amount" })],
    }),
    line("remaining_liability:remaining_projected_liability", "Remaining projected liability", "remaining_liability", 12400),
  ];
  return {
    version: "tax-workpaper-v1",
    lines: overrides.lines || defaultLines,
    ruleVersionMap: {
      federal: { federalIncomeTaxBrackets: "fed-2026-v1" },
      state: { individualIncomeTax: "nc-2026-v1" },
      deductions: { meals_50_percent: "deduction-v1" },
    },
    sourceLineageSummary: { transactionClassifications: { count: 2 } },
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
    support_level: overrides.supportLevel || "supported",
    confidence: overrides.confidence ?? 0.9,
    formula_code: overrides.formulaCode || null,
    formula_description: overrides.formulaDescription || null,
    rule_refs: overrides.ruleRefs || [],
    rule_versions: overrides.ruleVersions || {},
    explanation: overrides.explanation || `${label} is persisted in the calculation graph test fixture.`,
    source_type: overrides.sourceType || null,
    source_refs: overrides.sourceRefs || [],
    is_projection: overrides.isProjection === true,
    is_actual: overrides.isActual === true,
    materiality: overrides.materiality || "high",
    drill_down_type: null,
    drill_down_params: {},
    metadata: overrides.metadata || {},
  };
}

function source(id, amount, overrides = {}) {
  return {
    type: overrides.sourceType || "manual_input",
    id,
    amount,
    field: overrides.field || "amount",
    value: amount,
    treatment: overrides.treatment || "included",
    label: overrides.label || id,
  };
}
