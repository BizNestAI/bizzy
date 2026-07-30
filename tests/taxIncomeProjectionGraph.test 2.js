import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTaxCalculationGraph,
  reproduceTaxCalculationGraph,
} from "../src/services/tax/workpaper/taxCalculationGraph.js";

test("income graph rolls exact transaction snapshots into monthly and account revenue nodes", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: canonicalResult(), workpaper: workpaper() });
  const revenue = node(graph, "source_period_income:actual_business_revenue_ytd");
  const january = node(graph, "source_period_income:actual_business_revenue_ytd:month:2026-01");
  const account = node(graph, "source_period_income:actual_business_revenue_ytd:month:2026-01:account:qbo_income_1");
  const transaction = node(graph, "source_period_income:actual_business_revenue_ytd:month:2026-01:account:qbo_income_1:transaction:class_rev_1");

  assert.equal(revenue.reconciliationStatus, "reconciled");
  assert.equal(revenue.reconciliationExpectedAmount, 1400);
  assert.equal(january.amount, 1000);
  assert.equal(account.amount, 1000);
  assert.equal(transaction.amount, 1000);
  assert.equal(transaction.sourceRefs[0].sourceId, "class-rev-1");
  assert.equal(transaction.sourceRefs[0].snapshotValue.qboTransactionId, "qbo-txn-1");
  assert.equal(transaction.sourceRefs[0].snapshotValue.plaidTransactionId, "plaid-1");
  assert.equal(transaction.sourceRefs[0].snapshotValue.overrideId, "override-1");
  assert.equal(transaction.ruleRefs[0].repository, "tax_classification_rules");
  assert.equal(transaction.ruleRefs[0].ruleCode, "income_gross_receipts");
});

test("income graph separates other supported income from gross receipts", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: canonicalResult(), workpaper: workpaper() });
  const other = node(graph, "source_period_income:other_actual_business_income_ytd");
  const otherMonth = node(graph, "source_period_income:other_actual_business_income_ytd:month:2026-03");
  const actualYtd = node(graph, "annual_income_bridge:actual_ytd_income");

  assert.equal(other.amount, 300);
  assert.equal(other.reconciliationExpectedAmount, 300);
  assert.equal(otherMonth.amount, 300);
  assert.deepEqual(actualYtd.inputValues.map((input) => [input.nodeCode, input.amount]), [
    ["source_period_income:actual_business_revenue_ytd", 1400],
    ["source_period_income:other_actual_business_income_ytd", 300],
  ]);
  assert.equal(actualYtd.reconciliationStatus, "reconciled");
});

test("income graph preserves excluded transfers, owner contributions, loan proceeds, and future transactions", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: canonicalResult(), workpaper: workpaper() });
  const excluded = node(graph, "source_period_income:excluded_income_activity");

  assert.equal(excluded.amount, 2800);
  assert.equal(excluded.metadata.excludedTransactionCount, 4);
  assert.deepEqual(excluded.metadata.exclusionReasons.sort(), [
    "future_transaction",
    "loan_proceeds_excluded",
    "owner_contribution_excluded",
    "transfer_excluded",
  ]);
  assert.equal(excluded.sourceRefs.find((ref) => ref.sourceId === "class-transfer").amountUsed, 700);
  assert.equal(excluded.sourceRefs.find((ref) => ref.sourceId === "class-owner").amountUsed, 800);
  assert.equal(excluded.sourceRefs.find((ref) => ref.sourceId === "class-loan").amountUsed, 900);
});

test("projection graph persists monthly formula inputs and reproduces projected remaining revenue", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: canonicalResult(), workpaper: workpaper() });
  const august = node(graph, "projected_remaining_year_income:projected_remaining_business_revenue:month:2026-08");
  const projectedRemaining = node(graph, "projected_remaining_year_income:projected_remaining_business_revenue");
  const reproduced = reproduceTaxCalculationGraph({ nodes: graph.nodes });

  assert.equal(august.amount, 1100);
  assert.equal(august.formulaOperator, "multiply_all");
  assert.equal(august.formulaExpression, "1000 * 1.1 * 1 * 1");
  assert.deepEqual(august.inputValues.map((input) => [input.code, input.amount]), [
    ["average_revenue", 1000],
    ["seasonality_factor", 1.1],
    ["growth_factor", 1],
    ["remaining_period_ratio", 1],
  ]);
  assert.equal(projectedRemaining.reconciliationStatus, "reconciled");
  assert.equal(reproduced.values["projected_remaining_year_income:projected_remaining_business_revenue"], 6000);
});

test("projection graph persists blended projection formulas", () => {
  const result = canonicalResult();
  result.projection.method = "blended";
  result.projection.projectedFuture.monthly["2026-08"].methodContributions = {
    trailing_average: { revenue: 1000 },
    seasonal_model: { revenue: 1200 },
  };
  result.projection.methodology.weights = { trailing_average: 0.4, seasonal_model: 0.6 };
  delete result.projection.methodology.projectionTrace.monthly["2026-08"];

  const graph = buildTaxCalculationGraph({ canonicalResult: result, workpaper: workpaper() });
  const august = node(graph, "projected_remaining_year_income:projected_remaining_business_revenue:month:2026-08");
  const reproduced = reproduceTaxCalculationGraph({ nodes: [august] });

  assert.equal(august.formulaOperator, "weighted_sum");
  assert.equal(august.formulaExpression, "1000 * 0.4 + 1200 * 0.6");
  assert.equal(reproduced.values[august.nodeCode], 1120);
});

test("projected annual income reconciles from actual YTD and projected remaining income", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: canonicalResult(), workpaper: workpaper() });
  const annual = node(graph, "annual_income_bridge:projected_annual_income");
  const reproduced = reproduceTaxCalculationGraph({ nodes: graph.nodes });

  assert.equal(annual.amount, 7700);
  assert.equal(annual.formulaExpression, "1700 + 6000");
  assert.equal(annual.reconciliationStatus, "reconciled");
  assert.equal(reproduced.values[annual.nodeCode], 7700);
});

test("income graph source snapshots remain immutable after current sources mutate", () => {
  const result = canonicalResult();
  const graph = buildTaxCalculationGraph({ canonicalResult: result, workpaper: workpaper() });
  const before = node(graph, "source_period_income:actual_business_revenue_ytd:month:2026-01:account:qbo_income_1:transaction:class_rev_1");

  result.actuals.taxableIncome.revenue.sourceItems.included[0].includedAmount = 999999;
  result.actuals.taxableIncome.revenue.sourceItems.included[0].qboTransactionId = "changed-qbo";

  assert.equal(before.amount, 1000);
  assert.equal(before.sourceRefs[0].snapshotValue.includedAmount, 1000);
  assert.equal(before.sourceRefs[0].snapshotValue.qboTransactionId, "qbo-txn-1");
});

function node(graph, code) {
  const found = graph.nodes.find((item) => item.nodeCode === code);
  assert.ok(found, `Expected graph node ${code}`);
  return found;
}

function canonicalResult() {
  return {
    meta: {
      businessId: "business-1",
      taxYear: 2026,
      asOfDate: "2026-07-21",
      engineVersions: { taxableIncome: "taxable-income-v1", projection: "projection-v1" },
    },
    profile: {
      profile: {
        entity_type: "s_corporation",
        filing_status: "single",
        primary_tax_state: "NC",
        accounting_method: "cash",
      },
    },
    actuals: {
      taxableIncome: {
        meta: { engineVersion: "taxable-income-v1" },
        actualYtdIncome: 1700,
        revenue: {
          grossReceipts: 1500,
          otherBusinessIncome: 300,
          returnsAndAllowances: 100,
          netBusinessRevenue: 1700,
          sourceItems: {
            included: [
              revenueItem({
                classificationId: "class-rev-1",
                bankTransactionId: "bank-1",
                plaidTransactionId: "plaid-1",
                qboTransactionId: "qbo-txn-1",
                qboAccountId: "qbo-income-1",
                transactionDate: "2026-01-15",
                transactionAmount: 1000,
                includedAmount: 1000,
                taxCategory: "gross_receipts",
                treatment: "included_gross_receipts",
                ruleCode: "income_gross_receipts",
                ruleVersion: "income-rules-v1",
                overrideId: "override-1",
                overrideVersion: "override-v1",
                sourceSystem: "quickbooks",
              }),
              revenueItem({
                classificationId: "class-rev-2",
                bankTransactionId: "bank-2",
                plaidTransactionId: "plaid-2",
                qboTransactionId: "qbo-txn-2",
                qboAccountId: "qbo-income-2",
                transactionDate: "2026-02-10",
                transactionAmount: 500,
                includedAmount: 500,
                taxCategory: "service_revenue",
                treatment: "included_gross_receipts",
                ruleCode: "income_service_revenue",
                ruleVersion: "income-rules-v1",
                sourceSystem: "plaid",
              }),
              revenueItem({
                classificationId: "class-return",
                bankTransactionId: "bank-return",
                qboAccountId: "qbo-income-2",
                transactionDate: "2026-02-20",
                transactionAmount: 100,
                includedAmount: -100,
                taxCategory: "returns_allowances",
                treatment: "returns_allowances",
                ruleCode: "returns_allowances",
                ruleVersion: "income-rules-v1",
                sourceSystem: "quickbooks",
              }),
              revenueItem({
                classificationId: "class-other",
                bankTransactionId: "bank-other",
                qboAccountId: "qbo-other-income",
                transactionDate: "2026-03-05",
                transactionAmount: 300,
                includedAmount: 300,
                taxCategory: "other_business_income",
                treatment: "included_other_business_income",
                ruleCode: "other_business_income",
                ruleVersion: "income-rules-v1",
                sourceSystem: "quickbooks",
              }),
            ],
            excluded: [
              revenueItem({ classificationId: "class-transfer", transactionDate: "2026-01-10", transactionAmount: 700, includedAmount: 0, taxCategory: "transfer", treatment: "excluded", exclusionReason: "transfer_excluded" }),
              revenueItem({ classificationId: "class-owner", transactionDate: "2026-02-10", transactionAmount: 800, includedAmount: 0, taxCategory: "owner_contribution", treatment: "excluded", exclusionReason: "owner_contribution_excluded" }),
              revenueItem({ classificationId: "class-loan", transactionDate: "2026-03-10", transactionAmount: 900, includedAmount: 0, taxCategory: "loan_principal", treatment: "excluded", exclusionReason: "loan_proceeds_excluded" }),
              revenueItem({ classificationId: "class-future", transactionDate: "2026-08-01", transactionAmount: 400, includedAmount: 0, taxCategory: "gross_receipts", treatment: "excluded", exclusionReason: "future_transaction" }),
            ],
          },
        },
      },
    },
    projection: {
      method: "seasonality",
      actual: {
        throughDate: "2026-07-21",
        revenue: 1700,
        monthly: {
          "2026-05": { revenue: 900 },
          "2026-06": { revenue: 1000 },
          "2026-07": { revenue: 1100 },
        },
      },
      projectedFuture: {
        revenue: 6000,
        monthly: {
          "2026-08": { revenue: 1100 },
          "2026-09": { revenue: 1150 },
          "2026-10": { revenue: 1200 },
          "2026-11": { revenue: 1250 },
          "2026-12": { revenue: 1300 },
        },
      },
      projectedAnnual: { revenue: 7700 },
      methodology: {
        primaryMethod: "seasonality",
        actualMonthsUsed: ["2026-05", "2026-06", "2026-07"],
        assumptions: ["Uses the trailing three complete months as projection inputs."],
        projectionTrace: {
          actualMonthsUsed: ["2026-05", "2026-06", "2026-07"],
          monthly: {
            "2026-08": {
              formulaCode: "seasonality_monthly_revenue_projection",
              formulaOperator: "multiply_all",
              inputValues: [
                { code: "average_revenue", amount: 1000 },
                { code: "seasonality_factor", amount: 1.1 },
                { code: "growth_factor", amount: 1 },
                { code: "remaining_period_ratio", amount: 1 },
              ],
              formulaExpression: "1000 * 1.1 * 1 * 1",
              monthlyInputs: [
                { code: "2026-05", amount: 900 },
                { code: "2026-06", amount: 1000 },
                { code: "2026-07", amount: 1100 },
              ],
              seasonalityFactor: 1.1,
              growthFactor: 1,
              remainingRatio: 1,
            },
          },
        },
      },
    },
  };
}

function revenueItem(overrides = {}) {
  const transactionDate = overrides.transactionDate || "2026-01-01";
  return {
    classificationId: overrides.classificationId,
    classificationVersion: overrides.classificationVersion || "classification-v1",
    classificationStatus: overrides.classificationStatus || "user_confirmed",
    bankTransactionId: overrides.bankTransactionId || null,
    plaidTransactionId: overrides.plaidTransactionId || null,
    qboTransactionId: overrides.qboTransactionId || null,
    qboAccountId: overrides.qboAccountId || null,
    transactionDate,
    month: transactionDate.slice(0, 7),
    transactionAmount: overrides.transactionAmount,
    includedAmount: overrides.includedAmount,
    taxCategory: overrides.taxCategory || null,
    ruleCode: overrides.ruleCode || null,
    ruleVersion: overrides.ruleVersion || null,
    overrideId: overrides.overrideId || null,
    overrideVersion: overrides.overrideVersion || null,
    sourceSystem: overrides.sourceSystem || "bank_transaction",
    confirmationState: overrides.confirmationState || "confirmed",
    treatment: overrides.treatment,
    exclusionReason: overrides.exclusionReason || null,
    sourceLabel: overrides.sourceLabel || overrides.classificationId,
  };
}

function workpaper() {
  return {
    version: "tax-workpaper-v1",
    lines: [
      line("source_period_income:actual_business_revenue_ytd", "Business revenue through July 21", "source_period_income", 1400, { isActual: true }),
      line("source_period_income:other_actual_business_income_ytd", "Other supported income", "source_period_income", 300, { isActual: true }),
      line("source_period_income:actual_nonbusiness_income_included", "Actual nonbusiness income included", "source_period_income", null, { status: "not_applicable" }),
      line("projected_remaining_year_income:projected_remaining_business_revenue", "Projected remaining revenue", "projected_remaining_year_income", 6000, { isProjection: true, status: "projected" }),
      line("projected_remaining_year_income:projected_remaining_other_business_income", "Projected remaining other business income", "projected_remaining_year_income", null, { status: "not_applicable" }),
      line("annual_income_bridge:actual_ytd_income", "Actual YTD income", "annual_income_bridge", 1700, { isActual: true }),
      line("annual_income_bridge:projected_remaining_income", "Projected remaining income", "annual_income_bridge", 6000, { isProjection: true, status: "projected" }),
      line("annual_income_bridge:projected_annual_income", "Annual income subtotal", "annual_income_bridge", 7700),
    ],
  };
}

function line(code, label, section, amount, overrides = {}) {
  return {
    code,
    label,
    section,
    amount,
    sort_order: overrides.sortOrder || 10,
    status: overrides.status || "calculated",
    support_level: "supported",
    confidence: 0.9,
    is_actual: overrides.isActual === true,
    is_projection: overrides.isProjection === true,
    formula_code: overrides.formulaCode || null,
    formula_description: overrides.formulaDescription || `Canonical ${label} calculation.`,
    explanation: overrides.explanation || `Canonical ${label} calculation.`,
    source_refs: overrides.sourceRefs || [],
    rule_refs: overrides.ruleRefs || [],
    rule_versions: {},
    metadata: { materiality: "high", ...(overrides.metadata || {}) },
  };
}
