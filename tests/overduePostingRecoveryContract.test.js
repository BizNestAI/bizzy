import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { derivePostingOutcome } from "../src/services/bookkeeping/bookkeepingLifecycleClassifier.js";
import { classifyPostingFailure } from "../src/services/bookkeeping/postingFailureClassification.js";
import { deriveQboPostingLifecycle } from "../src/services/bookkeeping/qboPostingLifecycle.js";

const read = (path) => readFileSync(path, "utf8");
const nowMs = Date.parse("2026-10-04T17:47:00.000Z");

test("future schedules and overdue schedules have distinct deterministic states", () => {
  assert.equal(derivePostingOutcome({ status: "approved", post_after: "2026-10-05T05:11:00.000Z" }, nowMs).key, "queued");
  assert.equal(derivePostingOutcome({ status: "approved", post_after: "2026-09-30T05:12:00.000Z" }, nowMs).key, "delayed");
});

test("durable job state outranks a stale categorization timestamp", () => {
  const base = { status: "approved", post_after: "2026-09-30T05:12:00.000Z" };
  assert.equal(deriveQboPostingLifecycle({ ...base, posting_job: { state: "processing" } }, { nowMs }).key, "posting");
  assert.equal(deriveQboPostingLifecycle({ ...base, posting_job: { state: "retry_scheduled", next_attempt_at: "2026-10-04T18:15:00.000Z" } }, { nowMs }).key, "retry_scheduled");
  assert.equal(deriveQboPostingLifecycle({ ...base, posting_job: { state: "blocked", blocking_code: "missing_source_qbo_account" } }, { nowMs }).key, "configuration_blocked");
});

test("posting failures separate retryable ambiguity from terminal validation", () => {
  const timeout = classifyPostingFailure(new Error("socket timed out"));
  assert.equal(timeout.code, "qbo_outcome_ambiguous");
  assert.equal(timeout.retryable, true);
  assert.equal(timeout.reconcile_before_retry, true);

  const rejected = classifyPostingFailure({ code: "qbo_transaction_rejected", retryable: false });
  assert.equal(rejected.terminal, true);
  assert.equal(rejected.retryable, false);

  const realm = classifyPostingFailure("qbo_posting_realm_mismatch");
  assert.equal(realm.terminal, true);
});

test("worker recovery is bounded, idempotent, and isolates vendor learning", () => {
  const worker = read("src/jobs/booksPost.cron.js");
  const intent = read("supabase/migrations/20260826_qbo_posting_idempotency_phase2.sql");
  const jobs = read("supabase/migrations/20261027_handled_posting_jobs_hardening.sql");
  const reconciliation = read("supabase/migrations/20261101094000_reconcile_handled_posting_job_runtime_states.sql");

  assert.match(worker, /BOOKS_POST_MAX_RETRIES \|\| 5/);
  assert.match(worker, /BACKOFF_SCHEDULE_MS/);
  assert.match(worker, /existingIntent\?\.status === "posted"/);
  assert.match(worker, /qbo_write_succeeded !== true/);
  assert.match(worker, /processVendorRuleLearningRetryJobs\(\)[\s\S]*?\.catch/);
  assert.match(intent, /lease_expires_at <=? p_now|v_row\.lease_expires_at > p_now/i);
  assert.match(intent, /already_posted/);
  assert.match(jobs, /handled_missing_posting_job/);
  assert.match(reconciliation, /v_intent\.status = 'posted'[\s\S]*v_state := 'reconciling'/);
});

test("posting job storage is business scoped and does not expose customer writes", () => {
  const jobs = read("supabase/migrations/20261027_handled_posting_jobs_hardening.sql");
  assert.match(jobs, /unique \(business_id, transaction_id\)/i);
  assert.match(jobs, /enable row level security/i);
  assert.match(jobs, /revoke all on table public\.bookkeeping_posting_jobs from anon, authenticated/i);
  assert.match(jobs, /grant all on table public\.bookkeeping_posting_jobs to service_role/i);
});
