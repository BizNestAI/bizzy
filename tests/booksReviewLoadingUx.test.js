import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = readFileSync(join(root, "src/pages/accounting/BookkeepingCleanup.jsx"), "utf8");
const routeSource = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.transactions.routes.js"), "utf8");

test("Books Review keeps loaded rows visible while categorization continues", () => {
  assert.match(source, /const hasVisibleRows = feedRows\.length > 0/);
  assert.match(source, /!hasVisibleRows[\s\S]*?\(loadingTxns \|\| isPreparingCategories/);
  assert.match(source, /setLoadingTxns\(false\);[\s\S]*?const key = `\$\{dateRange\}\|\$\{accountFilter \|\| "all"\}`/);
  assert.match(source, /Preparing category suggestions/);
  assert.match(source, /You can keep working while this finishes/);
});

test("Books Review caches the current transaction page across quick re-entry", () => {
  assert.match(source, /BOOKS_TXN_CACHE_PREFIX/);
  assert.match(source, /window\.sessionStorage\.getItem\(cacheKey\)/);
  assert.match(source, /window\.sessionStorage\.setItem\(cacheKey/);
  assert.match(source, /setBackgroundRefreshingTxns\(true\)/);
  assert.match(source, /Updating this feed in the background without hiding your current rows/);
});

test("Books Review does not render a blank table for empty rows with a positive total", () => {
  assert.match(source, /function isInconsistentEmptyTransactionPage/);
  assert.match(source, /rows\.length === 0 && Number\(total \|\| 0\) > 0/);
  assert.match(source, /window\.sessionStorage\.removeItem\(cacheKey\)/);
  assert.match(source, /if \(isInconsistentEmptyTransactionPage\(payload\)\) return/);
  assert.match(source, /lastNonEmptyTransactionsRef/);
  assert.match(source, /hasInconsistentEmptyPage/);
  assert.match(source, /loadingTxns \|\| isPreparingCategories \|\| hasInconsistentEmptyPage/);
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

test("Books Review immediately flips Needs Review and Handled counts for approve, undo, and bulk approve", () => {
  assert.match(source, /const approvedTxn = \{ \.\.\.txn, status: "approved", glAccountId, glAccountName \}/);
  assert.match(source, /applyOptimisticCountTransition\(txn, approvedTxn\)/);
  assert.match(source, /applyOptimisticCountTransition\(approvedTxn, txn\)/);
  assert.match(source, /const needsReviewTxn = \{ \.\.\.txn, status: "needs_review" \}/);
  assert.match(source, /applyOptimisticCountTransition\(txn, needsReviewTxn\)/);
  assert.match(source, /applyOptimisticCountTransition\(needsReviewTxn, txn\)/);
  assert.match(source, /approvedTxnsById\.forEach\(\(approvedTxn, txnId\) => \{[\s\S]*?applyOptimisticCountTransition\(selectedTxnById\.get\(txnId\), approvedTxn\)/);
  assert.match(source, /approvedTxnsById\.forEach\(\(approvedTxn, txnId\) => \{[\s\S]*?applyOptimisticCountTransition\(approvedTxn, selectedTxnById\.get\(txnId\)\)/);
});

test("Books Review transaction loading is database-bounded before pagination", () => {
  const fetchBody = routeSource.slice(
    routeSource.indexOf("export async function fetchBookkeepingTransactions"),
    routeSource.indexOf("/* ----------------------------- Grace edits")
  );
  const countsBody = routeSource.slice(
    routeSource.indexOf("router.get(\"/transactions/counts\""),
    routeSource.indexOf("router.get(\"/transactions\"")
  );

  assert.match(fetchBody, /get_bookkeeping_transactions_bounded/);
  assert.match(fetchBody, /p_limit:\s*safePageSize/);
  assert.match(fetchBody, /p_offset:\s*\(safePage - 1\) \* safePageSize/);
  assert.match(fetchBody, /rangeStartDateForBookkeeping\(rangeParam\)/);
  assert.doesNotMatch(fetchBody, /\.in\("transaction_id",\s*ids\)/);
  assert.doesNotMatch(fetchBody, /const ids = \(baseRows \|\| \[\]\)\.map/);
  assert.match(countsBody, /countBookkeepingTransactions/);
  assert.match(countsBody, /Promise\.all/);
});
