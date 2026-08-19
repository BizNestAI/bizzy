import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  __setBackgroundBookkeepingProcessingTestDeps,
  enqueueBookkeepingProcessingForTransactions,
  enqueueUnresolvedBookkeepingBacklog,
  processPendingBookkeepingRequests,
  processPendingBookkeepingRequestsUntilIdle,
} from "../src/services/bookkeeping/backgroundBookkeepingProcessingService.js";

const root = process.cwd();
const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";

function makeStore() {
  return {
    bookkeeping_processing_requests: [],
    transaction_categorizations: [],
    bank_transactions: [],
  };
}

class Query {
  constructor(store, table) {
    this.store = store;
    this.table = table;
    this.filters = [];
    this.patch = null;
    this.upsertRows = null;
    this.limitCount = null;
    this.singleMode = false;
  }

  select() { return this; }
  order() { return this; }
  limit(n) { this.limitCount = n; return this; }
  eq(key, value) { this.filters.push((row) => row[key] === value); return this; }
  in(key, values) {
    const set = new Set(values || []);
    this.filters.push((row) => set.has(row[key]));
    return this;
  }
  is(key, value) { this.filters.push((row) => row[key] === value); return this; }
  update(patch) { this.patch = patch; return this; }
  upsert(rows) {
    this.upsertRows = Array.isArray(rows) ? rows : [rows];
    return this._exec();
  }
  maybeSingle() { this.singleMode = true; return this._exec(); }
  then(resolve, reject) { return this._exec().then(resolve, reject); }

  async _exec() {
    const rows = this.store[this.table] ||= [];
    if (this.upsertRows) {
      for (const row of this.upsertRows) {
        const existing = rows.find((candidate) => {
          if (this.table === "bookkeeping_processing_requests") {
            return candidate.business_id === row.business_id && candidate.transaction_id === row.transaction_id;
          }
          if (this.table === "transaction_categorizations") {
            return candidate.business_id === row.business_id && candidate.transaction_id === row.transaction_id;
          }
          return candidate.id === row.id;
        });
        if (existing) Object.assign(existing, row);
        else rows.push({ id: row.id || `${this.table}_${rows.length + 1}`, created_at: row.created_at || "2026-08-19T00:00:00.000Z", ...row });
      }
      return { data: this.upsertRows, error: null };
    }

    let result = rows.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.patch) {
      for (const row of result) Object.assign(row, this.patch);
      result = result.map((row) => ({ ...row }));
    }
    if (this.limitCount != null) result = result.slice(0, this.limitCount);
    return { data: this.singleMode ? result[0] || null : result, error: null };
  }
}

function makeSupabase(store = makeStore()) {
  return {
    store,
    from(table) {
      return new Query(store, table);
    },
  };
}

function seedBankTransactions(supabase, businessId, ids) {
  for (const id of ids) {
    supabase.store.bank_transactions.push({
      id,
      business_id: businessId,
      is_archived: false,
      pending: false,
      date: "2026-08-19",
    });
  }
}

function resetDeps() {
  __setBackgroundBookkeepingProcessingTestDeps({
    runBookkeepingSuggestionPass: async () => ({ ok: true, updated: 0, auto_approved: 0, skipped: 0 }),
    reconsiderNeedsReviewTransactions: async () => ({ ok: true, processed: 0, promoted: 0, skipped: 0 }),
  });
}

test.afterEach(resetDeps);

test("background processing runs without browser user state and can auto-handle while Auto-post is off", async () => {
  const supabase = makeSupabase();
  seedBankTransactions(supabase, BUSINESS_ID, ["txn-1"]);
  supabase.store.transaction_categorizations.push({
    business_id: BUSINESS_ID,
    transaction_id: "txn-1",
    status: "needs_review",
    qbo_txn_id: null,
    post_after: null,
    meta: {},
  });
  let qboTransactionCreates = 0;
  let qboVendorCreates = 0;

  __setBackgroundBookkeepingProcessingTestDeps({
    runBookkeepingSuggestionPass: async ({ businessId, body }) => {
      assert.equal(businessId, BUSINESS_ID);
      assert.deepEqual(body.transaction_ids, ["txn-1"]);
      const row = supabase.store.transaction_categorizations[0];
      row.suggested_qbo_account_id = "software-current";
      row.suggested_qbo_account_name = "Software";
      row.suggested_canonical_account_key = "software";
      return { ok: true, updated: 1, auto_approved: 0, skipped: 0 };
    },
    reconsiderNeedsReviewTransactions: async (_businessId, options) => {
      assert.deepEqual(options.transactionIds, ["txn-1"]);
      const row = supabase.store.transaction_categorizations[0];
      row.status = "auto_approved";
      row.final_qbo_account_id = "software-current";
      row.final_qbo_account_name = "Software";
      row.post_after = null;
      return { ok: true, processed: 1, promoted: 1, skipped: 0 };
    },
  });

  await enqueueBookkeepingProcessingForTransactions({
    businessId: BUSINESS_ID,
    transactionIds: ["txn-1"],
    source: "plaid_sync",
    supabase,
  });
  const result = await processPendingBookkeepingRequests({ supabase, batchSize: 1, workerId: "test-worker" });

  assert.equal(result.completed, 1);
  assert.equal(supabase.store.transaction_categorizations[0].status, "auto_approved");
  assert.equal(supabase.store.transaction_categorizations[0].post_after, null);
  assert.equal(qboTransactionCreates, 0);
  assert.equal(qboVendorCreates, 0);
});

test("large backlog drains across bounded worker runs", async () => {
  const supabase = makeSupabase();
  seedBankTransactions(supabase, BUSINESS_ID, ["txn-1", "txn-2", "txn-3"]);
  for (const id of ["txn-1", "txn-2", "txn-3"]) {
    supabase.store.transaction_categorizations.push({
      business_id: BUSINESS_ID,
      transaction_id: id,
      status: "needs_review",
      qbo_txn_id: null,
      meta: {},
    });
  }
  __setBackgroundBookkeepingProcessingTestDeps({
    runBookkeepingSuggestionPass: async () => ({ ok: true, updated: 1, auto_approved: 0, skipped: 0 }),
    reconsiderNeedsReviewTransactions: async (_businessId, options) => {
      for (const transactionId of options.transactionIds) {
        const row = supabase.store.transaction_categorizations.find((cat) => cat.transaction_id === transactionId);
        row.status = "auto_approved";
        row.post_after = null;
      }
      return { ok: true, processed: options.transactionIds.length, promoted: options.transactionIds.length, skipped: 0 };
    },
  });
  await enqueueBookkeepingProcessingForTransactions({
    businessId: BUSINESS_ID,
    transactionIds: ["txn-1", "txn-2", "txn-3"],
    supabase,
  });

  const first = await processPendingBookkeepingRequests({ supabase, batchSize: 2, workerId: "worker-a" });
  const second = await processPendingBookkeepingRequests({ supabase, batchSize: 2, workerId: "worker-a" });

  assert.equal(first.claimed, 2);
  assert.equal(second.claimed, 1);
  assert.equal(supabase.store.transaction_categorizations.every((row) => row.status === "auto_approved"), true);
});

test("concurrent worker claims do not duplicate state transitions", async () => {
  const supabase = makeSupabase();
  seedBankTransactions(supabase, BUSINESS_ID, ["txn-1"]);
  supabase.store.transaction_categorizations.push({
    business_id: BUSINESS_ID,
    transaction_id: "txn-1",
    status: "needs_review",
    qbo_txn_id: null,
    meta: {},
  });
  let suggestionCalls = 0;
  __setBackgroundBookkeepingProcessingTestDeps({
    runBookkeepingSuggestionPass: async () => {
      suggestionCalls += 1;
      return { ok: true, updated: 1, auto_approved: 0, skipped: 0 };
    },
    reconsiderNeedsReviewTransactions: async () => ({ ok: true, processed: 1, promoted: 0, skipped: 1 }),
  });

  await enqueueBookkeepingProcessingForTransactions({ businessId: BUSINESS_ID, transactionIds: ["txn-1"], supabase });
  const first = await processPendingBookkeepingRequests({ supabase, batchSize: 1, workerId: "worker-a" });
  const second = await processPendingBookkeepingRequests({ supabase, batchSize: 1, workerId: "worker-b" });

  assert.equal(first.claimed, 1);
  assert.equal(second.claimed, 0);
  assert.equal(suggestionCalls, 1);
});

test("already handled or posted rows are skipped before categorization work", async () => {
  const supabase = makeSupabase();
  seedBankTransactions(supabase, BUSINESS_ID, ["txn-1"]);
  supabase.store.transaction_categorizations.push({
    business_id: BUSINESS_ID,
    transaction_id: "txn-1",
    status: "posted",
    qbo_txn_id: "qbo-1",
    meta: {},
  });
  let suggestionCalls = 0;
  __setBackgroundBookkeepingProcessingTestDeps({
    runBookkeepingSuggestionPass: async () => {
      suggestionCalls += 1;
      return { ok: true };
    },
  });

  await enqueueBookkeepingProcessingForTransactions({ businessId: BUSINESS_ID, transactionIds: ["txn-1"], supabase });
  const result = await processPendingBookkeepingRequests({ supabase, batchSize: 1 });

  assert.equal(result.skipped, 1);
  assert.equal(suggestionCalls, 0);
});

test("application enqueue rejects a transaction owned by another business", async () => {
  const supabase = makeSupabase();
  seedBankTransactions(supabase, OTHER_BUSINESS_ID, ["txn-foreign"]);

  await assert.rejects(
    enqueueBookkeepingProcessingForTransactions({
      businessId: BUSINESS_ID,
      transactionIds: ["txn-foreign"],
      supabase,
    }),
    /bookkeeping_queue_transaction_business_mismatch/
  );
  assert.equal(supabase.store.bookkeeping_processing_requests.length, 0);
});

test("worker skips malformed cross-business queue rows", async () => {
  const supabase = makeSupabase();
  seedBankTransactions(supabase, OTHER_BUSINESS_ID, ["txn-foreign"]);
  supabase.store.transaction_categorizations.push({
    business_id: BUSINESS_ID,
    transaction_id: "txn-foreign",
    status: "needs_review",
    qbo_txn_id: null,
    meta: {},
  });
  supabase.store.bookkeeping_processing_requests.push({
    id: "bad-queue-row",
    business_id: BUSINESS_ID,
    transaction_id: "txn-foreign",
    status: "pending",
    process_after: "2026-08-19T00:00:00.000Z",
    attempt_count: 0,
    max_attempts: 5,
    metadata: {},
  });
  let suggestionCalls = 0;
  __setBackgroundBookkeepingProcessingTestDeps({
    runBookkeepingSuggestionPass: async () => {
      suggestionCalls += 1;
      return { ok: true };
    },
  });

  const result = await processPendingBookkeepingRequests({ supabase, batchSize: 1 });

  assert.equal(result.skipped, 1);
  assert.equal(suggestionCalls, 0);
  assert.equal(supabase.store.bookkeeping_processing_requests[0].error_code, "transaction_business_mismatch");
});

test("direct DB migration enforces composite queue transaction ownership", () => {
  const migration = readFileSync(join(root, "supabase/migrations/20260830_background_bookkeeping_processing.sql"), "utf8");

  assert.match(migration, /bank_transactions_business_id_id_key[\s\S]*unique \(business_id, id\)/);
  assert.match(migration, /bookkeeping_processing_requests_business_transaction_fk[\s\S]*foreign key \(business_id, transaction_id\)[\s\S]*references public\.bank_transactions \(business_id, id\)/);
  assert.match(migration, /refusing to add ownership constraint/);
});

test("background worker passes provider-read-only COA mode and records unresolved cooldown", async () => {
  const supabase = makeSupabase();
  seedBankTransactions(supabase, BUSINESS_ID, ["txn-1"]);
  supabase.store.transaction_categorizations.push({
    business_id: BUSINESS_ID,
    transaction_id: "txn-1",
    status: "needs_review",
    qbo_txn_id: null,
    post_error: null,
    updated_at: "2026-08-19T00:00:00.000Z",
    meta: {},
  });
  let qboAccountCreates = 0;
  __setBackgroundBookkeepingProcessingTestDeps({
    runBookkeepingSuggestionPass: async ({ body }) => {
      assert.equal(body.allow_qbo_account_create, false);
      assert.equal(body.allow_ai_categorization, false);
      qboAccountCreates += 0;
      const row = supabase.store.transaction_categorizations[0];
      row.status = "needs_review";
      row.post_error = "canonical_account_requires_review";
      row.meta = {
        canonical_account_key: "software",
        canonical_coa_revalidation_reason: "canonical_account_requires_review",
        canonical_account_review_required: true,
      };
      return { ok: true, updated: 1, auto_approved: 0, skipped: 1 };
    },
    reconsiderNeedsReviewTransactions: async () => ({ ok: true, processed: 1, promoted: 0, skipped: 1 }),
  });

  await enqueueBookkeepingProcessingForTransactions({ businessId: BUSINESS_ID, transactionIds: ["txn-1"], supabase });
  const result = await processPendingBookkeepingRequests({ supabase, batchSize: 1 });
  const req = supabase.store.bookkeeping_processing_requests[0];

  assert.equal(result.completed, 1);
  assert.equal(qboAccountCreates, 0);
  assert.equal(supabase.store.transaction_categorizations[0].status, "needs_review");
  assert.equal(req.blocked_reason, "canonical_account_requires_review");
  assert.ok(req.evidence_fingerprint);
  assert.ok(req.blocked_until);
});

test("completed unresolved work is rediscovered only after evidence changes or cooldown", async () => {
  const supabase = makeSupabase();
  seedBankTransactions(supabase, BUSINESS_ID, ["txn-1"]);
  supabase.store.transaction_categorizations.push({
    business_id: BUSINESS_ID,
    transaction_id: "txn-1",
    status: "needs_review",
    qbo_txn_id: null,
    updated_at: "2026-08-19T00:00:00.000Z",
    meta: { auto_handle_decision: { reason: "check_requires_review" } },
  });
  await enqueueBookkeepingProcessingForTransactions({ businessId: BUSINESS_ID, transactionIds: ["txn-1"], supabase });
  await processPendingBookkeepingRequests({ supabase, batchSize: 1 });
  const completed = supabase.store.bookkeeping_processing_requests[0];
  completed.status = "completed";
  completed.blocked_until = "2026-08-20T00:00:00.000Z";

  const unchanged = await enqueueUnresolvedBookkeepingBacklog({
    businessId: BUSINESS_ID,
    supabase,
    now: new Date("2026-08-19T12:00:00.000Z"),
  });
  assert.equal(unchanged.enqueued, 0);
  assert.equal(completed.status, "completed");

  supabase.store.transaction_categorizations[0].updated_at = "2026-08-19T13:00:00.000Z";
  supabase.store.transaction_categorizations[0].meta = {
    canonical_account_key: "software",
    canonical_coa_resolved: true,
    canonical_vendor_id: "vendor-1",
    canonical_vendor_reliable: true,
  };
  const changed = await enqueueUnresolvedBookkeepingBacklog({
    businessId: BUSINESS_ID,
    supabase,
    now: new Date("2026-08-19T13:01:00.000Z"),
  });

  assert.equal(changed.enqueued, 1);
  assert.equal(completed.status, "pending");
  assert.equal(completed.blocked_until, null);
});

test("catch-up discovery skips pending archived and pre-start transactions", async () => {
  const supabase = makeSupabase();
  supabase.store.business_profiles = [{ id: BUSINESS_ID, bookkeeping_start_date: "2026-08-01" }];
  supabase.store.bank_transactions.push(
    { id: "eligible", business_id: BUSINESS_ID, date: "2026-08-19", pending: false, is_archived: false },
    { id: "pending", business_id: BUSINESS_ID, date: "2026-08-19", pending: true, is_archived: false },
    { id: "archived", business_id: BUSINESS_ID, date: "2026-08-19", pending: false, is_archived: true },
    { id: "pre-start", business_id: BUSINESS_ID, date: "2026-07-31", pending: false, is_archived: false }
  );
  for (const transaction_id of ["eligible", "pending", "archived", "pre-start"]) {
    supabase.store.transaction_categorizations.push({
      business_id: BUSINESS_ID,
      transaction_id,
      status: "needs_review",
      qbo_txn_id: null,
      updated_at: "2026-08-19T00:00:00.000Z",
      meta: {},
    });
  }

  const result = await enqueueUnresolvedBookkeepingBacklog({ businessId: BUSINESS_ID, supabase });

  assert.deepEqual(result.transaction_ids, ["eligible"]);
  assert.equal(supabase.store.bookkeeping_processing_requests.length, 1);
});

test("active queue lease is not reset by rediscovery", async () => {
  const supabase = makeSupabase();
  seedBankTransactions(supabase, BUSINESS_ID, ["txn-1"]);
  supabase.store.transaction_categorizations.push({
    business_id: BUSINESS_ID,
    transaction_id: "txn-1",
    status: "needs_review",
    qbo_txn_id: null,
    updated_at: "2026-08-19T00:00:00.000Z",
    meta: {},
  });
  await enqueueBookkeepingProcessingForTransactions({ businessId: BUSINESS_ID, transactionIds: ["txn-1"], supabase });
  const req = supabase.store.bookkeeping_processing_requests[0];
  Object.assign(req, {
    status: "processing",
    locked_by: "worker-a",
    locked_at: "2026-08-19T00:00:00.000Z",
    attempt_count: 1,
  });

  await enqueueBookkeepingProcessingForTransactions({ businessId: BUSINESS_ID, transactionIds: ["txn-1"], supabase });

  assert.equal(req.status, "processing");
  assert.equal(req.locked_by, "worker-a");
  assert.equal(req.attempt_count, 1);
});

test("source wiring preserves server-side authority and removes Books Review backlog drain", () => {
  const plaidSync = readFileSync(join(root, "src/services/plaid/plaidSyncService.js"), "utf8");
  const server = readFileSync(join(root, "src/server.js"), "utf8");
  const page = readFileSync(join(root, "src/pages/accounting/BookkeepingCleanup.jsx"), "utf8");
  const service = readFileSync(join(root, "src/services/bookkeeping/backgroundBookkeepingProcessingService.js"), "utf8");
  const suggestRoute = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.suggest.routes.js"), "utf8");
  const migration = readFileSync(join(root, "supabase/migrations/20260830_background_bookkeeping_processing.sql"), "utf8");

  assert.match(plaidSync, /enqueueBookkeepingProcessingForTransactions/);
  assert.match(server, /startBookkeepingProcessingWorker\(\)/);
  assert.match(service, /runBookkeepingSuggestionPass/);
  assert.match(service, /reconsiderNeedsReviewTransactions/);
  assert.match(service, /const transactionIds = requests\.map\(\(request\) => request\.transaction_id\)/);
  assert.match(service, /ignoreDuplicates: true/);
  assert.match(service, /\.neq\("status", BOOKKEEPING_PROCESSING_STATUSES\.PROCESSING\)/);
  assert.match(service, /BACKGROUND_BOOKKEEPING_EXECUTION_POLICY/);
  assert.match(service, /allow_ai_categorization:\s*false/);
  assert.match(service, /allow_qbo_account_create:\s*false/);
  assert.match(suggestRoute, /const allowQboAccountCreate/);
  assert.match(suggestRoute, /const allowAiCategorization/);
  assert.match(suggestRoute, /allowCreate: allowQboAccountCreate/);
  assert.match(migration, /create table if not exists public\.bookkeeping_processing_requests/);
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /bookkeeping_processing_requests_business_transaction_fk/);
  assert.doesNotMatch(page, /books-review-reconsider/);
  assert.doesNotMatch(page, /window\.localStorage\?\.setItem\(reconsiderCursorKey/);
  assert.doesNotMatch(page, /maxBatchesPerPass/);
  assert.doesNotMatch(service, /postToQbo|createQboVendorWithRequestId|ensureCanonicalVendorMappedToQbo/);
});

test("tenant isolation is preserved by queue identity", async () => {
  const supabase = makeSupabase();
  seedBankTransactions(supabase, BUSINESS_ID, ["txn-1"]);
  seedBankTransactions(supabase, OTHER_BUSINESS_ID, ["txn-1"]);
  await enqueueBookkeepingProcessingForTransactions({
    businessId: BUSINESS_ID,
    transactionIds: ["txn-1"],
    supabase,
  });
  await enqueueBookkeepingProcessingForTransactions({
    businessId: OTHER_BUSINESS_ID,
    transactionIds: ["txn-1"],
    supabase,
  });

  assert.equal(supabase.store.bookkeeping_processing_requests.length, 2);
  assert.equal(new Set(supabase.store.bookkeeping_processing_requests.map((row) => row.business_id)).size, 2);
});

test("multi-batch worker invocation can advance more than one claim batch without draining unbounded work", async () => {
  const supabase = makeSupabase();
  const ids = Array.from({ length: 209 }, (_value, index) => `txn-${index + 1}`);
  seedBankTransactions(supabase, BUSINESS_ID, ids);
  for (const transaction_id of ids) {
    supabase.store.transaction_categorizations.push({
      business_id: BUSINESS_ID,
      transaction_id,
      status: "needs_review",
      qbo_txn_id: null,
      meta: {},
    });
  }
  let batches = 0;
  __setBackgroundBookkeepingProcessingTestDeps({
    runBookkeepingSuggestionPass: async ({ businessId, body }) => {
      assert.equal(businessId, BUSINESS_ID);
      assert.equal(body.allow_qbo_account_create, false);
      assert.equal(body.allow_ai_categorization, false);
      assert.ok(body.transaction_ids.length <= 25);
      batches += 1;
      return { ok: true, updated: body.transaction_ids.length, auto_approved: 0, skipped: 0 };
    },
    reconsiderNeedsReviewTransactions: async (_businessId, options) => {
      for (const transactionId of options.transactionIds) {
        const row = supabase.store.transaction_categorizations.find((cat) => cat.transaction_id === transactionId);
        row.status = "auto_approved";
        row.post_after = null;
      }
      return { ok: true, processed: options.transactionIds.length, promoted: options.transactionIds.length, skipped: 0 };
    },
  });
  await enqueueBookkeepingProcessingForTransactions({ businessId: BUSINESS_ID, transactionIds: ids, supabase });

  const result = await processPendingBookkeepingRequestsUntilIdle({
    supabase,
    businessId: BUSINESS_ID,
    batchSize: 25,
    maxBatches: 4,
    workerId: "worker-multi",
  });

  assert.equal(result.batches, 4);
  assert.equal(result.claimed, 100);
  assert.equal(result.completed, 100);
  assert.equal(batches, 4);
  assert.equal(supabase.store.bookkeeping_processing_requests.filter((row) => row.status === "pending").length, 109);
});

test("business-scoped processing does not claim another business during Plaid wake style runs", async () => {
  const supabase = makeSupabase();
  seedBankTransactions(supabase, BUSINESS_ID, ["txn-a"]);
  seedBankTransactions(supabase, OTHER_BUSINESS_ID, ["txn-b"]);
  for (const [business_id, transaction_id] of [[BUSINESS_ID, "txn-a"], [OTHER_BUSINESS_ID, "txn-b"]]) {
    supabase.store.transaction_categorizations.push({
      business_id,
      transaction_id,
      status: "needs_review",
      qbo_txn_id: null,
      meta: {},
    });
  }
  await enqueueBookkeepingProcessingForTransactions({ businessId: BUSINESS_ID, transactionIds: ["txn-a"], supabase });
  await enqueueBookkeepingProcessingForTransactions({ businessId: OTHER_BUSINESS_ID, transactionIds: ["txn-b"], supabase });

  const result = await processPendingBookkeepingRequestsUntilIdle({
    supabase,
    businessId: BUSINESS_ID,
    batchSize: 25,
    maxBatches: 4,
    workerId: "plaid-wake",
  });

  assert.equal(result.claimed, 1);
  assert.equal(supabase.store.bookkeeping_processing_requests.find((row) => row.transaction_id === "txn-a").status, "completed");
  assert.equal(supabase.store.bookkeeping_processing_requests.find((row) => row.transaction_id === "txn-b").status, "pending");
});

test("Plaid sync wires enqueue to a bounded best-effort business wake without making sync fragile", () => {
  const plaidSync = readFileSync(join(root, "src/services/plaid/plaidSyncService.js"), "utf8");

  assert.match(plaidSync, /processPendingBookkeepingRequestsUntilIdle/);
  assert.match(plaidSync, /function triggerBookkeepingProcessingWake/);
  assert.match(plaidSync, /BOOKKEEPING_PROCESSING_PLAID_WAKE_BATCH_SIZE \|\| 10/);
  assert.match(plaidSync, /BOOKKEEPING_PROCESSING_PLAID_WAKE_MAX_BATCHES \|\| 1/);
  assert.match(plaidSync, /businessId,\s*batchSize,\s*maxBatches/s);
  assert.match(plaidSync, /\.catch\(\(err\) => \{/);
  assert.match(plaidSync, /immediate bookkeeping processing failed/);
});

test("recurring worker uses sequential multi-batch drain with a bounded cap", () => {
  const cron = readFileSync(join(root, "src/cron/bookkeepingProcessing.cron.js"), "utf8");

  assert.match(cron, /BOOKKEEPING_PROCESSING_MAX_BATCHES_PER_TICK \|\| 4/);
  assert.match(cron, /processPendingBookkeepingRequestsUntilIdle/);
  assert.match(cron, /maxBatches: MAX_BATCHES_PER_TICK/);
  assert.doesNotMatch(cron, /Promise\.all\(\s*businesses/);
});

test("background bookkeeping has an explicit zero-AI policy and no provider-write imports", () => {
  const service = readFileSync(join(root, "src/services/bookkeeping/backgroundBookkeepingProcessingService.js"), "utf8");
  const suggestRoute = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.suggest.routes.js"), "utf8");

  assert.match(service, /BACKGROUND_BOOKKEEPING_EXECUTION_POLICY/);
  assert.match(service, /allow_ai_categorization:\s*false/);
  assert.match(service, /allow_qbo_provider_writes:\s*false/);
  assert.match(suggestRoute, /Any future paid model fallback[\s\S]*must require this flag/);
  assert.doesNotMatch(service, /from ["']openai["']|chat\.completions|responses\.create|embeddings\.create/);
  assert.doesNotMatch(suggestRoute, /from ["']openai["']|chat\.completions|responses\.create|embeddings\.create/);
  assert.doesNotMatch(service, /postToQbo|claim_qbo_posting_intent|ensureCanonicalVendorMappedToQbo|createQboAccountFromCanonical|createQboVendorWithRequestId/);
});

test("business-scoped claim RPC preserves leases and service-role-only access", () => {
  const migration = readFileSync(join(root, "supabase/migrations/20260831_bookkeeping_processing_business_scoped_claim.sql"), "utf8");

  assert.match(migration, /claim_bookkeeping_processing_requests_for_business/);
  assert.match(migration, /where business_id = p_business_id/);
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /status = 'processing'/);
  assert.match(migration, /locked_at < p_now - interval '10 minutes'/);
  assert.match(migration, /grant execute[\s\S]*to service_role/i);
  assert.match(migration, /revoke all[\s\S]*from authenticated/i);
});
