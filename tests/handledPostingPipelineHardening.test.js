import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync("supabase/migrations/20261027_handled_posting_jobs_hardening.sql", "utf8");
const worker = readFileSync("src/jobs/booksPost.cron.js", "utf8");
const feed = readFileSync("src/services/bookkeeping/bookkeepingTransactionFeedService.js", "utf8");

test("every Handled row receives one durable scheduled or blocked posting job", () => {
  assert.match(migration, /unique \(business_id, transaction_id\)/i);
  assert.match(migration, /sync_bookkeeping_posting_job/i);
  assert.match(migration, /state in \('scheduled','retry_scheduled','processing','reconciling','blocked','failed','posted','cancelled'\)/i);
  assert.match(migration, /blocking_code/i);
  assert.match(migration, /audit_handled_posting_job_invariants/i);
});

test("posting jobs retain authoritative QBO intent and receipt identifiers", () => {
  assert.match(migration, /qbo_intent_id uuid references public\.qbo_posted_transactions/i);
  assert.match(migration, /qbo_request_id text/i);
  assert.match(migration, /qbo_txn_id text/i);
  assert.match(migration, /posted_without_qbo_reference/i);
});

test("worker sweeps due rows immediately after deploy and UI loads job state", () => {
  assert.match(worker, /startup sweep error/);
  assert.match(feed, /attachPostingJobsForFeed/);
  assert.match(feed, /Overdue — posting delayed/);
  assert.match(feed, /configuration_blocked/);
  assert.match(feed, /retry_scheduled/);
});

test("a pre-create vendor gate releases the QBO intent lease", () => {
  assert.match(worker, /status: outcome\.retryable \? "pending" : "failed"/);
  assert.match(worker, /processing_started_at: null/);
  assert.match(worker, /lease_expires_at: null/);
});

test("retry backoff updates the scheduler's authoritative due time", () => {
  assert.match(worker, /post_after: shouldStop \? null : nextAttemptIso/);
  assert.match(worker, /post_after: nextAttemptIso/);
  assert.doesNotMatch(worker, /shouldStop[\s\S]{0,120}: item\.post_after/);
});
