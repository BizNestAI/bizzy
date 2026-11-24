import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { derivePostingEligibilityRecheckAvailability } from "../src/pages/Admin/postingEligibilityRecheckAvailability.js";

test("failed counts refresh keeps RPE disabled even when an older Handled count remains", () => {
  assert.equal(derivePostingEligibilityRecheckAvailability({
    handledTotalCount: 9, countLoaded: true, countsError: "statement timeout",
    authorized: true, contextReady: true,
  }).disabled, true);
});
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
  assert.match(page, /"Refresh preview" : "Retry"/);
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


const originalKey = "11111111-1111-1111-1111-111111111111";
const recoveredMessage = "Recheck completed successfully. The connection ended before confirmation was received.";
const unknownMessage = "The connection ended before the outcome could be confirmed. Refresh the preview before trying again.";
const persistedResult = { ok: true, execution_id: "execution", request_id: "request", examined: 61, counts: { newly_scheduled: 61 }, reason_counts: { final_persisted_gl_authority: 61 }, rows: [] };

function recoveryHarness(request, { refresh = async () => {}, advancePerRead = 0 } = {}) {
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const action = page.slice(page.indexOf("const executePostingEligibilityRecheckAction"), page.indexOf("const patchBookkeepingFeedsAfterApproval"));
  const recovery = page.slice(page.indexOf("async function recoverPostingEligibilityExecution"), page.indexOf("function PostingEligibilityRecheckModal"));
  let state = { open: true, executing: false, preview: { preview_version: "preview", examined: 61, counts: {}, rows: [] } };
  let clock = 0;
  const transitions = [], calls = [];
  const context = vm.createContext({
    useCallback: (fn) => fn, detail: { run: { id: "run" } },
    get postingEligibilityRecheck() { return state; },
    setPostingEligibilityRecheck: (update) => { state = update(state); transitions.push(state); },
    crypto: { randomUUID: () => originalKey },
    safeFetch: async (url, options) => { calls.push({ url, ...options }); clock += advancePerRead; return request(url, options, calls.length); },
    refreshAfterFeedAction: refresh,
    AbortController, setTimeout, clearTimeout,
  });
  vm.runInContext(recovery, context);
  const recover = context.recoverPostingEligibilityExecution;
  context.recoverPostingEligibilityExecution = (url) => recover(url, context.safeFetch, () => clock, async (ms) => { clock += ms; });
  const submit = vm.runInContext(`${action}\nexecutePostingEligibilityRecheckAction`, context);
  return { submit, calls, transitions, state: () => state, elapsed: () => clock };
}

function modalTree(state) {
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const modal = page.slice(page.indexOf("function PostingEligibilityRecheckModal"), page.indexOf("function SummaryMetric"));
  const compiled = transformSync(modal, { loader: "jsx", jsxFactory: "element", jsxFragment: "Fragment" }).code;
  const render = vm.runInNewContext(`${compiled}\nPostingEligibilityRecheckModal`, {
    useState: () => [true, () => {}], useEffect: () => {}, Fragment: "fragment",
    element: (type, props, ...children) => ({ type: typeof type === "string" ? type : "component", props: props || {}, children }),
    formatMonth: (month) => month, SummaryMetric: () => null, Loader2: () => null, ShieldCheck: () => null,
  });
  return render({ state, businessName: "Business", month: "2026-10" });
}

const networkFailure = () => { throw Object.assign(new TypeError("Failed to fetch"), { code: "NETWORK_ERROR" }); };

test("ordinary success uses the original response without a recovery GET or notice", async () => {
  let refreshed = 0;
  const h = recoveryHarness(async () => persistedResult, { refresh: async () => { refreshed += 1; } });
  await h.submit();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, "POST");
  assert.equal(h.state().result, persistedResult);
  assert.equal(h.state().notice, "");
  assert.equal(refreshed, 1);
});

test("disconnected POST recovers original-key persisted counts using only GETs", async () => {
  const h = recoveryHarness(async (_url, options, call) => {
    if (options.method === "POST") return networkFailure();
    return call === 2 ? { status: "in_progress" } : { status: "completed", result: persistedResult };
  });
  await h.submit();
  assert.equal(h.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(h.calls[0].headers["Idempotency-Key"], originalKey);
  assert.equal(h.calls[0].body.idempotency_key, originalKey);
  assert.equal(h.calls.length, 3);
  for (const call of h.calls.slice(1)) {
    assert.equal(call.method, "GET");
    assert.ok(call.url.endsWith(`/${originalKey}`));
    assert.equal(call.body, undefined);
    assert.equal(call.cache, "no-store");
  }
  assert.ok(h.transitions.some((state) => state.recovering && state.executing && !state.error));
  assert.equal(h.state().notice, recoveredMessage);
  assert.equal(h.state().error, "");
  assert.equal(h.state().result.counts.newly_scheduled, 61);
  const rendered = JSON.stringify(modalTree(h.state()));
  assert.ok(rendered.includes(recoveredMessage));
  assert.ok(!rendered.includes("Failed to fetch"));
  assert.match(rendered, /Persisted result/);
});

for (const status of ["in_progress", "unknown", "not_found"]) {
  test(`${status} recovery is bounded, does not resubmit, and requires a fresh preview`, async () => {
    const h = recoveryHarness(async (_url, options) => {
      if (options.method === "POST") return networkFailure();
      if (status === "not_found") throw Object.assign(new Error("not found"), { status: 404 });
      return { status };
    });
    await h.submit();
    assert.equal(h.calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(h.calls.filter((call) => call.method === "GET").length, 9);
    assert.equal(h.elapsed(), 9000);
    assert.equal(h.state().notice, unknownMessage);
    assert.equal(h.state().error, "");
    assert.equal(h.state().outcomeUnconfirmed, true);
    const requestsBeforeRetry = h.calls.length;
    await h.submit();
    assert.equal(h.calls.length, requestsBeforeRetry);
    const tree = modalTree(h.state());
    assert.ok(JSON.stringify(tree).includes(unknownMessage));
    assert.ok(JSON.stringify(tree).includes("Refresh preview"));
    const findConfirm = (node) => node && typeof node === "object" && (node.type === "button" && JSON.stringify(node.children).includes("Confirm recheck") ? node : (node.children || []).flat(Infinity).map(findConfirm).find(Boolean));
    assert.equal(findConfirm(tree).props.disabled, true);
  });
}

test("slow recovery GETs respect the shared deadline", async () => {
  const h = recoveryHarness(async (_url, options) => options.method === "POST" ? networkFailure() : { status: "in_progress" }, { advancePerRead: 2000 });
  await h.submit();
  assert.ok(h.calls.length <= 5);
  assert.ok(h.calls.slice(1).every((call) => call.timeoutMs <= 2000));
  assert.equal(h.state().notice, unknownMessage);
});

test("explicit persisted failure stops recovery and retains sanitized failure treatment", async () => {
  const failed = { ...persistedResult, counts: { failed: 1 }, rows: [{ transaction_id: "txn", outcome: "failed", reason: "posting_eligibility_row_execution_failed" }] };
  const h = recoveryHarness(async (_url, options) => options.method === "POST" ? networkFailure() : { status: "failed", result: failed });
  await h.submit();
  assert.equal(h.calls.length, 2);
  assert.equal(h.state().result, failed);
  assert.equal(h.state().notice, "");
  assert.equal(h.state().error, "Could not safely recheck posting eligibility. No provider calls were made.");
  assert.ok(!JSON.stringify(modalTree(h.state())).includes(recoveredMessage));
});

test("HTTP errors are not treated as ambiguous network failures", async () => {
  const h = recoveryHarness(async () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); });
  await h.submit();
  assert.equal(h.calls.length, 1);
  assert.equal(h.state().error, "Forbidden");
});

test("feed refresh error cannot start outcome recovery after confirmed success", async () => {
  const h = recoveryHarness(async () => persistedResult, { refresh: async () => networkFailure() });
  await h.submit();
  assert.equal(h.calls.length, 1);
  assert.equal(h.state().result, persistedResult);
  assert.equal(h.state().error, "");
});

function lookupHarness({ execution = null, runError = null, staff = { user_id: "staff", role: "operator", active: true } } = {}) {
  const source = read("src/api/admin/monthlyReview.routes.js");
  const route = source.slice(source.indexOf('router.get("/runs/:runId/bookkeeping/posting-eligibility-executions/'), source.indexOf('router.post("/runs/:runId/bookkeeping/posting-eligibility-executions"'));
  const filters = {};
  let handler, queries = 0;
  const db = { from(table) {
    queries += 1;
    assert.equal(table, "bookkeeping_posting_eligibility_rechecks");
    const query = {
      select: (fields) => { assert.equal(fields, "id,status,result"); return query; },
      eq: (key, value) => { filters[key] = value; return query; },
      maybeSingle: async () => ({ data: execution && execution.business_id === filters.business_id && execution.review_month === filters.review_month && execution.idempotency_key === filters.idempotency_key ? execution : null }),
    };
    return query;
  } };
  const context = vm.createContext({
    router: { get: (_path, fn) => { handler = fn; } },
    setMonthlyReviewNoStore: (res) => { res.noStore = true; },
    UUID_RE: /^[0-9a-f-]{36}$/i,
    fetchRun: async () => { if (runError) throw runError; return { business_id: "business", review_month: "2026-10-01" }; },
    supabase: db,
  });
  vm.runInContext(route, context);
  // Exercise the actual staff authorization middleware without importing clients.
  const auth = read("src/api/_shared/internalStaffAuth.js").replace(/^import .*;$/gm, "").replace(/export /g, "");
  const requireRole = vm.runInNewContext(`${auth}\nrequireInternalRole`, {
    getAuthenticatedUserId: (req) => req.user?.id,
    defaultSupabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: staff }) }) }) }) },
  });
  const authorize = requireRole(["owner_admin", "accountant", "operator"]);
  return { filters, queryCount: () => queries, async get({ user = { id: "staff" }, key = originalKey } = {}) {
    const req = { user, params: { runId: "22222222-2222-2222-2222-222222222222", idempotencyKey: key } };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await authorize(req, res, () => handler(req, res));
    return res;
  } };
}

const executionRecord = { id: "execution", business_id: "business", review_month: "2026-10-01", idempotency_key: originalKey, status: "completed", result: { ...persistedResult, secret: "do not expose", rows: [{ transaction_id: "txn", outcome: "newly_scheduled", reason: "final_persisted_gl_authority", current_meta: { secret: true } }] } };

test("lookup reads only the run-scoped sanitized persisted result", async () => {
  const h = lookupHarness({ execution: executionRecord });
  const response = await h.get();
  assert.equal(response.code, 200);
  assert.equal(response.noStore, true);
  assert.equal(response.body.status, "completed");
  assert.equal(response.body.result.counts.newly_scheduled, 61);
  assert.deepEqual(h.filters, { business_id: "business", review_month: "2026-10-01", idempotency_key: originalKey });
  assert.equal(h.queryCount(), 1);
  assert.doesNotMatch(JSON.stringify(response.body), /secret|current_meta|idempotency_key|business_id/);
});

test("lookup distinguishes running, failed, partial, stale and missing executions", async () => {
  for (const [stored, expected] of [["running", "in_progress"], ["failed", "failed"], ["partial", "failed"], ["stale", "unknown"]]) {
    const h = lookupHarness({ execution: { ...executionRecord, status: stored } });
    assert.equal((await h.get()).body.status, expected);
  }
  const missing = await lookupHarness().get();
  assert.equal(missing.code, 404);
  assert.equal(missing.body.status, "unknown");
});

test("lookup rejects unauthenticated/nonstaff users and inaccessible runs before querying executions", async () => {
  const source = read("src/api/admin/monthlyReview.routes.js");
  const routeIndex = source.indexOf('router.get("/runs/:runId/bookkeeping/posting-eligibility-executions/');
  assert.ok(source.indexOf("router.use(requireAuth)") < routeIndex);
  assert.ok(source.indexOf("router.use(requireInternalRole(MONTHLY_REVIEW_STAFF_ROLES))") < routeIndex);
  const anonymous = lookupHarness();
  assert.equal((await anonymous.get({ user: null })).code, 401);
  assert.equal(anonymous.queryCount(), 0);
  const nonstaff = lookupHarness({ staff: null });
  assert.equal((await nonstaff.get()).code, 403);
  assert.equal(nonstaff.queryCount(), 0);
  const forbiddenRun = lookupHarness({ runError: Object.assign(new Error("denied"), { status: 403 }) });
  assert.equal((await forbiddenRun.get()).code, 403);
  assert.equal(forbiddenRun.queryCount(), 0);
});

test("lookup does not disclose another business, month or idempotency key", async () => {
  for (const override of [{ business_id: "other" }, { review_month: "2026-11-01" }, { idempotency_key: "other" }]) {
    const response = await lookupHarness({ execution: { ...executionRecord, ...override } }).get();
    assert.equal(response.code, 404);
    assert.equal(response.body.status, "unknown");
    assert.equal(response.body.result, undefined);
  }
  const h = lookupHarness();
  assert.equal((await h.get({ key: "invalid" })).code, 400);
  assert.equal(h.queryCount(), 0);
});


test("overall recovery deadline aborts a hung lookup and returns unknown", async () => {
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const source = page.slice(page.indexOf("async function recoverPostingEligibilityExecution"), page.indexOf("function PostingEligibilityRecheckModal"));
  let expire, signal, calls = 0, cleared = false;
  const recover = vm.runInNewContext(`${source}\nrecoverPostingEligibilityExecution`, {
    AbortController,
    setTimeout: (callback, ms) => { assert.equal(ms, 9000); expire = callback; return "timer"; },
    clearTimeout: (timer) => { assert.equal(timer, "timer"); cleared = true; },
  });
  const pending = recover("/lookup", async (_url, options) => {
    calls += 1;
    signal = options.signal;
    return new Promise(() => {});
  }, () => 0);
  expire();
  assert.equal((await pending).status, "unknown");
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
  assert.equal(cleared, true);
});

test("recovery stops on authorization rejection and does not retry the POST", async () => {
  const h = recoveryHarness(async (_url, options) => {
    if (options.method === "POST") return networkFailure();
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  });
  await h.submit();
  assert.equal(h.calls.length, 2);
  assert.equal(h.state().notice, unknownMessage);
});
