import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

test("processing status active_count excludes failed retry rows and stale processing locks", () => {
  const service = read("src/services/bookkeeping/backgroundBookkeepingProcessingService.js");
  assert.match(service, /BOOKKEEPING_PROCESSING_STATUSES\.PENDING,\s*BOOKKEEPING_PROCESSING_STATUSES\.PROCESSING/);
  assert.doesNotMatch(service, /\.in\("status", queuedStatuses\)/);
  assert.match(service, /const active = \(queued \|\| \[\]\)\.filter/);
  assert.match(service, /status === BOOKKEEPING_PROCESSING_STATUSES\.PENDING[\s\S]*?return !row\.process_after \|\| String\(row\.process_after\) <= nowText/);
  assert.match(service, /status === BOOKKEEPING_PROCESSING_STATUSES\.PROCESSING[\s\S]*?String\(row\.locked_at\) >= staleBefore/);
  assert.match(service, /retry_count: retryRows\?\.length \|\| 0/);
  assert.match(service, /active_count: active\.length/);
});

test("Books Review feed reads processing status without creating processing requests", () => {
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  const client = read("src/services/bookkeeping/bookkeepingClient.js");
  const processingRoute = read("src/api/bookkeeping/routes/bookkeeping.processing.routes.js");
  const txRoute = read("src/api/bookkeeping/routes/bookkeeping.transactions.routes.js");

  assert.match(page, /getBookkeepingProcessingStatus\(businessId\)/);
  assert.match(client, /safeFetch\(apiUrl\("\/api\/bookkeeping\/processing\/status"\)/);
  assert.match(processingRoute, /router\.get\("\/processing\/status"/);
  assert.match(processingRoute, /getBookkeepingProcessingStatus\(\{ businessId \}\)/);
  assert.doesNotMatch(processingRoute.slice(
    processingRoute.indexOf('router.get("/processing/status"'),
    processingRoute.indexOf('router.post("/processing/retry"')
  ), /enqueueBookkeepingProcessingForTransactions|processPendingBookkeepingRequests|reconsiderNeedsReviewTransactions/);
  assert.doesNotMatch(txRoute.slice(
    txRoute.indexOf('router.get("/transactions"'),
    txRoute.indexOf("/* ----------------------------- Payee enrichment")
  ), /enqueueUnresolvedBookkeepingBacklog|enqueueBookkeepingProcessingForTransactions|resolvePayee|runBookkeepingSuggestionPass/);
});
