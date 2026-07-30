import test from "node:test";
import assert from "node:assert/strict";

import {
  THROUGH_DATE_RULE_TREATMENT_REGISTRY,
  THROUGH_DATE_TAX_METHODS,
  computeTaxAttributableThroughDate,
  buildTaxTrajectoryPoints,
} from "../src/services/tax/throughDate/throughDateTaxAttribution.js";

test("linear income case attributes tax by actual taxable-income share with direct SE component", () => {
  const result = computeTaxAttributableThroughDate(baseCase());

  assert.equal(result.methodCode, THROUGH_DATE_TAX_METHODS.ANNUALIZED_ACTUAL_YTD);
  assert.equal(result.actualYtdTaxableIncomeBase, 50000);
  assert.equal(result.projectedAnnualTaxableIncomeBase, 100000);
  assert.equal(result.allocationPercentage, 0.5);
  assert.equal(component(result.directlyCalculatedComponents, "self_employment_tax").amount, 7064.78);
  assert.equal(component(result.allocatedComponents, "federal_income_tax").amount, 5000);
  assert.equal(component(result.allocatedComponents, "state_individual_income_tax").amount, 2500);
  assert.equal(result.amount, 14564.78);
});

test("highly seasonal income attributes current activity by taxable-income share, not elapsed time", () => {
  const result = computeTaxAttributableThroughDate(baseCase({
    actualTaxableIncome: 90000,
    annualTaxableIncome: 120000,
    projectedTotalTax: 36000,
    federalIncomeTax: 20000,
    stateTax: 6000,
    seTax: seTax({ annual: 10000 }),
  }));

  assert.equal(result.allocationPercentage, 0.75);
  assert.equal(result.amount > 27000, true);
  assert.notEqual(result.methodCode, THROUGH_DATE_TAX_METHODS.ELAPSED_TIME);
});

test("loss in early months produces zero attributable tax without converting unavailable values to zero", () => {
  const result = computeTaxAttributableThroughDate(baseCase({
    actualTaxableIncome: -10000,
    annualTaxableIncome: 100000,
  }));

  assert.equal(result.allocationPercentage, 0);
  assert.equal(result.amount, 0);
  assert.equal(result.methodCode, THROUGH_DATE_TAX_METHODS.ANNUALIZED_ACTUAL_YTD);
});

test("S-Corp owner wages and entity payroll context are allocated without self-employment tax", () => {
  const result = computeTaxAttributableThroughDate(baseCase({
    selfEmploymentTax: null,
    sCorp: { payroll: { payrollTaxAmount: 7200 } },
    federalIncomeTax: 18000,
    stateTax: 5000,
    projectedTotalTax: 30200,
  }));

  assert.equal(result.methodCode, THROUGH_DATE_TAX_METHODS.TAXABLE_INCOME_SHARE);
  assert.equal(result.directlyCalculatedComponents.length, 0);
  assert.equal(component(result.allocatedComponents, "entity_level_tax").amount, 3600);
  assert.ok(result.limitations.some((item) => item.includes("No directly calculated")));
});

test("self-employment wage base caps Social Security tax for high YTD earnings", () => {
  const result = computeTaxAttributableThroughDate(baseCase({
    actualTaxableIncome: 300000,
    annualTaxableIncome: 400000,
    seTax: seTax({ annual: 30000, wageBase: 160200 }),
  }));
  const se = component(result.directlyCalculatedComponents, "self_employment_tax");

  assert.equal(se.metadata.wageBase, 160200);
  assert.equal(se.metadata.socialSecurityTax, 19864.8);
  assert.equal(se.amount < 300000 * 0.9235 * 0.153, true);
});

test("progressive federal brackets and annual deduction treatment are registered explicitly", () => {
  assert.equal(THROUGH_DATE_RULE_TREATMENT_REGISTRY.progressive_brackets.treatment, "annualized_using_projected_annual_income");
  assert.equal(THROUGH_DATE_RULE_TREATMENT_REGISTRY.standard_deductions.treatment, "applied_fully");
  assert.equal(THROUGH_DATE_RULE_TREATMENT_REGISTRY.tax_credits.treatment, "allocated_by_actual_ytd_share");
});

test("state flat and progressive taxes are attributed as annual components with explicit treatment", () => {
  const flat = computeTaxAttributableThroughDate(baseCase({ stateTax: 5000 }));
  const progressive = computeTaxAttributableThroughDate(baseCase({
    stateTax: 9000,
    stateIncomeTax: { tax: { regularStateIncomeTax: 9000, kind: "progressive" } },
  }));

  assert.equal(component(flat.allocatedComponents, "state_individual_income_tax").treatment, "allocated_by_actual_ytd_share");
  assert.equal(component(progressive.allocatedComponents, "state_individual_income_tax").treatment, "annualized_using_projected_annual_income");
});

test("entity minimum tax is allocated by YTD taxable-income share", () => {
  const result = computeTaxAttributableThroughDate(baseCase({
    stateIncomeTax: { tax: { regularStateIncomeTax: 5000, sCorpMinimumTax: 800 } },
  }));

  assert.equal(component(result.allocatedComponents, "entity_minimum_tax").amount, 400);
  assert.equal(component(result.allocatedComponents, "entity_minimum_tax").treatment, "allocated_by_actual_ytd_share");
});

test("missing projection data returns unavailable instead of elapsed-time allocation", () => {
  const result = computeTaxAttributableThroughDate(baseCase({
    annualTaxableIncome: null,
  }));

  assert.equal(result.methodCode, THROUGH_DATE_TAX_METHODS.UNAVAILABLE);
  assert.equal(result.amount, null);
  assert.equal(result.allocationPercentage, null);
  assert.equal(result.methodCode === THROUGH_DATE_TAX_METHODS.ELAPSED_TIME, false);
});

test("fallback method uses taxable-income share when no direct YTD components are available", () => {
  const result = computeTaxAttributableThroughDate(baseCase({
    selfEmploymentTax: null,
    projectedTotalTax: 30000,
    federalIncomeTax: 20000,
    stateTax: 10000,
  }));

  assert.equal(result.methodCode, THROUGH_DATE_TAX_METHODS.TAXABLE_INCOME_SHARE);
  assert.equal(result.amount, 15000);
  assert.equal(result.limitations.some((item) => item.includes("No directly calculated")), true);
});

test("new canonical trajectory points expose source type, method, confidence, and workpaper links", () => {
  const canonical = {
    meta: { taxYear: 2026, asOfDate: "2026-07-19", runId: "run-1", sourceFreshness: { books: "fresh" } },
    liability: {
      projectedTotalTax: 30000,
      paymentsAndWithholdingYtd: 1200,
      taxAttributableThroughToday: computeTaxAttributableThroughDate(baseCase({ projectedTotalTax: 30000 })),
    },
    projection: {
      projectedAnnual: {
        monthly: {
          "2026-01": { taxableBusinessIncome: 10000 },
          "2026-02": { taxableBusinessIncome: 10000 },
          "2026-07": { taxableBusinessIncome: 10000 },
        },
      },
    },
    confidence: { level: "medium" },
    warnings: [],
  };
  const points = buildTaxTrajectoryPoints({ canonical });

  assert.equal(points.length, 12);
  assert.equal(points.find((point) => point.month === "2026-06").periodType, "modeled_reconstructed");
  assert.equal(points.find((point) => point.month === "2026-07").pointType, "current_partial_period");
  assert.equal(points.find((point) => point.month === "2026-08").pointType, "projected_future_period");
  assert.equal(points.find((point) => point.month === "2026-07").method, THROUGH_DATE_TAX_METHODS.ANNUALIZED_ACTUAL_YTD);
  assert.equal(points.find((point) => point.month === "2026-07").workpaperDeepLink, "/api/tax/calculations/run-1/workpaper?section=through_date_tax");
});

function baseCase(overrides = {}) {
  const stateIncomeTax = overrides.stateIncomeTax || { tax: { regularStateIncomeTax: overrides.stateTax ?? 5000 } };
  return {
    taxYear: 2026,
    asOfDate: "2026-07-19",
    projection: {
      actual: { taxableBusinessIncome: overrides.actualTaxableIncome ?? 50000 },
      projectedAnnual: { taxableBusinessIncome: overrides.annualTaxableIncome === undefined ? 100000 : overrides.annualTaxableIncome },
    },
    taxableIncome: {
      businessTaxableIncome: { finalBusinessTaxableIncome: overrides.actualTaxableIncome ?? 50000 },
    },
    federal: {
      incomeTax: {
        income: { qbiDeduction: 0 },
        tax: { federalIncomeTax: overrides.federalIncomeTax ?? 10000 },
      },
    },
    selfEmploymentTax: overrides.selfEmploymentTax === undefined ? seTax({ annual: 15300 }) : overrides.selfEmploymentTax,
    sCorp: overrides.sCorp || null,
    state: {
      incomeTax: stateIncomeTax,
      individualIncomeTax: { amount: overrides.stateTax ?? stateIncomeTax.tax?.regularStateIncomeTax ?? 5000 },
    },
    projectedTotalTax: overrides.projectedTotalTax ?? 30300,
  };
}

function seTax({ annual = 15300, wageBase = 160200 } = {}) {
  return {
    result: { totalSelfEmploymentTax: annual },
    detail: {
      socialSecurity: { rate: 0.124, wageBase },
      medicare: { rate: 0.029 },
      additionalMedicare: { rate: 0.009, threshold: 200000 },
    },
  };
}

function component(components, code) {
  const found = components.find((row) => row.code === code);
  assert.ok(found, `missing component ${code}`);
  return found;
}
