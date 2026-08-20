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
