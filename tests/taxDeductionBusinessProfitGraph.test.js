import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTaxCalculationGraph,
  reproduceTaxCalculationGraph,
} from "../src/services/tax/workpaper/taxCalculationGraph.js";

test("deduction graph traces confirmed deduction categories to exact source transactions", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: canonicalResult(), workpaper: workpaper() });
  const confirmed = node(graph, "deductions:confirmed_deductible_expenses");
  const materials = node(graph, "deductions:confirmed_deductible_expenses:category:materials");
  const transaction = node(graph, "deductions:confirmed_deductible_expenses:category:materials:transaction:class_materials");

  assert.equal(confirmed.reconciliationStatus, "reconciled");
  assert.equal(materials.amount, 10000);
  assert.equal(materials.reconciliationStatus, "reconciled");
  assert.equal(transaction.amount, 10000);
  assert.equal(transaction.sourceRefs[0].sourceId, "class-materials");
  assert.equal(transaction.sourceRefs[0].snapshotValue.qboTransactionId, "qbo-materials");
  assert.equal(transaction.sourceRefs[0].snapshotValue.qboAccountId, "qbo-materials-account");
  assert.equal(transaction.ruleRefs[0].ruleCode, "materials_ordinary");
});

test("deduction graph traces estimated deductions and excludes needs-review rows from estimated inclusion", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: canonicalResult(), workpaper: workpaper() });
  const estimated = node(graph, "deductions:estimated_deductible_expenses");
  const vehicle = node(graph, "deductions:estimated_deductible_expenses:category:vehicle");

  assert.equal(estimated.reconciliationStatus, "reconciled");
  assert.equal(estimated.reconciliationExpectedAmount, 5000);
  assert.equal(vehicle.amount, 3000);
  assert.equal(graph.nodes.some((item) => item.nodeCode.includes("class_review") && item.nodeCode.startsWith("deductions:estimated_deductible_expenses")), false);
  assert.equal(node(graph, "deductions:items_awaiting_review:category:office").amount, 4000);
});

test("deduction graph persists 50% meals and nondeductible portion formulas", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: canonicalResult(), workpaper: workpaper() });
  const allowed = node(graph, "deductions:partially_deductible_allowed_amount:category:meals:transaction:class_meals");
  const nondeductible = node(graph, "deductions:nondeductible_portion:category:meals:transaction:class_meals");

  assert.equal(allowed.amount, 1000);
  assert.equal(allowed.formulaOperator, "multiply");
  assert.equal(allowed.formulaExpression, "2000 * 0.5");
  assert.equal(allowed.ruleRefs[0].configFieldsUsed.deductiblePercent, 50);
  assert.equal(nondeductible.amount, 1000);
  assert.equal(nondeductible.formulaExpression, "2000 - 1000");
});

test("deduction graph preserves loan principal, owner draw, and transfer exclusions", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: canonicalResult(), workpaper: workpaper() });
  const excluded = node(graph, "deductions:excluded_transfers_owner_activity");

  assert.equal(excluded.reconciliationStatus, "reconciled");
  assert.equal(excluded.reconciliationExpectedAmount, 13500);
  assert.ok(graph.nodes.some((item) => item.nodeCode.includes("class_loan") && item.metadata.categoryCode === "loan_principal"));
  assert.ok(graph.nodes.some((item) => item.nodeCode.includes("class_owner_draw") && item.metadata.categoryCode === "owner_draw"));
  assert.ok(graph.nodes.some((item) => item.nodeCode.includes("class_transfer") && item.metadata.categoryCode === "transfer"));
});

test("deduction graph preserves capitalized equipment separate from current deductible expenses", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: canonicalResult(), workpaper: workpaper() });
  const capitalized = node(graph, "deductions:capitalized_items:category:equipment");
  const equipment = node(graph, "deductions:capitalized_items:category:equipment:transaction:class_equipment");

  assert.equal(capitalized.amount, 8000);
  assert.equal(equipment.amount, 8000);
  assert.equal(equipment.metadata.capitalizableAmount, 8000);
  assert.equal(equipment.metadata.deductibleAmount, 0);
  assert.equal(equipment.ruleRefs[0].ruleCode, "equipment_capitalization");
});

test("deduction graph reproduces projected future deductions and total deductible expenses", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: canonicalResult(), workpaper: workpaper() });
  const future = node(graph, "deductions:projected_future_deductible_expenses");
  const total = node(graph, "deductions:total_deductible_expenses");
  const reproduced = reproduceTaxCalculationGraph({ nodes: graph.nodes });

  assert.equal(future.amount, 18000);
  assert.equal(future.reconciliationStatus, "reconciled");
  assert.equal(node(graph, "deductions:projected_future_deductible_expenses:month:2026-10").amount, 6000);
  assert.equal(total.amount, 35000);
  assert.equal(total.reconciliationStatus, "reconciled");
  assert.equal(reproduced.values["deductions:total_deductible_expenses"], 35000);
});

test("business taxable profit graph reproduces revenue minus deductions plus addbacks and adjustments", () => {
  const graph = buildTaxCalculationGraph({ canonicalResult: canonicalResult(), workpaper: workpaper() });
  const profit = node(graph, "business_taxable_income_bridge:projected_business_taxable_profit");
  const reproduced = reproduceTaxCalculationGraph({ nodes: graph.nodes });

  assert.equal(profit.formulaExpression, "100000 - 35000 + 2500 - 1500");
  assert.equal(profit.reconciliationStatus, "reconciled");
  assert.equal(reproduced.values[profit.nodeCode], 66000);
});

test("deduction graph source and override snapshots remain immutable after reclassification", () => {
  const result = canonicalResult();
  const graph = buildTaxCalculationGraph({ canonicalResult: result, workpaper: workpaper() });
  const transaction = node(graph, "deductions:confirmed_deductible_expenses:category:materials:transaction:class_materials");

  result.actuals.taxableIncome.expenses.sourceItems.included[0].deductibleAmount = 999999;
  result.actuals.taxableIncome.expenses.sourceItems.included[0].newTreatment = "nondeductible";
  result.actuals.taxableIncome.expenses.sourceItems.included[0].qboTransactionId = "changed";

  assert.equal(transaction.amount, 10000);
  assert.equal(transaction.sourceRefs[0].snapshotValue.deductibleAmount, 10000);
  assert.equal(transaction.sourceRefs[0].snapshotValue.newTreatment, "deductible");
  assert.equal(transaction.sourceRefs[0].snapshotValue.qboTransactionId, "qbo-materials");
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
      engineVersions: { taxableIncome: "taxable-income-v1", deductions: "deductions-v1", projection: "projection-v1" },
    },
    profile: { profile: { entity_type: "s_corporation", filing_status: "single", primary_tax_state: "NC" } },
    actuals: {
      taxableIncome: {
        meta: { engineVersion: "taxable-income-v1" },
        expenses: {
          costOfGoodsSold: 0,
          deductibleOperatingExpenses: 17000,
          confirmedDeductibleExpenses: 12000,
          autoClassifiedDeductibleExpenses: 5000,
          nondeductibleBookExpenses: 2500,
          capitalizableExpenditures: 8000,
          needsReviewAmount: 4000,
          balanceSheetActivity: 13500,
          sourceItems: {
            included: [
              deductionItem({ classificationId: "class-materials", taxCategory: "materials", grossAmount: 10000, deductibleAmount: 10000, ruleCode: "materials_ordinary", qboTransactionId: "qbo-materials", qboAccountId: "qbo-materials-account", overrideId: "override-materials", previousTreatment: "needs_review", newTreatment: "deductible" }),
              deductionItem({ classificationId: "class-interest", taxCategory: "interest", grossAmount: 1000, deductibleAmount: 1000, ruleCode: "interest_business", qboTransactionId: "qbo-interest" }),
              deductionItem({ classificationId: "class-meals", taxCategory: "meals", grossAmount: 2000, deductiblePercent: 50, deductibleAmount: 1000, nondeductibleAmount: 1000, ruleCode: "meals_50_percent" }),
              deductionItem({ classificationId: "class-vehicle", taxCategory: "vehicle", grossAmount: 3000, deductibleAmount: 3000, classificationStatus: "auto_classified", confirmationStatus: "auto_classified", confirmed: false, auto: true, treatment: "estimated", confidenceScore: 0.72, classificationMethod: "ml_category_model", ruleCode: "vehicle_business_use" }),
              deductionItem({ classificationId: "class-office", taxCategory: "office", grossAmount: 2000, deductibleAmount: 2000, classificationStatus: "auto_classified", confirmationStatus: "auto_classified", confirmed: false, auto: true, treatment: "estimated", confidenceScore: 0.8, classificationMethod: "rule_match", ruleCode: "office_supplies" }),
              deductionItem({ classificationId: "class-personal", taxCategory: "personal", grossAmount: 1500, deductibleAmount: 0, nondeductibleAmount: 1500, ruleCode: "personal_expense_nondeductible" }),
              deductionItem({ classificationId: "class-equipment", taxCategory: "equipment", grossAmount: 8000, deductibleAmount: 0, capitalizableAmount: 8000, deductibilityStatus: "capitalizable", treatment: "capitalized", ruleCode: "equipment_capitalization" }),
              deductionItem({ classificationId: "class-review", taxCategory: "office", grossAmount: 4000, deductibleAmount: 0, treatment: "needs_review", classificationStatus: "needs_review", confirmationStatus: "needs_review", needsReview: true, reviewStatus: "needs_review" }),
            ],
            excluded: [
              deductionItem({ classificationId: "class-loan", taxCategory: "loan_principal", grossAmount: 7000, deductibleAmount: 0, treatment: "excluded", deductibilityStatus: "balance_sheet", exclusionReason: "loan_principal_excluded" }),
              deductionItem({ classificationId: "class-owner-draw", taxCategory: "owner_draw", grossAmount: 6000, deductibleAmount: 0, treatment: "excluded", deductibilityStatus: "balance_sheet", exclusionReason: "owner_activity_excluded" }),
              deductionItem({ classificationId: "class-transfer", taxCategory: "transfer", grossAmount: 500, deductibleAmount: 0, treatment: "excluded", deductibilityStatus: "balance_sheet", exclusionReason: "transfer_excluded" }),
            ],
          },
        },
        adjustments: {
          increasesToTaxableIncome: 0,
          decreasesToTaxableIncome: 1500,
        },
      },
      deductions: { meta: { engineVersion: "deductions-v1" } },
    },
    projection: {
      method: "trailing_average",
      projectedAnnual: {
        revenue: 100000,
        cogs: 0,
        deductibleExpenses: 35000,
        taxableBusinessIncome: 66000,
      },
      projectedFuture: {
        deductibleExpenses: 18000,
        monthly: {
          "2026-10": { deductibleExpenses: 6000, formulaExpression: "5000 * 1.2", formulaOperator: "multiply", inputValues: [{ code: "monthly_average", amount: 5000 }, { code: "seasonality_factor", amount: 1.2 }] },
          "2026-11": { deductibleExpenses: 6000 },
          "2026-12": { deductibleExpenses: 6000 },
        },
      },
      methodology: { assumptions: ["Projects future expenses from trailing monthly expense activity."] },
    },
  };
}

function deductionItem(overrides = {}) {
  return {
    classificationId: overrides.classificationId,
    classificationVersion: "classification-v1",
    classificationStatus: overrides.classificationStatus || "user_confirmed",
    bankTransactionId: overrides.bankTransactionId || `bank-${overrides.classificationId}`,
    plaidTransactionId: overrides.plaidTransactionId || `plaid-${overrides.classificationId}`,
    qboTransactionId: overrides.qboTransactionId || `qbo-${overrides.classificationId}`,
    qboAccountId: overrides.qboAccountId || `qbo-account-${overrides.taxCategory}`,
    sourceDate: "2026-06-15",
    month: "2026-06",
    grossAmount: overrides.grossAmount,
    deductiblePercent: overrides.deductiblePercent ?? 100,
    deductibleAmount: overrides.deductibleAmount,
    nondeductibleAmount: overrides.nondeductibleAmount || 0,
    capitalizableAmount: overrides.capitalizableAmount || 0,
    taxCategory: overrides.taxCategory,
    deductibilityStatus: overrides.deductibilityStatus || "deductible",
    ruleId: overrides.ruleId || `rule-${overrides.ruleCode}`,
    ruleCode: overrides.ruleCode,
    ruleVersion: overrides.ruleVersion || "deduction-rules-v1",
    confirmationStatus: overrides.confirmationStatus || "user_confirmed",
    confidenceScore: overrides.confidenceScore ?? 0.95,
    classificationMethod: overrides.classificationMethod || "user_confirmed",
    reviewStatus: overrides.reviewStatus || "included",
    overrideId: overrides.overrideId || null,
    overrideVersion: overrides.overrideVersion || null,
    previousTreatment: overrides.previousTreatment || null,
    newTreatment: overrides.newTreatment || null,
    changedBy: overrides.changedBy || null,
    changedAt: overrides.changedAt || null,
    sourceSystem: overrides.sourceSystem || "quickbooks",
    sourceLabel: overrides.classificationId,
    treatment: overrides.treatment || "confirmed",
    exclusionReason: overrides.exclusionReason || null,
    confirmed: overrides.confirmed ?? (overrides.confirmationStatus || "user_confirmed") === "user_confirmed",
    auto: overrides.auto || false,
    needsReview: overrides.needsReview || false,
  };
}

function workpaper() {
  return {
    version: "tax-workpaper-v1",
    lines: [
      line("deductions:confirmed_deductible_expenses", "Confirmed deductible expenses", "deductions", 12000, { status: "confirmed", displaySign: "subtract" }),
      line("deductions:estimated_deductible_expenses", "Estimated deductible expenses", "deductions", 5000, { status: "estimated", displaySign: "subtract" }),
      line("deductions:partially_deductible_gross_amount", "Partially deductible gross amount", "deductions", 2000, { status: "partial" }),
      line("deductions:partially_deductible_allowed_amount", "Partially deductible allowed amount", "deductions", 1000, { status: "partial", displaySign: "subtract" }),
      line("deductions:nondeductible_portion", "Nondeductible portion", "deductions", 2500),
      line("deductions:capitalized_items", "Capitalized expenses", "deductions", 8000, { displaySign: "subtract" }),
      line("deductions:items_awaiting_review", "Items awaiting review", "deductions", 4000, { status: "review_required" }),
      line("deductions:excluded_transfers_owner_activity", "Excluded transfers and owner activity", "deductions", 13500, { status: "excluded" }),
      line("business_taxable_income_bridge:projected_annual_revenue", "Projected annual revenue", "business_taxable_income_bridge", 100000, { parentCode: "business_taxable_income_bridge:projected_business_taxable_profit", sourceRefs: [source("annual-income", 100000)] }),
      line("business_taxable_income_bridge:deductible_expenses", "Deductible expenses", "business_taxable_income_bridge", 35000, { parentCode: "business_taxable_income_bridge:projected_business_taxable_profit", displaySign: "subtract" }),
      line("business_taxable_income_bridge:nondeductible_addbacks", "Nondeductible addbacks", "business_taxable_income_bridge", 2500, { parentCode: "business_taxable_income_bridge:projected_business_taxable_profit", displaySign: "add" }),
      line("business_taxable_income_bridge:other_tax_adjustments", "Other tax adjustments", "business_taxable_income_bridge", -1500, { parentCode: "business_taxable_income_bridge:projected_business_taxable_profit", displaySign: "add" }),
      line("business_taxable_income_bridge:projected_business_taxable_profit", "Projected business taxable profit", "business_taxable_income_bridge", 66000, { formulaCode: "annual_revenue_minus_deductions_plus_addbacks_adjustments" }),
    ],
  };
}

function line(code, label, section, amount, overrides = {}) {
  return {
    code,
    label,
    section,
    parent_code: overrides.parentCode || null,
    amount,
    sort_order: 10,
    display_sign: overrides.displaySign || null,
    status: overrides.status || "calculated",
    support_level: "supported",
    confidence: 0.9,
    formula_code: overrides.formulaCode || null,
    formula_description: `${label} calculation from graph source nodes.`,
    explanation: `${label} calculation from graph source nodes.`,
    source_refs: overrides.sourceRefs || [],
    rule_refs: overrides.ruleRefs || [],
    rule_versions: {},
    metadata: { materiality: "high" },
  };
}

function source(id, amount) {
  return {
    type: "calculation_input_snapshot",
    id,
    amount,
    field: id,
    snapshotValue: amount,
  };
}
