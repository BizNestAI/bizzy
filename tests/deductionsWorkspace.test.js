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

test("manual override history still displays as overridden authority", () => {
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

  assert.equal(row.status, "overridden");
  assert.equal(row.statusLabel, "Overridden");
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

test("terminal classification polling refreshes all Deductions resources without using stale cache", () => {
  const hook = fs.readFileSync("src/hooks/tax/useTaxDeductions.js", "utf8");
  assert.match(hook, /if \(isTerminalJobStatus\(status\?\.status\)\) \{\s*await load\(\{ refresh: true \}\);\s*return;\s*\}/);
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
  assert.match(dashboard, /Automatic deductions/);
  assert.match(dashboard, /Proposed — needs review/);
  assert.match(dashboard, /posted expense rows grouped by QBO GL account/);
  assert.match(dashboard, /Automatic deduction totals exclude proposed review-required amounts/);
});

test("Tax Dashboard matrix drilldown scopes cells by GL account, month, and authority", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /function MatrixCell/);
  assert.match(dashboard, /openCell\("automatic"\)/);
  assert.match(dashboard, /openCell\("proposed"\)/);
  assert.match(dashboard, /selectedAuthority: authority/);
  assert.match(dashboard, /const isReviewDetail = transactions\.some/);
  assert.match(dashboard, /transactions\.filter\(\(row\) => classificationBucket\(row\) === "auto_classified"\)/);
  assert.match(dashboard, /transactions\.filter\(\(row\) => classificationBucket\(row\) === "needs_review"\)/);
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
  assert.doesNotMatch(dashboard, /0 deductible/);
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
  assert.match(dashboard, /Bizzi matched this posted QuickBooks GL account to an active tax rule and calculated the confirmed deduction/);
});

test("Deduction detail modal renders specific review explanations and resolution workflows", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /QuickBooks categorized these expenses as Meals/);
  assert.match(dashboard, /Bizzi matched this QuickBooks account to Utilities, but needs your business-use percentage before calculating a deduction/);
  assert.match(dashboard, /Bizzi matched these expenses to Business Transportation/);
  assert.match(dashboard, /Bizzi matched this QuickBooks account to Vehicle Expense, but needs your vehicle deduction method before calculating a deduction/);
  assert.match(dashboard, /Confirm whether these are office supplies, job supplies, or materials/);
  assert.match(dashboard, /Review needed/);
  assert.match(dashboard, /Selected transactions/);
  assert.match(dashboard, /All matching QBO GL transactions for \{taxYear\}/);
  assert.doesNotMatch(dashboard, /This GL account going forward/);
  assert.doesNotMatch(dashboard, /Requires a schema-backed account-level authority record before it can be saved/);
});

test("Deduction detail modal validates business-use and vehicle method resolution", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /function parseBusinessUsePercent/);
  assert.match(dashboard, /number < 0 \|\| number > 100/);
  assert.match(dashboard, /vehicleMethod === "standard_mileage"/);
  assert.match(dashboard, /vehicle_standard_mileage_no_separate_gas/);
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
  assert.match(dashboard, /}, \[hasSelection, selectionFocusKey, reviewContext\.supported\]\)/);
  assert.match(dashboard, /type="text"/);
  assert.match(dashboard, /inputMode="decimal"/);
  assert.ok(dashboard.includes('next === "" || /^\\d{0,3}(?:\\.\\d{0,2})?$/.test(next)'));
  assert.match(dashboard, /onKeyDown=\{\(event\) => event\.stopPropagation\(\)\}/);
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
  assert.match(html, /Apply to/);
  assert.match(html, /All matching QBO GL transactions for 2026/);
  assert.match(html, /Save and confirm/);
  assert.match(html, /Not sure yet/);
  assert.match(html, /Bizzi matched this QuickBooks account to Utilities, but needs your business-use percentage before calculating a deduction/);
  assert.doesNotMatch(html, /calculated the confirmed deduction/);
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
  assert.match(html, /Bizzi matched this QuickBooks account to Vehicle Expense, but needs your vehicle deduction method before calculating a deduction/);
  assert.doesNotMatch(html, /This row already has confirmed rule-engine treatment/);
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
  assert.match(dashboard, /onBulkUpdateClassifications\(chunk, changes, \{ reason \}\)/);
  assert.match(dashboard, /await onRefresh\?\.\(\)/);
  assert.match(dashboard, /User confirmed \$\{count\} deduction review/);
  assert.match(routes, /protectConfirmedAuthority: true/);
  assert.match(service, /confirmed_authority_protected/);
});
