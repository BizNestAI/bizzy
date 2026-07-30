import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyNormalizedTransaction,
  classifyPostedTransaction,
  classifyPostedTransactionsBatch,
} from "../src/services/tax/taxClassificationEngine.js";
import { TAX_CLASSIFICATION_ENGINE_VERSION } from "../src/services/tax/taxEngineVersions.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";

test("deduction rules classify transfer, credit-card payment, owner draw, owner contribution, and refund conservatively", async () => {
  const rules = pack2Rules();
  const transfer = await classifyNormalizedTransaction(baseArgs({ transaction: txn({ bookkeepingCategory: "transfers", taxonomyType: "transfer_internal" }), rules }));
  assert.equal(transfer.ruleCode, "transfers");
  assert.equal(transfer.taxCategory, "transfer");
  assert.equal(transfer.deductibilityStatus, "balance_sheet");
  assert.equal(transfer.deductibleAmount, 0);
  assert.equal(transfer.classificationStatus, "auto_classified");
  assert.equal(transfer.metadata.rule_priority, 5);

  const cc = await classifyNormalizedTransaction(baseArgs({ transaction: txn({ bookkeepingCategory: "credit_card_payments", taxonomyType: "cc_payment" }), rules }));
  assert.equal(cc.taxCategory, "credit_card_payment");
  assert.equal(cc.deductibilityStatus, "balance_sheet");

  const draw = await classifyNormalizedTransaction(baseArgs({ transaction: txn({ bookkeepingCategory: "owner_draws_contributions", taxonomyType: "owner_draw" }), rules }));
  assert.equal(draw.taxCategory, "owner_draw");
  assert.equal(draw.deductibilityStatus, "balance_sheet");

  const contribution = await classifyNormalizedTransaction(baseArgs({ transaction: txn({ bookkeepingCategory: "owner_draws_contributions", taxonomyType: "owner_contribution" }), rules }));
  assert.equal(contribution.taxCategory, "owner_draw");
  assert.equal(contribution.deductibilityStatus, "balance_sheet");

  const refund = await classifyNormalizedTransaction(baseArgs({ transaction: txn({ bookkeepingCategory: "refunds_reversals", taxonomyType: "refund" }), rules }));
  assert.equal(refund.taxCategory, "refund");
  assert.equal(refund.classificationStatus, "needs_review");
});

test("Pack 2 base rules cover all 16 federal rule codes and key treatments", async () => {
  const cases = [
    ["materials_and_supplies", txn({ bookkeepingCategory: "materials_and_supplies", merchantName: "Home Depot", jobId: "job-1" }), "fully_deductible", 100],
    ["subcontractors_contract_labor", txn({ bookkeepingCategory: "subcontractors_contract_labor", hasEmployee: false }), "fully_deductible", 100],
    ["meals", txn({ bookkeepingCategory: "meals", merchantName: "Joe's Grill", metadata: { qbo_account_type: "Expense", qbo_account_subtype: "Meals" } }), "partially_deductible", 50],
    ["vehicle_fuel", txn({ bookkeepingCategory: "vehicle_fuel", merchantName: "Shell" }), "needs_review", 0],
    ["insurance", txn({ bookkeepingCategory: "insurance" }), "fully_deductible", 100],
    ["office_expense", txn({ bookkeepingCategory: "office_expense", merchantName: "Staples" }), "fully_deductible", 100],
    ["tools_small_equipment", txn({ bookkeepingCategory: "tools_small_equipment", absoluteAmount: 800, signedAmount: -800 }), "fully_deductible", 100],
    ["capitalizable_equipment", txn({ bookkeepingCategory: "capitalizable_equipment", absoluteAmount: 4000, signedAmount: -4000, metadata: { qbo_account_type: "Fixed Asset", qbo_account_subtype: "Equipment" } }), "capitalizable", 0],
    ["loan_principal", txn({ bookkeepingCategory: "loan_principal", taxonomyType: "loan_principal", description: "Loan principal payment" }), "balance_sheet", 0],
    ["loan_interest", txn({ bookkeepingCategory: "loan_interest", description: "Loan interest payment" }), "fully_deductible", 100],
    ["owner_draws_contributions", txn({ bookkeepingCategory: "owner_draws_contributions", taxonomyType: "owner_draw" }), "balance_sheet", 0],
    ["transfers", txn({ bookkeepingCategory: "transfers", taxonomyType: "transfer_internal" }), "balance_sheet", 0],
    ["credit_card_payments", txn({ bookkeepingCategory: "credit_card_payments", taxonomyType: "cc_payment" }), "balance_sheet", 0],
    ["refunds_reversals", txn({ bookkeepingCategory: "refunds_reversals", taxonomyType: "refund" }), "needs_review", 0],
    ["payroll_payroll_taxes", txn({ bookkeepingCategory: "payroll_payroll_taxes", hasEmployee: true }), "fully_deductible", 100],
    ["personal_nondeductible", txn({ bookkeepingCategory: "personal_nondeductible", description: "personal groceries" }), "nondeductible", 0],
  ];

  for (const [ruleCode, transaction, status, percent] of cases) {
    const result = await classifyNormalizedTransaction(baseArgs({ transaction, rules: pack2Rules() }));
    assert.equal(result.ruleCode, ruleCode, ruleCode);
    assert.equal(result.deductibilityStatus, status, ruleCode);
    assert.equal(result.deductiblePercent, percent, ruleCode);
    assert.equal(result.metadata.rule_version, "irs-2026", ruleCode);
    assert.equal(typeof result.metadata.rule_priority, "number", ruleCode);
    assert.match(result.reason, new RegExp(ruleCode));
  }
});

test("generic outflow is not assumed deductible and income is not stored as deductible expense", async () => {
  const outflow = await classifyNormalizedTransaction(baseArgs({ transaction: txn(), rules: [] }));
  assert.equal(outflow.taxCategory, "unclassified");
  assert.equal(outflow.deductibilityStatus, "needs_review");
  assert.equal(outflow.deductibleAmount, 0);

  const income = await classifyNormalizedTransaction(baseArgs({ transaction: txn({ direction: "INFLOW", signedAmount: 500, absoluteAmount: 500 }) }));
  assert.equal(income.taxCategory, "income");
  assert.equal(income.deductibleAmount, 0);
  assert.equal(income.nondeductibleAmount, 0);
});

test("meals percentage comes from rule config, equipment can be capitalizable, and amounts do not double-count", async () => {
  const meals = await classifyNormalizedTransaction(baseArgs({
    transaction: txn({ bookkeepingCategory: "Meals" }),
    rules: [rule({ id: "meals-rule", rule_code: "meals_50", tax_category: "meals", bookkeeping_category: "Meals", deductibility_status: "partially_deductible", default_deductible_percent: 0.5 })],
  }));
  assert.equal(meals.deductiblePercent, 50);
  assert.equal(meals.deductibleAmount, 50);
  assert.equal(meals.nondeductibleAmount, 50);
  assert.equal(meals.capitalizableAmount, 0);

  const equipment = await classifyNormalizedTransaction(baseArgs({
    transaction: txn({ bookkeepingCategory: "Equipment" }),
    rules: [rule({
      id: "equipment-rule",
      rule_code: "equipment_cap",
      tax_category: "equipment_asset",
      bookkeeping_category: "Equipment",
      deductibility_status: "capitalizable",
      default_deductible_percent: 0,
      treatment: { type: "capitalizable" },
    })],
  }));
  assert.equal(equipment.capitalizableAmount, 100);
  assert.equal(equipment.deductibleAmount, 0);
});

test("business rule beats global rule through repository-backed matching", async () => {
  const supabase = makeSupabase({
    tax_deduction_rules: [
      rule({ id: "global", rule_code: "global_supplies", tax_category: "supplies_materials", bookkeeping_category: "Supplies", default_deductible_percent: 1 }),
      rule({ id: "business", business_id: BUSINESS_ID, scope: "business_override", rule_code: "biz_supplies", tax_category: "office_expense", bookkeeping_category: "Supplies", default_deductible_percent: 1, priority: 999 }),
    ],
  });
  const result = await classifyNormalizedTransaction(baseArgs({
    supabase,
    transaction: txn({ bookkeepingCategory: "Supplies" }),
    rules: null,
  }));
  assert.equal(result.ruleId, "business");
  assert.equal(result.taxCategory, "office_expense");
  assert.equal(result.metadata.rule_scope, "business_override");
});

test("rule engine ignores inactive, expired, future, and unverified in-memory rules", async () => {
  const result = await classifyNormalizedTransaction(baseArgs({
    transaction: txn({ bookkeepingCategory: "Fees", transactionDate: "2026-03-15" }),
    rules: [
      rule({ id: "inactive", is_active: false, priority: 1, tax_category: "inactive" }),
      rule({ id: "expired", effective_to: "2026-01-01", priority: 1, tax_category: "expired" }),
      rule({ id: "future", effective_from: "2027-01-01", priority: 1, tax_category: "future" }),
      rule({ id: "unverified", verified_at: null, source_reference: null, source_url: null, support_level: undefined, priority: 1, tax_category: "unverified" }),
      rule({ id: "current", priority: 50, tax_category: "bank_fees" }),
    ],
  }));
  assert.equal(result.ruleId, "current");
});

test("verified exact rule can auto-classify while unverified rule and source conflict force review", async () => {
  const verified = await classifyNormalizedTransaction(baseArgs({
    transaction: txn({ bookkeepingCategory: "Bank Fees" }),
    rules: [rule({ rule_code: "bank_fees", tax_category: "bank_fees", bookkeeping_category: "Bank Fees", default_deductible_percent: 1 })],
  }));
  assert.equal(verified.classificationStatus, "auto_classified");

  const unverified = await classifyNormalizedTransaction(baseArgs({
    transaction: txn({ bookkeepingCategory: "Bank Fees" }),
    rules: [rule({ rule_code: "bank_fees_unverified", tax_category: "bank_fees", bookkeeping_category: "Bank Fees", default_deductible_percent: 1, support_level: "unverified" })],
  }));
  assert.equal(unverified.classificationStatus, "needs_review");

  const conflict = await classifyNormalizedTransaction(baseArgs({
    transaction: txn({ bookkeepingCategory: "Bank Fees", sourceWarnings: ["qbo_id_mismatch"] }),
    rules: [rule({ rule_code: "bank_fees", tax_category: "bank_fees", bookkeeping_category: "Bank Fees", default_deductible_percent: 1 })],
  }));
  assert.equal(conflict.classificationStatus, "needs_review");
});

test("user-confirmed and CPA-confirmed classifications are preserved", async () => {
  for (const status of ["user_confirmed", "cpa_confirmed"]) {
    const supabase = makeSupabase({
      bank_transactions: [bankTxn({ id: `txn-${status}` })],
      transaction_categorizations: [cat({ transaction_id: `txn-${status}` })],
      tax_profiles: [profile()],
      transaction_tax_classifications: [classificationRow({ transaction_id: `txn-${status}`, classification_status: status })],
    });
    const out = await classifyPostedTransaction({ supabase, businessId: BUSINESS_ID, taxYear: 2026, transactionId: `txn-${status}` });
    assert.equal(out.skipped, true);
    assert.equal(out.classification.classification_status, status);
  }
});

test("classification persistence is year/business isolated and repeated run is idempotent", async () => {
  const supabase = makeSupabase({
    bank_transactions: [bankTxn({ id: "txn-1" }), bankTxn({ id: "txn-other", business_id: OTHER_BUSINESS_ID })],
    transaction_categorizations: [cat({ transaction_id: "txn-1" }), cat({ transaction_id: "txn-other", business_id: OTHER_BUSINESS_ID })],
    tax_profiles: [profile()],
    tax_deduction_rules: [rule({ rule_code: "fees", tax_category: "bank_fees", bookkeeping_category: "Fees", default_deductible_percent: 1 })],
  });
  const first = await classifyPostedTransaction({ supabase, businessId: BUSINESS_ID, taxYear: 2026, transactionId: "txn-1" });
  const second = await classifyPostedTransaction({ supabase, businessId: BUSINESS_ID, taxYear: 2026, transactionId: "txn-1" });
  assert.equal(first.classification.business_id, BUSINESS_ID);
  assert.equal(first.classification.tax_year, 2026);
  assert.equal(supabase.store.transaction_tax_classifications.length, 1);
  assert.equal(second.classification.transaction_id, "txn-1");
  assert.equal(second.classification.metadata.classification_engine_version, TAX_CLASSIFICATION_ENGINE_VERSION);
});

test("batch processing continues past one malformed transaction", async () => {
  const supabase = makeSupabase({
    bank_transactions: [bankTxn({ id: "good" })],
    transaction_categorizations: [cat({ transaction_id: "good" })],
    tax_profiles: [profile()],
    tax_deduction_rules: [rule({ rule_code: "fees", tax_category: "bank_fees", bookkeeping_category: "Fees", default_deductible_percent: 1 })],
  });
  const result = await classifyPostedTransactionsBatch({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    transactionIds: ["good", "missing"],
  });
  assert.equal(result.attempted, 2);
  assert.equal(result.classified, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.errors[0].transactionId, "missing");
});

function baseArgs(overrides = {}) {
  return {
    supabase: makeSupabase(),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    transaction: txn(),
    profile: profile(),
    memories: [],
    rules: [],
    ...overrides,
  };
}

function txn(overrides = {}) {
  return {
    transactionId: "txn-1",
    businessId: BUSINESS_ID,
    transactionDate: "2026-03-15",
    description: "Vendor charge",
    merchantName: "Vendor",
    counterpartyName: "Vendor LLC",
    signedAmount: -100,
    absoluteAmount: 100,
    direction: "OUTFLOW",
    bookkeepingCategory: "Fees",
    qboAccountId: "acct-1",
    qboAccountName: "Fees",
    qboTxnId: "qbo-1",
    qboTxnType: "Expense",
    taxonomyType: null,
    sourceTruth: { bankTransaction: true, categorizationPosted: true, qboPostedRecord: false, matchedQboIds: null },
    sourceWarnings: [],
    rawRefs: { bankTransactionId: "txn-1" },
    ...overrides,
  };
}

function profile(overrides = {}) {
  return { id: "profile-1", business_id: BUSINESS_ID, tax_year: 2026, entity_type: "sole_proprietor", profile_status: "active", ...overrides };
}

function rule(overrides = {}) {
  return {
    id: "rule-1",
    business_id: null,
    scope: "global",
    rule_code: "fees",
    tax_year: 2026,
    jurisdiction: "federal",
    entity_type: null,
    bookkeeping_category: "Fees",
    qbo_account_type: null,
    qbo_account_subtype: null,
    match_conditions: {},
    tax_category: "bank_fees",
    deductibility_status: "fully_deductible",
    default_deductible_percent: 1,
    treatment: { type: "ordinary_expense" },
    requires_review: false,
    priority: 100,
    explanation: "Rule",
    source_reference: "policy",
    source_url: "https://example.test",
    verified_at: "2026-01-01",
    effective_from: "2026-01-01",
    effective_to: null,
    is_active: true,
    version: "1",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    support_level: "verified",
    ...overrides,
  };
}

function pack2Rules() {
  return [
    rule({ id: "r-materials", rule_code: "materials_and_supplies", tax_category: "supplies", bookkeeping_category: "materials_and_supplies", priority: 40, match_conditions: { vendor_names: ["Home Depot"], assigned_job_required: true } }),
    rule({ id: "r-contract", rule_code: "subcontractors_contract_labor", tax_category: "contract_labor", bookkeeping_category: "subcontractors_contract_labor", priority: 35, match_conditions: { requires_employee: false } }),
    rule({ id: "r-meals", rule_code: "meals", tax_category: "meals", bookkeeping_category: "meals", qbo_account_type: "Expense", qbo_account_subtype: "Meals", priority: 45, deductibility_status: "partially_deductible", default_deductible_percent: 0.5, requires_review: true, match_conditions: { merchant_regex: "restaurant|grill|cafe" } }),
    rule({ id: "r-fuel", rule_code: "vehicle_fuel", tax_category: "auto", bookkeeping_category: "vehicle_fuel", priority: 45, deductibility_status: "needs_review", default_deductible_percent: 0, requires_review: true, treatment: { type: "allocation_required" }, match_conditions: { merchant_regex: "fuel|shell|exxon|chevron" } }),
    rule({ id: "r-insurance", rule_code: "insurance", tax_category: "insurance", bookkeeping_category: "insurance", priority: 40 }),
    rule({ id: "r-office", rule_code: "office_expense", tax_category: "office", bookkeeping_category: "office_expense", priority: 40, match_conditions: { vendor_names: ["Staples"] } }),
    rule({ id: "r-tools", rule_code: "tools_small_equipment", tax_category: "equipment", bookkeeping_category: "tools_small_equipment", priority: 35, match_conditions: { maximum_amount: 2500 } }),
    rule({ id: "r-cap", rule_code: "capitalizable_equipment", tax_category: "capitalizable_equipment", bookkeeping_category: "capitalizable_equipment", qbo_account_type: "Fixed Asset", qbo_account_subtype: "Equipment", priority: 30, deductibility_status: "capitalizable", default_deductible_percent: 0, requires_review: true, treatment: { type: "capitalizable" }, match_conditions: { minimum_amount: 2500.01 } }),
    rule({ id: "r-principal", rule_code: "loan_principal", tax_category: "loan_principal", bookkeeping_category: "loan_principal", priority: 10, deductibility_status: "balance_sheet", default_deductible_percent: 0, treatment: { type: "balance_sheet" }, match_conditions: { taxonomy_types: ["loan_principal"] } }),
    rule({ id: "r-interest", rule_code: "loan_interest", tax_category: "loan_interest", bookkeeping_category: "loan_interest", priority: 25, match_conditions: { description_regex: "interest" } }),
    rule({ id: "r-owner", rule_code: "owner_draws_contributions", tax_category: "owner_draw", bookkeeping_category: "owner_draws_contributions", priority: 5, deductibility_status: "balance_sheet", default_deductible_percent: 0, treatment: { type: "balance_sheet" }, match_conditions: { taxonomy_types: ["owner_draw", "owner_contribution"] } }),
    rule({ id: "r-transfer", rule_code: "transfers", tax_category: "transfer", bookkeeping_category: "transfers", priority: 5, deductibility_status: "balance_sheet", default_deductible_percent: 0, treatment: { type: "balance_sheet" }, match_conditions: { taxonomy_types: ["transfer_internal"] } }),
    rule({ id: "r-cc", rule_code: "credit_card_payments", tax_category: "credit_card_payment", bookkeeping_category: "credit_card_payments", priority: 5, deductibility_status: "balance_sheet", default_deductible_percent: 0, treatment: { type: "balance_sheet" }, match_conditions: { taxonomy_types: ["cc_payment"] } }),
    rule({ id: "r-refund", rule_code: "refunds_reversals", tax_category: "refund", bookkeeping_category: "refunds_reversals", priority: 20, deductibility_status: "needs_review", default_deductible_percent: 0, requires_review: true, treatment: { type: "reversal" }, match_conditions: { taxonomy_types: ["refund"] } }),
    rule({ id: "r-payroll", rule_code: "payroll_payroll_taxes", tax_category: "payroll", bookkeeping_category: "payroll_payroll_taxes", priority: 35, match_conditions: { requires_employee: true } }),
    rule({ id: "r-personal", rule_code: "personal_nondeductible", tax_category: "personal", bookkeeping_category: "personal_nondeductible", priority: 15, deductibility_status: "nondeductible", default_deductible_percent: 0, treatment: { type: "nondeductible" }, requires_review: true, match_conditions: { description_regex: "personal|groceries" } }),
  ].map((row) => rule({ ...row, version: "irs-2026" }));
}

function bankTxn(overrides = {}) {
  return {
    id: "txn-1",
    business_id: BUSINESS_ID,
    pending: false,
    date: "2026-03-15",
    name: "Vendor charge",
    merchant_name: "Vendor",
    amount: 100,
    signed_amount: -100,
    direction: "OUTFLOW",
    counterparty_name: "Vendor LLC",
    is_archived: false,
    created_at: "2026-03-15T00:00:00Z",
    ...overrides,
  };
}

function cat(overrides = {}) {
  return {
    id: "cat-1",
    business_id: BUSINESS_ID,
    transaction_id: "txn-1",
    status: "posted",
    suggested_qbo_account_id: "acct-1",
    suggested_qbo_account_name: "Fees",
    final_qbo_account_id: "acct-1",
    final_qbo_account_name: "Fees",
    confidence: 0.9,
    reason: "matched",
    meta: {},
    qbo_txn_id: "qbo-1",
    qbo_txn_type: "Expense",
    posted_at: "2026-03-16T00:00:00Z",
    ...overrides,
  };
}

function classificationRow(overrides = {}) {
  return {
    business_id: BUSINESS_ID,
    transaction_id: "txn-1",
    tax_year: 2026,
    tax_category: "bank_fees",
    deductibility_status: "fully_deductible",
    classification_status: "auto_classified",
    metadata: {},
    created_at: "2026-03-16T00:00:00Z",
    updated_at: "2026-03-16T00:00:00Z",
    ...overrides,
  };
}

function makeSupabase(initial = {}) {
  const store = {
    bank_transactions: [],
    transaction_categorizations: [],
    qbo_posted_transactions: [],
    transaction_tax_classifications: [],
    tax_profiles: [],
    tax_profile_memory: [],
    tax_deduction_rules: [],
    ...initial,
  };
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
    this.pendingUpsert = null;
    this.pendingUpdate = null;
  }
  select() { return this; }
  eq(field, value) {
    this.rows = this.rows.filter((row) => row[field] === value);
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
  in(field, values) {
    const set = new Set(values.map(String));
    this.rows = this.rows.filter((row) => set.has(String(row[field])));
    return this;
  }
  order() { return this; }
  range(start, end) {
    this.rows = this.rows.slice(start, end + 1);
    return this;
  }
  limit(n) {
    this.rows = this.rows.slice(0, n);
    return this;
  }
  upsert(row) {
    const rows = this.store[this.table];
    const idx = rows.findIndex((existing) =>
      existing.business_id === row.business_id &&
      existing.transaction_id === row.transaction_id &&
      existing.tax_year === row.tax_year
    );
    if (idx >= 0) rows[idx] = { ...rows[idx], ...row };
    else rows.push(row);
    this.rows = [idx >= 0 ? rows[idx] : row];
    return this;
  }
  update(patch) {
    this.pendingUpdate = patch;
    return this;
  }
  maybeSingle() {
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  single() {
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  then(resolve) {
    return Promise.resolve({ data: this.rows, error: null }).then(resolve);
  }
}
