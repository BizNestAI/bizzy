import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import process from "node:process";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import {
  buildDeductionsWorkspaceViewModel,
  mapDeductionTransactionRow,
} from "../src/components/Tax/Deductions/deductionsWorkspaceViewModel.js";
import { calculateVehicleMileageDeduction } from "../src/services/tax/vehicleMileageRates.js";

let taxDashboardInternalsPromise;

async function loadTaxDashboardInternals() {
  if (!taxDashboardInternalsPromise) {
    taxDashboardInternalsPromise = (async () => {
      const server = await createServer({
        appType: "custom",
        server: { middlewareMode: true },
        logLevel: "silent",
        resolve: {
          alias: {
            "react-router-dom": `${process.cwd()}/tests/fixtures/reactRouterDomSsrStub.js`,
            "../../services/supabaseClient.js": `${process.cwd()}/tests/fixtures/supabaseClientSsrStub.js`,
            "../supabaseClient.js": `${process.cwd()}/tests/fixtures/supabaseClientSsrStub.js`,
            "../supabaseClient": `${process.cwd()}/tests/fixtures/supabaseClientSsrStub.js`,
          },
        },
        ssr: {
          noExternal: ["react-router-dom"],
        },
        plugins: [{
          name: "deductions-workspace-react-router-ssr-mock",
          enforce: "pre",
          resolveId(id) {
            return id === "react-router-dom" ? "\0react-router-dom-ssr-mock" : null;
          },
          load(id) {
            if (id !== "\0react-router-dom-ssr-mock") return null;
            return "export function useNavigate() { return () => {}; }";
          },
        }, {
          name: "deductions-workspace-supabase-client-ssr-mock",
          enforce: "pre",
          resolveId(id) {
            return /(^|\/|\\.\\.)supabaseClient(\\.js)?$/.test(id) || id.endsWith("/services/supabaseClient.js")
              ? "\0supabase-client-ssr-mock"
              : null;
          },
          load(id) {
            if (id !== "\0supabase-client-ssr-mock") return null;
            return "export const supabase = { auth: { getSession: async () => ({ data: { session: null }, error: null }) } }; export default supabase;";
          },
        }],
      });
      try {
        const mod = await server.ssrLoadModule("/src/pages/Tax/TaxDashboard.jsx");
        return mod.__TaxDashboardTestInternals;
      } finally {
        await server.close();
      }
    })();
  }
  return taxDashboardInternalsPromise;
}

function makeReviewSelection({ accountName, taxCategory, monthKey, longLabel, deductiblePercent = 0, amount = 100, id = "txn-1" }) {
  const row = {
    id,
    date: `${monthKey}-15`,
    vendor: `${accountName} Vendor`,
    description: `${accountName} test transaction`,
    qboAccountId: `${accountName.toLowerCase()}-qbo`,
    qboAccountName: accountName,
    amount,
    taxCategory,
    taxCategoryLabel: taxCategory.split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "),
    taxTreatment: "needs_review",
    taxTreatmentLabel: "Needs review",
    deductiblePercent,
    deductibleAmount: deductiblePercent > 0 ? Math.round(Math.abs(amount) * deductiblePercent) / 100 : 0,
    status: "needs_review",
    statusLabel: "Needs review",
    requiresReview: true,
    classificationSource: "rule_engine",
    matchedRuleCode: `${taxCategory}_review_gl_v3`,
    ruleVersion: "bizzi-gl-2026-v3",
    raw: { transactionId: id },
  };
  const month = {
    key: monthKey,
    longLabel,
    transactions: [row],
    expenseTotal: amount,
    authoritativeDeductibleTotal: 0,
    proposedDeductibleTotal: row.deductibleAmount,
    selectedAuthority: "automatic",
  };
  return {
    account: {
      key: `qbo:${accountName.toLowerCase()}`,
      name: accountName,
      sourceLabel: row.taxCategoryLabel,
      months: { [monthKey]: month },
    },
    month: { key: monthKey, longLabel },
    cell: month,
  };
}

test("deductions workspace view model keeps canonical buckets separate and preserves null", () => {
  const model = buildDeductionsWorkspaceViewModel({
    overview: {
      meta: { taxYear: 2026, asOfDate: "2026-07-14", source: "transaction_tax_classifications" },
      coverage: {
        eligiblePostedCount: 10,
        classifiedCount: 9,
        confirmedCount: 4,
        needsReviewCount: 2,
        classificationCoveragePercent: 90,
        confirmedCoveragePercent: 40,
        bookAmountCovered: 1000,
        needsReviewBookAmount: 250,
      },
      totals: {
        confirmedDeductibleAmount: 300,
        autoClassifiedDeductibleAmount: 200,
        estimatedDeductibleAmount: 500,
        nondeductibleAmount: 75,
        capitalizableAmount: 125,
        balanceSheetActivityAmount: 600,
        excludedAmount: null,
        needsReviewAmount: 250,
      },
      categories: [{
        taxCategory: "meals",
        displayName: "Meals",
        transactionCount: 3,
        confirmedDeductibleAmount: 100,
        autoClassifiedDeductibleAmount: 50,
        estimatedDeductibleAmount: 150,
        nondeductibleAmount: 25,
        capitalizableAmount: 0,
        balanceSheetActivityAmount: null,
        excludedAmount: null,
        needsReviewAmount: 80,
        reviewCount: 1,
      }],
    },
  });

  assert.equal(model.summary.confirmedDeductibleAmount, 300);
  assert.equal(model.summary.autoClassifiedDeductibleAmount, 200);
  assert.equal(model.summary.estimatedDeductibleAmount, 500);
  assert.equal(model.summary.needsReviewAmount, 250);
  assert.equal(model.summary.nondeductibleAmount, 75);
  assert.equal(model.summary.capitalizableAmount, 125);
  assert.equal(model.summary.balanceSheetAmount, 600);
  assert.equal(model.summary.excludedAmount, null);
  assert.equal(model.coverage.transactionCoveragePercent, 90);
  assert.equal(model.coverage.confirmedCoveragePercent, 40);
  assert.equal(model.coverage.reviewExposurePercent, 20);
  assert.equal(model.categories[0].status, "needs_review");
});

test("transaction rows map backend statuses to user-facing labels", () => {
  const row = mapDeductionTransactionRow({
    transactionId: "txn-1",
    date: "2026-07-01",
    merchantName: "Supply Co",
    qboAccountName: "Materials",
    signedAmount: -240,
    absoluteAmount: 240,
    taxCategory: "supplies",
    deductibilityStatus: "capitalizable",
    deductiblePercent: 0,
    deductibleAmount: 0,
    classificationStatus: "auto_classified",
    confidenceLevel: "medium",
  });
  assert.equal(row.vendor, "Supply Co");
  assert.equal(row.taxTreatmentLabel, "Capitalizable");
  assert.equal(row.statusLabel, "Auto-classified");
  assert.equal(row.amount, 240);
});

test("snake_case persisted classification rows hydrate into authoritative transaction fields", () => {
  const row = mapDeductionTransactionRow({
    transaction_id: "txn-software",
    transaction_date: "2026-09-04",
    merchant_name: "Software Co",
    source_qbo_account_name: "Software",
    book_amount: -100,
    tax_category: "software_subscriptions",
    deductibility_status: "fully_deductible",
    deductible_percent: 100,
    deductible_amount: 100,
    classification_status: "auto_classified",
    source_type: "rule_engine",
    matched_rule_code: "software_subscriptions_gl_v3",
    rule_version: "bizzi-gl-2026-v3",
    requires_review: false,
  });

  assert.equal(row.id, "txn-software");
  assert.equal(row.taxCategoryLabel, "Software Subscriptions");
  assert.equal(row.taxTreatmentLabel, "Fully deductible");
  assert.equal(row.statusLabel, "Auto-classified");
  assert.equal(row.requiresReview, false);
  assert.equal(row.classificationSource, "rule_engine");
  assert.equal(row.matchedRuleCode, "software_subscriptions_gl_v3");
});

test("system repair history does not make auto-classified rows look manually overridden", () => {
  const row = mapDeductionTransactionRow({
    transactionId: "txn-insurance",
    merchantName: "Progressive Insurance",
    qboAccountName: "Insurance",
    signedAmount: -273,
    absoluteAmount: 273,
    taxCategory: "business_insurance",
    deductibilityStatus: "fully_deductible",
    deductiblePercent: 100,
    deductibleAmount: 273,
    classificationStatus: "auto_classified",
    source_type: "rule_engine",
    matched_rule_code: "business_insurance_gl_v3",
    override: { hasOverride: true, source: "system_repair", lastChangedAt: "2026-09-09T00:00:00Z" },
  });

  assert.equal(row.status, "auto_classified");
  assert.equal(row.statusLabel, "Auto-classified");
});

test("user confirmation displays specific customer-facing authority", () => {
  const row = mapDeductionTransactionRow({
    transactionId: "txn-manual",
    merchantName: "Vendor",
    qboAccountName: "Supplies",
    signedAmount: -18.49,
    absoluteAmount: 18.49,
    taxCategory: "supplies",
    deductibilityStatus: "fully_deductible",
    deductiblePercent: 100,
    deductibleAmount: 18.49,
    classificationStatus: "user_confirmed",
    override: { hasOverride: true, source: "user", lastChangedAt: "2026-09-09T00:00:00Z" },
  });

  assert.equal(row.status, "user_confirmed");
  assert.equal(row.statusLabel, "Confirmed by you");
});

test("unclassified posted rows are not shown as authoritative needs-review classifications", () => {
  const row = mapDeductionTransactionRow({
    transactionId: "txn-pending",
    date: "2026-09-03",
    merchantName: "Chipotle Mexican Grill",
    qboAccountName: "Meals",
    signedAmount: -12,
    absoluteAmount: 12,
    taxCategory: "unclassified",
    deductibilityStatus: "needs_review",
    deductiblePercent: null,
    classificationStatus: null,
    requiresReview: true,
  });

  assert.equal(row.taxCategory, "pending");
  assert.equal(row.taxCategoryLabel, "Pending");
  assert.equal(row.taxTreatment, "pending_classification");
  assert.equal(row.taxTreatmentLabel, "Pending classification");
  assert.equal(row.status, "unclassified");
  assert.equal(row.statusLabel, "Unclassified");
  assert.equal(row.requiresReview, false);
});

test("persisted review-required fallback rows display as unresolved items", () => {
  const row = mapDeductionTransactionRow({
    transactionId: "txn-review",
    date: "2026-09-03",
    merchantName: "Vendor",
    qboAccountName: "Unmapped",
    signedAmount: -53,
    absoluteAmount: 53,
    taxCategory: "unclassified",
    deductibilityStatus: "needs_review",
    deductiblePercent: 0,
    deductibleAmount: 0,
    classificationStatus: "needs_review",
    requiresReview: true,
  });

  assert.equal(row.taxCategory, "unresolved");
  assert.equal(row.taxCategoryLabel, "Unresolved");
  assert.equal(row.taxTreatment, "not_determined");
  assert.equal(row.taxTreatmentLabel, "Not determined");
  assert.equal(row.status, "unclassified");
  assert.equal(row.statusLabel, "Needs classification");
  assert.equal(row.requiresReview, false);
});

test("fallback-only production state does not present automatic-majority copy", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /summary\.unresolvedTotal/);
  assert.match(dashboard, /transactions still need classification rules or additional context/);
  assert.match(dashboard, /meaningfulAutoMajority/);
  assert.doesNotMatch(dashboard, /Bizzi classified most transactions automatically/);
});

test("unresolved fallback rows remain a distinct controlled repair eligibility signal", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /function buildPrepareDeductionsEligibility/);
  assert.match(dashboard, /hasUnresolvedFallbackRows = Number\(summary\.unresolvedTotal \|\| 0\) > 0/);
  assert.match(dashboard, /canRepairUnresolved = hasUnresolvedFallbackRows/);
  assert.match(dashboard, /hasApprovedApplicableRules === false/);
  assert.match(dashboard, /Accountant-approved GL rules must be activated before preparation can improve them/);
});

test("active classification run disables Prepare and terminal fallback-only run does not permanently disable repair", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /if \(hasActiveRun\) return disabled\("Deductions preparation is already running\."\)/);
  assert.match(dashboard, /const enabled = canPrepareInitial \|\| canRepairUnresolved \|\| canRetry/);
  assert.doesNotMatch(dashboard, /completed_with_review[\s\S]{0,80}hasActiveRun/);
});

test("manual Refresh bypasses cached read-only tax resources and exposes result state", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const hook = fs.readFileSync("src/hooks/tax/useTaxDeductions.js", "utf8");
  const client = fs.readFileSync("src/services/tax/taxApiClient.js", "utf8");
  assert.match(dashboard, /const refreshDeductions = deductions\.refresh/);
  assert.match(dashboard, /onClick=\{refreshDeductions\}/);
  assert.match(dashboard, /deductions\.refreshing \? "Refreshing" : "Refresh"/);
  assert.match(dashboard, /deductions\.refreshError/);
  assert.match(dashboard, /Updated \{formatRelativeRefreshTime\(deductions\.lastRefreshedAt\)\}/);
  assert.match(hook, /load\(\{ \.\.\.options, refresh: true \}\)/);
  assert.match(hook, /setLastRefreshedAt\(new Date\(\)\.toISOString\(\)\)/);
  assert.match(client, /getTaxClassificationCoverage\(\{ businessId, year, refresh = false, signal \}/);
  assert.match(client, /bypassCache: refresh/);
  assert.doesNotMatch(hook, /refresh:[\s\S]{0,240}prepareTaxClassifications/);
});

test("tax deductions overview prefetch is read-only and mounted after business context resolves", () => {
  const prefetchHook = fs.readFileSync("src/hooks/tax/useTaxDeductionsPrefetch.js", "utf8");
  const apiClient = fs.readFileSync("src/services/tax/taxApiClient.js", "utf8");
  const main = fs.readFileSync("src/main.jsx", "utf8");

  assert.match(prefetchHook, /prefetchTaxDeductionsOverviewBundle\(\{ businessId, year \}\)/);
  assert.match(prefetchHook, /if \(!enabled \|\| loading \|\| !businessId/);
  assert.match(prefetchHook, /requestIdleCallback/);
  assert.match(prefetchHook, /setTimeout\(callback, 0\)/);
  assert.match(main, /<DashboardTaxPrefetcher \/>/);
  assert.match(main, /<BusinessProvider>[\s\S]*<DashboardTaxPrefetcher \/>[\s\S]*<FullDashboardLayout \/>/);

  const bundleBody = apiClient.match(/export async function prefetchTaxDeductionsOverviewBundle[\s\S]*?\n}\n\nexport async function prefetchTaxDeductionTransactionPages/)?.[0] || "";
  assert.match(bundleBody, /getTaxDeductionsOverview/);
  assert.match(bundleBody, /prefetchTaxDeductionTransactionPages/);
  assert.match(bundleBody, /getTaxClassificationCoverage/);
  assert.match(bundleBody, /getTaxClassificationReviewSummary/);
  assert.doesNotMatch(bundleBody, /prepareTaxClassifications|runTaxClassification|runTaxCalculation|QuickBooks|Plaid|POST|PATCH|DELETE/);
});

test("tax API cache dedupes in-flight overview requests between prefetch and route load", () => {
  const apiClient = fs.readFileSync("src/services/tax/taxApiClient.js", "utf8");
  const cachedGet = apiClient.match(/async function cachedGet[\s\S]*?\n}\n\nfunction getCachedValue/)?.[0] || "";
  assert.match(cachedGet, /if \(inflight\.has\(cacheKey\)\) return inflight\.get\(cacheKey\)/);
  assert.match(cachedGet, /inflight\.set\(cacheKey, promise\)/);
  assert.doesNotMatch(cachedGet, /if \(!signal && inflight\.has/);
  assert.match(apiClient, /function taxDeductionsOverviewPath/);
  assert.match(apiClient, /cacheKey: key\("deductionsOverview", params\)/);
});

test("deductions hook stages cold loading and keeps cached data visible during refresh", () => {
  const hook = fs.readFileSync("src/hooks/tax/useTaxDeductions.js", "utf8");
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");

  const primaryLoad = hook.match(/const \[overviewResult, allTransactionsResult, coverageResult, reviewSummaryResult\][\s\S]*?Promise\.allSettled\(\[[\s\S]*?\]\);/)?.[0] || "";
  assert.match(primaryLoad, /getTaxDeductionsOverview/);
  assert.match(primaryLoad, /fetchAllDeductionTransactions/);
  assert.match(primaryLoad, /getTaxClassificationCoverage/);
  assert.match(primaryLoad, /getTaxClassificationReviewSummary/);
  assert.doesNotMatch(primaryLoad, /fetchAllPostedTransactions|getTaxClassifications|getTaxDeductionTransactionDetail/);

  assert.match(hook, /const loadSecondaryDetails = useCallback/);
  assert.match(hook, /fetchAllPostedTransactions/);
  assert.match(hook, /getTaxClassifications/);
  assert.match(hook, /getCachedTaxDeductionsOverview\(\{ businessId, year, asOfDate, allowStale: true \}\)/);
  assert.match(dashboard, /const initialDeductionsLoading = deductions\.loading && !workspaceRows\.length/);
  assert.match(dashboard, /disabled=\{deductions\.refreshing \|\| !hasUsableDeductionsData\}/);
});

test("terminal classification polling refreshes all Deductions resources without using stale cache", () => {
  const hook = fs.readFileSync("src/hooks/tax/useTaxDeductions.js", "utf8");
  assert.match(hook, /if \(isTerminalJobStatus\(status\?\.status\)\) \{\s*await load\(\{ refresh: true \}\);\s*await loadSecondaryDetails\(\{ refresh: true \}\);\s*return;\s*\}/);
});

test("meaningful proposed-category needs review rows render proposed category and source while unresolved fallback stays pending-style", () => {
  const proposed = mapDeductionTransactionRow({
    transactionId: "txn-meal",
    date: "2026-09-03",
    merchantName: "Restaurant",
    qboAccountName: "Meals",
    signedAmount: -53,
    absoluteAmount: 53,
    taxCategory: "meals",
    deductibilityStatus: "partially_deductible",
    deductiblePercent: 50,
    deductibleAmount: 26.5,
    classificationStatus: "needs_review",
    requiresReview: true,
    rule: { ruleCode: "meals_gl_review" },
  });
  const unresolved = mapDeductionTransactionRow({
    transactionId: "txn-review",
    taxCategory: "unclassified",
    deductibilityStatus: "needs_review",
    deductiblePercent: 0,
    classificationStatus: "needs_review",
    requiresReview: true,
  });

  assert.equal(proposed.taxCategoryLabel, "Meals");
  assert.equal(proposed.taxTreatmentLabel, "Partially deductible");
  assert.equal(proposed.requiresReview, true);
  assert.equal(unresolved.taxCategoryLabel, "Unresolved");
  assert.equal(unresolved.taxTreatmentLabel, "Not determined");
  assert.equal(unresolved.statusLabel, "Needs classification");
});

test("migration seed is dashboard-runner compatible and uses explicit PostgreSQL casts", () => {
  const migration = fs.readFileSync("supabase/migrations/20260929_tax_classification_automatic_first_gl_rules.sql", "utf8");
  assert.match(migration, /^do \$\$/);
  assert.doesNotMatch(migration, /^begin;/m);
  assert.doesNotMatch(migration, /^commit;/m);
  assert.match(migration, /business_id::uuid as business_id/);
  assert.match(migration, /tax_year::integer as tax_year/);
  assert.match(migration, /priority::integer as priority/);
  assert.match(migration, /match_conditions::jsonb as match_conditions/);
  assert.match(migration, /treatment::jsonb as treatment/);
  assert.match(migration, /default_deductible_percent::numeric as default_deductible_percent/);
  assert.match(migration, /requires_review::boolean as requires_review/);
  assert.match(migration, /is_active::boolean as is_active/);
  assert.match(migration, /verified_at::timestamptz as verified_at/);
  assert.match(migration, /effective_from::date as effective_from/);
  assert.match(migration, /effective_to::date as effective_to/);
});

test("standalone deductions workspace page has been removed", () => {
  assert.equal(fs.existsSync("src/pages/Tax/DeductionsPage.jsx"), false);
  assert.equal(fs.existsSync("src/components/Tax/Deductions/DeductionsWorkspace.jsx"), false);
});

test("main route redirects legacy deductions workspace path to tax overview", () => {
  const main = fs.readFileSync("src/main.jsx", "utf8");
  assert.doesNotMatch(main, /import DeductionsPage/);
  assert.match(main, /path="tax\/deductions" element={<Navigate to="\/dashboard\/tax" replace \/>}/);
});

test("Tax Dashboard preview uses tax deductions hook and authenticated client without workspace navigation", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const hook = fs.readFileSync("src/hooks/tax/useTaxDeductions.js", "utf8");
  const client = fs.readFileSync("src/services/tax/taxApiClient.js", "utf8");
  assert.match(dashboard, /useTaxDeductions/);
  assert.doesNotMatch(dashboard, /Open workspace/);
  assert.doesNotMatch(dashboard, /navigate\("\/dashboard\/tax\/deductions"\)/);
  assert.match(hook, /getTaxDeductionTransactions/);
  assert.match(hook, /limit: parsedPagination\.limit/);
  assert.match(hook, /offset: parsedPagination\.offset/);
  assert.match(client, /exportTaxDeductions\(\{ businessId, year, asOfDate, format = "summary_csv", filters = \{\}/);
});

test("Tax Dashboard no longer embeds the legacy deductions matrix", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.doesNotMatch(dashboard, /useDeductionsMatrix|DeductionsMatrix|DeductionsHeaderKpis/);
  assert.match(dashboard, /useTaxDeductions/);
  assert.doesNotMatch(dashboard, /Open workspace/);
});

test("Tax Dashboard embeds classification workspace controls in Deductions", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const hook = fs.readFileSync("src/hooks/tax/useTaxDeductions.js", "utf8");
  assert.match(dashboard, /Classification status/);
  assert.match(dashboard, /Prepare deductions/);
  assert.match(dashboard, /Auto-classified/);
  assert.match(dashboard, /Needs review/);
  assert.match(dashboard, /Unclassified/);
  assert.match(dashboard, /Estimated payment amount pending/);
  assert.match(hook, /getTaxClassificationCoverage/);
  assert.match(hook, /previewClassificationBackfill/);
  assert.match(hook, /prepareDeductions/);
});

test("Tax Dashboard uses hydrated posted transactions and keeps matrix layout separate from classification filters", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /deductions\.allTransactions\?\.rows \|\| deductions\.transactions\?\.rows \|\| deductions\.classificationRows\?\.rows/);
  assert.match(dashboard, /const \[workspaceView, setWorkspaceView\] = useState\("overview"\)/);
  assert.match(dashboard, /buildDeductionAccountMatrix\(workspaceRows, year, \{ isDemo: deductions\.isDemo, scope: "overview" \}\)/);
  assert.doesNotMatch(dashboard, /const rows = classificationTab === "all" \? workspaceRows : filteredWorkspaceRows/);
  assert.doesNotMatch(dashboard, /buildDeductionAccountMatrix\(rows, year, \{ isDemo: deductions\.isDemo, scope: classificationTab \}\)/);
  assert.match(dashboard, /QBO GL account/);
  assert.match(dashboard, /authoritativeDeductibleTotal/);
  assert.match(dashboard, /proposedDeductibleTotal/);
  assert.match(dashboard, /Proposed — needs review/);
  assert.doesNotMatch(dashboard, /cell\.deductibleTotal/);
});

test("Tax Dashboard renders matrix-first Deductions workspace views with separate authority totals", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /Deductions overview/);
  assert.match(dashboard, /Needs attention/);
  assert.match(dashboard, /All transactions/);
  assert.match(dashboard, /workspaceView === "overview"/);
  assert.match(dashboard, /workspaceView === "needs_attention"/);
  assert.match(dashboard, /MatrixAuthoritySummary/);
  assert.match(dashboard, /DeductionAccountMatrix/);
  assert.match(dashboard, /Confirmed deductions/);
  assert.match(dashboard, /Bizzi-classified/);
  assert.match(dashboard, /confirmed by you/);
  assert.match(dashboard, /Proposed — needs review/);
  assert.match(dashboard, /posted expense rows grouped by QBO GL account/);
});

test("Tax Dashboard matrix drilldown scopes cells by GL account, month, and authority", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /function MatrixCell/);
  assert.match(dashboard, /openCell\(cell\.authoritativeDeductibleTotal > 0 \? "confirmed" : "resolved_zero"\)/);
  assert.match(dashboard, /openCell\("proposed"\)/);
  assert.match(dashboard, /"confirmed" : "resolved_zero"/);
  assert.match(dashboard, /openCell\("standard_mileage"\)/);
  assert.match(dashboard, /selectedAuthority: authority/);
  assert.match(dashboard, /const isReviewDetail = transactions\.some/);
  assert.match(dashboard, /isAuthoritativeDeductionBucket\(classificationBucket\(row\)\)/);
  assert.match(dashboard, /classificationBucket\(row\) === "needs_review" \|\| classificationBucket\(row\) === "unclassified"/);
  assert.match(dashboard, /cell\.authoritativeDeductibleTotal > 0 \|\| cell\.resolvedZeroTransactionCount > 0/);
  assert.doesNotMatch(dashboard, /const hasRenderableState = cell\.authoritativeDeductibleTotal > 0/);
  assert.doesNotMatch(dashboard, /cell\.autoTransactionCount > 0/);
  assert.match(dashboard, /return <span className="block px-2 py-1\.5 text-\[12px\] text-white\/22">—<\/span>/);
});

test("Deduction matrix keeps user-confirmed May Meals in the May confirmed cell", async () => {
  const { buildDeductionAccountMatrix } = await loadTaxDashboardInternals();
  const base = {
    date: "2026-05-27",
    vendor: "Publix",
    qboAccountId: "qbo-meals",
    qboAccountName: "Meals",
    amount: 346,
    signedAmount: -346,
    direction: "OUTFLOW",
    taxCategory: "business_meals",
    taxCategoryLabel: "Business Meals",
    taxTreatment: "partially_deductible",
    taxTreatmentLabel: "Partially deductible",
    deductiblePercent: 50,
    deductibleAmount: 173,
    classificationSource: "rule_engine",
    matchedRuleCode: "business_meals_review_gl_v3",
    ruleVersion: "bizzi-gl-2026-v3",
    requiresReview: true,
    raw: { transactionId: "meal-may-1" },
  };
  const proposedMatrix = buildDeductionAccountMatrix([{ ...base, id: "meal-may-1", status: "needs_review", statusLabel: "Needs review" }], 2026, { scope: "overview" });
  const proposedMay = proposedMatrix.accounts[0].months["2026-05"];
  assert.equal(proposedMay.authoritativeDeductibleTotal, 0);
  assert.equal(proposedMay.proposedDeductibleTotal, 173);
  assert.equal(proposedMay.reviewTransactionCount, 1);

  const confirmedMatrix = buildDeductionAccountMatrix([{ ...base, id: "meal-may-1", status: "user_confirmed", statusLabel: "Confirmed by you", requiresReview: false }], 2026, { scope: "overview" });
  const meals = confirmedMatrix.accounts[0];
  const confirmedMay = meals.months["2026-05"];
  assert.equal(confirmedMay.authoritativeDeductibleTotal, 173);
  assert.equal(confirmedMay.proposedDeductibleTotal, 0);
  assert.equal(confirmedMay.autoTransactionCount, 0);
  assert.equal(confirmedMay.userConfirmedTransactionCount, 1);
  assert.equal(meals.authoritativeDeductibleTotal, 173);
  assert.equal(meals.proposedDeductibleTotal, 0);
  assert.equal(meals.userConfirmedTransactionCount, 1);
  assert.equal(meals.months["2026-06"].authoritativeDeductibleTotal, 0);
});

test("Deduction matrix renders mixed confirmed and proposed monthly authority separately", async () => {
  const { buildDeductionAccountMatrix } = await loadTaxDashboardInternals();
  const rows = [{
    id: "meal-confirmed",
    date: "2026-05-10",
    vendor: "Confirmed Meal",
    qboAccountId: "qbo-meals",
    qboAccountName: "Meals",
    amount: 346,
    signedAmount: -346,
    direction: "OUTFLOW",
    taxCategory: "business_meals",
    taxCategoryLabel: "Business Meals",
    deductiblePercent: 50,
    deductibleAmount: 173,
    status: "user_confirmed",
    statusLabel: "Confirmed by you",
    requiresReview: false,
    raw: { transactionId: "meal-confirmed" },
  }, {
    id: "meal-proposed",
    date: "2026-05-12",
    vendor: "Proposed Meal",
    qboAccountId: "qbo-meals",
    qboAccountName: "Meals",
    amount: 48,
    signedAmount: -48,
    direction: "OUTFLOW",
    taxCategory: "business_meals",
    taxCategoryLabel: "Business Meals",
    deductiblePercent: 50,
    deductibleAmount: 24,
    status: "needs_review",
    statusLabel: "Needs review",
    requiresReview: true,
    raw: { transactionId: "meal-proposed" },
  }];
  const matrix = buildDeductionAccountMatrix(rows, 2026, { scope: "overview" });
  const may = matrix.accounts[0].months["2026-05"];
  assert.equal(may.authoritativeDeductibleTotal, 173);
  assert.equal(may.proposedDeductibleTotal, 24);
  assert.equal(may.userConfirmedTransactionCount, 1);
  assert.equal(may.reviewTransactionCount, 1);
  assert.equal(may.transactions.length, 2);
  assert.equal(matrix.accounts[0].authoritativeDeductibleTotal, 173);
  assert.equal(matrix.accounts[0].proposedDeductibleTotal, 24);
});

test("Tax Dashboard derives modal aggregate status from selected cell rows", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /function aggregateClassificationStatus\(rows = \[\]\)/);
  assert.match(dashboard, /const aggregateStatus = useMemo\(\(\) => aggregateClassificationStatus\(transactions\), \[transactions\]\)/);
  assert.match(dashboard, /buckets\.length > 1[\s\S]{0,100}label: "Mixed"/);
  assert.match(dashboard, /bucket === "needs_review"[\s\S]{0,100}label: "Needs review"/);
  assert.match(dashboard, /<DetailPill tone=\{aggregateStatus\.tone\}>/);
  assert.doesNotMatch(dashboard, /cell\.selectedAuthority === "proposed" \? "Needs review" : "Auto-classified"/);
});

test("Tax Dashboard row semantics distinguish auto-classified and review-required treatment", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.doesNotMatch(dashboard, /Treatment pending/);
  assert.match(dashboard, /Fully deductible/);
  assert.match(dashboard, /% deductible/);
  assert.match(dashboard, /QBO GL rule/);
  assert.match(dashboard, /Depends on business use/);
  assert.match(dashboard, /Review required/);
});

test("Tax Dashboard uses a deductions loading skeleton and keeps disabled Prepare reason in the button tooltip", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /function DeductionsLoadingState/);
  assert.match(dashboard, /function LoadingEllipsis/);
  assert.match(dashboard, /Loading posted QuickBooks transactions, GL mappings, and classification status/);
  assert.match(dashboard, /animate-dot-bounce/);
  assert.match(dashboard, /initialDeductionsLoading \? \(/);
  assert.match(dashboard, /role="status" aria-busy="true" aria-live="polite"/);
  assert.match(dashboard, /title=\{!canPrepareDeductions \? prepareEligibility\.reason : undefined\}/);
  assert.doesNotMatch(dashboard, /!\s*canPrepareDeductions && prepareEligibility\.reason \? \(/);
});

test("Tax Dashboard counts meaningful needs-review coverage and labels QBO GL rule sources", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /coverage\.needsReviewCount/);
  assert.match(dashboard, /coverage\.needs_review_count/);
  assert.match(dashboard, /source === "rule_engine" \|\| hasRuleIdentity/);
  assert.match(dashboard, /QBO GL rule/);
});

test("Tax Dashboard uses authoritative classification job progress instead of inferred processing", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const hook = fs.readFileSync("src/hooks/tax/useTaxDeductions.js", "utf8");
  const client = fs.readFileSync("src/services/tax/taxApiClient.js", "utf8");
  assert.match(client, /getTaxClassificationStatus/);
  assert.match(hook, /classificationJobStatus/);
  assert.match(hook, /getTaxClassificationStatus\(\{ businessId, year \}\)/);
  assert.match(hook, /pollInFlight/);
  assert.doesNotMatch(hook, /setInterval\(\(\) => \{\s*load\(\)/);
  assert.match(dashboard, /ClassificationProgressSummary/);
  assert.match(dashboard, /Deductions preparation is queued\./);
  assert.match(dashboard, /Deductions preparation is delayed\./);
  assert.match(dashboard, /Deductions preparation appears to be stalled\./);
  assert.match(dashboard, /Bizzi is classifying your transactions\./);
  assert.match(dashboard, /Deductions preparation appears to be delayed\./);
  assert.match(dashboard, /Updating \$\{total === 1 \? "one changed transaction"/);
  assert.match(dashboard, /The full deductions matrix stays visible while Bizzi refreshes the changed row/);
  assert.match(dashboard, /Run processed/);
  assert.match(dashboard, /label="Processing"/);
  assert.match(dashboard, /bizzi-progress-fill/);
  assert.match(dashboard, /aria-live="polite"/);
});

test("Tax Dashboard does not let processed job count masquerade as classified count", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /processedTotal: jobProcessed/);
  assert.doesNotMatch(dashboard, /classifiedTotal: jobProcessed/);
  assert.match(dashboard, /bucketClassified/);
  assert.doesNotMatch(dashboard, /activeJob && jobNeedsReview/);
  assert.doesNotMatch(dashboard, /activeJob && jobAutoClassified/);
  assert.doesNotMatch(dashboard, /activeJob && jobFailed/);
});

test("Prepare deductions accepts quickly and refreshes via polling, not a blocking full reload", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const hook = fs.readFileSync("src/hooks/tax/useTaxDeductions.js", "utf8");
  assert.doesNotMatch(hook, /const result = await prepareTaxClassifications[\s\S]{0,120}await load\(\)/);
  assert.match(hook, /setClassificationJobStatus\(job \|\| null\)/);
  assert.match(dashboard, /Deductions preparation started\./);
  assert.match(dashboard, /Starting deductions preparation\.\.\./);
  assert.match(dashboard, /setTrackedPrepareRun/);
  assert.match(dashboard, /String\(job\.jobId\) !== trackedPrepareRun\.jobId/);
  assert.match(dashboard, /setPrepareCompletionNotice\("Deductions preparation complete\."\)/);
  assert.match(dashboard, /Preparing deductions from your request\./);
  assert.match(dashboard, /Dismiss/);
  assert.doesNotMatch(dashboard, /onNotice\?\.\("Deductions preparation complete\."\)/);
  assert.doesNotMatch(dashboard, /lastTerminalJobRef/);
  assert.doesNotMatch(dashboard, /dispatchBizziToast/);
  assert.doesNotMatch(dashboard, /bizzy:toast/);
});

test("Prepare completion banner is scoped to the current mounted user run only", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /const \[trackedPrepareRun, setTrackedPrepareRun\] = useState\(null\)/);
  assert.match(dashboard, /const \[prepareCompletionNotice, setPrepareCompletionNotice\] = useState\(""\)/);
  assert.match(dashboard, /const runId = job\?\.jobId \|\| job\?\.id \|\| job\?\.runId \|\| job\?\.run_id/);
  assert.match(dashboard, /if \(!trackedPrepareRun\?\.jobId \|\| !job\?\.jobId\) return/);
  assert.match(dashboard, /setTrackedPrepareRun\(null\)/);
  assert.match(dashboard, /completionNoticeTimerRef/);
  assert.doesNotMatch(dashboard, /localStorage\.setItem\([^)]*trackedPrepareRun/);
});

test("Prepare deductions modal uses Bizzi loading treatment instead of native wait cursor", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /Loader2/);
  assert.match(dashboard, /aria-busy=\{loading \? "true" : "false"\}/);
  assert.match(dashboard, /<Loader2 className="h-3\.5 w-3\.5 animate-spin" aria-hidden="true" \/>/);
  assert.match(dashboard, /disabled:cursor-default disabled:opacity-70/);
  assert.doesNotMatch(
    dashboard,
    /Starting deductions preparation[\s\S]{0,500}disabled:cursor-wait|disabled:cursor-wait[\s\S]{0,500}Starting deductions preparation/
  );
});

test("Tax Dashboard does not present missing classification authority as zero deductible", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /No deduction total is shown until classification authority exists/);
  assert.match(dashboard, /\$0 deductible/);
  assert.match(dashboard, /classificationBucket\(row\) === "unclassified"/);
});

test("Tax Dashboard groups Needs Attention decisions by QBO GL account and missing action", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /function buildAttentionReviewGroups/);
  assert.match(dashboard, /const key = `\$\{qboAccountId\}:\$\{decision\.kind\}`/);
  assert.match(dashboard, /Apply to one transaction/);
  assert.match(dashboard, /Apply to GL account this year/);
  assert.match(dashboard, /Apply going forward/);
  assert.match(dashboard, /Going-forward business-use confirmations require a schema-backed account-level authority record/);
  assert.match(dashboard, /Preserve selected exceptions/);
  assert.match(dashboard, /ids\.slice\(index, index \+ 100\)/);
});

test("Tax Dashboard displays specific missing tax-review actions instead of generic zero-dollar conclusions", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /Set business use %/);
  assert.match(dashboard, /Confirm business use/);
  assert.match(dashboard, /Set vehicle method/);
  assert.match(dashboard, /Vehicle expenses need a vehicle-method workflow before they can become authoritative/);
  assert.match(dashboard, /reviewDecisionForRow\(row\)\.actionLabel/);
  assert.match(dashboard, /cell\.proposedDeductibleTotal > 0 \? `\$\{formatCurrencyLocal\(cell\.proposedDeductibleTotal\)\} proposed` : cell\.reviewActionLabel/);
});

test("Tax Dashboard recomputes review-required proposed amounts from percent instead of trusting gross stored totals", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /classificationBucket\(row\) === "needs_review"[\s\S]{0,220}Math\.abs\(normalizeMoney\(row\.amount\)\) \* \(percent \/ 100\)/);
  assert.match(dashboard, /function roundCurrency/);
  assert.doesNotMatch(dashboard, /const proposedAmount = bucket === "needs_review" \? row\.deductibleAmount/);
});

test("Tax Dashboard review decisions reuse existing override authority and avoid going-forward persistence", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const hook = fs.readFileSync("src/hooks/tax/useTaxDeductions.js", "utf8");
  const service = fs.readFileSync("src/services/tax/taxClassificationOverride.service.js", "utf8");
  assert.match(dashboard, /deductions\.overrideClassification/);
  assert.match(dashboard, /deductions\.bulkUpdateClassifications/);
  assert.match(dashboard, /This confirmation affects only the selected current classifications and writes through the existing override audit mechanism/);
  assert.match(dashboard, /hasManualClassificationAuthority\(row\)/);
  assert.match(dashboard, /status === "user_confirmed"/);
  assert.match(dashboard, /status === "cpa_confirmed"/);
  assert.match(dashboard, /status === "accountant_reviewed"/);
  assert.match(hook, /bulkUpdateTaxClassifications/);
  assert.match(service, /apply_tax_classification_override/);
  assert.match(service, /tax_classification_overrides/);
});

test("Deduction detail modal uses polished animated dialog accessibility", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const css = fs.readFileSync("src/index.css", "utf8");
  assert.match(dashboard, /import \{ AnimatePresence, motion as Motion, useReducedMotion \} from "framer-motion"/);
  assert.match(dashboard, /role="dialog"/);
  assert.match(dashboard, /aria-modal="true"/);
  assert.match(dashboard, /aria-labelledby="deduction-detail-title"/);
  assert.match(dashboard, /aria-describedby="deduction-detail-description"/);
  assert.match(dashboard, /event\.key === "Escape"/);
  assert.match(dashboard, /getFocusableElements/);
  assert.match(dashboard, /document\.body\.style\.overflow = "hidden"/);
  assert.match(dashboard, /previousFocusRef\.current\?\.focus/);
  assert.match(dashboard, /scale: 0\.98/);
  assert.match(dashboard, /y: 10/);
  assert.match(dashboard, /data-bizzy-tax-deduction-dialog/);
  assert.match(dashboard, /z-\[200000\]/);
  assert.match(dashboard, /max-h-\[calc\(100dvh-32px\)\]/);
  assert.match(dashboard, /min-h-0 flex-1 overflow-y-auto/);
  assert.match(css, /\[data-bizzy-tax-deduction-dialog\]\.bizzy-modal-main-backdrop/);
  assert.match(css, /left: 0 !important/);
  assert.match(css, /width: 100vw/);
});

test("Deduction detail modal explains proposed treatment and avoids automatic copy for review cells", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /Total expenses/);
  assert.match(dashboard, /Confirmed deductions/);
  assert.match(dashboard, /Estimated deductions/);
  assert.match(dashboard, /Estimated deductions are based on Bizzi's proposed treatment and are not added to confirmed deductions until you review them/);
  assert.match(dashboard, /Not calculated/);
  assert.doesNotMatch(dashboard, /cell\.selectedAuthority === "proposed" \? "Proposed needs-review amounts" : "Automatic deductions"/);
  assert.doesNotMatch(dashboard, /Why this needs review/);
  assert.match(dashboard, /Bizzi categorized these transactions using their posted QuickBooks GL account and an active verified deduction rule/);
  assert.match(dashboard, /No additional information is currently required/);
  assert.doesNotMatch(dashboard, /QuickBooks categorized/);
  assert.doesNotMatch(dashboard, /Sourced from posted QuickBooks/);
  assert.doesNotMatch(dashboard, /This row already has confirmed rule-engine treatment/);
});

test("Deduction detail modal renders specific review explanations and resolution workflows", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /Bizzi categorized these transactions as Business Meals based on their posted QuickBooks GL account/);
  assert.match(dashboard, /Bizzi categorized these transactions as Utilities based on their posted QuickBooks GL account/);
  assert.match(dashboard, /Tell us how much of this account is used for business so Bizzi can calculate the deductible amount/);
  assert.match(dashboard, /Bizzi categorized these transactions as Business Transportation based on their posted QuickBooks GL account/);
  assert.match(dashboard, /Bizzi categorized these transactions as Vehicle Expenses based on their posted QuickBooks GL account/);
  assert.match(dashboard, /Choose your vehicle deduction method before Bizzi calculates the deductible amount/);
  assert.match(dashboard, /Bizzi categorized these transactions as Supplies based on their posted QuickBooks GL account/);
  assert.match(dashboard, /Review needed/);
  assert.match(dashboard, /selected · \{formatCurrencyLocal\(selectedGrossTotal\)\} in expenses/);
  assert.doesNotMatch(dashboard, /id="deduction-review-scope-select"/);
  assert.doesNotMatch(dashboard, /All matching QBO GL transactions for \{taxYear\}/);
  assert.doesNotMatch(dashboard, /This GL account going forward/);
  assert.doesNotMatch(dashboard, /Requires a schema-backed account-level authority record before it can be saved/);
});

test("Deduction detail modal validates business-use and vehicle method resolution", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /function parseBusinessUsePercent/);
  assert.match(dashboard, /number < 0 \|\| number > 100/);
  assert.match(dashboard, /vehicleMethod === "standard_mileage"/);
  assert.match(dashboard, /Gas not deducted separately/);
  assert.match(dashboard, /vehicleMethod === "actual_expense"/);
  assert.match(dashboard, /vehicle_actual_expense_business_use/);
  assert.match(dashboard, /vehicleMethod === "unsure"/);
  assert.match(dashboard, /Stays in review/);
  assert.match(dashboard, /Gas not deducted separately/);
  assert.match(dashboard, /computeClassificationAmounts/);
  assert.match(dashboard, /deductiblePercent: Number\(percent\)/);
});

test("Deduction detail modal exposes concrete utility and business-purpose controls", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /How much of this account is used for business/);
  assert.match(dashboard, /100% business/);
  assert.match(dashboard, /Mixed business and personal use/);
  assert.match(dashboard, /Personal - 0%/);
  assert.match(dashboard, /Business-use percentage input/);
  assert.match(dashboard, /Save and confirm/);
  assert.match(dashboard, /Not sure yet/);
  assert.match(dashboard, /How do you deduct vehicle expenses/);
  assert.match(dashboard, /Standard mileage/);
  assert.match(dashboard, /Actual vehicle expenses/);
  assert.match(dashboard, /Save vehicle method/);
  assert.match(dashboard, /Confirm selected as business meals/);
  assert.match(dashboard, /Mark selected as personal meals/);
  assert.match(dashboard, /Confirm selected as business trips/);
  assert.match(dashboard, /Mark selected as personal or commuting/);
  assert.match(dashboard, /Uncheck personal or undocumented exceptions so they stay in Needs review/);
});

test("Deduction detail business-use input keeps stable focus and string draft semantics", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /const selectionFocusKey =/);
  assert.match(dashboard, /lastReviewResetKeyRef/);
  assert.match(dashboard, /if \(lastReviewResetKeyRef\.current === reviewResetKey\) return/);
  assert.doesNotMatch(dashboard, /}, \[selection, onClose\]\)/);
  assert.match(dashboard, /}, \[hasSelection, selectionFocusKey, onClose\]\)/);
  assert.doesNotMatch(dashboard, /window\.setTimeout\(\(\) => closeButtonRef\.current\?\.focus/);
  assert.match(dashboard, /requestAnimationFrameSafe\(\(\) => resolutionPanelRef\.current\?\.focus/);
  assert.ok(dashboard.includes("closeButtonRef.current?.focus?.({ preventScroll: true });"));
  assert.match(dashboard, /type="text"/);
  assert.match(dashboard, /inputMode="decimal"/);
  assert.match(dashboard, /autoComplete="off"/);
  assert.ok(dashboard.includes('next === "" || /^(?:\\d{0,3}|\\d{1,3}\\.\\d{0,2})$/.test(next)'));
  assert.match(dashboard, /if \(event\.key === "Enter"\) event\.preventDefault\(\)/);
  assert.match(dashboard, /event\.stopPropagation\(\)/);
  assert.doesNotMatch(dashboard, /event\.target\.value\.trim\(\)/);
  assert.match(dashboard, /if \(value === "" \|\| value == null\) return null/);
});

test("Deduction detail modal actually renders Electric business-use controls in the modal path", async () => {
  const { DeductionMonthDetailModal } = await loadTaxDashboardInternals();
  const html = renderToStaticMarkup(React.createElement(DeductionMonthDetailModal, {
    selection: makeReviewSelection({
      accountName: "Electric",
      taxCategory: "utilities",
      monthKey: "2026-05",
      longLabel: "May 2026",
      deductiblePercent: 0,
      amount: 120,
    }),
    onClose: () => {},
    onOverrideClassification: async () => ({}),
    onBulkUpdateClassifications: async () => ({}),
    onRefresh: async () => {},
  }));

  assert.match(html, /Review needed/);
  assert.match(html, /Set business use/);
  assert.match(html, /How much of this account is used for business/);
  assert.match(html, /100% business/);
  assert.match(html, /Mixed business and personal use/);
  assert.match(html, /Personal - 0%/);
  assert.match(html, /selected/);
  assert.match(html, /in expenses/);
  assert.doesNotMatch(html, /Apply to/);
  assert.doesNotMatch(html, /All matching QBO GL transactions for 2026/);
  assert.match(html, /Save and confirm/);
  assert.match(html, /Not sure yet/);
  assert.match(html, /Bizzi categorized these transactions as Utilities based on their posted QuickBooks GL account/);
  assert.match(html, /Tell us how much of this account is used for business so Bizzi can calculate the deductible amount/);
  assert.doesNotMatch(html, /calculated the confirmed deduction/);
  assert.doesNotMatch(html, /QuickBooks categorized/);
  assert.doesNotMatch(html, /Why this needs review/);
  assert.doesNotMatch(html, /This GL account going forward/);
});

test("Deduction detail modal actually renders Gas vehicle controls in the modal path", async () => {
  const { DeductionMonthDetailModal } = await loadTaxDashboardInternals();
  const html = renderToStaticMarkup(React.createElement(DeductionMonthDetailModal, {
    selection: makeReviewSelection({
      accountName: "Gas",
      taxCategory: "vehicle_expense",
      monthKey: "2026-06",
      longLabel: "June 2026",
      deductiblePercent: 0,
      amount: 80,
    }),
    onClose: () => {},
    onSetTaxProfileMemory: async () => ({}),
    onOverrideClassification: async () => ({}),
    onBulkUpdateClassifications: async () => ({}),
    onRefresh: async () => {},
  }));

  assert.match(html, /Review needed/);
  assert.match(html, /Choose vehicle deduction method/);
  assert.match(html, /How do you deduct vehicle expenses/);
  assert.match(html, /Standard mileage/);
  assert.match(html, /Actual vehicle expenses/);
  assert.match(html, /I(?:&#x27;|')m not sure/);
  assert.match(html, /Save vehicle method/);
  assert.match(html, /Bizzi categorized these transactions as Vehicle Expenses based on their posted QuickBooks GL account/);
  assert.match(html, /Choose your vehicle deduction method before Bizzi calculates the deductible amount/);
  assert.doesNotMatch(html, /QuickBooks categorized/);
  assert.doesNotMatch(html, /This row already has confirmed rule-engine treatment/);
});

test("Deduction detail modal renders Supplies as business purchase review without requiring category dropdown", async () => {
  const { DeductionMonthDetailModal } = await loadTaxDashboardInternals();
  const html = renderToStaticMarkup(React.createElement(DeductionMonthDetailModal, {
    selection: makeReviewSelection({
      accountName: "Supplies",
      taxCategory: "supplies",
      monthKey: "2026-08",
      longLabel: "August 2026",
      deductiblePercent: 100,
      amount: 18,
    }),
    onClose: () => {},
    onOverrideClassification: async () => ({}),
    onBulkUpdateClassifications: async () => ({}),
    onRefresh: async () => {},
  }));

  assert.match(html, /Was this purchase for your business/);
  assert.match(html, /Business purchase - 100% deductible/);
  assert.match(html, /Personal purchase - not deductible/);
  assert.match(html, /Change tax category/);
  assert.match(html, /Save purchase decision/);
  assert.doesNotMatch(html, /Confirm category/);
  assert.doesNotMatch(html, /Save supplies treatment/);
});

test("Deduction detail business-use field is a stable decimal text input in the actual modal path", async () => {
  const { DeductionMonthDetailModal } = await loadTaxDashboardInternals();
  const html = renderToStaticMarkup(React.createElement(DeductionMonthDetailModal, {
    selection: makeReviewSelection({
      accountName: "Electric",
      taxCategory: "utilities",
      monthKey: "2026-05",
      longLabel: "May 2026",
      deductiblePercent: 0,
      amount: 120,
    }),
    onClose: () => {},
    onOverrideClassification: async () => ({}),
    onBulkUpdateClassifications: async () => ({}),
    onRefresh: async () => {},
  }));
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");

  assert.match(dashboard, /function BusinessUsePercentInput/);
  assert.match(dashboard, /useRef\(null\)/);
  assert.match(dashboard, /autoFocusOnMount/);
  assert.match(dashboard, /type="text"/);
  assert.match(dashboard, /inputMode="decimal"/);
  assert.match(dashboard, /value=\{value\}/);
  assert.match(dashboard, /next === ""/);
  assert.ok(dashboard.includes("\\d{1,3}\\.\\d{0,2}"));
  const inputSource = dashboard.slice(dashboard.indexOf("function BusinessUsePercentInput"), dashboard.indexOf("function VehicleMethodControls"));
  assert.doesNotMatch(inputSource, /type="number"/);
  assert.match(html, /Mixed business and personal use/);
});

test("standard mileage gas rows remain visible in the matrix without zero-percent gas deduction", async () => {
  const { buildDeductionAccountMatrix } = await loadTaxDashboardInternals();
  const row = {
    id: "gas-1",
    date: "2026-06-15",
    vendor: "Fuel",
    qboAccountId: "gas-qbo",
    qboAccountName: "Gas",
    amount: 42,
    signedAmount: -42,
    direction: "OUTFLOW",
    taxCategory: "vehicle_expense",
    taxCategoryLabel: "Vehicle Expense",
    taxTreatment: "vehicle_standard_mileage_no_separate_gas",
    taxTreatmentLabel: "Covered by standard mileage",
    deductiblePercent: 0,
    deductibleAmount: 0,
    status: "user_confirmed",
    statusLabel: "Confirmed by you",
    requiresReview: false,
  };
  const matrix = buildDeductionAccountMatrix([row], 2026, { scope: "overview" });
  const gas = matrix.accounts.find((account) => account.name === "Gas");
  assert.equal(gas.months["2026-06"].standardMileageTransactionCount, 1);
  assert.equal(gas.months["2026-06"].authoritativeDeductibleTotal, 0);
  assert.equal(gas.months["2026-06"].expenseTotal, 42);
  assert.equal(gas.months["2026-06"].transactions.length, 1);
  assert.equal(gas.authoritativeDeductibleTotal, 0);
});

test("matrix membership comes from source activity, not positive deduction truthiness", async () => {
  const { buildDeductionAccountMatrix } = await loadTaxDashboardInternals();
  const base = {
    qboAccountId: "qbo-supplies",
    qboAccountName: "Supplies",
    signedAmount: -18,
    direction: "OUTFLOW",
    amount: 18,
    taxCategory: "supplies",
    taxCategoryLabel: "Supplies",
    deductibleAmount: 0,
    deductiblePercent: 0,
    requiresReview: false,
  };
  const rows = [{
    ...base,
    id: "personal-supply",
    date: "2026-08-08",
    status: "user_confirmed",
    statusLabel: "Confirmed by you",
    deductibilityStatus: "nondeductible",
    taxTreatment: "personal_purchase",
  }, {
    ...base,
    id: "excluded-supply",
    date: "2026-09-08",
    status: "excluded",
    statusLabel: "Excluded",
    deductibilityStatus: "excluded",
    taxTreatment: "excluded",
  }];

  const matrix = buildDeductionAccountMatrix(rows, 2026, { scope: "overview" });
  const supplies = matrix.accounts.find((account) => account.name === "Supplies");
  assert.ok(supplies);
  assert.equal(supplies.months["2026-08"].expenseTotal, 18);
  assert.equal(supplies.months["2026-08"].resolvedZeroTransactionCount, 1);
  assert.equal(supplies.months["2026-08"].authoritativeDeductibleTotal, 0);
  assert.equal(supplies.months["2026-08"].transactions.length, 1);
  assert.equal(supplies.months["2026-09"].expenseTotal, 18);
  assert.equal(supplies.months["2026-09"].excludedTransactionCount, 1);
  assert.equal(supplies.months["2026-09"].transactions.length, 1);
  assert.equal(supplies.months["2026-10"].transactions.length, 0);
});

test("confirmed, proposed, standard-mileage, and zero cells preserve transaction month and reconcile to YTD", async () => {
  const { buildDeductionAccountMatrix } = await loadTaxDashboardInternals();
  const rows = [{
    id: "confirmed-meal",
    date: "2026-05-10",
    qboAccountId: "qbo-meals",
    qboAccountName: "Meals",
    amount: 40,
    signedAmount: -40,
    direction: "OUTFLOW",
    taxCategory: "business_meals",
    taxCategoryLabel: "Business Meals",
    deductiblePercent: 50,
    deductibleAmount: 20,
    status: "user_confirmed",
    statusLabel: "Confirmed by you",
    requiresReview: false,
  }, {
    id: "proposed-meal",
    date: "2026-05-20",
    qboAccountId: "qbo-meals",
    qboAccountName: "Meals",
    amount: 30,
    signedAmount: -30,
    direction: "OUTFLOW",
    taxCategory: "business_meals",
    taxCategoryLabel: "Business Meals",
    deductiblePercent: 50,
    deductibleAmount: 15,
    status: "needs_review",
    statusLabel: "Needs review",
    requiresReview: true,
  }, {
    id: "gas-standard-mileage",
    date: "2026-06-01",
    qboAccountId: "qbo-gas",
    qboAccountName: "Gas",
    amount: 200,
    signedAmount: -200,
    direction: "OUTFLOW",
    taxCategory: "vehicle_expense",
    taxCategoryLabel: "Vehicle Expense",
    taxTreatment: "vehicle_standard_mileage_no_separate_gas",
    taxTreatmentLabel: "Covered by standard mileage",
    deductiblePercent: 0,
    deductibleAmount: 0,
    status: "user_confirmed",
    statusLabel: "Confirmed by you",
    requiresReview: false,
  }];
  const matrix = buildDeductionAccountMatrix(rows, 2026, { scope: "overview" });
  const meals = matrix.accounts.find((account) => account.name === "Meals");
  const gas = matrix.accounts.find((account) => account.name === "Gas");

  assert.equal(meals.months["2026-05"].authoritativeDeductibleTotal, 20);
  assert.equal(meals.months["2026-05"].proposedDeductibleTotal, 15);
  assert.equal(meals.authoritativeDeductibleTotal, 20);
  assert.equal(meals.proposedDeductibleTotal, 15);
  assert.equal(meals.months["2026-05"].transactions.length, 2);
  assert.equal(meals.months["2026-06"].transactions.length, 0);
  assert.equal(gas.months["2026-06"].expenseTotal, 200);
  assert.equal(gas.months["2026-06"].standardMileageTransactionCount, 1);
  assert.equal(gas.months["2026-06"].authoritativeDeductibleTotal, 0);
  assert.equal(gas.months["2026-06"].transactions.length, 1);
  assert.equal(gas.authoritativeDeductibleTotal, 0);
});

test("standard mileage workflow exposes business-mile entry and avoids gas zero-percent override", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /Business miles/);
  assert.match(dashboard, /Based on mileage records/);
  assert.match(dashboard, /estimated mileage deduction/);
  assert.match(dashboard, /Gas is covered by the standard-mileage method instead of deducted separately/);
  assert.match(dashboard, /taxTreatment: "vehicle_standard_mileage_no_separate_gas"/);
  assert.match(dashboard, /direct_vehicle_expense_deduction: false/);
});

test("vehicle mileage persistence requires a dedicated forward migration", () => {
  const migration = fs.readFileSync("supabase/migrations/20261006_tax_vehicle_mileage_inputs.sql", "utf8");
  assert.match(migration, /create table if not exists public\.tax_vehicle_mileage_inputs/);
  assert.match(migration, /business_miles numeric not null/);
  assert.match(migration, /mileage_basis in \('records', 'estimate'\)/);
  assert.match(migration, /revoke all on table public\.tax_vehicle_mileage_inputs from authenticated/);
  assert.match(migration, /grant all on table public\.tax_vehicle_mileage_inputs to service_role/);
});

test("vehicle mileage helper uses 2026 effective-dated rates", () => {
  assert.equal(calculateVehicleMileageDeduction({ date: "2026-06-30", miles: 100 }).amount, 72.5);
  assert.equal(calculateVehicleMileageDeduction({ date: "2026-07-01", miles: 100 }).amount, 76);
});

test("Deduction detail vehicle workflow stores method facts in tax profile memory", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const hook = fs.readFileSync("src/hooks/tax/useTaxDeductions.js", "utf8");
  assert.match(hook, /setTaxProfileMemory/);
  assert.match(hook, /setProfileMemory/);
  assert.match(dashboard, /onSetTaxProfileMemory/);
  assert.match(dashboard, /memoryKey: "vehicle_deduction_method"/);
  assert.match(dashboard, /value: vehicleMethod === "standard_mileage" \? "standard_mileage" : "actual_expense"/);
  assert.match(dashboard, /memoryKey: "vehicle_business_use_percent"/);
});

test("Deduction detail modal preserves exceptions and refreshes after confirmations", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const routes = fs.readFileSync("src/api/tax/taxClassificationReview.routes.js", "utf8");
  const service = fs.readFileSync("src/services/tax/taxClassificationOverride.service.js", "utf8");
  assert.match(dashboard, /selectedReviewTransactionIds/);
  assert.match(dashboard, /Uncheck personal or undocumented exceptions so they stay in Needs review/);
  assert.match(dashboard, /hasManualClassificationAuthority\(row\)/);
  assert.match(dashboard, /onBulkUpdateClassifications\(transactionIds, changes, \{/);
  assert.match(dashboard, /skipReload: true/);
  assert.match(dashboard, /allowUserConfirmedEdit: editingConfirmation/);
  assert.doesNotMatch(dashboard, /onBulkUpdateClassifications\(chunk, changes, \{ reason \}\)/);
  assert.match(dashboard, /Confirming \$\{selectedCount\}/);
  assert.match(dashboard, /await onRefresh\?\.\(\)/);
  assert.match(dashboard, /User confirmed \$\{count\} deduction review/);
  assert.match(routes, /protectConfirmedAuthority: true/);
  assert.match(service, /confirmed_authority_protected/);
});

test("Deduction detail modal renders edit confirmation summary for user-confirmed rows", async () => {
  const { DeductionMonthDetailModal } = await loadTaxDashboardInternals();
  const selection = makeReviewSelection({
    accountName: "Meals",
    taxCategory: "business_meals",
    monthKey: "2026-05",
    longLabel: "May 2026",
    deductiblePercent: 50,
    amount: 40,
  });
  selection.cell.transactions[0] = {
    ...selection.cell.transactions[0],
    status: "user_confirmed",
    statusLabel: "Confirmed by you",
    requiresReview: false,
    deductibleAmount: 20,
    raw: {
      transactionId: "txn-1",
      override: { lastChangedAt: "2026-09-10T12:00:00Z" },
    },
  };
  selection.cell.authoritativeDeductibleTotal = 20;
  selection.cell.proposedDeductibleTotal = 0;

  const html = renderToStaticMarkup(React.createElement(DeductionMonthDetailModal, {
    selection,
    onClose: () => {},
    onBulkUpdateClassifications: async () => ({}),
    onRefresh: async () => {},
  }));

  assert.match(html, /Confirmed by you/);
  assert.match(html, /1 transaction/);
  assert.match(html, /50% business use/);
  assert.match(html, /Edit confirmation/);
  assert.match(html, /You confirmed this treatment based on your business use/);
  assert.doesNotMatch(html, /Bizzi automatically determined/);
});

test("user-confirmed edit path reuses the atomic batch override with explicit edit authorization", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const routes = fs.readFileSync("src/api/tax/taxClassificationReview.routes.js", "utf8");
  const service = fs.readFileSync("src/services/tax/taxClassificationOverride.service.js", "utf8");
  const migration = fs.readFileSync("supabase/migrations/20261005_tax_classification_bulk_override_rpc.sql", "utf8");

  assert.match(dashboard, /const \[editingConfirmation, setEditingConfirmation\] = useState\(false\)/);
  assert.match(dashboard, /function preloadConfirmationDraft/);
  assert.match(dashboard, /setEditingConfirmation\(true\)/);
  assert.match(dashboard, /Save changes/);
  assert.match(dashboard, /Return to Needs review/);
  assert.match(dashboard, /clearUserOverride: true/);
  assert.match(routes, /allowUserConfirmedEdit/);
  assert.match(service, /hasProtectedConfirmedAuthority/);
  assert.match(service, /input\.allowUserConfirmedEdit/);
  assert.match(migration, /when v_item \? 'user_override'/);
});
