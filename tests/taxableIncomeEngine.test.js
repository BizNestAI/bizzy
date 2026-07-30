import test from "node:test";
import assert from "node:assert/strict";

import { computeTaxableIncome } from "../src/services/tax/taxableIncome/taxableIncomeEngine.js";
import { getTaxRevenueSummary } from "../src/services/tax/taxableIncome/taxRevenueSource.service.js";
import { getTaxExpenseSummary } from "../src/services/tax/taxableIncome/taxExpenseSource.service.js";
import { listTaxAdjustments, summarizeTaxAdjustments } from "../src/services/tax/taxAdjustment.service.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "99999999-9999-4999-8999-999999999999";

test("revenue includes true income and excludes owner contributions, loan proceeds, and transfers", async () => {
  const revenue = await getTaxRevenueSummary({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
  });
  assert.equal(revenue.grossReceipts, 1000);
  assert.equal(revenue.otherBusinessIncome, 50);
  assert.equal(revenue.returnsAndAllowances, 100);
  assert.equal(revenue.netBusinessRevenue, 950);
  assert.equal(revenue.reconciliation.financialMetricsRevenue, 1200);
  assert.equal(revenue.reconciliation.status, "difference_found");
});

test("missing income classification creates warning and financial_metrics is reconciliation only", async () => {
  const store = baseStore({
    bank_transactions: [bankTxn({ id: "unclassified-income", signed_amount: 400, direction: "INFLOW" })],
    transaction_categorizations: [cat({ transaction_id: "unclassified-income" })],
    transaction_tax_classifications: [
      classification({ id: "c-unclassified-income", transaction_id: "unclassified-income", book_amount: 400, tax_category: "unclassified", classification_status: "needs_review", requires_review: true }),
    ],
    financial_metrics: [{ business_id: BUSINESS_ID, month: "2026-01", revenue: 400 }],
  });
  const revenue = await getTaxRevenueSummary({ supabase: makeSupabase(store), businessId: BUSINESS_ID, taxYear: 2026 });
  assert.equal(revenue.netBusinessRevenue, 0);
  assert.ok(revenue.warnings.some((warning) => warning.code === "unsupported_income_source"));
  assert.equal(revenue.reconciliation.financialMetricsRevenue, 400);
});

test("expenses separate COGS, deductible, nondeductible, capitalizable, review, and income", async () => {
  const expenses = await getTaxExpenseSummary({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
  });
  assert.equal(expenses.costOfGoodsSold, 200);
  assert.equal(expenses.deductibleOperatingExpenses, 100);
  assert.equal(expenses.estimatedDeductibleExpenses, 300);
  assert.equal(expenses.confirmedDeductibleExpenses, 200);
  assert.equal(expenses.nondeductibleBookExpenses, 80);
  assert.equal(expenses.capitalizableExpenditures, 300);
  assert.equal(expenses.balanceSheetActivity, 400);
  assert.equal(expenses.needsReviewAmount, 60);
});

test("adjustments summarize taxable-income directions and exclude archived/future rows", async () => {
  const supabase = makeSupabase(baseStore());
  const rows = await listTaxAdjustments({ supabase, businessId: BUSINESS_ID, taxYear: 2026, asOfDate: "2026-06-30" });
  assert.equal(rows.length, 3);
  const summary = await summarizeTaxAdjustments({ supabase, businessId: BUSINESS_ID, taxYear: 2026, asOfDate: "2026-06-30" });
  assert.equal(summary.increasesToTaxableIncome, 50);
  assert.equal(summary.decreasesToTaxableIncome, 25);
  assert.equal(summary.increasesToTax, 10);
  assert.equal(summary.decreasesToTax, 0);
});

test("engine computes taxable business income without final tax math and preserves estimated vs confirmed", async () => {
  const result = await computeTaxableIncome({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-06-30",
  });
  assert.equal(result.revenue.netBusinessRevenue, 950);
  assert.equal(result.expenses.grossProfit, 750);
  assert.equal(result.businessTaxableIncome.beforeAdjustments, 650);
  assert.equal(result.adjustments.increasesToTaxableIncome, 50);
  assert.equal(result.adjustments.decreasesToTaxableIncome, 25);
  assert.equal(result.businessTaxableIncome.finalBusinessTaxableIncome, 675);
  assert.equal(result.businessTaxableIncome.estimatedBusinessTaxableIncome, 675);
  assert.equal(result.businessTaxableIncome.confirmedBusinessTaxableIncome, 775);
  assert.ok(!result.components.some((component) => ["qbi_deduction", "half_self_employment_tax_adjustment"].includes(component.componentType) && component.amount !== 0));
});

test("negative taxable income is preserved and business/year/asOfDate isolation is enforced", async () => {
  const store = baseStore({
    bank_transactions: [
      bankTxn({ id: "small-income", signed_amount: 100, direction: "INFLOW" }),
      bankTxn({ id: "large-expense", signed_amount: -500, direction: "OUTFLOW" }),
      bankTxn({ id: "future-expense", date: "2026-12-01", signed_amount: -999, direction: "OUTFLOW" }),
      bankTxn({ id: "other-business-income", business_id: OTHER_BUSINESS_ID, signed_amount: 9999, direction: "INFLOW" }),
      bankTxn({ id: "prior-year-income", date: "2025-01-01", signed_amount: 9999, direction: "INFLOW" }),
    ],
    transaction_categorizations: [
      cat({ transaction_id: "small-income" }),
      cat({ transaction_id: "large-expense" }),
      cat({ transaction_id: "future-expense" }),
      cat({ business_id: OTHER_BUSINESS_ID, transaction_id: "other-business-income" }),
      cat({ transaction_id: "prior-year-income" }),
    ],
    transaction_tax_classifications: [
      classification({ id: "c-small-income", transaction_id: "small-income", book_amount: 100, tax_category: "income", classification_status: "auto_classified" }),
      classification({ id: "c-large-expense", transaction_id: "large-expense", book_amount: -500, deductible_amount: 500, tax_category: "office_expense", classification_status: "auto_classified" }),
      classification({ id: "c-future-expense", transaction_id: "future-expense", transaction_date: "2026-12-01", book_amount: -999, deductible_amount: 999, tax_category: "office_expense", classification_status: "auto_classified" }),
      classification({ id: "c-other-business", business_id: OTHER_BUSINESS_ID, transaction_id: "other-business-income", book_amount: 9999, tax_category: "income", classification_status: "auto_classified" }),
      classification({ id: "c-prior-year", transaction_id: "prior-year-income", tax_year: 2025, transaction_date: "2025-01-01", book_amount: 9999, tax_category: "income", classification_status: "auto_classified" }),
    ],
    tax_adjustments: [],
    financial_metrics: [],
  });
  const result = await computeTaxableIncome({ supabase: makeSupabase(store), businessId: BUSINESS_ID, taxYear: 2026, asOfDate: "2026-06-30" });
  assert.equal(result.businessTaxableIncome.finalBusinessTaxableIncome, -400);
  assert.ok(result.warnings.some((warning) => warning.code === "negative_income"));
  assert.ok(result.warnings.some((warning) => warning.code === "future_data_excluded"));
});

test("repeat calculation is deterministic for monetary outputs", async () => {
  const supabase = makeSupabase(baseStore());
  const first = await computeTaxableIncome({ supabase, businessId: BUSINESS_ID, taxYear: 2026, asOfDate: "2026-06-30" });
  const second = await computeTaxableIncome({ supabase, businessId: BUSINESS_ID, taxYear: 2026, asOfDate: "2026-06-30" });
  assert.deepEqual(first.revenue, second.revenue);
  assert.deepEqual(first.expenses, second.expenses);
  assert.deepEqual(first.adjustments, second.adjustments);
  assert.deepEqual(first.businessTaxableIncome, second.businessTaxableIncome);
});

function baseStore(overrides = {}) {
  const bank = [
    bankTxn({ id: "income", signed_amount: 1000, direction: "INFLOW" }),
    bankTxn({ id: "other-income", signed_amount: 50, direction: "INFLOW" }),
    bankTxn({ id: "returns", signed_amount: 100, direction: "INFLOW" }),
    bankTxn({ id: "owner-contribution", signed_amount: 500, direction: "INFLOW" }),
    bankTxn({ id: "loan-proceeds", signed_amount: 700, direction: "INFLOW" }),
    bankTxn({ id: "transfer", signed_amount: 800, direction: "INFLOW" }),
    bankTxn({ id: "cogs", signed_amount: -200, direction: "OUTFLOW" }),
    bankTxn({ id: "operating-auto", signed_amount: -100, direction: "OUTFLOW" }),
    bankTxn({ id: "nondeductible", signed_amount: -80, direction: "OUTFLOW" }),
    bankTxn({ id: "capital", signed_amount: -300, direction: "OUTFLOW" }),
    bankTxn({ id: "balance", signed_amount: -400, direction: "OUTFLOW" }),
    bankTxn({ id: "review", signed_amount: -60, direction: "OUTFLOW" }),
  ];
  const classifications = [
    classification({ id: "c-income", transaction_id: "income", book_amount: 1000, tax_category: "income", classification_status: "auto_classified" }),
    classification({ id: "c-other-income", transaction_id: "other-income", book_amount: 50, tax_category: "other_business_income", classification_status: "user_confirmed" }),
    classification({ id: "c-returns", transaction_id: "returns", book_amount: 100, tax_category: "returns_allowances", tax_treatment: { type: "returns_allowances" }, classification_status: "user_confirmed" }),
    classification({ id: "c-owner-contribution", transaction_id: "owner-contribution", book_amount: 500, tax_category: "owner_contribution", deductibility_status: "balance_sheet", classification_status: "auto_classified" }),
    classification({ id: "c-loan-proceeds", transaction_id: "loan-proceeds", book_amount: 700, tax_category: "loan_principal", deductibility_status: "balance_sheet", classification_status: "auto_classified" }),
    classification({ id: "c-transfer", transaction_id: "transfer", book_amount: 800, tax_category: "transfer", deductibility_status: "balance_sheet", classification_status: "auto_classified" }),
    classification({ id: "c-cogs", transaction_id: "cogs", book_amount: -200, deductible_amount: 200, tax_category: "cost_of_goods_sold", classification_status: "user_confirmed" }),
    classification({ id: "c-operating-auto", transaction_id: "operating-auto", book_amount: -100, deductible_amount: 100, tax_category: "office_expense", classification_status: "auto_classified" }),
    classification({ id: "c-nondeductible", transaction_id: "nondeductible", book_amount: -80, deductible_amount: 0, nondeductible_amount: 80, tax_category: "penalties_fines", deductibility_status: "nondeductible", classification_status: "user_confirmed" }),
    classification({ id: "c-capital", transaction_id: "capital", book_amount: -300, deductible_amount: 0, capitalizable_amount: 300, tax_category: "equipment_asset", deductibility_status: "capitalizable", classification_status: "user_confirmed" }),
    classification({ id: "c-balance", transaction_id: "balance", book_amount: -400, deductible_amount: 0, tax_category: "transfer", deductibility_status: "balance_sheet", classification_status: "auto_classified" }),
    classification({ id: "c-review", transaction_id: "review", book_amount: -60, deductible_amount: 60, tax_category: "unclassified", deductibility_status: "needs_review", classification_status: "needs_review", requires_review: true }),
  ];
  return {
    bank_transactions: bank,
    transaction_categorizations: bank.map((row) => cat({ business_id: row.business_id, transaction_id: row.id })),
    qbo_posted_transactions: [],
    transaction_tax_classifications: classifications,
    tax_adjustments: [
      adjustment({ id: "addback", direction: "increase_taxable_income", amount: 50, adjustment_type: "book_depreciation_addback" }),
      adjustment({ id: "decrease", direction: "decrease_taxable_income", amount: 25, adjustment_type: "home_office_deduction" }),
      adjustment({ id: "tax-only", direction: "increase_tax", amount: 10, adjustment_type: "tax_only_penalty" }),
      adjustment({ id: "future", direction: "increase_taxable_income", amount: 999, effective_date: "2026-12-31" }),
      adjustment({ id: "archived", direction: "increase_taxable_income", amount: 999, status: "archived" }),
    ],
    tax_profiles: [taxProfile()],
    tax_profile_memory: [],
    financial_metrics: [{ business_id: BUSINESS_ID, month: "2026-06", revenue: 1200 }],
    ...overrides,
  };
}

function bankTxn(overrides = {}) {
  return {
    id: "txn-1",
    business_id: BUSINESS_ID,
    pending: false,
    date: "2026-03-15",
    name: "Transaction",
    merchant_name: "Merchant",
    signed_amount: -100,
    direction: "OUTFLOW",
    is_archived: false,
    created_at: "2026-03-15T00:00:00Z",
    ...overrides,
  };
}

function cat(overrides = {}) {
  return {
    business_id: BUSINESS_ID,
    transaction_id: "txn-1",
    status: "posted",
    qbo_txn_id: "qbo-1",
    qbo_txn_type: "Expense",
    posted_at: "2026-03-16T00:00:00Z",
    meta: {},
    ...overrides,
  };
}

function classification(overrides = {}) {
  return {
    id: "c-1",
    business_id: BUSINESS_ID,
    transaction_id: "txn-1",
    tax_year: 2026,
    transaction_date: "2026-03-15",
    tax_category: "office_expense",
    deductibility_status: "fully_deductible",
    deductible_percent: 100,
    book_amount: -100,
    deductible_amount: 100,
    nondeductible_amount: 0,
    capitalizable_amount: 0,
    tax_treatment: { type: "ordinary_expense" },
    classification_status: "auto_classified",
    confidence_score: 90,
    confidence_level: "high",
    requires_review: false,
    metadata: { direction: "OUTFLOW" },
    created_at: "2026-03-15T00:00:00Z",
    updated_at: "2026-03-15T00:00:00Z",
    ...overrides,
  };
}

function adjustment(overrides = {}) {
  return {
    id: "adjustment-1",
    business_id: BUSINESS_ID,
    tax_year: 2026,
    adjustment_type: "manual",
    direction: "increase_taxable_income",
    amount: 10,
    effective_date: "2026-06-01",
    source: "user",
    reason: "CPA adjustment",
    status: "active",
    metadata: {},
    created_at: "2026-06-01T00:00:00Z",
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
    reserve_buffer_percent: 10,
    metadata: {},
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
    this.patch = null;
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
  insert(row) {
    const stored = { id: `${this.table}-${this.store[this.table].length + 1}`, ...row };
    this.store[this.table].push(stored);
    this.rows = [stored];
    return this;
  }
  update(patch) {
    this.patch = patch;
    return this;
  }
  maybeSingle() {
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  single() {
    if (this.patch) {
      const rows = this.store[this.table];
      const target = this.rows[0];
      const idx = rows.findIndex((row) => row === target || row.id === target?.id);
      if (idx >= 0) rows[idx] = { ...rows[idx], ...this.patch };
      this.rows = [idx >= 0 ? rows[idx] : null].filter(Boolean);
    }
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  then(resolve) {
    if (this.patch) {
      const rows = this.store[this.table];
      const ids = new Set(this.rows.map((row) => row.id));
      this.rows = rows.filter((row) => ids.has(row.id)).map((row) => Object.assign(row, this.patch));
    }
    return Promise.resolve({ data: this.rows, error: null }).then(resolve);
  }
}
