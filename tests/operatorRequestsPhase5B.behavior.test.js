import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getPersistedClarificationRequestIds,
  isClarificationAnswerPersisted,
  summarizeClarificationSubmitFailure,
} from "../src/services/bookkeeping/clarificationSubmitResult.js";

process.env.SUPABASE_URL ||= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const { processClarificationAnswers } = await import("../src/services/bookkeeping/clarificationService.js");

const BUSINESS_ID = "biz-1";
const USER_ID = "user-1";

function baseStore(overrides = {}) {
  return {
    business_profiles: [{ id: BUSINESS_ID, bookkeeping_start_date: null }],
    clarification_requests: [
      {
        id: "req-1",
        business_id: BUSINESS_ID,
        transaction_id: "txn-1",
        status: "pending",
        prompt_text: "What was this for?",
        meta: {},
        resolved_at: null,
      },
    ],
    transaction_categorizations: [
      {
        business_id: BUSINESS_ID,
        transaction_id: "txn-1",
        status: "needs_review",
        meta: {},
        final_qbo_account_id: null,
        final_qbo_account_name: null,
        post_after: null,
      },
    ],
    qboWrites: [],
    ...overrides,
  };
}

function txn(id = "txn-1", extra = {}) {
  return {
    id,
    business_id: BUSINESS_ID,
    date: "2026-08-22",
    is_archived: false,
    pending: false,
    accounting_review_required: false,
    name: "Apple",
    merchant_name: "Apple",
    counterparty_name: "Apple",
    amount: -2.99,
    direction: "OUTFLOW",
    ...extra,
  };
}

class Query {
  constructor(store, table) {
    this.store = store;
    this.table = table;
    this.filters = [];
    this.inFilters = [];
    this.payload = null;
    this.mode = "select";
  }

  select() { return this; }
  order() { return this; }
  limit() { return this; }
  gte(column, value) { this.filters.push([column, ">=", value]); return this; }
  lt(column, value) { this.filters.push([column, "<", value]); return this; }
  is(column, value) { this.filters.push([column, "is", value]); return this; }
  eq(column, value) { this.filters.push([column, "=", value]); return this; }
  in(column, values) { this.inFilters.push([column, new Set((values || []).map(String))]); return this; }
  update(payload) { this.mode = "update"; this.payload = payload; return this; }
  upsert(payload) { this.mode = "upsert"; this.payload = payload; return this; }

  _rows() {
    return (this.store[this.table] || []).filter((row) => {
      const matchesEq = this.filters.every(([column, op, value]) => {
        if (op === "=") return String(row[column]) === String(value);
        if (op === "is") return row[column] === value;
        if (op === ">=") return String(row[column]) >= String(value);
        if (op === "<") return String(row[column]) < String(value);
        return true;
      });
      if (!matchesEq) return false;
      return this.inFilters.every(([column, values]) => values.has(String(row[column])));
    });
  }

  _applyWrite() {
    if (this.mode === "update") {
      const rows = this._rows();
      rows.forEach((row) => Object.assign(row, this.payload));
      return rows;
    }
    if (this.mode === "upsert") {
      const rows = this.store[this.table] || [];
      const payload = { ...this.payload };
      const existing = rows.find((row) => {
        if (this.table === "clarification_requests") {
          return row.business_id === payload.business_id && row.transaction_id === payload.transaction_id;
        }
        if (this.table === "transaction_categorizations") {
          return row.business_id === payload.business_id && row.transaction_id === payload.transaction_id;
        }
        return false;
      });
      if (existing) {
        Object.assign(existing, payload);
        return [existing];
      }
      if (!payload.id && this.table === "clarification_requests") payload.id = `req-${rows.length + 1}`;
      rows.push(payload);
      this.store[this.table] = rows;
      return [payload];
    }
    return this._rows();
  }

  async maybeSingle() {
    const rows = this._applyWrite();
    return { data: rows[0] || null, error: null };
  }

  async then(resolve, reject) {
    try {
      const rows = this._applyWrite();
      resolve({ data: rows, error: null, count: rows.length });
    } catch (error) {
      reject(error);
    }
  }
}

function createDb(store) {
  return {
    store,
    from(table) {
      return new Query(store, table);
    },
  };
}

async function submit(store, answers, options = {}) {
  const db = createDb(store);
  return processClarificationAnswers({
    businessId: BUSINESS_ID,
    answers,
    answeredByUserId: USER_ID,
    db,
    resolveTxn: options.resolveTxn || (async ({ transactionId }) => ({
      originalTxnId: transactionId,
      canonicalTxnId: transactionId,
      txn: txn(transactionId, options.txn || {}),
      wasRemapped: false,
    })),
    mapAnswer: options.mapAnswer || (async () => null),
    refreshSummary: options.refreshSummary || (async () => ({ ok: true })),
  });
}

test("Phase 5B successful single answer persists answered state without accounting or QBO mutation", async () => {
  const store = baseStore();
  const result = await submit(store, [{ request_id: "req-1", transaction_id: "txn-1", answer_text: "software subscription" }]);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, "all_succeeded");
  assert.equal(result.successful_count, 1);
  assert.equal(result.rows[0].persisted, true);
  assert.equal(store.clarification_requests[0].status, "answered");
  assert.equal(store.clarification_requests[0].answer_text, "software subscription");
  assert.equal(store.clarification_requests[0].resolved_at, null);
  assert.equal(store.transaction_categorizations[0].status, "needs_review");
  assert.equal(store.transaction_categorizations[0].final_qbo_account_id, null);
  assert.equal(store.transaction_categorizations[0].post_after, null);
  assert.deepEqual(store.qboWrites, []);
});

test("Phase 5B invalid answer fails authoritatively and leaves request pending", async () => {
  const store = baseStore();
  const result = await submit(store, [{ request_id: "req-1", transaction_id: "txn-1", answer_text: "x" }]);

  assert.equal(result.ok, false);
  assert.equal(result.outcome, "all_failed");
  assert.equal(result.rows[0].error, "invalid_answer_length");
  assert.equal(store.clarification_requests[0].status, "pending");
  assert.equal(store.clarification_requests[0].answer_text, undefined);
});

test("Phase 5B transaction no longer Needs Review fails without answered state", async () => {
  const store = baseStore({
    transaction_categorizations: [{ business_id: BUSINESS_ID, transaction_id: "txn-1", status: "approved", meta: {} }],
  });
  const result = await submit(store, [{ request_id: "req-1", transaction_id: "txn-1", answer_text: "materials" }]);

  assert.equal(result.ok, false);
  assert.equal(result.rows[0].error, "transaction_not_needs_review");
  assert.equal(store.clarification_requests[0].status, "pending");
});

test("Phase 5B provisional transaction id materializes one request and persists the answer", async () => {
  const store = baseStore({ clarification_requests: [] });
  const result = await submit(store, [{ request_id: "txn-1", transaction_id: "txn-1", answer_text: "materials" }]);

  assert.equal(result.ok, true);
  assert.equal(store.clarification_requests.length, 1);
  assert.equal(store.clarification_requests[0].transaction_id, "txn-1");
  assert.equal(store.clarification_requests[0].status, "answered");
  assert.equal(store.clarification_requests[0].meta.source, "operator_requests_answer_submit");
});

test("Phase 5B mapping failure stays non-blocking and Monthly Review still has answered source row", async () => {
  const store = baseStore();
  const result = await submit(store, [{ request_id: "req-1", transaction_id: "txn-1", answer_text: "materials" }], {
    mapAnswer: async () => {
      throw new Error("canonical resolver unavailable");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.rows[0].success, true);
  assert.equal(result.rows[0].mapping_status, "lookup_failed");
  assert.equal(store.clarification_requests[0].status, "answered");
  assert.equal(store.clarification_requests[0].resolved_at, null);
  assert.equal(store.clarification_requests[0].meta.customer_context_only, true);
  assert.equal(store.transaction_categorizations[0].status, "needs_review");
});

test("Phase 5B partial multi-row submission distinguishes persisted and failed rows", async () => {
  const store = baseStore({
    clarification_requests: [
      { id: "req-1", business_id: BUSINESS_ID, transaction_id: "txn-1", status: "pending", meta: {}, resolved_at: null },
      { id: "req-2", business_id: BUSINESS_ID, transaction_id: "txn-2", status: "pending", meta: {}, resolved_at: null },
    ],
    transaction_categorizations: [
      { business_id: BUSINESS_ID, transaction_id: "txn-1", status: "needs_review", meta: {} },
      { business_id: BUSINESS_ID, transaction_id: "txn-2", status: "approved", meta: {} },
    ],
  });
  const result = await submit(store, [
    { request_id: "req-1", transaction_id: "txn-1", answer_text: "materials" },
    { request_id: "req-2", transaction_id: "txn-2", answer_text: "fuel" },
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.outcome, "partial_success");
  assert.equal(result.successful_count, 1);
  assert.equal(result.failed_count, 1);
  assert.equal(result.rows.find((row) => row.request_id === "req-1").persisted, true);
  assert.equal(result.rows.find((row) => row.request_id === "req-2").error, "transaction_not_needs_review");
});

test("Phase 5B frontend helpers remove only confirmed persisted answers and preserve failed-row messaging", () => {
  const result = {
    outcome: "partial_success",
    rows: [
      { request_id: "req-1", status: "answered", success: true, persisted: true },
      { request_id: "req-2", success: false, persisted: false, error: "transaction_not_needs_review" },
    ],
  };

  assert.equal(isClarificationAnswerPersisted(result.rows[0]), true);
  assert.equal(isClarificationAnswerPersisted(result.rows[1]), false);
  assert.deepEqual([...getPersistedClarificationRequestIds(result)], ["req-1"]);
  assert.equal(summarizeClarificationSubmitFailure(result), "This transaction is no longer awaiting review.");
});

test("Phase 5B stale expiration remains pending-only and answered rows stay durable", () => {
  const migration = readFileSync(join(process.cwd(), "supabase/migrations/20260905_bounded_bookkeeping_needs_review_retrieval.sql"), "utf8");
  const expirationBody = migration.slice(
    migration.indexOf("create or replace function public.expire_stale_operator_requests"),
    migration.indexOf("revoke all on function public.bookkeeping_transaction_matches_status")
  );

  assert.match(expirationBody, /cr\.status = 'pending'/);
  assert.doesNotMatch(expirationBody, /cr\.status in \('pending', 'answered'\)/);
});

test("Phase 5B route and Monthly Review contracts expose non-misleading submit and answered-review visibility", () => {
  const route = readFileSync(join(process.cwd(), "src/api/bookkeeping/routes/bookkeeping.clarifications.routes.js"), "utf8");
  const monthly = readFileSync(join(process.cwd(), "src/api/admin/monthlyReview.routes.js"), "utf8");
  const submitRoute = route.slice(
    route.indexOf('router.post("/clarifications/submit"'),
    route.indexOf('router.post("/clarifications/snooze"')
  );
  const operatorFetch = monthly.slice(
    monthly.indexOf("async function fetchOperatorResponsesAwaitingReview"),
    monthly.indexOf("function normalizeReviewerDisplay")
  );

  assert.match(submitRoute, /result\.outcome === "partial_success" \? 207 : 400/);
  assert.match(submitRoute, /rows\?\.find\(\(row\) => row\?\.error\)\?\.error/);
  assert.match(operatorFetch, /\.eq\("status", "answered"\)/);
  assert.match(operatorFetch, /\.is\("resolved_at", null\)/);
  assert.match(operatorFetch, /matchesTransactionStatusFilter\("needs_review", cat\)/);
  assert.match(operatorFetch, /\.gte\("date", start\)/);
  assert.match(operatorFetch, /\.lt\("date", end\)/);
});
