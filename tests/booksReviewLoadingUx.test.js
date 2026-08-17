import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = readFileSync(join(root, "src/pages/accounting/BookkeepingCleanup.jsx"), "utf8");

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
