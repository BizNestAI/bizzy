import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

test("Operator Requests live population is derived from Books Review Needs Review and not clarification rows", () => {
  const service = read("src/services/bookkeeping/clarificationService.js");
  const route = read("src/api/bookkeeping/routes/bookkeeping.clarifications.routes.js");
  const client = read("src/services/bookkeeping/bookkeepingClient.js");

  assert.match(service, /fetchOperatorRequests/);
  assert.match(service, /get_operator_request_counts_bounded/);
  assert.match(service, /get_operator_requests_bounded/);
  assert.match(service, /outstanding_count/);
  assert.match(service, /answered_awaiting_review_count/);
  assert.doesNotMatch(service, /while \(allRows\.length < totalCount\)/);
  assert.doesNotMatch(service, /fetchBookkeepingTransactions\(\{[\s\S]*statusFilter:\s*"needs_review"[\s\S]*rangeParam:\s*"all"/);
  assert.match(route, /router\.get\("\/operator-requests"/);
  assert.match(client, /getOperatorRequests/);
});

test("Operator Requests retrieval is database bounded and supports large Needs Review populations", () => {
  const service = read("src/services/bookkeeping/clarificationService.js");
  const migration = read("supabase/migrations/20260905_bounded_bookkeeping_needs_review_retrieval.sql");
  const fetchBody = service.slice(
    service.indexOf("export async function fetchOperatorRequests"),
    service.indexOf("async function upsertVendorRuleFromClarification")
  );

  assert.match(migration, /create or replace function public\.get_operator_request_counts_bounded/);
  assert.match(migration, /outstanding_count bigint/);
  assert.match(migration, /answered_awaiting_review_count bigint/);
  assert.match(migration, /accounting_needs_review_count bigint/);
  assert.match(migration, /create or replace function public\.get_operator_requests_bounded/);
  assert.match(migration, /count\(\*\) over \(\) as total_count/);
  assert.match(migration, /limit greatest\(least\(coalesce\(p_limit, 25\), 100\), 1\)/);
  assert.match(migration, /offset greatest\(coalesce\(p_offset, 0\), 0\)/);
  assert.match(migration, /not exists \([\s\S]*from public\.clarification_requests cr[\s\S]*cr\.status = 'answered'[\s\S]*cr\.resolved_at is null/);
  assert.match(fetchBody, /p_limit:\s*safePageSize/);
  assert.match(fetchBody, /p_offset:\s*\(safePage - 1\) \* safePageSize/);
  assert.doesNotMatch(fetchBody, /\.in\("transaction_id",\s*ids\)/);
});

test("Operator Request summary is durable and recomputed from authoritative SQL semantics", () => {
  const migration = read("supabase/migrations/20260906_operator_request_summary.sql");
  const fixMigration = read("supabase/migrations/20260907_fix_operator_request_summary_business_id_conflict.sql");
  const boundedMigration = read("supabase/migrations/20260905_bounded_bookkeeping_needs_review_retrieval.sql");
  const service = read("src/services/bookkeeping/operatorRequestSummaryService.js");

  assert.match(migration, /create table if not exists public\.operator_request_summaries/);
  assert.match(migration, /business_id uuid primary key references public\.business_profiles\(id\) on delete cascade/);
  assert.match(migration, /accounting_needs_review_count integer not null default 0/);
  assert.match(migration, /outstanding_count integer not null default 0/);
  assert.match(migration, /answered_awaiting_review_count integer not null default 0/);
  assert.match(migration, /create or replace function public\.refresh_operator_request_summary/);
  assert.match(migration, /from public\.get_operator_request_counts_bounded\(p_business_id\)/);
  assert.match(fixMigration, /create or replace function public\.refresh_operator_request_summary\(p_business_id uuid\)/);
  assert.match(fixMigration, /from public\.get_operator_request_counts_bounded\(p_business_id\)/);
  assert.equal((fixMigration.match(/on conflict on constraint operator_request_summaries_pkey do update/g) || []).length, 2);
  assert.doesNotMatch(fixMigration, /on conflict \(business_id\)/i);
  assert.match(fixMigration, /returns table \([\s\S]*business_id uuid/);
  assert.match(fixMigration, /revoke all on function public\.refresh_operator_request_summary\(uuid\) from public, anon, authenticated/);
  assert.match(fixMigration, /grant execute on function public\.refresh_operator_request_summary\(uuid\) to service_role/);
  assert.match(migration, /alter table public\.operator_request_summaries enable row level security/);
  assert.match(migration, /revoke all on table public\.operator_request_summaries from public, anon, authenticated/);
  assert.match(migration, /grant all on table public\.operator_request_summaries to service_role/);
  assert.match(boundedMigration, /create or replace function public\.get_operator_request_counts_bounded/);
  assert.match(service, /refresh_operator_request_summary/);
  assert.doesNotMatch(service, /outstanding_count\s*[+-]=/);
});

test("Operator Request summary business_id conflict target is unambiguous in success and error paths", () => {
  const fixMigration = read("supabase/migrations/20260907_fix_operator_request_summary_business_id_conflict.sql");
  const successUpsert = fixMigration.slice(
    fixMigration.indexOf("insert into public.operator_request_summaries as ors ("),
    fixMigration.indexOf("return query")
  );
  const errorUpsert = fixMigration.slice(
    fixMigration.indexOf("exception"),
    fixMigration.indexOf("end;", fixMigration.indexOf("exception"))
  );

  assert.match(successUpsert, /on conflict on constraint operator_request_summaries_pkey do update/);
  assert.match(errorUpsert, /on conflict on constraint operator_request_summaries_pkey do update/);
  assert.doesNotMatch(successUpsert, /on conflict\s*\(\s*business_id\s*\)/i);
  assert.doesNotMatch(errorUpsert, /on conflict\s*\(\s*business_id\s*\)/i);
  assert.match(successUpsert, /last_reconciled_at = excluded\.last_reconciled_at/);
  assert.match(errorUpsert, /reconciliation_status = 'error'/);
  assert.match(errorUpsert, /last_error = left\(sqlerrm, 1000\)/);
});

test("Home count uses summary endpoint first and prefetches first Operator Request page in the background", () => {
  const home = read("src/pages/Bizzy/ChatHome.jsx");
  const client = read("src/services/bookkeeping/bookkeepingClient.js");
  const panel = read("src/components/Bizzy/OperatorRequestsPanel.jsx");
  const card = read("src/components/Bizzy/OperatorStatusCard.jsx");

  assert.match(client, /export async function getOperatorRequestSummary/);
  assert.match(client, /\/api\/bookkeeping\/operator-requests\/summary/);
  assert.match(home, /import \{ getOperatorRequestSummary, getOperatorRequests \}/);
  assert.match(home, /const summaryPromise = getOperatorRequestSummary\(businessId\)/);
  assert.match(home, /const firstPagePromise = getOperatorRequests\(businessId, \{[\s\S]*page:\s*1,[\s\S]*page_size:\s*OPERATOR_REQUEST_PREFETCH_PAGE_SIZE/);
  assert.match(home, /const summary = await summaryPromise/);
  assert.match(home, /summary\?\.outstanding_count/);
  assert.match(home, /operatorRequestPrefetchSeq/);
  assert.doesNotMatch(home, /getOperatorRequests\(businessId, \{ page: 1, page_size: 15 \}/);
  assert.match(home, /requests=\{isMockMode \|\| needsReviewRequests\.length \? needsReviewRequests : null\}/);
  assert.match(home, /clarOpen \? \(/);
  assert.match(panel, /if \(!openExternally && !open\) return/);
  assert.match(card, /if \(!expanded \|\| !businessId\) return/);
  assert.match(card, /OPERATOR_REQUEST_PAGE_SIZE = 25/);
  assert.match(card, /const canLoadMore = !mockMode[\s\S]*requests\.length < effectiveCount[\s\S]*loadedPage < knownPageCount/);
  assert.match(card, /const loadMore = useCallback/);
  assert.match(card, /getOperatorRequests\(businessId, \{ page: nextPage, page_size: OPERATOR_REQUEST_PAGE_SIZE \}\)/);
  assert.doesNotMatch(card, /onScroll=\{handleListScroll\}/);
  assert.match(card, /`Load more \(\$\{requests\.length\} of \$\{effectiveCount\}\)`/);
});

test("summary endpoint is lightweight and does not materialize rows or provider calls", () => {
  const route = read("src/api/bookkeeping/routes/bookkeeping.clarifications.routes.js");
  const service = read("src/services/bookkeeping/operatorRequestSummaryService.js");
  const summaryRoute = route.slice(
    route.indexOf("router.get(\"/operator-requests/summary\""),
    route.indexOf("router.post(\"/clarifications/submit\"")
  );

  assert.match(summaryRoute, /getOperatorRequestSummary/);
  assert.doesNotMatch(summaryRoute, /fetchOperatorRequests/);
  assert.doesNotMatch(summaryRoute, /expire_stale_operator_requests/);
  assert.doesNotMatch(summaryRoute, /ensurePendingRequestForTransaction/);
  assert.doesNotMatch(summaryRoute, /getOperatorRequests/);
  assert.match(service, /\.from\("operator_request_summaries"\)/);
  assert.doesNotMatch(service, /getQBOClient|plaid|openai|createQbo|postToQbo/i);
});

test("state-change boundaries reconcile Operator Request summary without blind counters", () => {
  const clarification = read("src/services/bookkeeping/clarificationService.js");
  const approval = read("src/services/bookkeeping/bookkeepingApprovalService.js");
  const approvalsRoute = read("src/api/bookkeeping/routes/bookkeeping.approvals.routes.js");
  const monthly = read("src/api/admin/monthlyReview.routes.js");
  const worker = read("src/services/bookkeeping/backgroundBookkeepingProcessingService.js");
  const plaid = read("src/services/plaid/plaidSyncService.js");
  const suggest = read("src/api/bookkeeping/routes/bookkeeping.suggest.routes.js");
  const cron = read("src/cron/operatorRequestSummary.cron.js");
  const server = read("src/server.js");

  assert.match(clarification, /reason:\s*"customer_answer"/);
  assert.match(clarification, /reason:\s*"operator_requests_rows_loaded"/);
  assert.match(approval, /reason:\s*"human_approval"/);
  assert.match(approvalsRoute, /reason:\s*"approval_undo"/);
  assert.match(approvalsRoute, /reason:\s*"cc_payment_rejection"/);
  assert.match(monthly, /reason:\s*"operator_response_resolved"/);
  assert.match(worker, /reason:\s*"background_bookkeeping_batch"/);
  assert.match(plaid, /reason:\s*"plaid_sync"/);
  assert.match(suggest, /reason:\s*"bookkeeping_suggestion_pass"/);
  assert.match(cron, /runOperatorRequestSummaryReconciliationOnce/);
  assert.match(cron, /periodic_reconciliation/);
  assert.match(server, /startOperatorRequestSummaryCron\(\)/);
});

test("customer answer stores context only and leaves accounting Needs Review unchanged", () => {
  const service = read("src/services/bookkeeping/clarificationService.js");

  assert.match(service, /answered_by_user_id:\s*answeredByUserId/);
  assert.match(service, /allowQboAccountCreate:\s*false/);
  assert.match(service, /allowProviderWrites:\s*false/);
  assert.match(service, /allowCreate:\s*allowQboAccountCreate === true && allowProviderWrites === true/);
  assert.match(service, /selected_intent/);
  assert.match(service, /non_authoritative_account_evidence/);
  assert.match(service, /accounting_status:\s*"needs_review"/);
  assert.doesNotMatch(service, /status:\s*"approved"[\s\S]*final_qbo_account_id/);
  assert.doesNotMatch(service, /status:\s*"auto_approved"[\s\S]*post_after/);
  assert.doesNotMatch(service, /upsert\(catPayload/);
});

test("customer answer path has zero QBO provider-write capability", () => {
  const service = read("src/services/bookkeeping/clarificationService.js");
  const resolver = read("src/services/bookkeeping/canonicalQboAccountResolver.js");
  const answerBody = service.slice(
    service.indexOf("export async function processClarificationAnswers"),
    service.indexOf("export default")
  );
  const mappingBody = service.slice(
    service.indexOf("export async function mapAnswerToCoa"),
    service.indexOf("export async function createOrUpdateClarificationRequest")
  );

  assert.match(mappingBody, /allowQboAccountCreate = false/);
  assert.match(mappingBody, /allowProviderWrites = false/);
  assert.match(mappingBody, /allowCreate:\s*allowQboAccountCreate === true && allowProviderWrites === true/);
  assert.match(answerBody, /allowQboAccountCreate:\s*false/);
  assert.match(answerBody, /allowProviderWrites:\s*false/);
  assert.match(answerBody, /catch \(err\)[\s\S]*customer_answer_account_suggestion_failed/);
  assert.doesNotMatch(answerBody, /createQboAccountFromCanonical|claimCreationIntent|createQboVendor|postToQbo|createQboTransfer|createQboPurchase|createQboDeposit/);
  assert.match(resolver, /allowCreate = true/);
});

test("Books Review exposes answered customer context without moving the transaction tab", () => {
  const txRoute = read("src/api/bookkeeping/routes/bookkeeping.transactions.routes.js");
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");

  assert.match(txRoute, /operator_request/);
  assert.match(txRoute, /customer_answered/);
  assert.match(txRoute, /customer_response/);
  assert.match(feed, /Customer answered/);
  assert.match(feed, /Customer response/);
  assert.match(feed, /customerResponseText/);
});

test("Monthly Review has Operator Responses review and approval path", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const approvalService = read("src/services/bookkeeping/bookkeepingApprovalService.js");

  assert.match(route, /operator_responses:\s*operatorResponses/);
  assert.match(route, /fetchOperatorResponsesAwaitingReview/);
  assert.match(route, /operator-responses\/:requestId\/approve/);
  assert.match(route, /approveBookkeepingTransactions/);
  assert.match(route, /requireNeedsReview:\s*true/);
  assert.match(approvalService, /transaction_not_needs_review/);
  assert.match(route, /resolved_reason:\s*"monthly_review_approved"/);
  assert.match(ui, /OperatorResponsesPanel/);
  assert.match(ui, /Operator Responses/);
  assert.match(ui, /answer_text/);
});

test("Books Review and Monthly Review share authoritative human approval service", () => {
  const booksRoute = read("src/api/bookkeeping/routes/bookkeeping.approvals.routes.js");
  const monthlyRoute = read("src/api/admin/monthlyReview.routes.js");
  const approvalService = read("src/services/bookkeeping/bookkeepingApprovalService.js");

  assert.match(booksRoute, /approveBookkeepingTransactions/);
  assert.match(monthlyRoute, /approveBookkeepingTransactions/);
  assert.match(monthlyRoute, /allowCcPaymentRejection:\s*false/);
  assert.match(approvalService, /getAutoPostToQuickBooks/);
  assert.match(approvalService, /computePostAfterForAutoPost\(autoPostEnabled, 24\)/);
  assert.match(approvalService, /transfer_posting_not_supported/);
  assert.match(approvalService, /owner_move_posting_not_supported/);
  assert.match(approvalService, /refund_posting_not_supported/);
  assert.match(approvalService, /missing_final_account_for_check/);
  assert.match(approvalService, /pending_transaction_not_postable/);
  assert.match(approvalService, /plaid_accounting_review_required/);
  assert.match(approvalService, /confirmCreditCardPaymentPairForTransaction/);
  assert.match(approvalService, /createManualCreditCardPaymentPair/);
  assert.match(approvalService, /allowCcPaymentRejection !== true/);
});

test("stale requests close and answered awaiting review rows block background auto-handling", () => {
  const service = read("src/services/bookkeeping/clarificationService.js");
  const worker = read("src/services/bookkeeping/backgroundBookkeepingProcessingService.js");
  const migration = read("supabase/migrations/20260905_bounded_bookkeeping_needs_review_retrieval.sql");

  assert.match(service, /expire_stale_operator_requests/);
  assert.match(migration, /transaction_no_longer_needs_review/);
  assert.match(migration, /status = 'expired'/);
  assert.match(worker, /hasAnsweredOperatorRequestAwaitingReview/);
  assert.match(worker, /operator_response_awaiting_accountant_review/);
});

test("schema preserves reviewer attribution and resolution audit fields", () => {
  const migration = read("supabase/migrations/20260904_operator_requests_answer_review_state.sql");

  assert.match(migration, /answered_by_user_id uuid/);
  assert.match(migration, /selected_intent text/);
  assert.match(migration, /resolved_at timestamp with time zone/);
  assert.match(migration, /resolved_by_user_id uuid/);
  assert.match(migration, /resolved_final_qbo_account_id text/);
});

test("bounded retrieval migration keeps Books Review and Operator Requests on the same Needs Review semantics", () => {
  const migration = read("supabase/migrations/20260905_bounded_bookkeeping_needs_review_retrieval.sql");

  assert.match(migration, /create or replace function public\.bookkeeping_transaction_matches_status/);
  assert.match(migration, /coalesce\(p_status, 'needs_review'\) in \('needs_review', 'uncategorized'\)/);
  assert.match(migration, /coalesce\(p_status, ''\) = 'auto_approved'[\s\S]*p_meta ->> 'is_check'/);
  assert.match(migration, /bt\.business_id = p_business_id/);
  assert.match(migration, /bt\.is_archived is false/);
  assert.match(migration, /bp\.bookkeeping_start_date is null or bt\.date >= bp\.bookkeeping_start_date/);
  assert.match(migration, /revoke all on function public\.get_operator_requests_bounded/);
  assert.match(migration, /grant execute on function public\.get_operator_requests_bounded\(uuid, integer, integer\) to service_role/);
});
