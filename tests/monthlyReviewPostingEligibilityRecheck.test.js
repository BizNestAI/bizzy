import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { derivePostingEligibilityRecheckAvailability } from "../src/pages/Admin/postingEligibilityRecheckAvailability.js";
import { isBulkApprovablePostingReason } from "../src/services/bookkeeping/postingEligibilityApprovalPolicy.js";
import { resolveCompletedPostingEligibilityExecution } from "../src/services/bookkeeping/postingEligibilityExecutionState.js";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("MRP exposes a bounded two-step posting eligibility workflow", () => {
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  assert.match(page, /Recheck Posting Eligibility/);
  assert.match(page, /posting-eligibility-preview/);
  assert.match(page, /posting-eligibility-executions/);
  assert.match(page, /Idempotency-Key/);
  assert.match(page, /preview_version/);
  assert.match(page, /No QuickBooks or Plaid call occurs/);
  assert.match(page, /feeds\?\.handled\?\.totalCount/);
  assert.doesNotMatch(page, /feeds\?\.handled\?\.count/);
  assert.match(page, /role="dialog" aria-modal="true"/);
});

test("preview and execution derive business and month from the authorized run", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  assert.match(route, /router\.use\(requireAuth\)/);
  assert.match(route, /requireInternalRole\(MONTHLY_REVIEW_STAFF_ROLES\)/);
  assert.match(route, /posting-eligibility-preview/);
  assert.match(route, /posting-eligibility-executions/);
  assert.match(route, /businessId: run\.business_id/);
  assert.match(route, /fetchPostingEligibilityHandledScope\(run\)/);
  assert.match(route, /month: handled\.reviewMonth/);
  assert.doesNotMatch(route.slice(route.indexOf("posting-eligibility-preview"), route.indexOf("posting-eligibility-executions")), /req\.body\?\.business_id/);
});

test("authoritative Handled count controls button availability without client eligibility guesses", () => {
  assert.deepEqual(derivePostingEligibilityRecheckAvailability({
    handledTotalCount: 80, countLoaded: true, authorized: true, contextReady: true,
  }), { disabled: false, title: "Preview a server-side posting eligibility recheck." });
  assert.equal(derivePostingEligibilityRecheckAvailability({
    handledTotalCount: 0, countLoaded: true, authorized: true, contextReady: true,
  }).title, "No Handled transactions exist for the selected month.");
  assert.equal(derivePostingEligibilityRecheckAvailability({
    handledTotalCount: 80, countLoaded: false, authorized: true, contextReady: true,
  }).title, "Loading Handled transactions…");
  assert.equal(derivePostingEligibilityRecheckAvailability({
    handledTotalCount: 80, countLoaded: true, authorized: false, contextReady: true,
  }).title, "You do not have permission to perform this action.");
  assert.equal(derivePostingEligibilityRecheckAvailability({
    handledTotalCount: 80, countLoaded: true, authorized: true, contextReady: true, executing: true,
  }).title, "A posting-eligibility recheck is already running.");
});

test("server preview starts from the same bounded selected-month Handled RPC population", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const helper = route.slice(route.indexOf("async function fetchPostingEligibilityHandledScope"), route.indexOf("router.use(requireAuth)"));
  assert.match(helper, /get_bookkeeping_transactions_bounded/);
  assert.match(helper, /p_status_filter: "handled"/);
  assert.match(helper, /p_range_start: rangeStart/);
  assert.match(helper, /p_range_end: rangeEnd/);
  assert.match(helper, /p_limit: MONTHLY_REVIEW_BOOKKEEPING_PAGE_SIZE_MAX/);
  assert.match(route, /transactionIds: handled\.transactionIds/);
  assert.match(route, /authoritative_handled_count: handled\.totalCount/);
});

test("shared reconciliation is bounded, read-only in preview, and CAS guarded in execution", () => {
  const service = read("src/services/bookkeeping/postingEligibilityRecheckService.js");
  assert.match(service, /const MAX_ROWS = 100/);
  assert.match(service, /previewPostingEligibilityRecheck/);
  assert.match(service, /executePostingEligibilityRecheck/);
  const preview = service.slice(service.indexOf("export async function previewPostingEligibilityRecheck"), service.indexOf("async function persistExecution"));
  assert.doesNotMatch(preview, /\.update\(|\.insert\(|\.upsert\(/);
  assert.match(service, /\.eq\("updated_at", row\.categorization_updated_at\)/);
  assert.match(service, /posting_eligibility_preview_stale/);
  assert.match(service, /business_id,idempotency_key/);
  assert.doesNotMatch(service, /getQBOClient|plaidClient|createPurchase|createDeposit|createCreditCardCredit/);
});

test("preview uses the deployed posting-intent schema and normalizes fatal schema failures", () => {
  const service = read("src/services/bookkeeping/postingEligibilityRecheckService.js");
  const route = read("src/api/admin/monthlyReview.routes.js");
  const intentSelect = service.match(/qbo_posted_transactions"\)\.select\("([^"]+)/)?.[1] || "";
  assert.ok(intentSelect.includes("lease_expires_at"));
  assert.ok(!intentSelect.includes("lease_owner"));
  assert.match(route, /posting_eligibility_schema_unavailable/);
  assert.match(route, /"42703"/);
  assert.match(route, /request_id: requestId/);
  assert.match(route, /x-bizzi-request-id/);
  assert.doesNotMatch(route.slice(route.indexOf('posting-eligibility-preview'), route.indexOf('posting-eligibility-executions')), /error\?\.message/);
});

test("preview contract rejects a non-empty body with 400 semantics", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const previewRoute = route.slice(route.indexOf('posting-eligibility-preview'), route.indexOf('posting-eligibility-executions'));
  assert.match(previewRoute, /Object\.keys\(req\.body\)\.length > 0/);
  assert.match(previewRoute, /status\(400\)/);
  assert.match(previewRoute, /invalid_posting_eligibility_preview_request/);
});

test("one malformed row becomes a sanitized failed preview outcome", () => {
  const service = read("src/services/bookkeeping/postingEligibilityRecheckService.js");
  assert.match(service, /posting_eligibility_row_evaluation_failed/);
  assert.match(service, /outcome = "failed"/);
  assert.match(service, /counts: \{[^}]*failed: 0/);
});

test("preview error UI shows stable diagnostics and keeps confirmation gated", () => {
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  assert.match(page, /Code: \{state\.errorCode\}/);
  assert.match(page, /Request: \{state\.requestId\}/);
  assert.match(page, />Retry<\/button>/);
  assert.match(page, /disabled=\{!preview \|\| state\.loading \|\| state\.executing/);
});

test("canonical safety evaluation protects provider evidence and special workflows", () => {
  const service = read("src/services/bookkeeping/postingEligibilityRecheckService.js");
  for (const contract of [
    "pending_transaction_not_postable",
    "active_provider_operation",
    "active_worker_lease",
    "qbo_receipt_requires_reconciliation",
    "provider_reconciliation_required",
    "recovery_posting_hold_active",
    "matched_or_paired_transaction",
    "possible_qbo_duplicate",
    "incoming_deposit_resolution_required",
    "invalid_or_inactive_qbo_account",
    "source_environment_mismatch",
  ]) assert.match(service, new RegExp(contract));
  assert.match(service, /hasAuthorizedMonthlyReviewApproval/);
  assert.match(service, /current_automatic_safety_gates/);
  assert.match(service, /durable_manual_approval/);
});

test("soft evidence blockers are centrally allowlisted while hard gates stay outside bulk approval", () => {
  const service = read("src/services/bookkeeping/postingEligibilityRecheckService.js");
  const policy = read("src/services/bookkeeping/postingEligibilityApprovalPolicy.js");
  assert.match(policy, /BULK_APPROVABLE_POSTING_REASON_CODES/);
  for (const reason of ["no_active_authoritative_business_rule", "weak_memo_evidence", "missing_safe_to_auto_post_attestation"]) assert.match(policy, new RegExp(reason));
  for (const hard of ["pending_transaction_not_postable", "possible_qbo_duplicate", "matched_or_paired_transaction", "active_provider_operation", "active_worker_lease", "already_posted"]) {
    assert.match(service, new RegExp(hard));
  }
  assert.match(service, /outcome = isBulkApprovablePostingReason\(why\)/);
});

test("63 automatic rows and 17 missing-rule rows produce distinct preview groups", () => {
  const fixture = [
    ...Array.from({ length: 63 }, (_, index) => ({ id: `automatic-${index}`, reason: "current_automatic_safety_gates" })),
    ...Array.from({ length: 17 }, (_, index) => ({ id: `manual-${index}`, reason: "no_active_authoritative_business_rule" })),
  ];
  assert.equal(fixture.filter((row) => !isBulkApprovablePostingReason(row.reason)).length, 63);
  assert.equal(fixture.filter((row) => isBulkApprovablePostingReason(row.reason)).length, 17);
  assert.equal(isBulkApprovablePostingReason("possible_qbo_duplicate"), false);
});

test("bulk approval persists durable authority and delegates to canonical approval and vendor learning", () => {
  const service = read("src/services/bookkeeping/postingEligibilityRecheckService.js");
  const authority = read("src/services/bookkeeping/manualPostingAuthority.js");
  assert.match(service, /approveBookkeepingTransactions/);
  assert.match(service, /MONTHLY_REVIEW_BULK_APPROVAL_SOURCE/);
  assert.match(authority, /monthly_review_bulk_posting_approval/);
  for (const field of ["approved_by", "approved_at", "selected_qbo_account_id", "previous_categorization_source", "override_reason", "preview_id", "execution_id"]) assert.match(authority, new RegExp(field));
  assert.match(service, /manualRequest\.row_version !== row\.row_version/);
  assert.match(service, /only_this_transaction: manualRequest\.learn_reusable_rule !== true/);
  assert.match(service, /idempotency_context: `posting-eligibility:/);
  assert.match(service, /transaction_outside_authoritative_scope/);
  assert.match(service, /resolveCompletedPostingEligibilityExecution\(existing\.data\)/);
  assert.doesNotMatch(service, /if \(existing\.data\?\.status !== "running"\)/);
  assert.match(service, /conflicting_vendor_rule_categories/);
  assert.match(service, /ruleLearningLeaders/);
});

test("first submission does not dereference a missing prior execution and retries reuse completion", () => {
  assert.equal(resolveCompletedPostingEligibilityExecution(null), null);
  assert.equal(resolveCompletedPostingEligibilityExecution({ id: "running-id", status: "running" }), null);
  assert.deepEqual(resolveCompletedPostingEligibilityExecution({ id: "done-id", status: "completed", result: { ok: true, counts: { newly_scheduled: 80 } } }), {
    ok: true,
    counts: { newly_scheduled: 80 },
    idempotent: true,
    execution_id: "done-id",
  });
});

test("modal only offers automatic scheduling and never submits category approval", () => {
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const modal = page.slice(page.indexOf("function PostingEligibilityRecheckModal"), page.indexOf("function SummaryMetric"));
  assert.match(modal, /useState\(true\)/);
  assert.match(modal, /setScheduleAutomatic\(true\)/);
  assert.match(modal, /Schedule automatically eligible transactions/);
  assert.match(modal, /Eligible Handled transactions will receive the normal future posting timestamp\. Existing schedules and selected categories will remain unchanged\./);
  assert.doesNotMatch(modal, /approveSelected|manualApprovals|learnReusableRule|selectedManualIds|Select all|records your approval|Approve selected categories/);
  const action = page.slice(page.indexOf("const executePostingEligibilityRecheckAction"), page.indexOf("const executePostingEligibilityRecheckAction") + 2300);
  assert.doesNotMatch(action, /manual_approvals|manualApprovals|learn_reusable_rule/);
  assert.match(action, /schedule_automatically_eligible: scheduleAutomaticallyEligible/);
});

test("scheduling uses a new grace timestamp and auto-post off remains Ready", () => {
  const service = read("src/services/bookkeeping/postingEligibilityRecheckService.js");
  const lifecycle = read("src/services/bookkeeping/qboPostingLifecycle.js");
  const feed = read("src/services/bookkeeping/bookkeepingTransactionFeedService.js");
  assert.match(service, /computePostAfterForAutoPost\(preview\.auto_post_enabled, graceHours, nowMs\)/);
  assert.match(service, /post_after: preview\.auto_post_enabled \? postAfter : null/);
  assert.match(lifecycle, /Ready · Auto-post off/);
  assert.match(lifecycle, /Scheduled for/);
  assert.match(feed, /Retry scheduled for/);
  assert.match(feed, /Checking QuickBooks/);
});

test("release of a recovery posting hold invokes the same bounded eligibility service", () => {
  const recovery = read("src/services/plaid/plaidReplacementRecoveryService.js");
  assert.match(recovery, /previewPostingEligibilityRecheck/);
  assert.match(recovery, /executePostingEligibilityRecheck/);
  assert.match(recovery, /transactionIds/);
  assert.match(recovery, /posting hold was released, but posting eligibility needs attention/i);
});

test("forward migration persists service-only idempotency and sanitized audit history", () => {
  const migration = read("supabase/migrations/20261101106000_monthly_review_posting_eligibility_rechecks.sql");
  assert.match(migration, /bookkeeping_posting_eligibility_rechecks/);
  assert.match(migration, /unique \(business_id, idempotency_key\)/);
  assert.match(migration, /outcome_counts jsonb/);
  assert.match(migration, /reason_counts jsonb/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all.*anon, authenticated/i);
  assert.match(migration, /grant all.*service_role/i);
});

// Exercise the production execution function with a server-preview boundary and
// an in-memory persistence adapter; no application/provider clients are loaded.
test("automatic execution schedules only eligible preview rows and preserves existing schedules", async () => {
  const nowMs = Date.parse("2026-11-17T12:00:00Z");
  const existingTimestamp = "2026-11-20T08:00:00Z";
  const outcomes = ["eligible_to_schedule", "already_scheduled", "blocked", "categorized_requires_approval", "returned_to_review", "processing", "reconciling"];
  const rows = outcomes.map((outcome) => ({ transaction_id: outcome, outcome, reason: outcome, categorization_updated_at: "version", current_meta: {} }));
  const stored = new Map(rows.map((row) => [row.transaction_id, { post_after: row.outcome === "already_scheduled" ? existingTimestamp : null }]));
  const writes = [];
  const db = { from(table) {
    assert.ok(["bookkeeping_posting_eligibility_rechecks", "transaction_categorizations"].includes(table));
    let patch; const filters = {};
    const query = {
      select() { return query; },
      eq(key, value) { filters[key] = value; return query; },
      in() { return query; },
      update(value) { patch = value; return query; },
      maybeSingle: async () => ({ data: null }),
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          if (patch) {
            writes.push({ table, patch, filters });
            if (table === "transaction_categorizations") Object.assign(stored.get(filters.transaction_id), patch);
          }
          return { data: [{ id: "execution" }] };
        }).then(resolve, reject);
      },
    };
    return query;
  } };
  const service = read("src/services/bookkeeping/postingEligibilityRecheckService.js");
  const execution = service.slice(service.indexOf("export async function executePostingEligibilityRecheck"), service.indexOf("export default"));
  const control = read("src/services/bookkeeping/autoPostControl.js");
  const grace = control.slice(control.indexOf("export function computePostAfterForAutoPost"), control.indexOf("function chunk", control.indexOf("export function computePostAfterForAutoPost")));
  const forbidden = () => { assert.fail("category approval, provider call or immediate posting attempted"); };
  const execute = vm.runInNewContext(`${grace.replace("export ", "")}\n${execution.replace("export ", "")}\nexecutePostingEligibilityRecheck`, {
    previewPostingEligibilityRecheck: async () => ({ rows: structuredClone(rows), auto_post_enabled: true, examined: rows.length, preview_version: "preview" }),
    persistExecution: async () => ({ created: true, row: { id: "execution" } }),
    resolveCompletedPostingEligibilityExecution: () => null,
    recoveryCounts: () => ({}), HANDLED: ["handled"],
    approveBookkeepingTransactions: forbidden, fetch: forbidden, getQBOClient: forbidden, plaidClient: forbidden,
  });
  const result = await execute({ db, businessId: "business", month: "2026-11", previewVersion: "preview", idempotencyKey: "11111111-1111-1111-1111-111111111111", requestId: "request", nowMs });
  assert.equal(result.counts.newly_scheduled, 1);
  assert.equal(stored.get("eligible_to_schedule").post_after, "2026-11-18T12:00:00.000Z");
  assert.equal(stored.get("already_scheduled").post_after, existingTimestamp);
  for (const outcome of outcomes.slice(2)) assert.equal(stored.get(outcome).post_after, null);
  assert.equal(writes.filter((write) => write.table === "transaction_categorizations").length, 1);
  assert.ok(writes.some((write) => write.table === "bookkeeping_posting_eligibility_rechecks"));
});
