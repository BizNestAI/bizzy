import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

function routeBody(source, marker, endMarker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} route missing`);
  const end = endMarker ? source.indexOf(endMarker, start + marker.length) : source.indexOf("\nrouter.", start + marker.length);
  assert.notEqual(end, -1, `${marker} route end missing`);
  return source.slice(start, end);
}

test("Monthly Review feed Needs Review approval uses the shared bookkeeping approval path", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const approveBody = routeBody(
    route,
    'router.post("/runs/:runId/transactions/:transactionId/approve"',
    '\nrouter.post("/runs/:runId/transactions/:transactionId/post-qbo"'
  );

  assert.match(route, /router\.use\(requireAuth\)/);
  assert.match(route, /router\.use\(requireInternalRole\(MONTHLY_REVIEW_STAFF_ROLES\)\)/);
  assert.match(approveBody, /assertRunTransactionInSelectedMonth\(run,\s*transactionId\)/);
  assert.match(approveBody, /approveBookkeepingTransactions\(/);
  assert.match(approveBody, /resolution:\s*"categorize_new"/);
  assert.match(approveBody, /newAccountId:\s*accountId/);
  assert.doesNotMatch(approveBody, /\.from\("transaction_categorizations"\)\s*\.update/);
  assert.doesNotMatch(approveBody, /runBooksPostOnce|postSingleBookkeepingTransactionNow|updatePostedQboTransactionAccount/);
});

test("Monthly Review feed handled post uses the durable shared command and blocks already posted rows", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const postBody = routeBody(
    route,
    'router.post("/runs/:runId/transactions/:transactionId/post-qbo"',
    '\nrouter.post("/runs/:runId/transactions/:transactionId/retry-qbo-sync"'
  );

  assert.match(postBody, /assertRunTransactionInSelectedMonth\(run,\s*transactionId\)/);
  assert.match(postBody, /matchesTransactionStatusFilter\("handled",\s*current\)/);
  assert.match(postBody, /transaction_already_posted/);
  assert.match(postBody, /requestInteractiveTransactionPosting\(\{/);
  assert.match(postBody, /businessId:\s*run\.business_id/);
  assert.match(postBody, /transactionId/);
  assert.match(postBody, /runInteractivePostingCommandWorkerOnce/);
  assert.match(postBody, /getInteractivePostingCommandStatus/);
  assert.doesNotMatch(postBody, /auto_post_to_quickbooks|runBooksPostOnce|createQbo|updateQbo|postSingleBookkeepingTransactionNow\(\{/);
});

test("Monthly Review feed reclassification and retry are selected-month guarded", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const accountBody = routeBody(
    route,
    'router.patch("/runs/:runId/transactions/:transactionId/account"',
    '\nrouter.post("/runs/:runId/transactions/:transactionId/approve"'
  );
  const retryBody = routeBody(
    route,
    'router.post("/runs/:runId/transactions/:transactionId/retry-qbo-sync"',
    '\nrouter.get("/runs/:runId/transactions/:transactionId/history"'
  );

  assert.match(accountBody, /assertRunTransactionInSelectedMonth\(run,\s*transactionId\)/);
  assert.match(accountBody, /reclassifyBookkeepingTransaction\(/);
  assert.match(retryBody, /assertRunTransactionInSelectedMonth\(run,\s*transactionId\)/);
  assert.match(retryBody, /updatePostedQboTransactionAccount|postSingleBookkeepingTransactionNow/);
});

test("Monthly Review failed unposted retry preserves failure state until posting authority confirms success", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const retryBody = routeBody(
    route,
    'router.post("/runs/:runId/transactions/:transactionId/retry-qbo-sync"',
    '\nrouter.get("/runs/:runId/transactions/:transactionId/history"'
  );
  const unpostedBranch = retryBody.slice(retryBody.indexOf("} else {"), retryBody.indexOf("await logAuditEvent"));

  assert.match(unpostedBranch, /postSingleBookkeepingTransactionNow\(\{/);
  assert.match(unpostedBranch, /businessId:\s*run\.business_id/);
  assert.match(unpostedBranch, /transactionId/);
  assert.doesNotMatch(unpostedBranch, /\.from\("transaction_categorizations"\)\s*\.update/);
  assert.doesNotMatch(unpostedBranch, /status:\s*"auto_approved"|status:\s*"approved"/);
  assert.doesNotMatch(unpostedBranch, /post_after:\s*now/);
  assert.doesNotMatch(unpostedBranch, /post_error:\s*null/);
  assert.doesNotMatch(unpostedBranch, /runBooksPostOnce/);
});

test("Monthly Review mirror UI requires explicit actions and does not mutate on GL selection", () => {
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const table = read("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx");

  assert.match(page, /runBookkeepingFeedAction/);
  assert.match(page, /const routeBase = `\/api\/admin\/monthly-review\/runs\/\$\{encodeURIComponent\(detail\.run\.id\)\}\/transactions\/\$\{encodeURIComponent\(transactionId\)\}`/);
  assert.match(page, /\$\{routeBase\}\/approve/);
  assert.match(page, /\$\{routeBase\}\/account/);
  assert.match(page, /\$\{routeBase\}\/post-qbo/);
  assert.match(page, /\$\{routeBase\}\/retry-qbo-sync/);
  assert.match(page, /refreshAfterFeedAction/);
  assert.match(page, /patchBookkeepingFeedsAfterApproval\(row,\s*accountId,\s*result\)/);
  assert.match(page, /patchBookkeepingFeedsAfterReclassification\(row,\s*accountId,\s*result\)/);
  assert.match(page, /setBookkeepingFeedActionErrors/);
  assert.match(page, /setBusyFeedActions/);
  assert.match(page, /else\s*\{\s*await refreshAfterFeedAction\(\);\s*\}/);

  const dropdownSnippet = table.slice(table.indexOf("<CoaDropdown"), table.indexOf("          />", table.indexOf("<CoaDropdown")) + 12);
  assert.match(dropdownSnippet, /onChange=\{\(accountId\) => \{\s*setSelectedAccountId\(accountId\)/);
  assert.doesNotMatch(dropdownSnippet, /onApprove|onReclassify|safeFetch|fetch\(/);
  assert.match(table, />\s*\{isActionBusy\("approve"\) \? "Approving\.\.\." : "Approve"\}\s*</);
  assert.match(table, />\s*\{isActionBusy\("reclassify"\) \? "Saving\.\.\." : "Reclassify"\}\s*</);
  assert.match(table, /postingAction\.permitted_action/);
  assert.match(table, /Retry posting/);
  assert.match(table, /getProtectedWorkflowReason/);
  assert.match(table, /onChange=\{\(accountId\) => \{\s*setSelectedAccountId\(accountId\)/);
  assert.match(table, /Bank Account/);
  assert.match(table, /GL Account/);
  assert.match(table, /QBO Status/);
  assert.doesNotMatch(table, />\s*Special workflow\s*</);
});

test("Monthly Review mirror approve and reclassify patch local feed state instead of full workspace refresh", () => {
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const localState = read("src/services/bookkeeping/bookkeepingFeedMirrorLocalState.js");
  const runStart = page.indexOf("const runBookkeepingFeedAction = useCallback");
  assert.notEqual(runStart, -1, "runBookkeepingFeedAction missing");
  const runEnd = page.indexOf("useEffect(() => {", runStart);
  assert.notEqual(runEnd, -1, "runBookkeepingFeedAction end missing");
  const runBody = page.slice(runStart, runEnd);

  assert.match(runBody, /patchBookkeepingFeedsAfterApproval\(row,\s*accountId,\s*result\)/);
  assert.match(runBody, /patchBookkeepingFeedsAfterReclassification\(row,\s*accountId,\s*result\)/);
  assert.match(runBody, /else\s*\{\s*await refreshAfterFeedAction\(\);\s*\}/);

  assert.match(localState, /removeBookkeepingRow\(needsReview\.rows,\s*transactionId\)/);
  assert.match(localState, /decrementCount\(needsReview\.totalCount\)/);
  assert.match(localState, /incrementCount\(handled\.totalCount\)/);
  assert.match(localState, /upsertBookkeepingRow\(handled\.rows,\s*nextRow,\s*\{\s*prepend:\s*true\s*\}\)/);
  assert.match(localState, /updateExistingBookkeepingRow\(feed\?\.rows,\s*nextRow\)/);
  assert.match(page, /patchSourceLedgerTransaction\(current,\s*nextRow\)/);
});

test("Monthly Review re-evaluate submits the exact population and refreshes every affected mirror", () => {
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const localState = read("src/services/bookkeeping/bookkeepingFeedMirrorLocalState.js");
  const runStart = page.indexOf("const runBookkeepingReconsideration = useCallback");
  assert.notEqual(runStart, -1, "runBookkeepingReconsideration missing");
  const runEnd = page.indexOf("const refreshAfterFeedAction = useCallback", runStart);
  assert.notEqual(runEnd, -1, "runBookkeepingReconsideration end missing");
  const runBody = page.slice(runStart, runEnd);

  assert.match(runBody, /bookkeeping\/transactions\/reconsider/);
  assert.match(runBody, /transaction_ids:\s*\[\.\.\.new Set\(transactionIds\)\]/);
  assert.match(runBody, /auto_approve:\s*true/);
  assert.match(runBody, /allow_ai_categorization:\s*false/);
  assert.match(runBody, /allow_qbo_account_create:\s*false/);
  assert.match(runBody, /loadDetail\(\)/);
  assert.match(runBody, /loadSourceLedger\(\)/);
  assert.match(runBody, /loadBookkeepingFeedCounts\(\)/);
  assert.match(runBody, /loadBookkeepingFeed\(status,\s*\{ reset:\s*true \}\)/);
  assert.doesNotMatch(runBody, /patchBookkeepingFeedsAfterReconsiderationState|window\.location\.reload/);
  assert.match(runBody, /suggestions changed/);
  assert.match(runBody, /skipped as final\/posted\/matched/);
  assert.match(page, /Re-evaluate Needs Review/);
  assert.match(localState, /patchBookkeepingFeedsAfterReconsiderationState/);
  assert.match(localState, /decrementCountBy\(needsReview\.totalCount,\s*promotedRows\.length\)/);
  assert.match(localState, /incrementCountBy\(handled\.totalCount,\s*promotedRows\.length\)/);
});

test("Monthly Review feed actions preserve Phase 4B bounded mirror source", () => {
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const service = read("src/services/bookkeeping/bookkeepingTransactionFeedService.js");

  assert.match(page, /BOOKKEEPING_FEED_PAGE_SIZE\s*=\s*25/);
  assert.match(page, /bookkeeping\/transactions\?month=/);
  assert.match(page, /const byId = new Map\(previousRows\.map/);
  assert.match(page, /const mergedRows = \[\.\.\.byId\.values\(\)\]/);
  assert.match(service, /p_range_end:\s*normalizeBookkeepingDate\(rangeEnd\)/);
  assert.match(service, /matchesTransactionStatusFilter/);
});

test("Monthly Review existing-QBO matching is an explicit proposal then approval workflow", () => {
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const route = read("src/api/admin/monthlyReview.routes.js");
  const table = read("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx");
  const panel = read("src/components/Accounting/BookkeepingFeed.jsx");

  const inspectStart = page.indexOf("const handleMirrorInspectIncomingDepositMatch");
  const inspectEnd = page.indexOf("const handleMirrorRejectIncomingDepositMatch", inspectStart);
  const inspect = page.slice(inspectStart, inspectEnd);
  assert.match(inspect, /resolution: "match_existing_qbo"/);
  assert.match(inspect, /proposalState/);
  assert.doesNotMatch(inspect, /status: "success"/);

  const discovery = routeBody(
    route,
    'router.post("/businesses/:businessId/bookkeeping/transactions/:transactionId/incoming-deposit-match/refresh"',
    '\nrouter.post("/businesses/:businessId/bookkeeping/transactions/:transactionId/incoming-deposit-match/:matchId/reject"'
  );
  assert.match(discovery, /discoverIncomingDepositQboMatch/);
  assert.doesNotMatch(discovery, /refreshProcessorFeeQboEvidence|confirmIncomingDepositQboMatch/);
  assert.match(discovery, /qbo_provider_writes: false/);
  assert.match(discovery, /qbo_transaction_writes: false/);

  assert.match(route, /incoming-deposit-match\/:matchId\/confirm/);
  assert.match(route, /incoming-deposit-match\/:matchId\/reject/);
  assert.match(table, /onReject=\{onRejectIncomingDepositMatch\}/);
  assert.match(panel, /Approve Match/);
  assert.match(panel, /Not a Match/);
  assert.match(panel, /QBO transaction/);
  assert.match(panel, /displayPrimary\.qbo_entity_id/);
  const confirmStart = page.indexOf("const handleMirrorConfirmIncomingDepositMatch");
  const confirmEnd = page.indexOf("const handleMirrorResolutionChange", confirmStart);
  const confirm = page.slice(confirmStart, confirmEnd);
  assert.match(confirm, /loadBookkeepingFeed\("needs_review", \{ reset: true \}\)/);
  assert.match(confirm, /loadBookkeepingFeed\("matched", \{ reset: true \}\)/);
});

test("Monthly Review unresolved QuickBooks payments expose Match before Approve Match", () => {
  const feed = readFileSync(join(root, "src/components/Accounting/BookkeepingFeed.jsx"), "utf8");
  assert.match(feed, /!state\.matchId \? \(/);
  assert.match(feed, /Finding match…/);
  assert.match(feed, /transitionMatching \? "Finding match…" : "Match"/);
  assert.match(feed, /const primaryActionLabel = "Approve Match"/);
  assert.match(feed, /onClick=\{\(\) => onInspect\?\.\(txn\.id, null, txn\)\}/);
});
