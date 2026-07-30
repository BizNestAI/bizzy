import test from "node:test";
import assert from "node:assert/strict";

import { getDeductionsMatrix } from "../src/services/tax/deductions.service.js";
import { computeTaxDeductionsSummary } from "../src/services/tax/taxDeductionsEngine.js";
import { toLegacyDeductionsMatrix } from "../src/services/tax/taxDeductionsLegacyAdapter.js";
import { compareTaxClassificationsToBookkeepingRollups } from "../src/services/tax/taxDeductionsReconciliation.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

test("deductions summary separates confirmed, auto, review, nondeductible, capitalizable, balance-sheet, excluded, and income", async () => {
  const supabase = makeSupabase(baseStore());
  const summary = await computeTaxDeductionsSummary({ supabase, businessId: BUSINESS_ID, taxYear: 2026, asOfDate: "2026-07-15" });

  assert.equal(summary.meta.source, "transaction_tax_classifications");
  assert.equal(summary.totals.estimatedDeductibleAmount, 170);
  assert.equal(summary.totals.confirmedDeductibleAmount, 100);
  assert.equal(summary.totals.autoClassifiedDeductibleAmount, 70);
  assert.equal(summary.totals.needsReviewAmount, 80);
  assert.equal(summary.totals.nondeductibleAmount, 80);
  assert.equal(summary.totals.capitalizableAmount, 300);
  assert.equal(summary.totals.balanceSheetActivityAmount, 400);
  assert.equal(summary.totals.excludedAmount, 0);
  assert.equal(summary.totals.bookExpenseAmount, 330);
  assert.equal(summary.totals.byMonth["2026-01"].estimatedDeductibleAmount, 100);
  assert.equal(summary.totals.byMonth["2026-02"].estimatedDeductibleAmount, 70);
  const income = summary.categories.find((c) => c.taxCategory === "income");
  assert.equal(income.bookExpenseAmount, 0);
  assert.equal(income.estimatedDeductibleAmount, 0);
});

test("partial deduction split is respected and category/month totals reconcile", async () => {
  const supabase = makeSupabase(baseStore());
  const summary = await computeTaxDeductionsSummary({ supabase, businessId: BUSINESS_ID, taxYear: 2026, asOfDate: "2026-12-31" });
  const meals = summary.categories.find((c) => c.taxCategory === "meals");
  assert.equal(meals.estimatedDeductibleAmount, 70);
  assert.equal(meals.nondeductibleAmount, 30);
  assert.equal(meals.averageDeductiblePercent, 70);

  const categoryDeductible = round2(summary.categories.reduce((sum, c) => sum + c.estimatedDeductibleAmount, 0));
  const monthlyDeductible = round2(Object.values(summary.totals.byMonth).reduce((sum, m) => sum + m.estimatedDeductibleAmount, 0));
  assert.equal(categoryDeductible, summary.totals.estimatedDeductibleAmount);
  assert.equal(monthlyDeductible, summary.totals.estimatedDeductibleAmount);
});

test("YTD cutoff and prior-year comparison use comparable dates", async () => {
  const supabase = makeSupabase(baseStore({
    bank_transactions: [
      ...baseStore().bank_transactions,
      bankTxn({ id: "prior-1", date: "2025-01-10", signed_amount: -50 }),
      bankTxn({ id: "prior-late", date: "2025-09-01", signed_amount: -999 }),
    ],
    transaction_tax_classifications: [
      ...baseStore().transaction_tax_classifications,
      classification({ id: "c-prior-1", transaction_id: "prior-1", tax_year: 2025, transaction_date: "2025-01-10", deductible_amount: 50, book_amount: -50 }),
      classification({ id: "c-prior-late", transaction_id: "prior-late", tax_year: 2025, transaction_date: "2025-09-01", deductible_amount: 999, book_amount: -999 }),
    ],
    transaction_categorizations: [
      ...baseStore().transaction_categorizations,
      cat({ transaction_id: "prior-1" }),
      cat({ transaction_id: "prior-late" }),
    ],
  }));
  const summary = await computeTaxDeductionsSummary({ supabase, businessId: BUSINESS_ID, taxYear: 2026, asOfDate: "2026-07-15" });
  assert.equal(summary.totals.estimatedDeductibleAmount, 170);
  assert.equal(summary.comparisons.currentYtdVsPriorYearYtd.priorAmount, 50);
  assert.equal(summary.comparisons.currentYtdVsPriorYearYtd.currentAmount, 170);
});

test("legacy adapter preserves current frontend matrix fields and semantics", async () => {
  const canonical = await computeTaxDeductionsSummary({ supabase: makeSupabase(baseStore()), businessId: BUSINESS_ID, taxYear: 2026, asOfDate: "2026-12-31" });
  const legacy = toLegacyDeductionsMatrix(canonical);
  assert.equal(legacy.meta.source, "tax_classifications");
  assert.equal(legacy.meta.semantics, "estimated_deductible_amount");
  assert.equal(legacy.meta.is_legacy_adapter, true);
  assert.ok(Array.isArray(legacy.categories));
  assert.ok(Array.isArray(legacy.grid));
  assert.ok(Array.isArray(legacy.series));
  assert.equal(legacy.grid.find((row) => row.taxCategory === "meals").ytdTotal, 70);
  assert.equal(legacy.grid.find((row) => row.taxCategory === "meals").bookSpendYtd, 100);
});

test("live no-data does not become mock data", async () => {
  const supabase = makeSupabase({
    bank_transactions: [],
    transaction_categorizations: [],
    qbo_posted_transactions: [],
    transaction_tax_classifications: [],
    expense_totals_monthly: [{ business_id: BUSINESS_ID, month: "2026-01-01", category: "Old Rollup", amount: 9999 }],
  });
  const legacy = await getDeductionsMatrix({ supabase, businessId: BUSINESS_ID, year: 2026 });
  assert.equal(legacy.meta.source, "tax_classifications");
  assert.equal(legacy.totals.ytdTotal, 0);
  assert.equal(legacy.grid.length, 0);
  assert.equal(legacy.meta.warnings[0].code, "no_tax_classifications");
});

test("bookkeeping reconciliation reports differences without forcing equality", async () => {
  const supabase = makeSupabase(baseStore({
    expense_totals_monthly: [
      { business_id: BUSINESS_ID, month: "2026-01-01", category: "Bank Fees", amount: 200 },
      { business_id: BUSINESS_ID, month: "2026-02-01", category: "Meals", amount: 100 },
    ],
  }));
  const reconciliation = await compareTaxClassificationsToBookkeepingRollups({ supabase, businessId: BUSINESS_ID, taxYear: 2026, asOfDate: "2026-12-31" });
  assert.equal(reconciliation.bookkeepingExpenseTotal, 300);
  assert.equal(reconciliation.classifiedBookExpenseTotal, 330);
  assert.equal(reconciliation.difference, 30);
  assert.equal(reconciliation.status, "difference_found");
  assert.ok(reconciliation.likelyReasons.includes("needs_review_transactions"));
});

function baseStore(overrides = {}) {
  const bank = [
    bankTxn({ id: "confirmed", date: "2026-01-10", signed_amount: -100 }),
    bankTxn({ id: "auto-partial", date: "2026-02-10", signed_amount: -100 }),
    bankTxn({ id: "review", date: "2026-03-10", signed_amount: -80 }),
    bankTxn({ id: "nondeductible", date: "2026-04-10", signed_amount: -50 }),
    bankTxn({ id: "capital", date: "2026-05-10", signed_amount: -300 }),
    bankTxn({ id: "balance", date: "2026-06-10", signed_amount: -400 }),
    bankTxn({ id: "excluded", date: "2026-07-10", signed_amount: -25 }),
    bankTxn({ id: "income", date: "2026-07-11", signed_amount: 1000, direction: "INFLOW" }),
    bankTxn({ id: "pending", date: "2026-01-11", signed_amount: -999, pending: true }),
  ];
  const classifications = [
    classification({ id: "c-confirmed", transaction_id: "confirmed", transaction_date: "2026-01-10", tax_category: "bank_fees", classification_status: "user_confirmed", deductible_amount: 100, book_amount: -100, deductible_percent: 100 }),
    classification({ id: "c-auto", transaction_id: "auto-partial", transaction_date: "2026-02-10", tax_category: "meals", classification_status: "auto_classified", deductibility_status: "partially_deductible", deductible_amount: 70, nondeductible_amount: 30, book_amount: -100, deductible_percent: 70 }),
    classification({ id: "c-review", transaction_id: "review", transaction_date: "2026-03-10", tax_category: "unclassified", classification_status: "needs_review", deductibility_status: "needs_review", deductible_amount: 80, book_amount: -80, requires_review: true }),
    classification({ id: "c-nondeductible", transaction_id: "nondeductible", transaction_date: "2026-04-10", tax_category: "personal_expense", classification_status: "user_confirmed", deductibility_status: "nondeductible", deductible_amount: 0, nondeductible_amount: 50, book_amount: -50, deductible_percent: 0 }),
    classification({ id: "c-capital", transaction_id: "capital", transaction_date: "2026-05-10", tax_category: "equipment_asset", classification_status: "user_confirmed", deductibility_status: "capitalizable", deductible_amount: 0, capitalizable_amount: 300, book_amount: -300, deductible_percent: 0 }),
    classification({ id: "c-balance", transaction_id: "balance", transaction_date: "2026-06-10", tax_category: "transfer", classification_status: "auto_classified", deductibility_status: "balance_sheet", deductible_amount: 0, book_amount: -400, deductible_percent: 0 }),
    classification({ id: "c-excluded", transaction_id: "excluded", transaction_date: "2026-07-10", tax_category: "excluded", classification_status: "excluded", deductible_amount: 0, book_amount: -25 }),
    classification({ id: "c-income", transaction_id: "income", transaction_date: "2026-07-11", tax_category: "income", classification_status: "auto_classified", deductible_amount: 0, book_amount: 1000 }),
    classification({ id: "c-pending", transaction_id: "pending", transaction_date: "2026-01-11", tax_category: "bank_fees", classification_status: "auto_classified", deductible_amount: 999, book_amount: -999 }),
  ];
  return {
    bank_transactions: bank,
    transaction_categorizations: bank.map((row) => cat({ transaction_id: row.id })),
    qbo_posted_transactions: [],
    transaction_tax_classifications: classifications,
    expense_totals_monthly: [],
    ...overrides,
  };
}

function bankTxn(overrides = {}) {
  return {
    id: "txn-1",
    business_id: BUSINESS_ID,
    pending: false,
    date: "2026-01-10",
    name: "Vendor",
    merchant_name: "Vendor",
    signed_amount: -100,
    direction: "OUTFLOW",
    is_archived: false,
    created_at: "2026-01-10T00:00:00Z",
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
    final_qbo_account_name: "Bank Fees",
    posted_at: "2026-01-11T00:00:00Z",
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
    transaction_date: "2026-01-10",
    tax_category: "bank_fees",
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
    rule_code: "rule",
    reason: "Rule",
    requires_review: false,
    metadata: { bookkeeping_category: "Bank Fees" },
    created_at: "2026-01-10T00:00:00Z",
    updated_at: "2026-01-10T00:00:00Z",
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
  order(field, options = {}) {
    const direction = options.ascending === false ? -1 : 1;
    this.rows = [...this.rows].sort((a, b) => String(a[field] || "").localeCompare(String(b[field] || "")) * direction);
    return this;
  }
  range(start, end) {
    this.rows = this.rows.slice(start, end + 1);
    return this;
  }
  limit(n) {
    this.rows = this.rows.slice(0, n);
    return this;
  }
  maybeSingle() {
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  then(resolve) {
    return Promise.resolve({ data: this.rows, error: null }).then(resolve);
  }
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}
