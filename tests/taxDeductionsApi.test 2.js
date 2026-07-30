/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

import {
  buildCpaPackage,
  getDeductionCategoryDetail,
  getDeductionTransactionDetail,
  getDeductionsOverview,
  listDeductionTransactions,
  normalizeDeductionPagination,
  validateDeductionTransactionFilters,
} from "../src/services/tax/taxDeductionsApi.service.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";

test("canonical overview returns setup state and totals without fake data", async () => {
  const noData = await getDeductionsOverview({ supabase: makeSupabase(emptyStore()), businessId: BUSINESS_ID, taxYear: 2026 });
  assert.equal(noData.setupState.state, "no_posted_transactions");
  assert.equal(noData.totals.estimatedDeductibleAmount, 0);

  const overview = await getDeductionsOverview({ supabase: makeSupabase(baseStore()), businessId: BUSINESS_ID, taxYear: 2026, asOfDate: "2026-12-31" });
  assert.equal(overview.totals.estimatedDeductibleAmount, 100);
  assert.equal(overview.coverage.classifiedCount, 2);
  assert.equal(overview.setupState.state, "needs_review");
});

test("transaction drill-down filters by month, category, and status with pagination metadata", async () => {
  const result = await listDeductionTransactions({
    supabase: makeSupabase(baseStore()),
    businessId: BUSINESS_ID,
    taxYear: 2026,
    filters: validateDeductionTransactionFilters({ month: "2026-01", taxCategory: "bank_fees", classificationStatus: "user_confirmed" }),
    pagination: { limit: 10, offset: 0 },
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].transactionId, "txn-1");
  assert.equal(result.rows[0].raw, undefined);
  assert.equal(result.rows[0].payload, undefined);
  assert.equal(result.availableFilters.taxCategories.includes("bank_fees"), true);
});

test("transaction detail includes safe source trace and override history", async () => {
  const detail = await getDeductionTransactionDetail({ supabase: makeSupabase(baseStore()), businessId: BUSINESS_ID, taxYear: 2026, transactionId: "txn-1" });
  assert.equal(detail.transaction.transactionId, "txn-1");
  assert.equal(detail.overrideHistory.length, 1);
  assert.equal(detail.sourceTrace.some((step) => step.step === "qbo_posting"), true);
  assert.equal(JSON.stringify(detail).includes("raw_secret"), false);
});

test("wrong-business transaction cannot be fetched", async () => {
  await assert.rejects(
    () => getDeductionTransactionDetail({ supabase: makeSupabase(baseStore()), businessId: BUSINESS_ID, taxYear: 2026, transactionId: "other-business-txn" }),
    (err) => err.code === "tax_deduction_transaction_not_found"
  );
});

test("category detail totals match transaction rows", async () => {
  const detail = await getDeductionCategoryDetail({ supabase: makeSupabase(baseStore()), businessId: BUSINESS_ID, taxYear: 2026, taxCategory: "bank_fees" });
  assert.equal(detail.transactionCount, 1);
  assert.equal(detail.totals.estimatedDeductibleAmount, 100);
  assert.equal(detail.recentTransactions[0].taxCategory, "bank_fees");
});

test("CPA package contains safe fields only", async () => {
  const pkg = await buildCpaPackage({ supabase: makeSupabase(baseStore()), businessId: BUSINESS_ID, taxYear: 2026, includeHistory: true });
  assert.equal(pkg.metadata.source, "transaction_tax_classifications");
  assert.equal(pkg.generationAudit.rawPayloadsIncluded, false);
  assert.equal(pkg.transactions.find((row) => row.transactionId === "txn-1").overrideHistory.length, 1);
  assert.equal(JSON.stringify(pkg).includes("raw_secret"), false);
});

test("invalid filters and pagination are rejected", async () => {
  assert.throws(() => validateDeductionTransactionFilters({ month: "2026-1" }), /month must be YYYY-MM/);
  assert.throws(() => validateDeductionTransactionFilters({ minAmount: "abc" }), /finite number/);
  assert.throws(() => validateDeductionTransactionFilters({ sort: "bad" }), /Unsupported/);
  assert.throws(() => normalizeDeductionPagination({ limit: 201 }), /1 to 200/);
});

test("RPC drill-down handles more than 2000 classifications with deterministic pages and SQL-style filters", async () => {
  const supabase = makeRpcSupabase(largeStore(2105));
  const page1 = await listDeductionTransactions({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    filters: validateDeductionTransactionFilters({ sort: "date_desc" }),
    pagination: { limit: 50, offset: 0 },
  });
  const page2 = await listDeductionTransactions({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    filters: validateDeductionTransactionFilters({ sort: "date_desc" }),
    pagination: { limit: 50, offset: 50 },
  });
  assert.equal(page1.pagination.total, 2105);
  assert.equal(page1.rows.length, 50);
  assert.equal(page2.rows.length, 50);
  assert.equal(new Set(page1.rows.map((row) => row.transactionId)).size, 50);
  assert.equal(page1.rows.some((row) => page2.rows.find((other) => other.transactionId === row.transactionId)), false);
  assert.equal(page1.rows[0].raw, undefined);
  assert.equal(page1.rows[0].payload, undefined);

  const filtered = await listDeductionTransactions({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    filters: validateDeductionTransactionFilters({
      month: "2026-03",
      taxCategory: "meals",
      classificationStatus: "needs_review",
      deductibilityStatus: "partially_deductible",
      minAmount: 25,
      maxAmount: 250,
    }),
    pagination: { limit: 50, offset: 0 },
  });
  assert.equal(filtered.rows.every((row) => row.date.startsWith("2026-03")), true);
  assert.equal(filtered.rows.every((row) => row.taxCategory === "meals"), true);
  assert.equal(filtered.rows.every((row) => row.classificationStatus === "needs_review"), true);
  assert.equal(filtered.rows.every((row) => row.absoluteAmount >= 25 && row.absoluteAmount <= 250), true);
  assert.equal(filtered.pagination.total >= filtered.rows.length, true);
  assert.equal(filtered.pagination.total, 176);

  const search = await listDeductionTransactions({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    filters: validateDeductionTransactionFilters({ search: "needle vendor" }),
    pagination: { limit: 50, offset: 0 },
  });
  assert.equal(search.rows.length, 1);
  assert.equal(search.rows[0].merchantName, "Needle Vendor");
});

test("deductions routes preserve auth/business authorization and CSV export safety code", () => {
  const routes = readFileSync("src/api/tax/deductions.routes.js", "utf8");
  const exportHandler = readFileSync("src/api/tax/deductionsExport.js", "utf8");
  assert.match(routes, /assertTaxBusinessAccess/);
  assert.match(routes, /router\.get\("\/overview"/);
  assert.match(routes, /router\.get\("\/transactions"/);
  assert.match(routes, /router\.get\("\/categories\/:taxCategory"/);
  assert.match(exportHandler, /summary_csv/);
  assert.match(exportHandler, /transactions_csv/);
  assert.match(exportHandler, /review_csv/);
  assert.match(exportHandler, /cpa_package_json/);
  assert.match(exportHandler, /\^\[=\+\\-@\]/);
});

test("internal upsert endpoint is locked down for ordinary users", async () => {
  const { default: deductionsUpsertHandler } = await import("../src/api/tax/deductionsUpsert.js");
  const res = makeRes();
  await deductionsUpsertHandler({
    method: "POST",
    headers: {},
    user: { id: "user-1", role: "user" },
    body: { businessId: BUSINESS_ID, payload: [] },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "forbidden_internal_tax_sync_only");
});

function emptyStore() {
  return {
    bank_transactions: [],
    transaction_categorizations: [],
    qbo_posted_transactions: [],
    transaction_tax_classifications: [],
    tax_classification_overrides: [],
    tax_review_tasks: [],
    tax_profiles: [],
    tax_rule_configs: [],
    expense_totals_monthly: [],
  };
}

function baseStore() {
  return {
    ...emptyStore(),
    bank_transactions: [
      bankTxn({ id: "txn-1", date: "2026-01-15", signed_amount: -100, raw: { secret: "raw_secret" } }),
      bankTxn({ id: "txn-2", date: "2026-02-15", signed_amount: -50, name: "=Formula Vendor" }),
      bankTxn({ id: "other-business-txn", business_id: OTHER_BUSINESS_ID, date: "2026-01-15" }),
    ],
    transaction_categorizations: [
      cat({ transaction_id: "txn-1" }),
      cat({ transaction_id: "txn-2" }),
      cat({ transaction_id: "other-business-txn", business_id: OTHER_BUSINESS_ID }),
    ],
    transaction_tax_classifications: [
      classification({ id: "class-1", transaction_id: "txn-1", transaction_date: "2026-01-15", classification_status: "user_confirmed", tax_category: "bank_fees", deductible_amount: 100, book_amount: -100, source_qbo_account_name: "Bank Fees" }),
      classification({ id: "class-2", transaction_id: "txn-2", transaction_date: "2026-02-15", classification_status: "needs_review", tax_category: "unclassified", deductibility_status: "needs_review", deductible_amount: 0, book_amount: -50, requires_review: true }),
      classification({ id: "class-other", business_id: OTHER_BUSINESS_ID, transaction_id: "other-business-txn", transaction_date: "2026-01-15", classification_status: "user_confirmed" }),
    ],
    tax_classification_overrides: [
      {
        id: "override-1",
        business_id: BUSINESS_ID,
        transaction_id: "txn-1",
        tax_year: 2026,
        classification_id: "class-1",
        previous_values: { tax_category: "unclassified" },
        new_values: { tax_category: "bank_fees" },
        override_source: "user",
        override_reason: "Confirmed",
        overridden_by: "user-1",
        created_at: "2026-01-16T00:00:00Z",
      },
    ],
    tax_review_tasks: [
      {
        id: "review-1",
        business_id: BUSINESS_ID,
        transaction_id: "txn-2",
        tax_year: 2026,
        reason_code: "no_matching_rule",
        severity: "medium",
        status: "open",
      },
    ],
    tax_profiles: [
      {
        id: "profile-1",
        business_id: BUSINESS_ID,
        tax_year: 2026,
        entity_type: "sole_proprietor",
        filing_status: "single",
        primary_tax_state: "NC",
        accounting_method: "cash",
        safe_harbor_method: "current_year_90",
        profile_status: "active",
      },
    ],
  };
}

function largeStore(count) {
  const store = emptyStore();
  for (let i = 0; i < count; i += 1) {
    const month = (i % 12) + 1;
    const day = (i % 27) + 1;
    const id = `large-${String(i).padStart(5, "0")}`;
    const isNeedle = i === 1234;
    const date = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const mealsReview = month === 3 && i % 2 === 0;
    store.bank_transactions.push(bankTxn({
      id,
      date,
      signed_amount: -((i % 180) + 25),
      merchant_name: isNeedle ? "Needle Vendor" : `Vendor ${i % 20}`,
      name: isNeedle ? "Needle vendor charge" : `Charge ${i}`,
      raw: { secret: "raw_secret" },
    }));
    store.transaction_tax_classifications.push(classification({
      id: `class-${id}`,
      transaction_id: id,
      transaction_date: date,
      tax_category: mealsReview ? "meals" : "bank_fees",
      classification_status: mealsReview ? "needs_review" : "user_confirmed",
      deductibility_status: mealsReview ? "partially_deductible" : "fully_deductible",
      deductible_percent: mealsReview ? 50 : 100,
      book_amount: -((i % 180) + 25),
      deductible_amount: mealsReview ? (((i % 180) + 25) * 0.5) : ((i % 180) + 25),
      nondeductible_amount: mealsReview ? (((i % 180) + 25) * 0.5) : 0,
      confidence_score: mealsReview ? 55 : 95,
      confidence_level: mealsReview ? "low" : "high",
      requires_review: mealsReview,
      updated_at: `2026-12-31T00:${String(i % 60).padStart(2, "0")}:00Z`,
    }));
  }
  store.bank_transactions.push(bankTxn({ id: "wrong-business-large", business_id: OTHER_BUSINESS_ID, date: "2026-12-31" }));
  store.transaction_tax_classifications.push(classification({ id: "class-wrong-business-large", business_id: OTHER_BUSINESS_ID, transaction_id: "wrong-business-large", transaction_date: "2026-12-31" }));
  return store;
}

function bankTxn(overrides = {}) {
  return {
    id: "txn-1",
    business_id: BUSINESS_ID,
    pending: false,
    is_archived: false,
    date: "2026-01-15",
    authorized_date: "2026-01-14",
    name: "Vendor",
    merchant_name: "Vendor",
    counterparty_name: "Vendor LLC",
    signed_amount: -100,
    amount: 100,
    direction: "OUTFLOW",
    raw: null,
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
    final_qbo_account_id: "acct-1",
    final_qbo_account_name: "Bank Fees",
    posted_at: "2026-01-16T00:00:00Z",
    meta: {},
    ...overrides,
  };
}

function classification(overrides = {}) {
  return {
    id: "class-1",
    business_id: BUSINESS_ID,
    transaction_id: "txn-1",
    tax_year: 2026,
    transaction_date: "2026-01-15",
    tax_category: "bank_fees",
    deductibility_status: "fully_deductible",
    deductible_percent: 100,
    book_amount: -100,
    deductible_amount: 100,
    nondeductible_amount: 0,
    capitalizable_amount: 0,
    tax_treatment: { type: "ordinary_expense" },
    classification_status: "auto_classified",
    confidence_score: 95,
    confidence_level: "high",
    rule_id: "rule-1",
    rule_code: "bank_fees",
    reason: "Matched bank fees rule.",
    requires_review: false,
    source_qbo_txn_id: "qbo-1",
    source_qbo_txn_type: "Expense",
    source_qbo_account_id: "acct-1",
    source_qbo_account_name: "Bank Fees",
    metadata: { source_truth: { bankTransaction: true }, source_warnings: [] },
    created_at: "2026-01-16T00:00:00Z",
    updated_at: "2026-01-16T00:00:00Z",
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

function makeRpcSupabase(store) {
  return {
    store,
    from(table) {
      return new Query(table, store);
    },
    rpc(name, params) {
      if (name !== "get_tax_deduction_transaction_drilldown") return Promise.resolve({ data: null, error: { message: "function does not exist" } });
      return Promise.resolve({ data: rpcDrilldown(store, params), error: null });
    },
  };
}

function rpcDrilldown(store, params) {
  const limit = Math.min(Math.max(Number(params.p_limit || 50), 1), 200);
  const offset = Math.max(Number(params.p_offset || 0), 0);
  const taxYear = Number(params.p_tax_year);
  const asOfDate = params.p_as_of_date || `${taxYear}-12-31`;
  const banks = new Map(store.bank_transactions.filter((row) => row.business_id === params.p_business_id && !row.pending && !row.is_archived).map((row) => [row.id, row]));
  let rows = store.transaction_tax_classifications
    .filter((c) => c.business_id === params.p_business_id && c.tax_year === taxYear)
    .map((c) => ({ c, b: banks.get(c.transaction_id) }))
    .filter((row) => row.b)
    .filter((row) => rowDate(row) <= asOfDate && rowDate(row).startsWith(`${taxYear}-`));
  if (params.p_month) rows = rows.filter((row) => rowDate(row).startsWith(params.p_month));
  if (params.p_tax_category) rows = rows.filter((row) => row.c.tax_category === params.p_tax_category);
  if (params.p_deductibility_status) rows = rows.filter((row) => row.c.deductibility_status === params.p_deductibility_status);
  if (params.p_classification_status) rows = rows.filter((row) => row.c.classification_status === params.p_classification_status);
  if (params.p_confidence_level) rows = rows.filter((row) => row.c.confidence_level === params.p_confidence_level);
  if (params.p_qbo_account_id) rows = rows.filter((row) => row.c.source_qbo_account_id === params.p_qbo_account_id);
  if (params.p_min_amount != null) rows = rows.filter((row) => Math.abs(Number(row.c.book_amount || 0)) >= Number(params.p_min_amount));
  if (params.p_max_amount != null) rows = rows.filter((row) => Math.abs(Number(row.c.book_amount || 0)) <= Number(params.p_max_amount));
  if (params.p_search) {
    const needle = String(params.p_search).toLowerCase();
    rows = rows.filter((row) => [row.b.name, row.b.merchant_name, row.b.counterparty_name, row.c.source_qbo_account_name, row.c.tax_category].some((value) => String(value || "").toLowerCase().includes(needle)));
  }
  rows = sortRpcRows(rows, params.p_sort || "date_desc");
  const paged = rows.slice(offset, offset + limit);
  return {
    rows: paged.map(rpcRow),
    pagination: { limit, offset, returned: paged.length, total: rows.length, hasMore: offset + limit < rows.length },
    totalsForFilter: rows.reduce((acc, row) => {
      acc.bookAmount += Math.abs(Number(row.c.book_amount || 0));
      acc.deductibleAmount += Number(row.c.deductible_amount || 0);
      acc.nondeductibleAmount += Number(row.c.nondeductible_amount || 0);
      acc.capitalizableAmount += Number(row.c.capitalizable_amount || 0);
      if (row.c.requires_review || row.c.classification_status === "needs_review") acc.needsReviewAmount += Math.abs(Number(row.c.book_amount || 0));
      return acc;
    }, { bookAmount: 0, deductibleAmount: 0, nondeductibleAmount: 0, capitalizableAmount: 0, needsReviewAmount: 0 }),
    availableFilters: {
      taxCategories: [...new Set(rows.map((row) => row.c.tax_category))],
      classificationStatuses: [...new Set(rows.map((row) => row.c.classification_status))],
      deductibilityStatuses: [...new Set(rows.map((row) => row.c.deductibility_status))],
      qboAccounts: [{ id: "acct-1", name: "Bank Fees" }],
      months: [...new Set(rows.map((row) => rowDate(row).slice(0, 7)))],
      confidenceLevels: [...new Set(rows.map((row) => row.c.confidence_level))],
    },
    warnings: [],
  };
}

function rpcRow({ c, b }) {
  return {
    transactionId: c.transaction_id,
    date: rowDate({ c, b }),
    description: b.name,
    merchantName: b.merchant_name,
    counterpartyName: b.counterparty_name,
    signedAmount: c.book_amount,
    absoluteAmount: Math.abs(Number(c.book_amount || 0)),
    direction: b.direction,
    qboAccountId: c.source_qbo_account_id,
    qboAccountName: c.source_qbo_account_name,
    qboTxnId: c.source_qbo_txn_id,
    qboTxnType: c.source_qbo_txn_type,
    taxCategory: c.tax_category,
    deductibilityStatus: c.deductibility_status,
    deductiblePercent: c.deductible_percent,
    deductibleAmount: c.deductible_amount,
    nondeductibleAmount: c.nondeductible_amount,
    capitalizableAmount: c.capitalizable_amount,
    taxTreatment: c.tax_treatment,
    classificationStatus: c.classification_status,
    confidenceScore: c.confidence_score,
    confidenceLevel: c.confidence_level,
    rule: { id: c.rule_id, code: c.rule_code, explanation: c.reason, supportLevel: c.metadata?.rule_support_level || null },
    reason: c.reason,
    warnings: [],
    requiresReview: c.requires_review || c.classification_status === "needs_review",
    override: { hasOverride: false, source: c.source, lastChangedAt: null },
    sourceTruth: c.metadata?.source_truth || null,
    postedAt: null,
    classifiedAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

function rowDate({ c, b }) {
  return c.transaction_date || b.date;
}

function sortRpcRows(rows, sort) {
  const byDate = (a, b) => rowDate(a).localeCompare(rowDate(b)) || String(a.c.updated_at || "").localeCompare(String(b.c.updated_at || "")) || String(a.c.id).localeCompare(String(b.c.id));
  if (sort === "date_asc") return [...rows].sort(byDate);
  if (sort === "amount_desc") return [...rows].sort((a, b) => Math.abs(b.c.book_amount) - Math.abs(a.c.book_amount) || byDate(b, a));
  if (sort === "amount_asc") return [...rows].sort((a, b) => Math.abs(a.c.book_amount) - Math.abs(b.c.book_amount) || byDate(b, a));
  if (sort === "confidence_asc") return [...rows].sort((a, b) => Number(a.c.confidence_score || 0) - Number(b.c.confidence_score || 0) || byDate(b, a));
  if (sort === "confidence_desc") return [...rows].sort((a, b) => Number(b.c.confidence_score || 0) - Number(a.c.confidence_score || 0) || byDate(b, a));
  if (sort === "updated_desc") return [...rows].sort((a, b) => String(b.c.updated_at || "").localeCompare(String(a.c.updated_at || "")) || rowDate(b).localeCompare(rowDate(a)) || String(b.c.id).localeCompare(String(a.c.id)));
  return [...rows].sort((a, b) => byDate(b, a));
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
  order(field, options = {}) {
    const dir = options.ascending === false ? -1 : 1;
    this.rows = [...this.rows].sort((a, b) => String(a[field] || "").localeCompare(String(b[field] || "")) * dir);
    return this;
  }
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

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key] = value; },
    set(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
}
