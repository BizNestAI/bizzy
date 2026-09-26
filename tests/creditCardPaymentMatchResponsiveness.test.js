import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
/* global process */
import test from "node:test";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("credit-card payment selection starts row-level discovery before confirm", () => {
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  const client = read("src/services/bookkeeping/bookkeepingClient.js");

  assert.match(client, /export async function discoverCreditCardPaymentMatch/);
  assert.match(client, /discover-match`/);
  assert.match(page, /startCreditCardPaymentDiscovery\(txnId, accountId\)/);
  assert.match(page, /discoverCreditCardPaymentMatch\(businessId, txnId, targetQboAccountId/);
  assert.match(page, /ccDiscoverySeqRef/);
  assert.match(page, /AbortController/);
  assert.match(page, /controller\.signal\.aborted/);
  const accountChange = page.slice(
    page.indexOf("const handleAccountChange"),
    page.indexOf("const reloadAccounts")
  );
  assert.match(accountChange, /isCreditCardPaymentWorkflowTxn\(txn\)[\s\S]*startCreditCardPaymentDiscovery\(txnId, accountId\)[\s\S]*return;/);
  assert.ok(
    accountChange.indexOf("return;") < accountChange.indexOf("updateHandledTransaction"),
    "credit-card payment selection must not reach the Handled account-change endpoint"
  );
});

test("confirm uses the discovered target transaction and prevents duplicate mutations", () => {
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");

  assert.match(feed, /ccAction\.targetTransactionId \|\| ccAction\.candidate\?\.transaction_id/);
  assert.match(page, /ccConfirmInFlightRef\.current\.has\(key\)/);
  assert.match(page, /confirmCreditCardPaymentMatch\(businessId, id, targetQboAccountId, targetTransactionId, \{/);
  const confirmHandler = page.slice(
    page.indexOf("const handleConfirmCreditCardPaymentMatch"),
    page.indexOf("const handleConfirmLoanPaymentSplit")
  );
  assert.doesNotMatch(confirmHandler, /await\s+(?:reloadTransactions|loadMappingStatus)\s*\(/);
});

test("match card exposes localized async states without global processing banners", () => {
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");

  assert.match(feed, /Finding payment…/);
  assert.match(feed, /Matching…/);
  assert.match(feed, /aria-busy/);
  assert.match(feed, /role="status"/);
  assert.match(feed, /motion-reduce:animate-none/);
  assert.match(page, /ccPaymentActionState/);
  const discoveryHandler = page.slice(
    page.indexOf("const startCreditCardPaymentDiscovery"),
    page.indexOf("const buildMatchedCreditCardPaymentTxn")
  );
  assert.doesNotMatch(discoveryHandler, /showBackgroundRefresh|Categorizing new transactions|Refreshing transactions/);
});

test("read-only discovery route avoids broad refresh and posting side effects", () => {
  const route = read("src/api/bookkeeping/routes/bookkeeping.approvals.routes.js");
  const service = read("src/services/bookkeeping/creditCardPaymentPairService.js");

  assert.match(route, /\/credit-card-payments\/:transactionId\/discover-match/);
  assert.match(route, /discoverCreditCardPaymentMatchForTransaction/);
  const discoverRoute = route.slice(
    route.indexOf('router.post("/credit-card-payments/:transactionId/discover-match"'),
    route.indexOf('router.post("/credit-card-payments/:transactionId/confirm-match"')
  );
  assert.doesNotMatch(discoverRoute, /refreshOperatorRequestSummaryBestEffort/);
  assert.match(service, /discoverOnly = false/);
  assert.match(service, /status: "candidate_found"/);
  assert.match(service, /target_transaction_id/);
  assert.match(service, /candidate_query_ms/);
  assert.match(service, /pending_to_posted_canonicalization_ms/);
  assert.match(service, /categorization_update_ms/);
});

test("confirmed credit-card payment pairs use handled legacy state while pair authority drives Matched", () => {
  const approval = read("src/services/bookkeeping/bookkeepingApprovalService.js");
  const pairService = read("src/services/bookkeeping/creditCardPaymentPairService.js");
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");

  assert.match(pairService, /match_type: isConfirmedPairStatus\(pair\.status\) \? "credit_card_payment_pair"/);
  assert.match(pairService, /safe_to_auto_post: false/);
  assert.match(approval, /isConfirmedCcPaymentPair \? "handled"/);
  assert.match(approval, /linkCategorizationToCreditCardPair/);
  assert.doesNotMatch(approval, /cc_payment_pair_status: "confirmed"[\s\S]{0,800}safe_to_auto_post: true/);
  assert.match(page, /match_type: "credit_card_payment_pair"/);
  assert.match(page, /safe_to_auto_post: false/);
});

test("confirmation transitions optimistically and background reconciliation does not block success", () => {
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  const client = read("src/services/bookkeeping/bookkeepingClient.js");
  const handler = page.slice(
    page.indexOf("const handleConfirmCreditCardPaymentMatch"),
    page.indexOf("const handleConfirmLoanPaymentSplit")
  );

  assert.match(handler, /applyOptimisticCountTransition\(initiatingTxn, optimisticTxn\)/);
  assert.match(handler, /setTransactions[\s\S]*confirmCreditCardPaymentMatch/);
  assert.match(handler, /setTransactions\(previousTransactions\)/);
  assert.match(handler, /setTabCounts\(previousTabCounts\)/);
  assert.match(handler, /updateCachedCreditCardPaymentFeeds/);
  assert.match(handler, /rollbackCachedFeeds\(\)/);
  assert.match(handler, /queueMicrotask/);
  assert.doesNotMatch(handler, /await reloadCurrentBookkeepingView/);
  assert.match(client, /Idempotency-Key/);
  assert.match(client, /x-correlation-id/);
  assert.match(client, /expected_candidate_version/);
});

test("only the two affected account caches are transitioned between review and matched", () => {
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  const helper = page.slice(
    page.indexOf("function updateCachedCreditCardPaymentFeeds"),
    page.indexOf("function isInconsistentEmptyTransactionPage")
  );

  assert.match(helper, /accounts\.has\(cachedAccount\)/);
  assert.match(helper, /\["needs_review", "matched"\]/);
  assert.match(helper, /cachedPage === 1/);
  assert.match(helper, /snapshots/);
  assert.doesNotMatch(helper, /sessionStorage\.clear/);
});

test("matched feed paginates existing-QBO matches and credit-card pair legs together", () => {
  const feedService = read("src/services/bookkeeping/bookkeepingTransactionFeedService.js");
  const start = feedService.indexOf("export async function fetchBookkeepingTransactions");
  const fetchBody = feedService.slice(
    start,
    feedService.indexOf("// Job Costing uses posted Books transactions", start)
  );

  assert.match(fetchBody, /needsCombinedMatchedPagination/);
  assert.match(fetchBody, /const rpcLimit = needsCombinedMatchedPagination \? safePage \* safePageSize : safePageSize/);
  assert.match(fetchBody, /pageSize: safePage \* safePageSize/);
  assert.match(fetchBody, /\.slice\(\(safePage - 1\) \* safePageSize, safePage \* safePageSize\)/);
  assert.match(feedService, /match_type: "credit_card_payment_pair"/);
});
