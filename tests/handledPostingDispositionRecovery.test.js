import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("automatic Handled writes persist posting safety with the final account and schedule", () => {
  const suggestion = read("src/api/bookkeeping/routes/bookkeeping.suggest.routes.js");
  const canonical = read("src/services/bookkeeping/canonicalQboAccountResolver.js");
  assert.match(suggestion, /safe_to_auto_post:\s*true[\s\S]*status:\s*"auto_approved"/);
  assert.match(suggestion, /finalAcctId[\s\S]*postAfter/);
  assert.match(canonical, /safe_to_auto_handle:\s*autoApproved,[\s\S]*safe_to_auto_post:\s*autoApproved/);
  assert.match(canonical, /status:\s*autoApproved \? "auto_approved" : "needs_review"/);
});

test("bounded recovery is business scoped, CAS guarded, and never invokes QuickBooks", () => {
  const source = read("src/services/bookkeeping/handledPostingDispositionRecoveryService.js");
  assert.match(source, /slice\(0, 25\)/);
  assert.match(source, /Math\.min\(Number\(limit\) \|\| 25, 25\)/);
  assert.match(source, /query = query\.in\("transaction_id", transactionIds\)/);
  assert.match(source, /\.eq\("business_id", businessId\)/);
  assert.match(source, /\.eq\("updated_at", updatedAt\)/);
  assert.match(source, /active_operation/);
  assert.match(source, /pending_transaction_not_postable/);
  assert.match(source, /automatic_safety_revalidated/);
  assert.match(source, /returned_to_review/);
  assert.match(source, /manual_approval_scheduled/);
  assert.doesNotMatch(source, /getQBOClient|postToQbo|createPurchase|createDeposit|createCreditCardCredit/);
});

test("unsafe automatic rows return to review while durable manual approvals are preserved", () => {
  const source = read("src/services/bookkeeping/handledPostingDispositionRecoveryService.js");
  assert.match(source, /const manual = hasManualAccountAuthority\(row\)/);
  assert.match(source, /if \(manual\)[\s\S]*result\.skipped/);
  assert.match(source, /status:\s*"needs_review"[\s\S]*final_qbo_account_id:\s*null/);
  assert.match(source, /superseded_automated_review_reason/);
});

test("forward migration exposes a service-only diagnostic and preserves grants", () => {
  const sql = read("supabase/migrations/20261101094000_reconcile_handled_posting_job_runtime_states.sql");
  assert.match(sql, /bookkeeping_handled_posting_disposition_violations/);
  assert.match(sql, /security_invoker = true/);
  assert.match(sql, /revoke all on table public\.bookkeeping_handled_posting_disposition_violations from public, anon, authenticated/);
  assert.match(sql, /grant select on table public\.bookkeeping_handled_posting_disposition_violations to service_role/);
  assert.match(sql, /automatic_posting_safety_not_established/);
});

test("worker diagnostics report configuration and bounded sweep outcomes without payloads", () => {
  const worker = read("src/jobs/booksPost.cron.js");
  assert.match(worker, /\[books-post\] worker configuration/);
  assert.match(worker, /cadence_minutes:\s*POLL_MINUTES/);
  assert.match(worker, /batch_size:\s*POSTING_BATCH_SIZE/);
  assert.match(worker, /maximum_retries:\s*MAX_RETRIES/);
  assert.match(worker, /\[books-post\] sweep started/);
  assert.match(worker, /\[books-post\] sweep completed/);
  for (const field of ["eligible", "claimed", "posted", "retried", "blocked", "failed"]) {
    assert.match(worker, new RegExp(`${field}:`));
  }
  assert.match(worker, /sanitizedErrorClass/);
});

test("Admin recovery endpoint delegates to the shared database-only service", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  assert.match(route, /recover-handled-posting-dispositions/);
  assert.match(route, /recoverHandledPostingDispositions/);
  assert.match(route, /bounded_transaction_selection_required/);
  assert.match(route, /assertRunTransactionInSelectedMonth\(run, transactionId\)/);
  assert.match(route, /No QuickBooks writes were attempted/);
});
