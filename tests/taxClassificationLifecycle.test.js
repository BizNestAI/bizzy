import test from "node:test";
import assert from "node:assert/strict";

import {
  enqueueTaxClassificationRun,
  getTaxClassificationLifecycleStatus,
} from "../src/services/tax/taxClassificationRun.service.js";
import { handleTaxClassificationEvent } from "../src/services/tax/taxClassificationTrigger.service.js";
import {
  processPendingTaxClassificationRuns,
} from "../src/services/tax/taxClassificationWorker.service.js";
import { evaluateTaxCalculationPrerequisites } from "../src/services/tax/taxCalculationPrerequisites.service.js";
import {
  TAX_CHANGE_TYPES,
} from "../src/services/tax/taxChangeEvents.js";
import {
  TAX_CLASSIFICATION_RUN_STATUSES,
  TAX_CLASSIFICATION_TRIGGER_SOURCES,
} from "../src/services/tax/taxDomain.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";

test("idle complete profile with 205 unclassified posted rows is ready to classify, not processing", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 205 }));

  const lifecycle = await getTaxClassificationLifecycleStatus({ supabase, businessId: BUSINESS_ID, taxYear: 2026 });

  assert.equal(lifecycle.eligiblePostedCount, 205);
  assert.equal(lifecycle.classifiedCount, 0);
  assert.equal(lifecycle.unclassifiedCount, 205);
  assert.equal(lifecycle.classificationStatus, "ready_to_classify");
  assert.equal(lifecycle.activeRun, null);
  assert.equal(lifecycle.processingCount, 0);
});

test("profile completion enqueues one idempotent historical classification run", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 205 }));
  const before = completeProfile({ self_employment_tax_applies: null });
  const after = completeProfile({ self_employment_tax_applies: true });

  const first = await handleTaxClassificationEvent({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    changeType: TAX_CHANGE_TYPES.PROFILE_UPDATED,
    entityId: "profile-1",
    userId: "user-1",
    metadata: { before, after },
  });
  const second = await handleTaxClassificationEvent({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    changeType: TAX_CHANGE_TYPES.PROFILE_UPDATED,
    entityId: "profile-1",
    userId: "user-1",
    metadata: { before, after },
  });

  assert.equal(first?.queued, true);
  assert.equal(second?.queued, false);
  assert.equal(second?.outcome, "existing_active_run");
  assert.equal(supabase.store.tax_classification_runs.length, 1);
  assert.equal(supabase.store.tax_classification_runs[0].trigger_source, TAX_CLASSIFICATION_TRIGGER_SOURCES.PROFILE_COMPLETED);
  assert.equal(supabase.store.tax_classification_runs[0].total_eligible, 205);
});

test("onboarding profile completion enqueues one idempotent historical classification run", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 205 }));
  const before = completeProfile({ self_employment_tax_applies: null });
  const after = completeProfile({ self_employment_tax_applies: true, source: "onboarding" });

  const first = await handleTaxClassificationEvent({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    changeType: TAX_CHANGE_TYPES.PROFILE_UPDATED,
    entityId: "profile-1",
    userId: "user-1",
    metadata: { before, after, source: "onboarding" },
  });
  const second = await handleTaxClassificationEvent({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    changeType: TAX_CHANGE_TYPES.PROFILE_UPDATED,
    entityId: "profile-1",
    userId: "user-1",
    metadata: { before, after, source: "onboarding" },
  });

  assert.equal(first?.queued, true);
  assert.equal(second?.queued, false);
  assert.equal(supabase.store.tax_classification_runs.length, 1);
  assert.equal(supabase.store.tax_classification_runs[0].trigger_source, TAX_CLASSIFICATION_TRIGGER_SOURCES.ONBOARDING_PROFILE_COMPLETED);
  assert.equal(supabase.store.tax_classification_runs[0].total_eligible, 205);
});

test("worker processes a 205-row production-shaped run in bounded batches and blocks calculation without verified standard deduction rule", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 205 }));
  const queued = await enqueueTaxClassificationRun({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.USER_PREPARE,
    now: new Date("2026-09-04T12:00:00Z"),
  });
  const startedAt = Date.now();

  let sweeps = 0;
  while (true) {
    sweeps += 1;
    await processPendingTaxClassificationRuns({
      supabase,
      workerId: "test-worker",
      runBatchSize: 1,
      transactionBatchSize: 50,
      now: new Date(Date.UTC(2026, 8, 4, 12, 0, sweeps * 15)),
    });
    const run = supabase.store.tax_classification_runs.find((row) => row.id === queued.run.id);
    if ([TAX_CLASSIFICATION_RUN_STATUSES.COMPLETED, TAX_CLASSIFICATION_RUN_STATUSES.REVIEW_REQUIRED, TAX_CLASSIFICATION_RUN_STATUSES.DEAD_LETTER].includes(run.status)) break;
    assert.ok(sweeps < 10, "worker should finish 205 rows in five bounded 50-row sweeps");
  }

  const durationMs = Date.now() - startedAt;
  const lifecycle = await getTaxClassificationLifecycleStatus({ supabase, businessId: BUSINESS_ID, taxYear: 2026 });
  const finalRun = supabase.store.tax_classification_runs.find((row) => row.id === queued.run.id);
  const classifiedRows = supabase.store.transaction_tax_classifications.filter((row) => row.business_id === BUSINESS_ID);

  assert.equal(classifiedRows.length, 205);
  assert.equal(lifecycle.unclassifiedCount, 0);
  assert.equal(lifecycle.autoClassifiedCount, 103);
  assert.equal(lifecycle.needsReviewCount, 102);
  assert.equal(lifecycle.classificationStatus, "classification_review_required");
  assert.equal(finalRun.status, TAX_CLASSIFICATION_RUN_STATUSES.REVIEW_REQUIRED);
  assert.equal(finalRun.processed_count, 205);
  assert.equal(finalRun.auto_classified_count, 103);
  assert.equal(finalRun.review_required_count, 102);
  assert.equal(supabase.store.tax_recalculation_requests.length, 0);
  assert.ok(durationMs < 5000, `local 205-row fixture should process quickly; observed ${durationMs}ms`);
});

test("new QBO-confirmed posting event enqueues classification and calculation prerequisites expose missing standard deduction rule", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 1, includeOtherTenantTransaction: true }));

  const queued = await handleTaxClassificationEvent({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    changeType: TAX_CHANGE_TYPES.QBO_TRANSACTION_POSTED,
    entityId: "txn-001",
    metadata: { source: "books_post_worker" },
    now: new Date("2026-09-04T12:00:00Z"),
  });
  const prerequisites = await evaluateTaxCalculationPrerequisites({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-09-04",
  });

  assert.equal(queued?.queued, true);
  assert.equal(supabase.store.tax_classification_runs.length, 1);
  assert.equal(supabase.store.tax_classification_runs[0].business_id, BUSINESS_ID);
  assert.equal(prerequisites.ready, false);
  assert.equal(prerequisites.blocker, "classification_in_progress");

  await processPendingTaxClassificationRuns({
    supabase,
    workerId: "test-worker",
    runBatchSize: 1,
    transactionBatchSize: 50,
    now: new Date("2026-09-04T12:00:00Z"),
  });
  const afterClassification = await evaluateTaxCalculationPrerequisites({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-09-04",
  });

  assert.equal(afterClassification.ready, false);
  assert.equal(afterClassification.blocker, "standard_deduction_rule_missing");
  assert.equal(supabase.store.transaction_tax_classifications.some((row) => row.business_id === OTHER_BUSINESS_ID), false);
});

function baseStore({ transactionCount = 0, includeOtherTenantTransaction = false } = {}) {
  const store = {
    business_profiles: [{ id: BUSINESS_ID, bookkeeping_start_date: null }],
    bank_transactions: [],
    transaction_categorizations: [],
    qbo_posted_transactions: [],
    transaction_tax_classifications: [],
    tax_classification_runs: [],
    tax_recalculation_requests: [],
    tax_profiles: [completeProfile()],
    tax_deduction_rules: [softwareRule(), mealsRule()],
    tax_rule_configs: [],
  };
  for (let i = 0; i < transactionCount; i += 1) {
    const id = `txn-${String(i + 1).padStart(3, "0")}`;
    const accountName = i % 2 === 0 ? "Software" : "Meals";
    store.bank_transactions.push(bankTxn({ id, name: `${accountName} vendor ${i + 1}` }));
    store.transaction_categorizations.push(categorization({
      id: `cat-${id}`,
      transaction_id: id,
      final_qbo_account_name: accountName,
      qbo_txn_id: `qbo-${id}`,
    }));
    store.qbo_posted_transactions.push(qboPosted({ id: `qbo-row-${id}`, transaction_id: id, qbo_txn_id: `qbo-${id}` }));
  }
  if (includeOtherTenantTransaction) {
    store.business_profiles.push({ id: OTHER_BUSINESS_ID, bookkeeping_start_date: null });
    store.bank_transactions.push(bankTxn({ id: "other-txn", business_id: OTHER_BUSINESS_ID }));
    store.transaction_categorizations.push(categorization({ id: "other-cat", business_id: OTHER_BUSINESS_ID, transaction_id: "other-txn" }));
    store.qbo_posted_transactions.push(qboPosted({ id: "other-qbo", business_id: OTHER_BUSINESS_ID, transaction_id: "other-txn", qbo_txn_id: "other-qbo-id" }));
  }
  return store;
}

function completeProfile(overrides = {}) {
  return {
    id: "profile-1",
    business_id: BUSINESS_ID,
    tax_year: 2026,
    entity_type: "sole_proprietor",
    filing_status: "single",
    primary_tax_state: "NC",
    accounting_method: "cash",
    safe_harbor_method: "current_year_90",
    self_employment_tax_applies: true,
    profile_status: "active",
    created_at: "2026-09-04T00:00:00Z",
    updated_at: "2026-09-04T00:00:00Z",
    ...overrides,
  };
}

function bankTxn(overrides = {}) {
  return {
    id: "txn-001",
    business_id: BUSINESS_ID,
    pending: false,
    date: "2026-08-15",
    name: "Software vendor",
    merchant_name: "Software vendor",
    counterparty_name: "Software vendor",
    amount: 25,
    signed_amount: -25,
    direction: "OUTFLOW",
    is_archived: false,
    created_at: "2026-08-15T00:00:00Z",
    ...overrides,
  };
}

function categorization(overrides = {}) {
  return {
    id: "cat-txn-001",
    business_id: BUSINESS_ID,
    transaction_id: "txn-001",
    status: "posted",
    final_qbo_account_id: "acct-1",
    final_qbo_account_name: "Software",
    qbo_txn_id: "qbo-txn-001",
    qbo_txn_type: "Purchase",
    posted_at: "2026-08-15T12:00:00Z",
    meta: { taxonomy_type: "ordinary_expense" },
    is_archived: false,
    ...overrides,
  };
}

function qboPosted(overrides = {}) {
  return {
    id: "qbo-row-txn-001",
    business_id: BUSINESS_ID,
    transaction_id: "txn-001",
    qbo_txn_type: "Purchase",
    qbo_txn_id: "qbo-txn-001",
    status: "posted",
    posted_at: "2026-08-15T12:00:00Z",
    ...overrides,
  };
}

function softwareRule() {
  return rule({
    id: "software-rule",
    rule_code: "software",
    tax_category: "software",
    bookkeeping_category: "Software",
    deductibility_status: "fully_deductible",
    default_deductible_percent: 1,
    priority: 10,
  });
}

function mealsRule() {
  return rule({
    id: "meals-rule",
    rule_code: "meals_requires_review",
    tax_category: "meals",
    bookkeeping_category: "Meals",
    deductibility_status: "partially_deductible",
    default_deductible_percent: 0.5,
    requires_review: true,
    priority: 20,
  });
}

function rule(overrides = {}) {
  return {
    id: "rule-1",
    business_id: null,
    scope: "global",
    rule_code: "software",
    tax_year: 2026,
    jurisdiction: "federal",
    entity_type: null,
    bookkeeping_category: "Software",
    qbo_account_type: null,
    qbo_account_subtype: null,
    tax_category: "software",
    deductibility_status: "fully_deductible",
    default_deductible_percent: 1,
    treatment: { type: "ordinary_expense" },
    match_conditions: {},
    priority: 100,
    version: "tax-classification-v1",
    support_level: "verified",
    source_reference: "test verified rule",
    source_url: "https://example.test/tax-rule",
    verified_at: "2026-01-01T00:00:00Z",
    effective_from: "2026-01-01",
    effective_to: "2026-12-31",
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeSupabase(store) {
  return {
    store,
    from(table) {
      store[table] ||= [];
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
    this.rows = this.rows.filter((row) => String(row[field]) === String(value));
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
    const set = new Set((values || []).map(String));
    this.rows = this.rows.filter((row) => set.has(String(row[field])));
    return this;
  }
  order(field, options = {}) {
    const dir = options.ascending === false ? -1 : 1;
    this.rows = [...this.rows].sort((a, b) => {
      const av = a[field] ?? "";
      const bv = b[field] ?? "";
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
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
  insert(row) {
    const rows = Array.isArray(row) ? row : [row];
    this.rows = rows.map((item, index) => ({ id: item.id || `${this.table}-${this.store[this.table].length + index + 1}`, ...item }));
    this.store[this.table].push(...this.rows);
    return this;
  }
  update(patch) {
    this.patch = patch;
    return this;
  }
  upsert(row) {
    const rows = this.store[this.table];
    const idx = rows.findIndex((existing) =>
      String(existing.business_id) === String(row.business_id) &&
      String(existing.transaction_id) === String(row.transaction_id) &&
      String(existing.tax_year) === String(row.tax_year)
    );
    if (idx >= 0) rows[idx] = { ...rows[idx], ...row };
    else rows.push(row);
    this.rows = [idx >= 0 ? rows[idx] : row];
    return this;
  }
  maybeSingle() {
    this.applyPatch();
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  single() {
    this.applyPatch();
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  then(resolve) {
    this.applyPatch();
    return Promise.resolve({ data: this.rows, error: null }).then(resolve);
  }
  applyPatch() {
    if (!this.patch) return;
    const ids = new Set(this.rows.map((row) => row.id));
    this.store[this.table] = this.store[this.table].map((row) => ids.has(row.id) ? { ...row, ...this.patch } : row);
    this.rows = this.store[this.table].filter((row) => ids.has(row.id));
    this.patch = null;
  }
}
