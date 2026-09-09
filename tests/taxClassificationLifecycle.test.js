import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildTaxClassificationJobStatus,
  claimTaxClassificationRuns,
  enqueueTaxClassificationRun,
  failExhaustedActiveTaxClassificationRuns,
  getTaxClassificationJobStatus,
  getTaxClassificationLifecycleStatus,
} from "../src/services/tax/taxClassificationRun.service.js";
import { handleTaxClassificationEvent } from "../src/services/tax/taxClassificationTrigger.service.js";
import {
  parseTaxClassificationWorkerEnabled,
  enqueueRecoveryTaxClassificationRuns,
  processPendingTaxClassificationRuns,
  requestTaxClassificationWorkerKick,
} from "../src/services/tax/taxClassificationWorker.service.js";
import { getBusinessesEligibleForTaxClassification } from "../src/services/tax/taxClassificationRecovery.service.js";
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

test("profile context update enqueues one idempotent historical classification run before estimate profile is complete", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 205 }));
  const before = draftProfile({ entity_type: "unknown" });
  const after = draftProfile({ entity_type: "sole_proprietor" });

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
  assert.equal(supabase.store.tax_classification_runs[0].trigger_source, TAX_CLASSIFICATION_TRIGGER_SOURCES.PROFILE_CONTEXT_UPDATED);
  assert.equal(supabase.store.tax_classification_runs[0].total_eligible, 205);
});

test("onboarding draft context update enqueues one idempotent historical classification run", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 205 }));
  const before = draftProfile({ entity_type: "unknown" });
  const after = draftProfile({ entity_type: "sole_proprietor", source: "onboarding" });

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
  assert.equal(supabase.store.tax_classification_runs[0].trigger_source, TAX_CLASSIFICATION_TRIGGER_SOURCES.PROFILE_CONTEXT_UPDATED);
  assert.equal(supabase.store.tax_classification_runs[0].total_eligible, 205);
});

test("missing estimate-only fields do not block classification enqueue but still block calculation", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 1, taxProfiles: [draftProfile({ entity_type: "sole_proprietor" })] }));

  const queued = await enqueueTaxClassificationRun({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.USER_PREPARE,
  });
  const prerequisites = await evaluateTaxCalculationPrerequisites({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-09-04",
  });

  assert.equal(queued.queued, true);
  assert.equal(prerequisites.ready, false);
  assert.equal(prerequisites.blocker, "profile_draft");
  assert.equal(prerequisites.calculationState, "blocked_by_profile");
  assert.ok(prerequisites.missingFields.includes("filing_status"));
  assert.ok(prerequisites.missingFields.includes("safe_harbor_method"));
  assert.ok(prerequisites.missingFields.includes("self_employment_tax_applies"));
});

test("prepare creates an authoritative queued job without marking all remaining rows as processing", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 207 }));

  const queued = await enqueueTaxClassificationRun({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.USER_PREPARE,
  });
  const lifecycle = await getTaxClassificationLifecycleStatus({ supabase, businessId: BUSINESS_ID, taxYear: 2026 });
  const job = buildTaxClassificationJobStatus({ run: queued.run, coverage: lifecycle });

  assert.equal(queued.queued, true);
  assert.ok(job.jobId);
  assert.equal(job.status, "queued");
  assert.equal(job.total, 207);
  assert.equal(job.processed, 0);
  assert.equal(job.remaining, 207);
  assert.equal(lifecycle.classificationStatus, "classification_queued");
  assert.equal(lifecycle.processingCount, 0);
  assert.equal(lifecycle.remainingCount, 207);
});

test("classification job status separates queued, delayed, processing, and stalled timing states", () => {
  const now = new Date("2026-09-04T12:10:00Z");
  const queued = buildTaxClassificationJobStatus({
    run: {
      id: "run-queued",
      status: TAX_CLASSIFICATION_RUN_STATUSES.QUEUED,
      queued_count: 207,
      total_eligible: 207,
      created_at: "2026-09-04T12:09:50Z",
      queued_at: "2026-09-04T12:09:50Z",
    },
    now,
  });
  const delayed = buildTaxClassificationJobStatus({
    run: {
      id: "run-delayed",
      status: TAX_CLASSIFICATION_RUN_STATUSES.QUEUED,
      queued_count: 207,
      total_eligible: 207,
      created_at: "2026-09-04T12:00:00Z",
      queued_at: "2026-09-04T12:00:00Z",
    },
    now,
  });
  const stalled = buildTaxClassificationJobStatus({
    run: {
      id: "run-stalled",
      status: TAX_CLASSIFICATION_RUN_STATUSES.RUNNING,
      queued_count: 157,
      processed_count: 50,
      total_eligible: 207,
      started_at: "2026-09-04T12:00:00Z",
      heartbeat_at: "2026-09-04T12:00:10Z",
    },
    now,
  });

  assert.equal(queued.status, "queued");
  assert.equal(queued.isDelayed, false);
  assert.equal(delayed.status, "delayed");
  assert.equal(delayed.isDelayed, true);
  assert.equal(stalled.status, "stalled");
  assert.equal(stalled.isStalled, true);
  assert.equal(stalled.canRetry, true);
});

test("exhausted queued runs are surfaced as failed and removed from active recovery blocking", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 207 }));
  supabase.store.tax_classification_runs.push({
    id: "run-exhausted",
    business_id: BUSINESS_ID,
    tax_year: 2026,
    trigger_source: TAX_CLASSIFICATION_TRIGGER_SOURCES.QBO_TRANSACTION_POSTED,
    status: TAX_CLASSIFICATION_RUN_STATUSES.QUEUED,
    total_eligible: 207,
    queued_count: 207,
    processed_count: 0,
    auto_classified_count: 0,
    review_required_count: 0,
    excluded_count: 0,
    failed_count: 0,
    source_fingerprint: "sha256:exhausted",
    rules_version: "tax-classification-v1",
    attempt_count: 5,
    max_attempts: 5,
    process_after: "2026-09-04T12:00:00Z",
    queued_at: "2026-09-04T12:00:00Z",
    started_at: "2026-09-04T12:01:00Z",
    heartbeat_at: "2026-09-04T12:05:00Z",
    created_at: "2026-09-04T12:00:00Z",
    updated_at: "2026-09-04T12:05:00Z",
    metadata: {},
  });

  const status = buildTaxClassificationJobStatus({
    run: supabase.store.tax_classification_runs[0],
    now: new Date("2026-09-04T12:10:00Z"),
  });
  const lifecycle = await getTaxClassificationLifecycleStatus({ supabase, businessId: BUSINESS_ID, taxYear: 2026 });
  const failed = await failExhaustedActiveTaxClassificationRuns({
    supabase,
    now: new Date("2026-09-04T12:10:00Z"),
  });

  assert.equal(status.status, "failed");
  assert.equal(status.errorCode, "classification_attempts_exhausted");
  assert.equal(status.canRetry, false);
  assert.equal(lifecycle.classificationStatus, "classification_failed");
  assert.equal(lifecycle.processingCount, 0);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].status, TAX_CLASSIFICATION_RUN_STATUSES.DEAD_LETTER);
});

test("latest lifecycle status prefers newer terminal review run over older dead-letter run", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 0 }));
  supabase.store.transaction_tax_classifications.push(fallbackClassification({
    transaction_id: "txn-review",
    tax_category: "business_meals",
    deductibility_status: "partially_deductible",
    deductible_percent: 50,
    deductible_amount: 25,
    classification_status: "needs_review",
    requires_review: true,
  }));
  supabase.store.tax_classification_runs.push(
    {
      id: "sep-8-dead-letter",
      business_id: BUSINESS_ID,
      tax_year: 2026,
      trigger_source: TAX_CLASSIFICATION_TRIGGER_SOURCES.USER_PREPARE,
      status: TAX_CLASSIFICATION_RUN_STATUSES.DEAD_LETTER,
      total_eligible: 208,
      queued_count: 207,
      processed_count: 0,
      auto_classified_count: 0,
      review_required_count: 0,
      excluded_count: 0,
      failed_count: 100,
      attempt_count: 5,
      max_attempts: 5,
      queued_at: "2026-09-08T20:48:04.860Z",
      started_at: "2026-09-08T20:48:26.965Z",
      dead_lettered_at: "2026-09-08T20:59:37.299Z",
      created_at: "2026-09-08T20:48:04.860Z",
      updated_at: "2026-09-08T20:59:37.299Z",
    },
    {
      id: "sep-9-review-required",
      business_id: BUSINESS_ID,
      tax_year: 2026,
      trigger_source: TAX_CLASSIFICATION_TRIGGER_SOURCES.USER_PREPARE,
      status: TAX_CLASSIFICATION_RUN_STATUSES.REVIEW_REQUIRED,
      total_eligible: 208,
      queued_count: 0,
      processed_count: 208,
      auto_classified_count: 27,
      review_required_count: 181,
      excluded_count: 0,
      failed_count: 0,
      attempt_count: 3,
      max_attempts: 5,
      queued_at: "2026-09-09T01:34:25.967Z",
      started_at: "2026-09-09T01:34:27.388Z",
      completed_at: "2026-09-09T01:35:36.546Z",
      created_at: "2026-09-09T01:34:25.967Z",
      updated_at: "2026-09-09T01:35:40.607Z",
    },
  );

  const lifecycle = await getTaxClassificationLifecycleStatus({ supabase, businessId: BUSINESS_ID, taxYear: 2026 });

  assert.equal(lifecycle.latestRun.id, "sep-9-review-required");
  assert.equal(lifecycle.jobStatus.jobId, "sep-9-review-required");
  assert.equal(lifecycle.jobStatus.status, "completed_with_review");
  assert.equal(lifecycle.jobStatus.failed, 0);
  assert.equal(lifecycle.latestRun.processedCount, 208);
});

test("unresolved fallback repair keeps original RPC error and does not retry deterministic zero-progress failures", async () => {
  const store = baseStore({ transactionCount: 1 });
  store.transaction_tax_classifications.push(fallbackClassification({
    transaction_id: "txn-001",
    source_qbo_account_name: "Software",
    book_amount: -25,
  }));
  const supabase = makeSupabase(store);
  supabase.rpc = (name) => {
    if (name !== "apply_tax_classification_repair") {
      return Promise.resolve({ data: null, error: { code: "rpc_not_found", message: "Unknown RPC" } });
    }
    return Promise.resolve({
      data: null,
      error: {
        code: "23514",
        message: "new row for relation tax_classification_overrides violates check constraint tax_classification_overrides_source_check",
      },
    });
  };

  const queued = await enqueueTaxClassificationRun({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.USER_PREPARE,
    metadata: { repairMode: "unresolved_fallback" },
    now: new Date("2026-09-08T12:00:00Z"),
  });
  const first = await processPendingTaxClassificationRuns({
    supabase,
    workerId: "test-worker",
    runBatchSize: 1,
    transactionBatchSize: 100,
    now: new Date("2026-09-08T12:01:00Z"),
  });
  const second = await processPendingTaxClassificationRuns({
    supabase,
    workerId: "test-worker",
    runBatchSize: 1,
    transactionBatchSize: 100,
    now: new Date("2026-09-08T12:02:00Z"),
  });
  const run = store.tax_classification_runs.find((row) => row.id === queued.run.id);
  const classification = store.transaction_tax_classifications.find((row) => row.transaction_id === "txn-001");

  assert.equal(first.failed, 1);
  assert.equal(second.processed, 0);
  assert.equal(run.status, TAX_CLASSIFICATION_RUN_STATUSES.DEAD_LETTER);
  assert.equal(run.attempt_count, 1);
  assert.equal(run.failed_count, 1);
  assert.equal(run.last_error_code, "23514");
  assert.match(run.last_error_message, /tax_classification_overrides_source_check/);
  assert.equal(classification.tax_category, "unclassified");
  assert.equal(store.tax_classification_overrides?.length || 0, 0);
});

test("duplicate prepare clicks reuse the active durable classification job", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 3 }));

  const first = await enqueueTaxClassificationRun({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.USER_PREPARE,
  });
  const second = await enqueueTaxClassificationRun({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.USER_PREPARE,
  });

  assert.equal(first.queued, true);
  assert.equal(second.queued, false);
  assert.equal(second.outcome, "existing_active_run");
  assert.equal(second.run.id, first.run.id);
  assert.equal(supabase.store.tax_classification_runs.length, 1);
});

test("worker kick consumes an accepted job and persists progress", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 4 }));
  const queued = await enqueueTaxClassificationRun({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.USER_PREPARE,
  });

  const kicked = await requestTaxClassificationWorkerKick({
    supabase,
    workerId: "test-kick-worker",
  });
  const job = await getTaxClassificationJobStatus({ supabase, businessId: BUSINESS_ID, taxYear: 2026 });

  assert.equal(kicked.processed, 1);
  assert.equal(job.jobId, queued.run.id);
  assert.equal(job.status, "completed_with_review");
  assert.equal(job.total, 4);
  assert.equal(job.processed, 4);
  assert.equal(job.remaining, 0);
});

test("worker classifies production whole-percent deduction rules", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 4 }));
  supabase.store.tax_deduction_rules = [
    softwareRule({ default_deductible_percent: 100 }),
    mealsRule({ default_deductible_percent: 50 }),
  ];
  const queued = await enqueueTaxClassificationRun({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.USER_PREPARE,
  });

  const result = await processPendingTaxClassificationRuns({
    supabase,
    workerId: "whole-percent-worker",
    runBatchSize: 1,
    transactionBatchSize: 10,
  });
  const run = supabase.store.tax_classification_runs.find((row) => row.id === queued.run.id);
  const rows = supabase.store.transaction_tax_classifications;

  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);
  assert.equal(run.status, TAX_CLASSIFICATION_RUN_STATUSES.REVIEW_REQUIRED);
  assert.equal(run.processed_count, 4);
  assert.equal(rows.length, 4);
  assert.equal(rows.find((row) => row.tax_category === "software")?.deductible_percent, 100);
  assert.equal(rows.find((row) => row.tax_category === "meals")?.deductible_percent, 50);
});

test("selected batch with all row failures records a diagnostic instead of silent zero-progress requeue", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 2 }));
  supabase.store.tax_deduction_rules = [
    softwareRule({ default_deductible_percent: 150 }),
    mealsRule({ default_deductible_percent: 150 }),
  ];
  const queued = await enqueueTaxClassificationRun({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.USER_PREPARE,
  });

  const result = await processPendingTaxClassificationRuns({
    supabase,
    workerId: "all-failed-worker",
    runBatchSize: 1,
    transactionBatchSize: 10,
  });
  const run = supabase.store.tax_classification_runs.find((row) => row.id === queued.run.id);

  assert.equal(result.processed, 1);
  assert.equal(result.failed, 1);
  assert.equal(run.status, TAX_CLASSIFICATION_RUN_STATUSES.FAILED);
  assert.equal(run.processed_count, 0);
  assert.equal(run.queued_count, 2);
  assert.equal(run.last_error_code, "invalid_default_deductible_percent");
  assert.equal(supabase.store.transaction_tax_classifications.length, 0);
});

test("repeated deterministic zero-progress dead letters suppress duplicate recovery loops", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 2 }));
  const first = await enqueueTaxClassificationRun({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.USER_PREPARE,
  });
  const run = supabase.store.tax_classification_runs.find((row) => row.id === first.run.id);
  Object.assign(run, {
    status: TAX_CLASSIFICATION_RUN_STATUSES.DEAD_LETTER,
    attempt_count: 5,
    max_attempts: 5,
    last_error_code: "candidate_snapshot_mismatch",
    failed_at: "2026-09-04T12:00:00Z",
  });

  const repeated = await enqueueTaxClassificationRun({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.RECOVERY_SCAN,
  });

  assert.equal(repeated.queued, false);
  assert.equal(repeated.outcome, "suppressed_repeated_failure");
  assert.equal(repeated.status, "classification_failed");
  assert.equal(repeated.run.id, first.run.id);
  assert.equal(supabase.store.tax_classification_runs.length, 1);
});

test("recurring worker path discovers queued jobs without a prepare-request kick", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 2 }));
  const queued = await enqueueTaxClassificationRun({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.USER_PREPARE,
  });

  await processPendingTaxClassificationRuns({
    supabase,
    workerId: "recurring-worker",
    runBatchSize: 1,
    transactionBatchSize: 50,
  });

  const run = supabase.store.tax_classification_runs.find((row) => row.id === queued.run.id);
  assert.equal(run.status, TAX_CLASSIFICATION_RUN_STATUSES.REVIEW_REQUIRED);
  assert.equal(run.processed_count, 2);
});

test("concurrent worker claims do not claim an already locked healthy run", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 2 }));
  await enqueueTaxClassificationRun({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.USER_PREPARE,
    now: new Date("2026-09-04T12:00:00Z"),
  });

  const first = await claimTaxClassificationRuns({
    supabase,
    workerId: "worker-a",
    batchSize: 1,
    now: new Date("2026-09-04T12:01:00Z"),
  });
  const second = await claimTaxClassificationRuns({
    supabase,
    workerId: "worker-b",
    batchSize: 1,
    now: new Date("2026-09-04T12:02:00Z"),
  });

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(first[0].locked_by, "worker-a");
});

test("healthy running heartbeat prevents stale recovery claim", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 2 }));
  const queued = await enqueueTaxClassificationRun({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.USER_PREPARE,
  });
  const run = supabase.store.tax_classification_runs.find((row) => row.id === queued.run.id);
  Object.assign(run, {
    status: TAX_CLASSIFICATION_RUN_STATUSES.RUNNING,
    locked_at: "2026-09-04T12:00:00Z",
    heartbeat_at: "2026-09-04T12:00:00Z",
    locked_by: "healthy-worker",
    attempt_count: 1,
  });

  const claimed = await claimTaxClassificationRuns({
    supabase,
    workerId: "recovery-worker",
    batchSize: 1,
    now: new Date("2026-09-04T12:05:00Z"),
  });

  assert.equal(claimed.length, 0);
  assert.equal(run.locked_by, "healthy-worker");
  assert.equal(run.status, TAX_CLASSIFICATION_RUN_STATUSES.RUNNING);
});

test("retryable failed run is requeued in place instead of duplicated", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 2 }));
  const first = await enqueueTaxClassificationRun({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.USER_PREPARE,
  });
  const run = supabase.store.tax_classification_runs.find((row) => row.id === first.run.id);
  Object.assign(run, {
    status: TAX_CLASSIFICATION_RUN_STATUSES.FAILED,
    failed_at: "2026-09-04T12:00:00Z",
    last_error_code: "test_failure",
    attempt_count: 1,
  });

  const retried = await enqueueTaxClassificationRun({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.USER_PREPARE,
    now: new Date("2026-09-04T12:05:00Z"),
  });

  assert.equal(retried.queued, true);
  assert.equal(retried.outcome, "retried_failed_run");
  assert.equal(retried.run.id, first.run.id);
  assert.equal(supabase.store.tax_classification_runs.length, 1);
  assert.equal(run.status, TAX_CLASSIFICATION_RUN_STATUSES.QUEUED);
  assert.equal(run.last_error_code, null);
});

test("classification worker environment parsing is fail-safe", () => {
  assert.deepEqual(parseTaxClassificationWorkerEnabled(undefined), {
    enabled: true,
    source: "default",
    reason: "unset_defaults_enabled",
  });
  assert.equal(parseTaxClassificationWorkerEnabled("true").enabled, true);
  assert.equal(parseTaxClassificationWorkerEnabled("false").enabled, false);
  assert.equal(parseTaxClassificationWorkerEnabled("0").enabled, false);
  assert.equal(parseTaxClassificationWorkerEnabled("unexpected").enabled, true);
});

test("stale recovery migration preserves claim RPC contract and only expands due running recovery", () => {
  const migration = fs.readFileSync("supabase/migrations/20260928_tax_classification_worker_recovery.sql", "utf8");
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.claim_tax_classification_runs/);
  assert.match(migration, /RETURNS SETOF public\.tax_classification_runs/);
  assert.match(migration, /FOR UPDATE SKIP LOCKED/);
  assert.match(migration, /r\.status = 'running'/);
  assert.match(migration, /r\.locked_at < p_now - interval '15 minutes'/);
  assert.match(migration, /tax_classification_runs_stale_running_idx/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.claim_tax_classification_runs\(text, integer, timestamptz\) TO service_role/);
  assert.doesNotMatch(migration, /DROP POLICY|DISABLE ROW LEVEL SECURITY|ALTER TABLE public\.tax_classification_runs DISABLE/);
});

test("stale running classification runs can be claimed by a recovery worker", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 2 }));
  const queued = await enqueueTaxClassificationRun({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.USER_PREPARE,
    now: new Date("2026-09-04T12:00:00Z"),
  });
  const run = supabase.store.tax_classification_runs.find((row) => row.id === queued.run.id);
  Object.assign(run, {
    status: TAX_CLASSIFICATION_RUN_STATUSES.RUNNING,
    locked_at: "2026-09-04T12:00:00Z",
    heartbeat_at: "2026-09-04T12:00:00Z",
    attempt_count: 1,
  });

  await processPendingTaxClassificationRuns({
    supabase,
    workerId: "recovery-worker",
    runBatchSize: 1,
    transactionBatchSize: 50,
    now: new Date("2026-09-04T12:16:00Z"),
  });

  const recovered = supabase.store.tax_classification_runs.find((row) => row.id === queued.run.id);
  assert.equal(recovered.locked_by, null);
  assert.equal(recovered.status, TAX_CLASSIFICATION_RUN_STATUSES.REVIEW_REQUIRED);
  assert.equal(recovered.processed_count, 2);
  assert.equal(recovered.attempt_count, 2);
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

test("review-required fallback outcomes reconcile as evaluated unresolved rows, not classified rows", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 207, taxDeductionRules: [] }));
  const queued = await enqueueTaxClassificationRun({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.USER_PREPARE,
    now: new Date("2026-09-07T16:14:01Z"),
  });

  await processPendingTaxClassificationRuns({
    supabase,
    workerId: "test-worker",
    runBatchSize: 1,
    transactionBatchSize: 100,
    now: new Date("2026-09-07T16:14:10Z"),
  });

  const lifecycle = await getTaxClassificationLifecycleStatus({ supabase, businessId: BUSINESS_ID, taxYear: 2026 });
  const finalRun = supabase.store.tax_classification_runs.find((row) => row.id === queued.run.id);

  assert.equal(finalRun.status, TAX_CLASSIFICATION_RUN_STATUSES.REVIEW_REQUIRED);
  assert.equal(finalRun.processed_count, 207);
  assert.equal(finalRun.review_required_count, 0);
  assert.equal(finalRun.queued_count, 0);
  assert.equal(lifecycle.evaluatedCount, 207);
  assert.equal(lifecycle.classifiedCount, 0);
  assert.equal(lifecycle.needsReviewCount, 0);
  assert.equal(lifecycle.unresolvedCount, 207);
  assert.equal(lifecycle.autoClassifiedCount, 0);
  assert.equal(lifecycle.excludedCount, 0);
  assert.equal(lifecycle.unclassifiedCount, 207);
  assert.equal(lifecycle.missingEvaluationCount, 0);
  assert.equal(lifecycle.classificationStatus, "ready_to_classify");
});

test("incomplete classification rows cannot make coverage or status appear complete", async () => {
  const store = baseStore({ transactionCount: 3 });
  store.transaction_tax_classifications = store.bank_transactions.map((row) => ({
    id: `bad-${row.id}`,
    business_id: BUSINESS_ID,
    transaction_id: row.id,
    tax_year: 2026,
    transaction_date: row.date,
    tax_category: null,
    deductibility_status: null,
    deductible_percent: null,
    book_amount: null,
    deductible_amount: null,
    nondeductible_amount: null,
    capitalizable_amount: null,
    classification_status: TAX_CLASSIFICATION_RUN_STATUSES.COMPLETED,
    metadata: { tax_classification_stale: false },
    created_at: "2026-09-07T16:00:00Z",
    updated_at: "2026-09-07T16:00:00Z",
  }));
  store.tax_classification_runs.push({
    id: "run-processed-without-outcomes",
    business_id: BUSINESS_ID,
    tax_year: 2026,
    status: TAX_CLASSIFICATION_RUN_STATUSES.COMPLETED,
    total_eligible: 3,
    queued_count: 0,
    processed_count: 3,
    auto_classified_count: 0,
    review_required_count: 0,
    excluded_count: 0,
    failed_count: 0,
    attempt_count: 1,
    max_attempts: 5,
    created_at: "2026-09-07T16:00:00Z",
    queued_at: "2026-09-07T16:00:00Z",
    completed_at: "2026-09-07T16:01:00Z",
    updated_at: "2026-09-07T16:01:00Z",
  });
  const supabase = makeSupabase(store);

  const lifecycle = await getTaxClassificationLifecycleStatus({ supabase, businessId: BUSINESS_ID, taxYear: 2026 });
  const job = await getTaxClassificationJobStatus({ supabase, businessId: BUSINESS_ID, taxYear: 2026 });

  assert.equal(lifecycle.classifiedCount, 0);
  assert.equal(lifecycle.unclassifiedCount, 3);
  assert.equal(lifecycle.classificationStatus, "ready_to_classify");
  assert.equal(job.status, "not_started");
  assert.equal(job.processed, 0);
  assert.equal(job.remaining, 3);
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

test("incomplete profile without entity context does not enqueue unsafe automatic classification", async () => {
  const supabase = makeSupabase(baseStore({
    transactionCount: 1,
    taxProfiles: [draftProfile({ entity_type: "unknown" })],
  }));

  const queued = await handleTaxClassificationEvent({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    changeType: TAX_CHANGE_TYPES.QBO_TRANSACTION_POSTED,
    entityId: "txn-001",
  });
  const recovery = await enqueueRecoveryTaxClassificationRuns({ supabase, taxYear: 2026 });

  assert.equal(queued.queued, false);
  assert.equal(queued.outcome, "classification_context_missing");
  assert.equal(recovery.length, 0);
  assert.equal(supabase.store.tax_classification_runs.length, 0);
});

test("profile already classification-ready with missed unclassified rows is recovered without calculation eligibility", async () => {
  const supabase = makeSupabase(baseStore({
    transactionCount: 3,
    taxProfiles: [draftProfile({ entity_type: "sole_proprietor", filing_status: null, safe_harbor_method: null })],
  }));

  const eligible = await getBusinessesEligibleForTaxClassification({ supabase, taxYear: 2026 });
  const queued = await enqueueRecoveryTaxClassificationRuns({ supabase, taxYear: 2026 });

  assert.equal(eligible.businesses[0].eligible, true);
  assert.equal(eligible.businesses[0].requiredContext.requiredForClassification.includes("entity_type"), true);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].queued, true);
  assert.equal(supabase.store.tax_classification_runs[0].trigger_source, TAX_CLASSIFICATION_TRIGGER_SOURCES.RECOVERY_SCAN);
});

test("posted GL account change marks prior machine classification stale and reclassifies current facts", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 1 }));
  await processPendingRunFromEvent({ supabase, changeType: TAX_CHANGE_TYPES.QBO_TRANSACTION_POSTED, transactionId: "txn-001" });
  let classification = supabase.store.transaction_tax_classifications.find((row) => row.transaction_id === "txn-001");
  assert.equal(classification.tax_category, "software");
  Object.assign(supabase.store.transaction_categorizations[0], {
    final_qbo_account_name: "Meals",
    updated_at: "2026-09-04T13:00:00Z",
  });

  const updated = await handleTaxClassificationEvent({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    changeType: TAX_CHANGE_TYPES.QBO_TRANSACTION_UPDATED,
    entityId: "txn-001",
    metadata: { changedFields: ["final_qbo_account_name"] },
    now: new Date("2026-09-04T13:00:00Z"),
  });
  await processPendingTaxClassificationRuns({ supabase, workerId: "test-worker", runBatchSize: 1, transactionBatchSize: 50 });

  classification = supabase.store.transaction_tax_classifications.find((row) => row.transaction_id === "txn-001");
  assert.equal(updated.stale.changed, true);
  assert.equal(updated.queued, true);
  assert.equal(classification.tax_category, "meals");
  assert.equal(classification.classification_status, "needs_review");
  assert.equal(classification.metadata.tax_classification_stale, false);
});

test("reviewed transaction fact change is preserved as renewed review, not silently overwritten", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 1 }));
  await processPendingRunFromEvent({ supabase, changeType: TAX_CHANGE_TYPES.QBO_TRANSACTION_POSTED, transactionId: "txn-001" });
  const classification = supabase.store.transaction_tax_classifications.find((row) => row.transaction_id === "txn-001");
  Object.assign(classification, { classification_status: "user_confirmed", user_override: true, requires_review: false });
  Object.assign(supabase.store.transaction_categorizations[0], { final_qbo_account_name: "Meals" });

  await handleTaxClassificationEvent({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    changeType: TAX_CHANGE_TYPES.QBO_TRANSACTION_UPDATED,
    entityId: "txn-001",
    metadata: { changedFields: ["final_qbo_account_name"] },
  });

  assert.equal(classification.user_override, true);
  assert.equal(classification.classification_status, "needs_review");
  assert.equal(classification.requires_review, true);
  assert.equal(classification.metadata.reviewed_decision_requires_renewed_review, true);
});

test("voided transaction neutralizes prior tax contribution without deleting audit row", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 1 }));
  await processPendingRunFromEvent({ supabase, changeType: TAX_CHANGE_TYPES.QBO_TRANSACTION_POSTED, transactionId: "txn-001" });
  const classification = supabase.store.transaction_tax_classifications.find((row) => row.transaction_id === "txn-001");
  assert.equal(classification.classification_status, "auto_classified");

  const result = await handleTaxClassificationEvent({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    changeType: TAX_CHANGE_TYPES.QBO_TRANSACTION_VOIDED,
    entityId: "txn-001",
    metadata: { source: "qbo_void" },
  });

  assert.equal(result.outcome, "classification_neutralized");
  assert.equal(supabase.store.transaction_tax_classifications.length, 1);
  assert.equal(classification.classification_status, "excluded");
  assert.equal(classification.deductible_amount, 0);
  assert.equal(classification.metadata.neutralized_reason, "qbo_transaction_voided");
});

test("older machine classification engine version is recovered as stale work", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 1 }));
  await processPendingRunFromEvent({ supabase, changeType: TAX_CHANGE_TYPES.QBO_TRANSACTION_POSTED, transactionId: "txn-001" });
  const classification = supabase.store.transaction_tax_classifications.find((row) => row.transaction_id === "txn-001");
  classification.metadata.classification_engine_version = "tax-classification-legacy";

  const lifecycle = await getTaxClassificationLifecycleStatus({ supabase, businessId: BUSINESS_ID, taxYear: 2026 });
  const queued = await enqueueRecoveryTaxClassificationRuns({ supabase, taxYear: 2026 });

  assert.equal(lifecycle.classificationStatus, "ready_to_classify");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].run.trigger_source, TAX_CLASSIFICATION_TRIGGER_SOURCES.RECOVERY_SCAN);
});

test("business mapping change stales machine classifications and enqueues bounded reclassification", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 1 }));
  await processPendingRunFromEvent({ supabase, changeType: TAX_CHANGE_TYPES.QBO_TRANSACTION_POSTED, transactionId: "txn-001" });
  const classification = supabase.store.transaction_tax_classifications.find((row) => row.transaction_id === "txn-001");
  assert.equal(classification.metadata.tax_classification_stale, false);

  const queued = await handleTaxClassificationEvent({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    changeType: TAX_CHANGE_TYPES.BUSINESS_RULE_CREATED,
    entityId: "business-rule-1",
  });

  assert.equal(queued.stale.changed, 1);
  assert.equal(queued.queued, true);
  assert.equal(classification.metadata.tax_classification_stale, true);
  assert.equal(supabase.store.tax_classification_runs.at(-1).trigger_source, TAX_CLASSIFICATION_TRIGGER_SOURCES.RULES_CHANGED);
});

test("calculation-only tax change events do not enqueue classification work", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 1 }));

  const result = await handleTaxClassificationEvent({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    changeType: TAX_CHANGE_TYPES.PAYMENT_UPDATED,
    entityId: "payment-1",
  });

  assert.equal(result.queued, false);
  assert.equal(result.outcome, "unsupported_classification_trigger");
  assert.equal(supabase.store.tax_classification_runs.length, 0);
});

test("manual link-existing posting route emits canonical tax classification event after persistence", () => {
  const route = fs.readFileSync("src/api/bookkeeping/routes/bookkeeping.posting.routes.js", "utf8");
  const linkExistingStart = route.indexOf('router.post("/posting/transactions/:transactionId/link-existing"');
  const successUpdate = route.indexOf(".from(\"transaction_categorizations\")", linkExistingStart);
  const eventEmit = route.indexOf("emitTaxDataChanged({", successUpdate);
  const response = route.indexOf("return res.json", successUpdate);

  assert.ok(linkExistingStart > 0);
  assert.ok(successUpdate > linkExistingStart);
  assert.ok(eventEmit > successUpdate);
  assert.ok(response > eventEmit);
  assert.match(route.slice(eventEmit, response), /changeType: TAX_CHANGE_TYPES\.QBO_TRANSACTION_POSTED/);
  assert.match(route.slice(eventEmit, response), /taxYearFromDate\(bankTxn\?\.date \|\| nowIso\)/);
});

test("posted bookkeeping reclassification service emits canonical updated tax event", () => {
  const service = fs.readFileSync("src/services/bookkeeping/bookkeepingReclassificationService.js", "utf8");
  const postedBranch = service.indexOf('mode: "posted_qbo_reclassification"');
  const eventEmit = service.indexOf("emitTaxDataChanged({");

  assert.ok(eventEmit > 0);
  assert.ok(postedBranch > eventEmit);
  assert.match(service.slice(eventEmit, postedBranch), /changeType: TAX_CHANGE_TYPES\.QBO_TRANSACTION_UPDATED/);
  assert.match(service.slice(eventEmit, postedBranch), /changedFields: \["final_qbo_account_id", "final_qbo_account_name"\]/);
  assert.match(service.slice(eventEmit, postedBranch), /taxYearFromDate\(context\.bankTxn\?\.date \|\| now\)/);
});

test("classification lifecycle covers deletion and reversal events idempotently", async () => {
  const supabase = makeSupabase(baseStore({ transactionCount: 1 }));
  await processPendingRunFromEvent({ supabase, changeType: TAX_CHANGE_TYPES.QBO_TRANSACTION_POSTED, transactionId: "txn-001" });

  const deleted = await handleTaxClassificationEvent({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    changeType: TAX_CHANGE_TYPES.QBO_TRANSACTION_DELETED,
    entityId: "txn-001",
  });
  const repeated = await handleTaxClassificationEvent({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    changeType: TAX_CHANGE_TYPES.QBO_TRANSACTION_DELETED,
    entityId: "txn-001",
  });
  supabase.store.bank_transactions.push(bankTxn({ id: "txn-002", name: "Refund reversal", signed_amount: 25, amount: 25, direction: "INFLOW" }));
  supabase.store.transaction_categorizations.push(categorization({ id: "cat-txn-002", transaction_id: "txn-002", final_qbo_account_name: "Refunds", qbo_txn_id: "qbo-txn-002" }));
  supabase.store.qbo_posted_transactions.push(qboPosted({ id: "qbo-row-txn-002", transaction_id: "txn-002", qbo_txn_id: "qbo-txn-002" }));
  const reversal = await handleTaxClassificationEvent({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    changeType: TAX_CHANGE_TYPES.QBO_TRANSACTION_REVERSED,
    entityId: "txn-002",
  });

  assert.equal(deleted.outcome, "classification_neutralized");
  assert.equal(repeated.outcome, "no_classification_to_neutralize");
  assert.equal(reversal.queued, true);
});

async function processPendingRunFromEvent({ supabase, changeType, transactionId }) {
  await handleTaxClassificationEvent({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: 2026,
    changeType,
    entityId: transactionId,
  });
  return processPendingTaxClassificationRuns({
    supabase,
    workerId: "test-worker",
    runBatchSize: 1,
    transactionBatchSize: 50,
  });
}

function baseStore({ transactionCount = 0, includeOtherTenantTransaction = false, taxProfiles = [completeProfile()], taxDeductionRules = [softwareRule(), mealsRule()] } = {}) {
  const store = {
    business_profiles: [{ id: BUSINESS_ID, bookkeeping_start_date: null }],
    bank_transactions: [],
    transaction_categorizations: [],
    qbo_posted_transactions: [],
    transaction_tax_classifications: [],
    tax_classification_runs: [],
    tax_recalculation_requests: [],
    tax_profiles: taxProfiles,
    tax_deduction_rules: taxDeductionRules,
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

function draftProfile(overrides = {}) {
  return completeProfile({
    filing_status: null,
    primary_tax_state: "NC",
    accounting_method: null,
    safe_harbor_method: null,
    self_employment_tax_applies: null,
    profile_status: "incomplete",
    ...overrides,
  });
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

function fallbackClassification(overrides = {}) {
  return {
    id: `fallback-${overrides.transaction_id || "txn-001"}`,
    business_id: BUSINESS_ID,
    transaction_id: "txn-001",
    tax_year: 2026,
    transaction_date: "2026-08-15",
    tax_category: "unclassified",
    deductibility_status: "needs_review",
    deductible_percent: 0,
    book_amount: -25,
    deductible_amount: 0,
    nondeductible_amount: 0,
    capitalizable_amount: 0,
    tax_treatment: { type: "unclassified" },
    classification_status: "needs_review",
    confidence_score: 20,
    confidence_level: "low",
    rule_id: null,
    rule_code: null,
    rule_version: null,
    rule_priority: null,
    source: "rule_engine",
    requires_review: true,
    user_override: false,
    cpa_override: false,
    reason: "No reliable tax deduction rule matched this posted transaction.",
    metadata: {
      fallback: true,
      source_qbo_account_name: "Software",
      normalized_qbo_account_name: "software",
      tax_classification_stale: false,
    },
    created_at: "2026-09-07T16:14:07.304Z",
    updated_at: "2026-09-07T16:14:07.304Z",
    ...overrides,
  };
}

function softwareRule(overrides = {}) {
  return rule({
    id: "software-rule",
    rule_code: "software",
    tax_category: "software",
    bookkeeping_category: "Software",
    deductibility_status: "fully_deductible",
    default_deductible_percent: 100,
    priority: 10,
    ...overrides,
  });
}

function mealsRule(overrides = {}) {
  return rule({
    id: "meals-rule",
    rule_code: "meals_requires_review",
    tax_category: "meals",
    bookkeeping_category: "Meals",
    deductibility_status: "partially_deductible",
    default_deductible_percent: 50,
    requires_review: true,
    priority: 20,
    ...overrides,
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
    default_deductible_percent: 100,
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
