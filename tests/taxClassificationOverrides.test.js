import test from "node:test";
import assert from "node:assert/strict";

import { computeClassificationAmounts } from "../src/services/tax/taxClassificationAmounts.js";
import {
  applyClassificationOverride,
  bulkApplyClassificationOverrides,
  confirmClassification,
  excludeTransactionFromTax,
  restoreExcludedTransaction,
} from "../src/services/tax/taxClassificationOverride.service.js";
import {
  createOrUpdateReviewTaskForClassification,
  getTaxReviewQueueSummary,
} from "../src/services/tax/taxClassificationReview.service.js";
import { classifyPostedTransaction } from "../src/services/tax/taxClassificationEngine.js";
import { mapChangeTypeToRecalculationEvent, TAX_CHANGE_TYPES } from "../src/services/tax/taxChangeEvents.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

test("override inserts immutable history and recomputes partial deduction amounts", async () => {
  const supabase = makeSupabase(baseStore());
  const updated = await applyClassificationOverride({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    transactionId: "txn-1",
    input: {
      taxCategory: "meals",
      deductibilityStatus: "partially_deductible",
      deductiblePercent: 50,
      taxTreatment: { type: "ordinary_expense" },
      reason: "Business meal with receipt.",
      expectedUpdatedAt: "old",
    },
    actor: actor(),
  });
  assert.equal(updated.classification.tax_category, "meals");
  assert.equal(updated.classification.deductible_amount, 50);
  assert.equal(updated.classification.nondeductible_amount, 50);
  assert.equal(supabase.store.tax_classification_overrides.length, 1);
  assert.equal(supabase.store.tax_classification_overrides[0].previous_values.tax_category, "unclassified");
  assert.equal(supabase.store.tax_classification_overrides[0].new_values.tax_category, "meals");
});

test("classification override preserves prior runs and maps to recalculation for a new immutable run", async () => {
  const supabase = makeSupabase(baseStore({
    tax_calculation_runs: [{ id: "old-run", business_id: BUSINESS_ID, tax_year: 2026, status: "completed", estimated_total_tax: 1000 }],
    tax_calculation_workpaper_lines: [{ run_id: "old-run", code: "deductions:category:meals", amount: 0 }],
  }));
  await applyClassificationOverride({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    transactionId: "txn-1",
    input: {
      taxCategory: "meals",
      deductibilityStatus: "partially_deductible",
      deductiblePercent: 50,
      taxTreatment: { type: "ordinary_expense" },
      reason: "Business meal with receipt.",
      expectedUpdatedAt: "old",
    },
    actor: actor(),
  });

  assert.equal(supabase.store.tax_calculation_runs.length, 1);
  assert.equal(supabase.store.tax_calculation_runs[0].id, "old-run");
  assert.equal(supabase.store.tax_calculation_workpaper_lines[0].amount, 0);
  assert.equal(
    mapChangeTypeToRecalculationEvent(TAX_CHANGE_TYPES.CLASSIFICATION_OVERRIDDEN),
    "transaction_classification_overridden"
  );
});

test("amount helper handles capitalizable, balance-sheet, and excluded consistently", () => {
  assert.deepEqual(
    computeClassificationAmounts({ signedAmount: -100, direction: "OUTFLOW", deductibilityStatus: "capitalizable", deductiblePercent: 100 }),
    { bookAmount: -100, deductibleAmount: 0, nondeductibleAmount: 0, capitalizableAmount: 100, deductiblePercent: 0 }
  );
  assert.deepEqual(
    computeClassificationAmounts({ signedAmount: -100, direction: "OUTFLOW", deductibilityStatus: "balance_sheet", deductiblePercent: 100 }),
    { bookAmount: -100, deductibleAmount: 0, nondeductibleAmount: 0, capitalizableAmount: 0, deductiblePercent: 0 }
  );
  assert.deepEqual(
    computeClassificationAmounts({ signedAmount: -100, direction: "OUTFLOW", deductibilityStatus: "excluded", deductiblePercent: 100, taxCategory: "excluded" }),
    { bookAmount: -100, deductibleAmount: 0, nondeductibleAmount: 0, capitalizableAmount: 0, deductiblePercent: 100 }
  );
});

test("ordinary user cannot claim CPA confirmation and confirmed changes require reason", async () => {
  const supabase = makeSupabase(baseStore());
  await assert.rejects(
    () => confirmClassification({ supabase, businessId: BUSINESS_ID, taxYear: 2026, transactionId: "txn-1", actor: actor(), confirmationType: "cpa" }),
    (err) => err.code === "business_access_denied"
  );
  supabase.store.transaction_tax_classifications[0].classification_status = "user_confirmed";
  await assert.rejects(
    () => applyClassificationOverride({
      supabase,
      businessId: BUSINESS_ID,
      taxYear: 2026,
      transactionId: "txn-1",
      input: { taxCategory: "office_expense", deductibilityStatus: "fully_deductible" },
      actor: actor(),
    }),
    (err) => err.code === "override_reason_required"
  );
});

test("lower-trust engine rerun cannot overwrite confirmed override", async () => {
  const supabase = makeSupabase(baseStore({
    transaction_tax_classifications: [classification({ classification_status: "user_confirmed", tax_category: "meals" })],
    tax_deduction_rules: [rule({ tax_category: "bank_fees", bookkeeping_category: "Fees" })],
  }));
  const out = await classifyPostedTransaction({ supabase, businessId: BUSINESS_ID, taxYear: 2026, transactionId: "txn-1" });
  assert.equal(out.skipped, true);
  assert.equal(out.classification.tax_category, "meals");
});

test("exclusion and restore update status conservatively", async () => {
  const supabase = makeSupabase(baseStore());
  const excluded = await excludeTransactionFromTax({ supabase, businessId: BUSINESS_ID, taxYear: 2026, transactionId: "txn-1", reason: "Personal transaction.", actor: actor() });
  assert.equal(excluded.classification_status, "excluded");
  assert.equal(excluded.deductible_amount, 0);
  const restored = await restoreExcludedTransaction({ supabase, businessId: BUSINESS_ID, taxYear: 2026, transactionId: "txn-1", actor: actor() });
  assert.equal(restored.classification_status, "needs_review");
  assert.equal(restored.tax_category, "unclassified");
});

test("business rule is created only when requested and unsafe merchant-only rule is rejected", async () => {
  const supabase = makeSupabase(baseStore());
  await applyClassificationOverride({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    transactionId: "txn-1",
    input: { taxCategory: "office_expense", deductibilityStatus: "fully_deductible", reason: "Office supplies." },
    actor: actor(),
  });
  assert.equal(supabase.store.tax_deduction_rules.length, 0);

  await assert.rejects(
    () => applyClassificationOverride({
      supabase,
      businessId: BUSINESS_ID,
      taxYear: 2026,
      transactionId: "txn-1",
      input: {
        taxCategory: "office_expense",
        deductibilityStatus: "fully_deductible",
        reason: "Create merchant rule.",
        createBusinessRule: true,
        businessRuleOptions: { matchType: "merchant_entity" },
      },
      actor: actor(),
    }),
    (err) => err.code === "unsafe_business_rule"
  );

  const withRule = makeSupabase(baseStore({ bank_transactions: [bankTxn({ merchant_entity_id: "merchant-1" })] }));
  await applyClassificationOverride({
    supabase: withRule,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    transactionId: "txn-1",
    input: {
      taxCategory: "office_expense",
      deductibilityStatus: "fully_deductible",
      reason: "Safe account rule.",
      createBusinessRule: true,
      businessRuleOptions: { matchType: "bookkeeping_category", ruleCode: "biz_office" },
    },
    actor: actor(),
  });
  assert.equal(withRule.store.tax_deduction_rules.length, 1);
});

test("duplicate review tasks are not created", async () => {
  const supabase = makeSupabase(baseStore());
  await createOrUpdateReviewTaskForClassification({ supabase, businessId: BUSINESS_ID, taxYear: 2026, classification: supabase.store.transaction_tax_classifications[0] });
  await createOrUpdateReviewTaskForClassification({ supabase, businessId: BUSINESS_ID, taxYear: 2026, classification: supabase.store.transaction_tax_classifications[0] });
  assert.equal(supabase.store.tax_review_tasks.length, 1);
  const summary = await getTaxReviewQueueSummary({ supabase, businessId: BUSINESS_ID, taxYear: 2026 });
  assert.equal(summary.needsReviewCount, 1);
});

test("stale expectedUpdatedAt returns conflict and business isolation is enforced", async () => {
  const supabase = makeSupabase(baseStore());
  await assert.rejects(
    () => applyClassificationOverride({
      supabase,
      businessId: BUSINESS_ID,
      taxYear: 2026,
      transactionId: "txn-1",
      input: { taxCategory: "meals", deductibilityStatus: "partially_deductible", deductiblePercent: 50, reason: "Late update.", expectedUpdatedAt: "stale" },
      actor: actor(),
    }),
    (err) => err.code === "classification_conflict"
  );
  await assert.rejects(
    () => applyClassificationOverride({
      supabase,
      businessId: "99999999-9999-4999-8999-999999999999",
      taxYear: 2026,
      transactionId: "txn-1",
      input: { taxCategory: "meals", deductibilityStatus: "partially_deductible", deductiblePercent: 50, reason: "Wrong business." },
      actor: actor(),
    }),
    (err) => err.code === "classification_not_found"
  );
});

test("atomic RPC rollback keeps history and classification in sync on failures", async () => {
  const historyFailure = makeSupabase(baseStore({ failOverrideHistoryInsert: true }));
  await assert.rejects(
    () => applyClassificationOverride({
      supabase: historyFailure,
      businessId: BUSINESS_ID,
      taxYear: 2026,
      transactionId: "txn-1",
      input: { taxCategory: "meals", deductibilityStatus: "partially_deductible", deductiblePercent: 50, reason: "Should roll back." },
      actor: actor(),
    }),
    (err) => err.code === "classification_override_failed"
  );
  assert.equal(historyFailure.store.tax_classification_overrides.length, 0);
  assert.equal(historyFailure.store.transaction_tax_classifications[0].tax_category, "unclassified");

  const updateFailure = makeSupabase(baseStore({ failOverrideUpdate: true }));
  await assert.rejects(
    () => applyClassificationOverride({
      supabase: updateFailure,
      businessId: BUSINESS_ID,
      taxYear: 2026,
      transactionId: "txn-1",
      input: { taxCategory: "meals", deductibilityStatus: "partially_deductible", deductiblePercent: 50, reason: "Should roll back." },
      actor: actor(),
    }),
    (err) => err.code === "classification_override_failed"
  );
  assert.equal(updateFailure.store.tax_classification_overrides.length, 0);
  assert.equal(updateFailure.store.transaction_tax_classifications[0].tax_category, "unclassified");
});

test("concurrent stale override is rejected without a second history row", async () => {
  const supabase = makeSupabase(baseStore());
  await applyClassificationOverride({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    transactionId: "txn-1",
    input: { taxCategory: "meals", deductibilityStatus: "partially_deductible", deductiblePercent: 50, reason: "First writer.", expectedUpdatedAt: "old" },
    actor: actor(),
  });
  await assert.rejects(
    () => applyClassificationOverride({
      supabase,
      businessId: BUSINESS_ID,
      taxYear: 2026,
      transactionId: "txn-1",
      input: { taxCategory: "office_expense", deductibilityStatus: "fully_deductible", reason: "Second stale writer.", expectedUpdatedAt: "old" },
      actor: actor(),
    }),
    (err) => err.code === "classification_conflict"
  );
  assert.equal(supabase.store.tax_classification_overrides.length, 1);
  assert.equal(supabase.store.transaction_tax_classifications[0].tax_category, "meals");
});

test("bulk override reports partial failures", async () => {
  const supabase = makeSupabase(baseStore());
  const result = await bulkApplyClassificationOverrides({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    transactionIds: ["txn-1", "missing"],
    input: { taxCategory: "office_expense", deductibilityStatus: "fully_deductible", reason: "Bulk update." },
    actor: actor(),
  });
  assert.equal(result.updated, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.errors[0].transactionId, "missing");
});

function actor(overrides = {}) {
  return { userId: "user-1", role: "user", source: "user", ...overrides };
}

function baseStore(overrides = {}) {
  return {
    bank_transactions: [bankTxn()],
    transaction_categorizations: [cat()],
    qbo_posted_transactions: [],
    transaction_tax_classifications: [classification()],
    tax_classification_overrides: [],
    tax_review_tasks: [],
    tax_deduction_rules: [],
    tax_profiles: [],
    tax_profile_memory: [],
    ...overrides,
  };
}

function bankTxn(overrides = {}) {
  return {
    id: "txn-1",
    business_id: BUSINESS_ID,
    pending: false,
    date: "2026-03-15",
    name: "Vendor charge",
    merchant_name: "Vendor",
    merchant_entity_id: null,
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
    business_id: BUSINESS_ID,
    transaction_id: "txn-1",
    status: "posted",
    final_qbo_account_id: "acct-1",
    final_qbo_account_name: "Fees",
    meta: {},
    qbo_txn_id: "qbo-1",
    qbo_txn_type: "Expense",
    posted_at: "2026-03-16T00:00:00Z",
    ...overrides,
  };
}

function classification(overrides = {}) {
  return {
    id: "class-1",
    business_id: BUSINESS_ID,
    transaction_id: "txn-1",
    tax_year: 2026,
    transaction_date: "2026-03-15",
    tax_category: "unclassified",
    deductibility_status: "needs_review",
    deductible_percent: 0,
    book_amount: -100,
    deductible_amount: 0,
    nondeductible_amount: 0,
    capitalizable_amount: 0,
    tax_treatment: { type: "unclassified" },
    classification_status: "needs_review",
    confidence_score: 20,
    confidence_level: "low",
    reason: "No rule",
    requires_review: true,
    metadata: { direction: "OUTFLOW" },
    updated_at: "old",
    created_at: "created",
    ...overrides,
  };
}

function rule(overrides = {}) {
  return {
    id: "rule-1",
    business_id: null,
    scope: "global",
    rule_code: "fees",
    tax_year: 2026,
    jurisdiction: "federal",
    bookkeeping_category: "Fees",
    tax_category: "bank_fees",
    deductibility_status: "fully_deductible",
    default_deductible_percent: 1,
    treatment: { type: "ordinary_expense" },
    requires_review: false,
    priority: 100,
    match_conditions: {},
    is_active: true,
    version: "1",
    ...overrides,
  };
}

function makeSupabase(store) {
  return {
    store,
    from(table) {
      return new Query(table, store);
    },
    rpc(name, params) {
      if (name !== "apply_tax_classification_override") {
        return Promise.resolve({ data: null, error: { code: "rpc_not_found", message: "Unknown RPC" } });
      }
      return Promise.resolve(applyOverrideRpc(store, params));
    },
  };
}

function applyOverrideRpc(store, params) {
  const rows = store.transaction_tax_classifications;
  const idx = rows.findIndex((row) =>
    row.business_id === params.p_business_id &&
    row.transaction_id === params.p_transaction_id &&
    row.tax_year === params.p_tax_year
  );
  if (idx < 0) return { data: null, error: { code: "P0002", message: "classification_not_found" } };
  const current = rows[idx];
  if (params.p_expected_updated_at && current.updated_at && String(params.p_expected_updated_at) !== String(current.updated_at)) {
    return { data: null, error: { code: "40001", message: "classification_conflict" } };
  }
  if (params.p_classification_status === "cpa_confirmed" && !["cpa", "admin"].includes(params.p_override_source)) {
    return { data: null, error: { code: "22023", message: "invalid_tax_classification_override" } };
  }
  if (Number(params.p_deductible_percent) < 0 || Number(params.p_deductible_percent) > 100) {
    return { data: null, error: { code: "22023", message: "invalid_tax_classification_override" } };
  }
  if (store.failOverrideHistoryInsert) {
    return { data: null, error: { code: "23514", message: "history insert failed" } };
  }
  if (store.failOverrideUpdate) {
    return { data: null, error: { code: "23514", message: "classification update failed" } };
  }

  const previous = snapshot(current);
  const metadata = { ...(current.metadata || {}), ...(params.p_metadata || {}) };
  const updated = {
    ...current,
    tax_category: params.p_tax_category,
    deductibility_status: params.p_deductibility_status,
    deductible_percent: params.p_deductible_percent,
    book_amount: params.p_book_amount,
    deductible_amount: params.p_deductible_amount,
    nondeductible_amount: params.p_nondeductible_amount,
    capitalizable_amount: params.p_capitalizable_amount,
    tax_treatment: params.p_tax_treatment,
    classification_status: params.p_classification_status,
    confidence_score: params.p_confidence_score,
    confidence_level: params.p_confidence_level,
    source: params.p_source,
    requires_review: params.p_requires_review,
    reason: params.p_reason,
    user_override: params.p_user_override || current.user_override || params.p_classification_status === "user_confirmed",
    cpa_override: params.p_cpa_override || current.cpa_override || params.p_classification_status === "cpa_confirmed",
    metadata,
    updated_at: new Date().toISOString(),
  };
  const next = snapshot(updated);
  store.tax_classification_overrides.push({
    id: `override-${store.tax_classification_overrides.length + 1}`,
    business_id: params.p_business_id,
    tax_year: params.p_tax_year,
    transaction_id: params.p_transaction_id,
    classification_id: current.id,
    previous_values: previous,
    new_values: next,
    override_source: params.p_override_source,
    override_reason: params.p_override_reason,
    overridden_by: params.p_actor_user_id,
    created_at: new Date().toISOString(),
  });
  rows[idx] = updated;
  return { data: updated, error: null };
}

function snapshot(row) {
  return {
    tax_category: row.tax_category,
    deductibility_status: row.deductibility_status,
    deductible_percent: row.deductible_percent,
    deductible_amount: row.deductible_amount,
    nondeductible_amount: row.nondeductible_amount,
    capitalizable_amount: row.capitalizable_amount,
    classification_status: row.classification_status,
    reason: row.reason,
    requires_review: row.requires_review,
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
  upsert(row) {
    const rows = this.store[this.table];
    const idx = rows.findIndex((existing) =>
      (row.dedupe_key && existing.business_id === row.business_id && existing.dedupe_key === row.dedupe_key) ||
      (row.transaction_id && existing.business_id === row.business_id && existing.transaction_id === row.transaction_id && existing.tax_year === row.tax_year)
    );
    if (idx >= 0) rows[idx] = { ...rows[idx], ...row };
    else rows.push({ id: `${this.table}-${rows.length + 1}`, ...row });
    this.rows = [idx >= 0 ? rows[idx] : rows[rows.length - 1]];
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
