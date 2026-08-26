import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

test("Monthly Review Operator Responses render exact customer answer and concise transaction context", () => {
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const route = read("src/api/admin/monthlyReview.routes.js");

  assert.match(ui, /Customer answer/);
  assert.match(ui, /row\.answer_text \|\| "No response text"/);
  assert.match(ui, /row\.prompt_text \|\| "Question not recorded"/);
  assert.match(ui, /formatDateTime\(row\.answered_at\)/);
  assert.match(ui, /row\.answered_by_display/);
  assert.match(ui, /row\.merchant \|\| row\.description/);
  assert.match(ui, /formatShortDate\(row\.date\)/);
  assert.match(ui, /formatCurrency\(row\.amount\)/);
  assert.match(ui, /row\.source_account \|\| "Bank account"/);
  assert.match(route, /answer_text:\s*request\.answer_text \|\| ""/);
  assert.match(route, /answered_by_display/);
  assert.match(route, /source_account:/);
});

test("Monthly Review Operator Responses use explicit accountant approval action after GL selection", () => {
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const panelStart = ui.indexOf("function OperatorResponsesPanel");
  const panelEnd = ui.indexOf("function ReconciliationTracePanel", panelStart);
  const panel = ui.slice(panelStart, panelEnd);
  const submitStart = ui.indexOf("const approveOperatorResponse");
  const submitEnd = ui.indexOf("const updateTransactionAccount", submitStart);
  const submit = ui.slice(submitStart, submitEnd);

  assert.match(panel, /selectedAccounts/);
  assert.match(panel, /onChange=\{\(accountId\) => setSelectedAccounts/);
  assert.match(panel, /onClick=\{\(\) => onApprove\?\.\(row, selectedAccountId\)\}/);
  assert.match(panel, /Approve\s*\n\s*<\/button>/);
  assert.match(submit, /final_qbo_account_id:\s*account\.id/);
  assert.doesNotMatch(submit, /final_qbo_account_name:\s*account\.name/);
});

test("Monthly Review Operator Response approval patches local state instead of reloading workspace", () => {
  const ui = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const submitStart = ui.indexOf("const approveOperatorResponse");
  const submitEnd = ui.indexOf("const openTransactionHistory", submitStart);
  const submit = ui.slice(submitStart, submitEnd);
  const panelStart = ui.indexOf("function OperatorResponsesPanel");
  const panelEnd = ui.indexOf("function ReconciliationTracePanel", panelStart);
  const panel = ui.slice(panelStart, panelEnd);

  assert.match(submit, /operatorResponseApprovalInFlightRef/);
  assert.match(submit, /setBusyOperatorResponseActions/);
  assert.match(submit, /patchOperatorResponseApprovalInDetail/);
  assert.match(submit, /patchBookkeepingFeedsAfterApprovalState/);
  assert.match(submit, /patchSourceLedgerTransaction/);
  assert.doesNotMatch(submit, /await loadDetail\(/);
  assert.doesNotMatch(submit, /await loadSourceLedger\(/);
  assert.doesNotMatch(submit, /await loadBusinesses\(/);
  assert.match(panel, /rowErrors/);
  assert.match(panel, /setSelectedAccounts\(\(current\) => Object\.fromEntries/);
});

test("Monthly Review Operator Response approval is server-authoritative and shared-service backed", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const approvalService = read("src/services/bookkeeping/bookkeepingApprovalService.js");
  const approveStart = route.indexOf('router.post("/businesses/:businessId/operator-responses/:requestId/approve"');
  const approveEnd = route.indexOf('\nrouter.post("/runs/:runId/lock"', approveStart);
  const approveRoute = route.slice(approveStart, approveEnd);

  assert.match(route, /fetchQboAccountByIdForBusiness/);
  assert.match(route, /async function resolveOperatorResponseTargetAccount/);
  assert.match(approveRoute, /const accountId = String\(req\.body\?\.final_qbo_account_id/);
  assert.doesNotMatch(approveRoute, /const accountName = String\(req\.body/);
  assert.match(approveRoute, /final_qbo_account_name:\s*targetAccount\.name/);
  assert.match(approveRoute, /approveBookkeepingTransactions\(\{/);
  assert.match(approveRoute, /requireNeedsReview:\s*true/);
  assert.match(approveRoute, /allowCcPaymentRejection:\s*false/);
  assert.match(approveRoute, /target_account:\s*targetAccount/);
  assert.match(approveRoute, /pipeline_status:\s*pipelineStatus/);
  assert.match(approveRoute, /qbo_lifecycle_status:\s*qboLifecycleStatus/);
  assert.match(approvalService, /getAutoPostToQuickBooks/);
  assert.match(approvalService, /computePostAfterForAutoPost\(autoPostEnabled, 24\)/);
});

test("Monthly Review Operator Response approval enforces selected business month and unresolved Needs Review scope", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const approveStart = route.indexOf('router.post("/businesses/:businessId/operator-responses/:requestId/approve"');
  const approveEnd = route.indexOf('\nrouter.post("/runs/:runId/lock"', approveStart);
  const approveRoute = route.slice(approveStart, approveEnd);
  const fetchStart = route.indexOf("async function fetchOperatorResponsesAwaitingReview");
  const fetchEnd = route.indexOf("\nasync function resolveOperatorResponseTargetAccount", fetchStart);
  const fetcher = route.slice(fetchStart, fetchEnd);

  assert.match(approveRoute, /\.eq\("business_id", businessId\)/);
  assert.match(approveRoute, /\.eq\("status", "answered"\)/);
  assert.match(approveRoute, /\.is\("resolved_at", null\)/);
  assert.match(approveRoute, /\.gte\("date", start\)/);
  assert.match(approveRoute, /\.lt\("date", end\)/);
  assert.match(approveRoute, /matchesTransactionStatusFilter\("needs_review", currentCat \|\| \{\}\)/);
  assert.match(approveRoute, /operator_response_transaction_not_in_selected_month/);
  assert.match(approveRoute, /operator_response_transaction_not_needs_review/);
  assert.match(fetcher, /state_basis:\s*"clarification_requests\.status=answered and resolved_at is null, transaction still Books Review Needs Review"/);
});

test("Monthly Review Operator Response request resolution happens only after approval succeeds", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const approveStart = route.indexOf('router.post("/businesses/:businessId/operator-responses/:requestId/approve"');
  const approveEnd = route.indexOf('\nrouter.post("/runs/:runId/lock"', approveStart);
  const approveRoute = route.slice(approveStart, approveEnd);

  const approvalIdx = approveRoute.indexOf("const approval = await approveBookkeepingTransactions");
  const resolutionIdx = approveRoute.indexOf(".from(\"clarification_requests\")", approvalIdx);
  assert.ok(approvalIdx >= 0, "approval call should exist");
  assert.ok(resolutionIdx > approvalIdx, "request resolution should happen after approval succeeds");
  assert.match(approveRoute, /resolved_reason:\s*"monthly_review_approved"/);
  assert.match(approveRoute, /resolved_final_qbo_account_id:\s*targetAccount\.id/);
});

test("Monthly Review Operator Responses preserve protected special workflow safeguards", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const approvalService = read("src/services/bookkeeping/bookkeepingApprovalService.js");
  const approveStart = route.indexOf('router.post("/businesses/:businessId/operator-responses/:requestId/approve"');
  const approveEnd = route.indexOf('\nrouter.post("/runs/:runId/lock"', approveStart);
  const approveRoute = route.slice(approveStart, approveEnd);

  assert.match(approveRoute, /allowCcPaymentRejection:\s*false/);
  assert.match(approvalService, /confirmCreditCardPaymentPairForTransaction/);
  assert.match(approvalService, /transfer_posting_not_supported/);
  assert.match(approvalService, /owner_move_posting_not_supported/);
  assert.match(approvalService, /refund_posting_not_supported/);
  assert.match(approvalService, /missing_final_account_for_check/);
  assert.match(approvalService, /pending_transaction_not_postable/);
  assert.match(approvalService, /plaid_accounting_review_required/);
});
