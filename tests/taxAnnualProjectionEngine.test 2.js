import test from "node:test";
import assert from "node:assert/strict";

import { projectAnnualTaxableIncome } from "../src/services/tax/projection/annualProjectionEngine.js";
import { mergeActualAndProjectedMonths } from "../src/services/tax/projection/taxProjectionUtils.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "99999999-9999-4999-8999-999999999999";

test("actual-only does not create future income", async () => {
  const result = await projectAnnualTaxableIncome({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-06-30",
    method: "actual_only",
  });
  assert.equal(result.projectedFuture.revenue, 0);
  assert.equal(result.projectedAnnual.revenue, 600);
  assert.equal(result.projectedAnnual.taxableBusinessIncome, 300);
  assert.equal(result.meta.engineVersion, "tax-projection-v1");
});

test("annualized run rate projects after valid elapsed period and does not calculate tax", async () => {
  const result = await projectAnnualTaxableIncome({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-06-30",
    method: "annualized_run_rate",
  });
  assert.equal(result.projectedAnnual.revenue, 1200);
  assert.equal(result.projectedAnnual.taxableBusinessIncome, 600);
  assert.ok(!("federalTax" in result.projectedAnnual));
  assert.ok(!("stateTax" in result.projectedAnnual));
});

test("actual months override forecast months and partial current month is handled once", () => {
  const merged = mergeActualAndProjectedMonths({
    taxYear: 2026,
    asOfDate: "2026-06-15",
    actualMonthly: { "2026-06": { revenue: 100, cogs: 20, deductibleExpenses: 30, taxableBusinessIncome: 50 } },
    projectedMonthly: {
      "2026-05": { revenue: 999, cogs: 0, deductibleExpenses: 0, taxableBusinessIncome: 999 },
      "2026-06": { revenue: 300, cogs: 60, deductibleExpenses: 90, taxableBusinessIncome: 150 },
      "2026-07": { revenue: 400, cogs: 80, deductibleExpenses: 120, taxableBusinessIncome: 200 },
    },
  });
  assert.equal(merged.monthly["2026-05"].revenue, 0);
  assert.equal(merged.monthly["2026-06"].revenue, 250);
  assert.equal(merged.monthly["2026-06"].partial, true);
  assert.equal(merged.monthly["2026-07"].revenue, 400);
  assert.equal(Object.keys(merged.monthly).length, 12);
});

test("future forecast is excluded from actual YTD and cashflow forecast projects future only", async () => {
  const result = await projectAnnualTaxableIncome({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-06-30",
    method: "cashflow_forecast",
  });
  assert.equal(result.actual.revenue, 600);
  assert.equal(result.projectedFuture.revenue, 600);
  assert.equal(result.projectedAnnual.revenue, 1200);
  assert.ok(result.warnings.some((warning) => warning.code === "forecast_actual_overlap"));
});

test("prior-year seasonality uses comparable months and blended weights sum to 1", async () => {
  const supabase = makeSupabase(baseStore());
  const seasonal = await projectAnnualTaxableIncome({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-06-30",
    method: "prior_year_seasonality",
  });
  assert.equal(seasonal.projectedAnnual.revenue, 1200);

  const blended = await projectAnnualTaxableIncome({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-06-30",
    method: "blended",
  });
  const weightSum = Object.values(blended.methodology.weights).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(weightSum - 1) < 0.02);
  assert.ok(blended.methodology.methodsUsed.length >= 2);
});

test("missing source weight is redistributed deterministically and lowers confidence", async () => {
  const store = baseStore({ cashflow_forecast: [], monthly_forecast: [], transaction_tax_classifications: currentYearClassifications() });
  const result = await projectAnnualTaxableIncome({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-06-30",
    method: "blended",
  });
  const weightSum = Object.values(result.methodology.weights).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(weightSum - 1) < 0.02);
  assert.ok(result.warnings.some((warning) => warning.code === "insufficient_history" || warning.code === "seasonality_unavailable"));
  assert.notEqual(result.confidence.level, "high");
});

test("manual override preserves original projection and returns override impact", async () => {
  const result = await projectAnnualTaxableIncome({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-06-30",
    method: "blended",
    manualOverrides: {
      reason: "Known signed backlog.",
      annual: { revenue: 1500, cogs: 300, deductibleExpenses: 400 },
    },
  });
  assert.equal(result.projectedAnnual.taxableBusinessIncome, 800);
  assert.ok(result.methodology.sourceInputs.originalProjection);
  assert.equal(result.methodology.sourceInputs.overrideImpact.taxableBusinessIncome, 200);
  assert.ok(result.warnings.some((warning) => warning.code === "projection_override_used"));
});

test("range widens with needs-review exposure, negative projections are preserved, and business/year isolation holds", async () => {
  const store = baseStore({
    bank_transactions: [
      ...baseBankTransactions(2026, { revenue: 50, cogs: 0, expense: 200 }),
      bankTxn({ id: "review-2026-01", date: "2026-01-20", signed_amount: -500, direction: "OUTFLOW" }),
      bankTxn({ id: "other-business", business_id: OTHER_BUSINESS_ID, signed_amount: 9999, direction: "INFLOW" }),
    ],
    transaction_categorizations: [
      ...baseBankTransactions(2026, { revenue: 50, cogs: 0, expense: 200 }).map((row) => cat({ transaction_id: row.id })),
      cat({ transaction_id: "review-2026-01" }),
      cat({ business_id: OTHER_BUSINESS_ID, transaction_id: "other-business" }),
    ],
    transaction_tax_classifications: [
      ...monthlyClassifications(2026, { revenue: 50, cogs: 0, expense: 200 }),
      classification({ id: "c-review", transaction_id: "review-2026-01", book_amount: -500, deductible_amount: 500, tax_category: "unclassified", deductibility_status: "needs_review", classification_status: "needs_review", requires_review: true }),
      classification({ id: "c-other-business", business_id: OTHER_BUSINESS_ID, transaction_id: "other-business", book_amount: 9999, tax_category: "income" }),
    ],
    cashflow_forecast: [],
    financial_metrics: [],
  });
  const result = await projectAnnualTaxableIncome({ supabase: makeSupabase(store), businessId: BUSINESS_ID, taxYear: 2026, asOfDate: "2026-06-30", method: "annualized_run_rate" });
  assert.ok(result.projectedAnnual.taxableBusinessIncome < 0);
  assert.ok(result.range.taxableIncomeHigh > result.range.taxableIncomeLow);
  assert.ok(result.warnings.some((warning) => warning.code === "negative_projection"));
});

function baseStore(overrides = {}) {
  const bank = [
    ...baseBankTransactions(2026),
    ...baseBankTransactions(2025),
    ...baseBankTransactions(2024),
  ];
  return {
    bank_transactions: bank,
    transaction_categorizations: bank.map((row) => cat({ business_id: row.business_id, transaction_id: row.id })),
    qbo_posted_transactions: [],
    transaction_tax_classifications: [
      ...monthlyClassifications(2026),
      ...monthlyClassifications(2025),
      ...monthlyClassifications(2024),
    ],
    tax_adjustments: [],
    tax_profiles: [taxProfile(2026), taxProfile(2025), taxProfile(2024)],
    tax_profile_memory: [],
    financial_metrics: [
      { business_id: BUSINESS_ID, month: "2026-06", revenue: 600 },
      { business_id: BUSINESS_ID, month: "2025-12", revenue: 1200 },
    ],
    cashflow_forecast: [
      { business_id: BUSINESS_ID, month: "2026-05", revenue: 999, expenses: 100, updated_at: "2026-01-01T00:00:00Z" },
      { business_id: BUSINESS_ID, month: "2026-07", revenue: 100, expenses: 50, updated_at: "2026-06-01T00:00:00Z" },
      { business_id: BUSINESS_ID, month: "2026-08", revenue: 100, expenses: 50, updated_at: "2026-06-01T00:00:00Z" },
      { business_id: BUSINESS_ID, month: "2026-09", revenue: 100, expenses: 50, updated_at: "2026-06-01T00:00:00Z" },
      { business_id: BUSINESS_ID, month: "2026-10", revenue: 100, expenses: 50, updated_at: "2026-06-01T00:00:00Z" },
      { business_id: BUSINESS_ID, month: "2026-11", revenue: 100, expenses: 50, updated_at: "2026-06-01T00:00:00Z" },
      { business_id: BUSINESS_ID, month: "2026-12", revenue: 100, expenses: 50, updated_at: "2026-06-01T00:00:00Z" },
    ],
    monthly_forecast: [],
    ...overrides,
  };
}

function currentYearClassifications() {
  return monthlyClassifications(2026);
}

function baseBankTransactions(year, amounts = { revenue: 100, cogs: 20, expense: 30 }) {
  const rows = [];
  for (let month = 1; month <= 12; month += 1) {
    const mm = String(month).padStart(2, "0");
    rows.push(bankTxn({ id: `rev-${year}-${mm}`, date: `${year}-${mm}-10`, signed_amount: amounts.revenue, direction: "INFLOW" }));
    rows.push(bankTxn({ id: `cogs-${year}-${mm}`, date: `${year}-${mm}-11`, signed_amount: -amounts.cogs, direction: "OUTFLOW" }));
    rows.push(bankTxn({ id: `exp-${year}-${mm}`, date: `${year}-${mm}-12`, signed_amount: -amounts.expense, direction: "OUTFLOW" }));
  }
  return rows;
}

function monthlyClassifications(year, amounts = { revenue: 100, cogs: 20, expense: 30 }) {
  const rows = [];
  for (let month = 1; month <= 12; month += 1) {
    const mm = String(month).padStart(2, "0");
    rows.push(classification({ id: `c-rev-${year}-${mm}`, transaction_id: `rev-${year}-${mm}`, tax_year: year, transaction_date: `${year}-${mm}-10`, book_amount: amounts.revenue, tax_category: "income", deductible_amount: 0 }));
    rows.push(classification({ id: `c-cogs-${year}-${mm}`, transaction_id: `cogs-${year}-${mm}`, tax_year: year, transaction_date: `${year}-${mm}-11`, book_amount: -amounts.cogs, deductible_amount: amounts.cogs, tax_category: "cost_of_goods_sold", classification_status: "user_confirmed" }));
    rows.push(classification({ id: `c-exp-${year}-${mm}`, transaction_id: `exp-${year}-${mm}`, tax_year: year, transaction_date: `${year}-${mm}-12`, book_amount: -amounts.expense, deductible_amount: amounts.expense, tax_category: "office_expense" }));
  }
  return rows;
}

function bankTxn(overrides = {}) {
  return {
    id: "txn",
    business_id: BUSINESS_ID,
    pending: false,
    date: "2026-01-01",
    name: "Txn",
    merchant_name: "Merchant",
    signed_amount: 100,
    direction: "INFLOW",
    is_archived: false,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function cat(overrides = {}) {
  return {
    business_id: BUSINESS_ID,
    transaction_id: "txn",
    status: "posted",
    qbo_txn_id: "qbo",
    qbo_txn_type: "Expense",
    posted_at: "2026-01-02T00:00:00Z",
    meta: {},
    ...overrides,
  };
}

function classification(overrides = {}) {
  return {
    id: "c",
    business_id: BUSINESS_ID,
    transaction_id: "txn",
    tax_year: 2026,
    transaction_date: "2026-01-01",
    tax_category: "income",
    deductibility_status: "fully_deductible",
    deductible_percent: 100,
    book_amount: 100,
    deductible_amount: 0,
    nondeductible_amount: 0,
    capitalizable_amount: 0,
    tax_treatment: { type: "ordinary" },
    classification_status: "auto_classified",
    confidence_score: 90,
    confidence_level: "high",
    requires_review: false,
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function taxProfile(year) {
  return {
    id: `profile-${year}`,
    business_id: BUSINESS_ID,
    tax_year: year,
    entity_type: "single_member_llc",
    tax_election: "disregarded_entity",
    filing_status: "single",
    primary_tax_state: "NC",
    accounting_method: "cash",
    safe_harbor_method: "current_year_90",
    self_employment_tax_applies: true,
    qbi_eligible: true,
    profile_status: "active",
    reserve_buffer_percent: 10,
    metadata: {},
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
  in(field, values) {
    const set = new Set(values.map(String));
    this.rows = this.rows.filter((row) => set.has(String(row[field])));
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
  is(field, value) {
    this.rows = this.rows.filter((row) => row[field] === value);
    return this;
  }
  or() { return this; }
  order() { return this; }
  limit(n) {
    this.rows = this.rows.slice(0, n);
    return this;
  }
  range(start, end) {
    this.rows = this.rows.slice(start, end + 1);
    return this;
  }
  maybeSingle() {
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  then(resolve) {
    return Promise.resolve({ data: this.rows, error: null }).then(resolve);
  }
}
