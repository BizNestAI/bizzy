/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = readFileSync(join(root, "src/pages/accounting/BookkeepingCleanup.jsx"), "utf8");
const clientSource = readFileSync(join(root, "src/services/bookkeeping/bookkeepingClient.js"), "utf8");
const routeSource = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.transactions.routes.js"), "utf8");
const feedServiceSource = readFileSync(join(root, "src/services/bookkeeping/bookkeepingTransactionFeedService.js"), "utf8");
const approvalRouteSource = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.approvals.routes.js"), "utf8");
const approvalServiceSource = readFileSync(join(root, "src/services/bookkeeping/bookkeepingApprovalService.js"), "utf8");
const postingWorkerSource = readFileSync(join(root, "src/jobs/interactivePostingCommands.worker.js"), "utf8");

test("Books Review keeps loaded rows visible while categorization continues", () => {
  assert.match(source, /const hasVisibleRows = feedRows\.length > 0/);
  assert.match(source, /!hasVisibleRows[\s\S]*?\(loadingTxns \|\| isPreparingCategories/);
  assert.match(source, /const processingMessage = useMemo/);
  assert.match(source, /current_run/);
  assert.match(source, /Categorized \$\{processed\} of \$\{expected\} transactions/);
  assert.match(source, /completedProcessingMessage/);
  assert.match(source, /\$\{count\} \$\{count === 1 \? "transaction" : "transactions"\} categorized/);
  assert.match(source, /Categorizing \$\{serverProcessingCount\} new transactions/);
  assert.match(source, /You can keep working while this finishes/);
});

test("Books Review caches the current transaction page across quick re-entry", () => {
  assert.match(source, /BOOKS_TXN_CACHE_PREFIX/);
  assert.match(source, /window\.sessionStorage\.getItem\(cacheKey\)/);
  assert.match(source, /window\.sessionStorage\.setItem\(cacheKey/);
  assert.match(source, /lastSuccessfulTransactionPagesRef/);
  assert.match(source, /lastSuccessfulTransactionPagesRef\.current\.get\(cacheKey\)/);
  assert.match(source, /lastSuccessfulTransactionPagesRef\.current\.set\(cacheKey/);
  assert.match(source, /showBackgroundRefresh = true/);
  assert.match(source, /setBackgroundRefreshingTxns\(shouldShowBackgroundRefresh\)/);
  assert.match(source, /Updating this feed in the background without hiding your current rows/);
});

test("Books Review does not render a blank table for empty rows with a positive total", () => {
  assert.match(source, /function isInconsistentEmptyTransactionPage/);
  assert.match(source, /rows\.length === 0 && Number\(total \|\| 0\) > 0/);
  assert.match(source, /window\.sessionStorage\.removeItem\(cacheKey\)/);
  assert.match(source, /if \(isInconsistentEmptyTransactionPage\(payload\)\) return/);
  assert.match(source, /const fallbackPage = cacheKey \? lastSuccessfulTransactionPagesRef\.current\.get\(cacheKey\) : null/);
  assert.match(source, /const clampedPage = Math\.min\(page - 1, lastPage\)/);
  assert.doesNotMatch(source, /lastNonEmptyTransactionsRef/);
  assert.match(source, /hasInconsistentEmptyPage/);
  assert.doesNotMatch(source, /loadingTxns \|\| isPreparingCategories \|\| hasInconsistentEmptyPage/);
});

test("Books Review refresh cache is scoped by business, account, status, range, page, and page size", () => {
  assert.match(source, /function buildTransactionCacheKey\(\{ businessId, accountFilter, activeTab, dateRange, page, rowsPerPage \}\)/);
  assert.match(source, /\[businessId, accountFilter, activeTab, dateRange, page, rowsPerPage\]/);
  assert.match(source, /setTransactions\(\[\]\);[\s\S]*?setTotalCount\(null\);[\s\S]*?setLoadingTxns\(true\)/);
  assert.doesNotMatch(source, /lastSuccessfulTransactionPagesRef\.current\.values\(\)/);
});

test("Books Review failed background refresh preserves the last good view and uses toast treatment", () => {
  assert.match(source, /Showing the last loaded transactions for this view/);
  assert.match(source, /setTransactions\(fallbackPage\.rows\)/);
  assert.match(source, /title: "Transactions couldn't refresh"/);
  assert.match(source, /setBackgroundRefreshingTxns\(false\)/);
});

test("Books Review account navigation does not trigger foreground enrichment or categorization work", () => {
  assert.doesNotMatch(source, /import[\s\S]*enrichCounterparties/);
  assert.doesNotMatch(source, /await enrichCounterparties\(/);
  assert.doesNotMatch(source, /setCategorizationStatus\(\{ phase: "enriching" \}\)/);
  assert.doesNotMatch(source, /Identifying payees before Bizzi prepares category suggestions/);
  assert.match(routeSource, /router\.post\("\/enrich-counterparties"/);
});

test("Books Review processing polling is read-only and only stays active while backend work is active", () => {
  assert.match(source, /loadProcessingStatus\(\);[\s\S]*?if \(Number\(processingStatus\?\.active_count \|\| 0\) <= 0\) return undefined;[\s\S]*?window\.setInterval/);
  assert.match(source, /processingStatus\?\.active_count/);
  assert.doesNotMatch(source, /retryBookkeepingProcessing\(businessId/);
  assert.doesNotMatch(source, /reconsiderSuggestions\(businessId/);
});

test("Books Review full loading state is reserved for true first load without renderable rows", () => {
  assert.match(source, /const showLoadingState =[\s\S]*?!hasVisibleRows[\s\S]*?\(loadingTxns \|\| isPreparingCategories/);
  assert.doesNotMatch(source, /showLoadingState =[\s\S]*?hasInconsistentEmptyPage/);
  assert.match(source, /setTransactions\(\[\]\);[\s\S]*?setTotalCount\(null\);[\s\S]*?setLoadingTxns\(true\)/);
  assert.match(source, /const cachedPage = readTransactionPageCache\(cacheKey\) \|\| previousPage/);
  assert.match(source, /if \(cachedPage && Array\.isArray\(cachedPage\.rows\)\) \{[\s\S]*?const ledgerSuppressed = suppressLedgerRowsFromNeedsReview\(cached\.rows[\s\S]*?setTransactions\(ledgerSuppressed\.rows\)[\s\S]*?setBackgroundRefreshingTxns\(shouldShowBackgroundRefresh\)/);
});

test("Books Review undo is row-scoped and reconciles in the background", () => {
  const undoStart = source.indexOf("const handleUndo = async");
  const undoEnd = source.indexOf("const handleRejectCreditCardPayment = async", undoStart);
  const undoBody = source.slice(undoStart, undoEnd);

  assert.match(source, /const \[undoingTransactionIds, setUndoingTransactionIds\] = useState\(\(\) => new Set\(\)\)/);
  assert.match(undoBody, /const pairId = txn\.cc_payment_pair_id \|\| txn\.meta\?\.cc_payment_pair_id/);
  assert.match(undoBody, /const optimisticTxnIds = new Set/);
  assert.match(undoBody, /setUndoingTransactionIds/);
  assert.match(undoBody, /await undoTransaction\(businessId, id\)/);
  assert.match(undoBody, /undoResult\?\.transaction_ids \|\| undoResult\?\.transactionIds/);
  assert.match(undoBody, /await reloadTransactions\(\{ showBackgroundRefresh: true, refreshProcessingStatus: false \}\)/);
  assert.doesNotMatch(undoBody, /showBackgroundRefresh: false/);
  assert.match(source, /postingTransactionIds=\{new Set\(\[\.\.\.postingTransactionIds, \.\.\.undoingTransactionIds\]\)\}/);
});

test("Books Review transaction fetches use timeout, abort cleanup, and Retry instead of endless loading", () => {
  assert.match(clientSource, /export async function getTransactions\(businessId, params = \{\}, options = \{\}\)/);
  assert.match(clientSource, /signal: options\.signal/);
  assert.match(clientSource, /timeoutMs: options\.timeoutMs \?\? 20000/);
  assert.match(source, /const \[transactionLoadError, setTransactionLoadError\] = useState\(null\)/);
  assert.match(source, /const transactionRequestAbortRef = useRef\(null\)/);
  assert.match(source, /transactionRequestAbortRef\.current\?\.abort\(\)/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /signal: requestController\.signal/);
  assert.match(source, /timeoutMs: 20000/);
  assert.match(source, /setTransactionLoadError\(\{[\s\S]*?This account took too long to load/);
  assert.match(source, /Transactions couldn't load\./);
  assert.match(source, />\s*Retry\s*</);
});

test("Books Review clears loading for success, empty, failure, no-account, and aborted stale requests", () => {
  assert.match(source, /if \(!accountFilter\) \{[\s\S]*?setLoadingTxns\(false\);[\s\S]*?setBackgroundRefreshingTxns\(false\);[\s\S]*?return;/);
  assert.match(source, /setTransactionLoadError\(null\);[\s\S]*?setLoadingTxns\(false\);[\s\S]*?setBackgroundRefreshingTxns\(false\)/);
  assert.match(source, /catch \(e\) \{[\s\S]*?if \(!isLatestRequest\(\)\) return;[\s\S]*?setTransactionLoadError/);
  assert.match(source, /finally \{[\s\S]*?if \(isLatestRequest\(\)\) \{[\s\S]*?setLoadingTxns\(false\);[\s\S]*?setBackgroundRefreshingTxns\(false\);/);
  assert.match(source, /transactionReloadSeqRef\.current === requestSeq/);
  assert.match(source, /transactionViewKeyRef\.current === requestViewKey/);
});

test("Books Review feed loading is independent of interactive posting workers and background polling", () => {
  const reloadStart = source.indexOf("const reloadTransactions = useCallback");
  const reloadEnd = source.indexOf("useEffect(() => {", reloadStart);
  const reloadBody = source.slice(reloadStart, reloadEnd);

  assert.match(reloadBody, /fetchTransactions\(businessId/);
  assert.doesNotMatch(reloadBody, /claimInteractivePosting|runInteractivePosting|posting\/backlog|post-ready|plaid\/sync|retryBookkeepingProcessing/);
  assert.match(source, /hasVisibleRows && \(categorizationMessage \|\| processingMessage \|\| completedProcessingMessage \|\| backgroundRefreshingTxns\)/);
  assert.match(postingWorkerSource, /isMissingInteractivePostingCommandRpcError/);
  assert.match(postingWorkerSource, /nextInteractivePostingPollDelayMs/);
});

test("Books Review bulk approval uses live COA accounts and selected vendors instead of mock placeholders", () => {
  assert.doesNotMatch(source, /Elm St\. Kitchen/);
  assert.doesNotMatch(source, /CATEGORY_OPTIONS/);
  assert.doesNotMatch(source, /JOB_OPTIONS/);
  assert.match(source, /import BookkeepingFeed, \{ CoaDropdown \}/);
  assert.match(source, /const \[bulkAccountId, setBulkAccountId\] = useState\(""\)/);
  assert.match(source, /accounts=\{groupedChartAccounts\}/);
  assert.match(source, /const selectedVendorLabel = useMemo/);
  assert.match(source, /newAccountId: bulkAccountId/);
  assert.match(source, /newAccountName: accountName/);
});

test("Books Review updates tab counts optimistically when transaction status changes", () => {
  assert.match(source, /function adjustCount\(value, delta\)/);
  assert.match(source, /const applyOptimisticCountTransition = useCallback/);
  assert.match(source, /const isInCurrentCountScope = \(txn\) =>/);
  assert.match(source, /matchesBooksTab\(beforeTxn, key\)/);
  assert.match(source, /matchesBooksTab\(afterTxn, key\)/);
  assert.match(source, /adjustCount\(next\[key\], Number\(afterMatches\) - Number\(beforeMatches\)\)/);
});

test("Books Review keeps approval rows and counts authoritative until the server succeeds", () => {
  const approveBody = source.slice(source.indexOf("const handleApprove = async"), source.indexOf("const handleUndo = async"));
  assert.match(approveBody, /status: "pending"/);
  assert.doesNotMatch(approveBody, /const approvedTxn|applyOptimisticCountTransition/);
  assert.match(approveBody, /setTransactions\(\(prev\) => prev\.filter/);
  assert.match(approveBody, /refreshCounts: true/);
  assert.match(source, /const needsReviewTxn = \{ \.\.\.txn, status: "needs_review" \}/);
});

test("Books Review manual categorization uses a silent row-scoped refetch without feed-wide banners", () => {
  const approveStart = source.indexOf("const handleApprove = async");
  const approveEnd = source.indexOf("const handleUndo = async", approveStart);
  const approveBody = source.slice(approveStart, approveEnd);
  const bulkStart = source.indexOf("const handleBulkApprove = async");
  const bulkEnd = source.indexOf("const handleManualPostTransaction", bulkStart);
  const bulkBody = source.slice(bulkStart, bulkEnd);

  assert.match(approveBody, /await approveTransactions\(businessId/);
  assert.match(approveBody, /reloadCurrentBookkeepingView\(reloadTransactionsRef, \{ showBackgroundRefresh: false, refreshProcessingStatus: false, refreshCounts: true \}\)/);
  assert.match(bulkBody, /await approveTransactions\(/);
  assert.match(bulkBody, /reloadCurrentBookkeepingView\(reloadTransactionsRef, \{ showBackgroundRefresh: false, refreshProcessingStatus: false, refreshCounts: true \}\)/);
  assert.doesNotMatch(approveBody, /triggerPlaidSync|reconsiderNeedsReviewTransactions|retryBookkeepingProcessing|setCategorizationStatus|setBackgroundRefreshingTxns/);
  assert.doesNotMatch(bulkBody, /triggerPlaidSync|reconsiderNeedsReviewTransactions|retryBookkeepingProcessing|setCategorizationStatus|setBackgroundRefreshingTxns/);
});

test("Books Review protects pending approvals from stale and out-of-order transaction refreshes", () => {
  assert.match(source, /const approvalMutationLedgerRef = useRef\(new Map\(\)\)/);
  assert.match(source, /const transactionReloadSeqRef = useRef\(0\)/);
  assert.match(source, /const transactionViewKeyRef = useRef\(""\)/);
  assert.match(source, /const pendingApprovalIds = useMemo/);
  assert.match(source, /approvalMutationLedgerRef\.current\.has\(String\(id\)\)/);
  assert.match(source, /setApprovalLedgerEntry\(id,\s*\{[\s\S]*?status: "pending"[\s\S]*?originalTxn: txn/);
  assert.match(source, /setApprovalLedgerEntry\(id,\s*\{[\s\S]*?status: "confirmed"[\s\S]*?serverRow/);
  assert.match(source, /removeApprovalLedgerEntry\(id\)/);
  assert.match(source, /function isNeedsReviewTransaction\(txn = \{\}\)/);
  assert.match(source, /suppressLedgerRowsFromNeedsReview/);
  assert.match(source, /APPROVAL_LEDGER_CONFIRMATION_GRACE_MS = 5_000/);
  assert.match(source, /if \(!isApprovalLedgerEntryActive\(entry, now\)\) return true/);
  assert.match(source, /staleApprovalIds\.add\(String\(txn\.id\)\)/);
  assert.match(source, /reconcileApprovalLedgerAfterRows\(new Set\(\)\)/);
  assert.match(source, /if \(staleApprovalIds\.has\(id\)\) continue/);
  assert.doesNotMatch(source, /if \(row && isNeedsReviewTransaction\(row\)\) continue/);
  assert.match(source, /const requestSeq = transactionReloadSeqRef\.current \+ 1/);
  assert.match(source, /transactionReloadSeqRef\.current === requestSeq/);
  assert.match(source, /transactionViewKeyRef\.current === requestViewKey/);
});

test("Books Review pending approvals do not fabricate tab counts", () => {
  const countsStart = source.indexOf("const loadTabCounts = useCallback");
  const countsEnd = source.indexOf("const loadClarifications = useCallback", countsStart);
  const countsBody = source.slice(countsStart, countsEnd);
  const approveStart = source.indexOf("const handleApprove = async");
  const approveEnd = source.indexOf("const handleUndo = async", approveStart);
  const approveBody = source.slice(approveStart, approveEnd);

  assert.match(source, /overlayPendingApprovalCounts/);
  assert.match(countsBody, /setTabCounts\(overlayPendingApprovalCounts\(counts\)\)/);
  assert.match(source, /excluded: Number\(counts\?\.excluded \|\| 0\)/);
  assert.doesNotMatch(approveBody, /applyOptimisticCountTransition/);
  assert.match(approveBody, /refreshCounts: true/);
});

test("Books Review concurrent approval handling is per transaction", () => {
  const bulkStart = source.indexOf("const handleBulkApprove = async");
  const bulkEnd = source.indexOf("const handleManualPostTransaction", bulkStart);
  const bulkBody = source.slice(bulkStart, bulkEnd);

  assert.match(bulkBody, /\.filter\(\(txnId\) => !approvalMutationLedgerRef\.current\.has\(String\(txnId\)\)\)/);
  assert.match(bulkBody, /selectedTxnIds\.forEach\(\(txnId\) => \{[\s\S]*?setApprovalLedgerEntry\(txnId,\s*\{[\s\S]*?status: "confirmed"/);
  assert.match(bulkBody, /setTransactions\(\(prev\) => prev\.filter\(\(txn\) => !selectedTxnIds\.includes\(txn\.id\)\)\)/);
  assert.match(bulkBody, /selectedTxnById\.forEach\(\(_originalTxn, txnId\) => \{[\s\S]*?removeApprovalLedgerEntry\(txnId\)/);
  assert.doesNotMatch(bulkBody, /approvalMutationLedgerRef\.current\.clear\(\)/);
  assert.doesNotMatch(source, /setApprovalLedgerVersion\(0\)/);
});

test("Books Review approval API is narrow and does not start feed sync or broad reprocessing", () => {
  const approveClientStart = clientSource.indexOf("export async function approveTransactions");
  const approveClientEnd = clientSource.indexOf("export async function undoTransaction", approveClientStart);
  const approveClientBody = clientSource.slice(approveClientStart, approveClientEnd);
  const approveRouteStart = approvalRouteSource.indexOf("router.post(\"/approve\"");
  const approveRouteEnd = approvalRouteSource.indexOf("router.post(\"/undo\"", approveRouteStart);
  const approveRouteBody = approvalRouteSource.slice(approveRouteStart, approveRouteEnd);

  assert.match(approveClientBody, /apiUrl\("\/api\/bookkeeping\/approve"\)/);
  assert.match(approveRouteBody, /approveBookkeepingTransactions\(\{/);
  assert.match(approvalServiceSource, /\.in\("transaction_id", txnIds\)/);
  assert.match(approvalServiceSource, /await learnVendorRuleFromTransaction\(\{/);
  assert.match(approvalServiceSource, /post_after:\s*item\.post_after === undefined \? postAfter : item\.post_after/);
  assert.doesNotMatch(approveClientBody, /triggerPlaidSync|suggest\/reconsider|processing\/retry|plaid\/sync/);
  assert.doesNotMatch(approveRouteBody, /triggerPlaidSync|reconsiderNeedsReviewTransactions|retryBookkeepingProcessing|enqueueUnresolvedBookkeepingBacklog|plaid\/sync/);
  assert.doesNotMatch(approvalServiceSource, /enqueueUnresolvedBookkeepingBacklog|reconsiderNeedsReviewTransactions|triggerPlaidSync|plaid\/sync/);
});

test("Books Review transaction loading is database-bounded before pagination", () => {
  const countsBody = routeSource.slice(
    routeSource.indexOf("router.get(\"/transactions/counts\""),
    routeSource.indexOf("router.get(\"/transactions\"")
  );

  assert.match(routeSource, /bookkeepingTransactionFeedService\.js/);
  assert.match(feedServiceSource, /get_bookkeeping_transactions_bounded/);
  assert.match(feedServiceSource, /p_limit:\s*safePageSize/);
  assert.match(feedServiceSource, /p_offset:\s*\(safePage - 1\) \* safePageSize/);
  assert.match(feedServiceSource, /rangeStartDateForBookkeeping\(rangeParam\)/);
  assert.doesNotMatch(feedServiceSource, /\.in\("transaction_id",\s*ids\)/);
  assert.doesNotMatch(feedServiceSource, /const ids = \(baseRows \|\| \[\]\)\.map/);
  assert.match(countsBody, /countBookkeepingTransactions/);
  assert.match(countsBody, /Promise\.all/);
});
