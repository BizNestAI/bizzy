import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dashboardSource = readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
const overviewHookSource = readFileSync("src/hooks/tax/useTaxOverview.js", "utf8");
const deductionsHookSource = readFileSync("src/hooks/tax/useTaxDeductions.js", "utf8");

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing source start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `Missing source end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("Tax overview hook enters Live Mode loading state before the first effect runs", () => {
  assert.match(overviewHookSource, /const startsWithLiveRequest = enabled && mode === TAX_DATA_MODES\.LIVE;/);
  assert.match(overviewHookSource, /const \[loading, setLoading\] = useState\(startsWithLiveRequest\);/);
  assert.match(overviewHookSource, /mode === TAX_DATA_MODES\.DEMO[\s\S]*setLoading\(false\)/);
  assert.match(overviewHookSource, /mode === TAX_DATA_MODES\.DISABLED[\s\S]*setLoading\(false\)/);
});

test("Tax dashboard shows the active loading shell before unresolved data can render fallback states", () => {
  const initialBranchIndex = dashboardSource.indexOf("initialLoading ? (");
  const failedBranchIndex = dashboardSource.indexOf("initialRequestFailed ? (");
  const trendIndex = dashboardSource.indexOf("<TaxTrendCard");
  assert.ok(initialBranchIndex > -1, "TaxDashboard should branch on initialLoading");
  assert.ok(failedBranchIndex > initialBranchIndex, "request failure should be handled after pending loading");
  assert.ok(trendIndex > failedBranchIndex, "dashboard content should render after loading and initial failure branches");
  assert.match(dashboardSource, /const initialLoading = tax\.loading && !hasPreviousData;/);
  assert.match(dashboardSource, /const initialRequestFailed = Boolean\(tax\.error && !hasPreviousData && !tax\.loading\);/);
});

test("Tax loading shell uses active accessible loading copy instead of static blank rectangles", () => {
  const skeleton = sourceBetween(dashboardSource, "function DashboardSkeleton", "function ErrorPanel");
  assert.match(skeleton, /role="status"/);
  assert.match(skeleton, /aria-live="polite"/);
  assert.match(skeleton, /aria-busy="true"/);
  assert.match(skeleton, /Loading your tax overview…/);
  assert.match(skeleton, /Fetching your profile, transactions, deductions, and estimate\./);
  assert.match(skeleton, /animate-dot-bounce/);
  assert.match(dashboardSource, /motion-safe:animate-pulse/);
  assert.match(skeleton, /motion-reduce:animate-none/);
  assert.match(skeleton, /aria-hidden="true"/);
  assert.doesNotMatch(skeleton, /Not available|\$0|Complete your tax profile|Tax profile incomplete/i);
});

test("Tax loading shell preserves dashboard geometry for low-jump replacement", () => {
  const skeleton = sourceBetween(dashboardSource, "function DashboardSkeleton", "function ErrorPanel");
  assert.match(skeleton, /min-h-\[360px\]/);
  assert.match(skeleton, /grid-cols-1 gap-4 xl:grid-cols-\[minmax\(0,0\.9fr\)_minmax\(0,1\.1fr\)\]/);
  assert.match(skeleton, /lg:grid-cols-\[minmax\(250px,0\.82fr\)_minmax\(0,1fr\)\]/);
  assert.match(skeleton, /grid-cols-2 gap-3 lg:grid-cols-4/);
});

test("Tax dashboard keeps cached content visible during background refresh", () => {
  assert.match(dashboardSource, /const hasPreviousData = !!tax\.data;/);
  assert.match(dashboardSource, /const initialLoading = tax\.loading && !hasPreviousData;/);
  assert.match(dashboardSource, /loading=\{tax\.refreshing\}/);
  assert.match(dashboardSource, /tax\.error && hasPreviousData/);
  assert.match(dashboardSource, /Keeping the last calculation on screen\./);
});

test("Tax dashboard distinguishes slow, failed, processing, and unavailable states", () => {
  assert.match(dashboardSource, /This is taking longer than expected\. You can stay here or return shortly\./);
  assert.match(dashboardSource, /We couldn’t load your tax overview\./);
  assert.match(dashboardSource, /Try again/);
  assert.match(dashboardSource, /calculation_required/);
  assert.match(dashboardSource, /model\.status\.calculationStatus === "failed"/);
  assert.match(dashboardSource, /ready_to_classify/);
  assert.match(dashboardSource, /classification_queued|classifying|classification_review_required|classification_failed/);
});

test("Tax dashboard does not add sequential duplicate reads for independent deduction resources", () => {
  assert.match(deductionsHookSource, /Promise\.allSettled\(\[/);
  assert.equal((deductionsHookSource.match(/getTaxDeductionsOverview/g) || []).length, 2);
  assert.equal((deductionsHookSource.match(/getTaxClassificationCoverage/g) || []).length, 2);
});
