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

test("Monthly Review feed Needs Review approval uses explicit shared reclassification approval path", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const approveBody = routeBody(
    route,
    'router.post("/runs/:runId/transactions/:transactionId/approve"',
    '\nrouter.post("/runs/:runId/transactions/:transactionId/post-qbo"'
  );

  assert.match(route, /router\.use\(requireAuth\)/);
  assert.match(route, /router\.use\(requireInternalRole\(MONTHLY_REVIEW_STAFF_ROLES\)\)/);
  assert.match(approveBody, /assertRunTransactionInSelectedMonth\(run,\s*transactionId\)/);
  assert.match(approveBody, /reclassifyBookkeepingTransaction\(/);
  assert.match(approveBody, /mode !== "needs_review_approval"/);
  assert.match(approveBody, /targetQboAccountId:\s*accountId/);
  assert.doesNotMatch(approveBody, /\.from\("transaction_categorizations"\)\s*\.update/);
  assert.doesNotMatch(approveBody, /runBooksPostOnce|postSingleBookkeepingTransactionNow|updatePostedQboTransactionAccount/);
});

test("Monthly Review feed handled post uses existing manual posting authority and blocks already posted rows", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const postBody = routeBody(
    route,
    'router.post("/runs/:runId/transactions/:transactionId/post-qbo"',
    '\nrouter.post("/runs/:runId/transactions/:transactionId/retry-qbo-sync"'
  );

  assert.match(postBody, /assertRunTransactionInSelectedMonth\(run,\s*transactionId\)/);
  assert.match(postBody, /matchesTransactionStatusFilter\("handled",\s*current\)/);
  assert.match(postBody, /transaction_already_posted/);
  assert.match(postBody, /postSingleBookkeepingTransactionNow\(\{/);
  assert.match(postBody, /businessId:\s*run\.business_id/);
  assert.match(postBody, /transactionId/);
  assert.doesNotMatch(postBody, /auto_post_to_quickbooks|runBooksPostOnce|createQbo|updateQbo/);
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
  assert.match(page, /loadBookkeepingFeed\(status,\s*\{\s*reset:\s*true\s*\}\)/);

  const dropdownSnippet = table.slice(table.indexOf("<CoaDropdown"), table.indexOf("onChange={(accountId) => setSelectedAccountId(accountId)}") + 80);
  assert.match(dropdownSnippet, /onChange=\{\(accountId\) => setSelectedAccountId\(accountId\)\}/);
  assert.doesNotMatch(dropdownSnippet, /onApprove|onReclassify|safeFetch|fetch\(/);
  assert.match(table, />\s*\{isActionBusy\("approve"\) \? "Approving\.\.\." : "Approve"\}\s*</);
  assert.match(table, />\s*\{isActionBusy\("reclassify"\) \? "Saving\.\.\." : "Reclassify"\}\s*</);
  assert.match(table, /Post to QBO/);
  assert.match(table, /Retry QBO/);
  assert.match(table, /getProtectedWorkflowReason/);
  assert.match(table, /onChange=\{\(accountId\) => setSelectedAccountId\(accountId\)\}/);
  assert.match(table, /Bank Account/);
  assert.match(table, /GL Account/);
  assert.match(table, /QBO Status/);
  assert.doesNotMatch(table, />\s*Special workflow\s*</);
});

test("Monthly Review feed actions preserve Phase 4B bounded mirror source", () => {
  const page = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const service = read("src/services/bookkeeping/bookkeepingTransactionFeedService.js");

  assert.match(page, /BOOKKEEPING_FEED_PAGE_SIZE\s*=\s*25/);
  assert.match(page, /bookkeeping\/transactions\?month=/);
  assert.match(page, /\[\.\.\.\(current\[status\]\?\.rows \|\| \[\]\), \.\.\.rows\]/);
  assert.match(service, /p_range_end:\s*normalizeBookkeepingDate\(rangeEnd\)/);
  assert.match(service, /matchesTransactionStatusFilter/);
});
