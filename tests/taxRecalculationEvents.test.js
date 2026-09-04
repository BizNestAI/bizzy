import assert from "node:assert/strict";
import { test } from "node:test";
import { createTaxRecalculationEvent } from "../src/services/tax/events/taxRecalculationEvent.js";
import { TAX_RECALCULATION_EVENT_TYPES as EVENTS, TAX_RECALCULATION_REQUEST_STATUSES } from "../src/services/tax/events/taxRecalculationEventDomain.js";
import { handleTaxRecalculationEvent } from "../src/services/tax/events/taxRecalculationTrigger.service.js";
import {
  __setTaxRecalculationWorkerTestDeps,
  processPendingTaxRecalculationRequests,
} from "../src/services/tax/events/processTaxRecalculationRequests.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

test("posted transaction queues recalculation and duplicate eventId does not duplicate request", async () => {
  const supabase = makeSupabase();
  const event = {
    eventId: "evt-posted-1",
    eventType: EVENTS.QBO_TRANSACTION_POSTED,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    sourceRecordId: "txn-1",
    sourceTable: "qbo_posted_transactions",
    materiality: { amount: 1200, transactionCount: 1 },
  };

  const first = await handleTaxRecalculationEvent({ supabase, event, now: date("2026-07-14T12:00:00Z") });
  const second = await handleTaxRecalculationEvent({ supabase, event, now: date("2026-07-14T12:00:05Z") });

  assert.equal(first.queued, true);
  assert.equal(second.outcome, "skip_duplicate");
  assert.equal(supabase.store.tax_recalculation_requests.length, 1);
  assert.equal(supabase.store.tax_recalculation_requests[0].business_id, BUSINESS_ID);
});

test("multiple transaction events coalesce into one pending request", async () => {
  const supabase = makeSupabase();
  await handleTaxRecalculationEvent({ supabase, event: txEvent("evt-a", "txn-a"), now: date("2026-07-14T12:00:00Z") });
  const result = await handleTaxRecalculationEvent({ supabase, event: txEvent("evt-b", "txn-b"), now: date("2026-07-14T12:00:10Z") });

  assert.equal(result.coalesced, true);
  assert.equal(supabase.store.tax_recalculation_requests.length, 1);
  assert.equal(supabase.store.tax_recalculation_requests[0].metadata.coalescedEventCount, 2);
  assert.deepEqual(supabase.store.tax_recalculation_requests[0].metadata.sourceRecordIds, ["txn-a", "txn-b"]);
});

test("profile entity change recalculates immediately while identical profile save is skipped", async () => {
  const supabase = makeSupabase();
  const now = date("2026-07-14T12:00:00Z");
  const immediate = await handleTaxRecalculationEvent({
    supabase,
    now,
    event: {
      eventId: "evt-profile-entity",
      eventType: EVENTS.TAX_ENTITY_CHANGED,
      businessId: BUSINESS_ID,
      taxYear: 2026,
      changedFields: ["entity_type"],
      before: { entity_type: "sole_proprietor" },
      after: { entity_type: "s_corporation" },
    },
  });
  assert.equal(immediate.queued, true);
  assert.equal(supabase.store.tax_recalculation_requests[0].process_after, now.toISOString());

  const skipped = await handleTaxRecalculationEvent({
    supabase,
    event: {
      eventId: "evt-profile-identical",
      eventType: EVENTS.TAX_PROFILE_UPDATED,
      businessId: BUSINESS_ID,
      taxYear: 2026,
      changedFields: ["metadata"],
      before: { entity_type: "s_corporation" },
      after: { entity_type: "s_corporation" },
    },
  });
  assert.equal(skipped.outcome, "skip_immaterial");
});

test("event sanitizer removes raw payloads, tokens, and account numbers", () => {
  const event = createTaxRecalculationEvent({
    eventType: EVENTS.TRANSACTION_CLASSIFICATION_OVERRIDDEN,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    sourceRecordId: "txn-1",
    before: { tax_category: "meals", rawQboPayload: { secret: true }, account_number: "123456789" },
    after: { tax_category: "travel", access_token: "token", deductible_percent: 100 },
    metadata: { rawPlaidPayload: { token: "secret" }, amount: 200 },
  });

  assert.deepEqual(event.before, { tax_category: "meals" });
  assert.deepEqual(event.after, { tax_category: "travel", deductible_percent: 100 });
  assert.deepEqual(event.metadata, { amount: 200 });
});

test("worker processes due request once, reuses fingerprints, and second worker sees no duplicate work", async () => {
  const supabase = makeSupabase({
    tax_recalculation_requests: [{
      id: "req-1",
      business_id: BUSINESS_ID,
      tax_year: 2026,
      event_type: EVENTS.QBO_SYNC_COMPLETED,
      trigger_source: "qbo_sync",
      priority: "normal",
      status: "pending",
      event_id: "evt-sync",
      first_event_at: "2026-07-14T12:00:00.000Z",
      last_event_at: "2026-07-14T12:00:00.000Z",
      process_after: "2026-07-14T12:00:00.000Z",
      attempt_count: 0,
      max_attempts: 5,
      metadata: {},
    }],
  });
  __setTaxRecalculationWorkerTestDeps({
    evaluateTaxCalculationPrerequisites: async () => ({ ready: true }),
    getLatestTaxRun: async () => ({ id: "run-1" }),
    runCanonicalTaxCalculation: async () => ({ meta: { runId: "run-1", reusedExistingRun: true } }),
    emitTaxDataChanged: () => assert.fail("identical reused run should not emit material change"),
  });

  const first = await processPendingTaxRecalculationRequests({ supabase, workerId: "w1", now: date("2026-07-14T12:00:01Z") });
  const second = await processPendingTaxRecalculationRequests({ supabase, workerId: "w2", now: date("2026-07-14T12:00:01Z") });

  assert.equal(first.processed, 1);
  assert.equal(first.skipped, 1);
  assert.equal(second.processed, 0);
  assert.equal(supabase.store.tax_recalculation_requests[0].calculation_run_id, "run-1");
});

test("worker retries failures and dead-letters after max attempts", async () => {
  const supabase = makeSupabase({
    tax_recalculation_requests: [{
      id: "req-fail",
      business_id: BUSINESS_ID,
      tax_year: 2026,
      event_type: EVENTS.TAX_PAYMENT_CREATED,
      trigger_source: "tax_payment_changed",
      priority: "high",
      status: "pending",
      event_id: "evt-pay",
      first_event_at: "2026-07-14T12:00:00.000Z",
      last_event_at: "2026-07-14T12:00:00.000Z",
      process_after: "2026-07-14T12:00:00.000Z",
      attempt_count: 0,
      max_attempts: 1,
      metadata: {},
    }],
  });
  __setTaxRecalculationWorkerTestDeps({
    evaluateTaxCalculationPrerequisites: async () => ({ ready: true }),
    getLatestTaxRun: async () => null,
    runCanonicalTaxCalculation: async () => {
      const err = new Error("boom");
      err.code = "boom";
      throw err;
    },
  });

  await processPendingTaxRecalculationRequests({ supabase, workerId: "w1", now: date("2026-07-14T12:00:01Z") });
  assert.equal(supabase.store.tax_recalculation_requests[0].status, TAX_RECALCULATION_REQUEST_STATUSES.DEAD_LETTER);
  assert.equal(supabase.store.tax_recalculation_requests[0].error_code, "boom");
});

test("material-change event is emitted only when comparison is material", async () => {
  const emitted = [];
  const supabase = makeSupabase({
    tax_recalculation_requests: [{
      id: "req-material",
      business_id: BUSINESS_ID,
      tax_year: 2026,
      event_type: EVENTS.TAX_PAYMENT_CREATED,
      trigger_source: "tax_payment_changed",
      priority: "high",
      status: "pending",
      event_id: "evt-material",
      first_event_at: "2026-07-14T12:00:00.000Z",
      last_event_at: "2026-07-14T12:00:00.000Z",
      process_after: "2026-07-14T12:00:00.000Z",
      attempt_count: 0,
      max_attempts: 5,
      metadata: {},
    }],
  });
  let latestCall = 0;
  __setTaxRecalculationWorkerTestDeps({
    evaluateTaxCalculationPrerequisites: async () => ({ ready: true }),
    getLatestTaxRun: async () => {
      latestCall += 1;
      return latestCall === 1 ? { id: "run-old", estimated_total_tax: 1000, warnings: [] } : { id: "run-new", estimated_total_tax: 1500, warnings: [] };
    },
    runCanonicalTaxCalculation: async () => ({ meta: { runId: "run-new", reusedExistingRun: false } }),
    compareTaxRuns: () => ({ materialChange: true, changes: { projectedTotalTax: { material: true } }, changedWarnings: [], resolvedWarnings: [], newBlockers: [] }),
    emitTaxDataChanged: (payload) => emitted.push(payload),
  });

  await processPendingTaxRecalculationRequests({ supabase, workerId: "w1", now: date("2026-07-14T12:00:01Z") });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].changeType, "tax_calculation_materially_changed");
  assert.equal(emitted[0].metadata.previousRunId, "run-old");
  assert.equal(emitted[0].metadata.currentRunId, "run-new");
});

function txEvent(eventId, sourceRecordId) {
  return {
    eventId,
    eventType: EVENTS.QBO_TRANSACTION_POSTED,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    sourceRecordId,
    sourceTable: "qbo_posted_transactions",
    materiality: { amount: 100, transactionCount: 1 },
  };
}

function date(value) {
  return new Date(value);
}

function makeSupabase(store = {}) {
  return {
    store: {
      tax_recalculation_requests: [],
      ...store,
    },
  };
}
