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
        }, {
          name: "deductions-workspace-demo-client-ssr-mock",
          enforce: "pre",
          resolveId(id) {
            return /services\/demo\/demoClient(\.js)?$/.test(id) ? "\0demo-client-ssr-mock" : null;
          },
          load(id) {
            if (id !== "\0demo-client-ssr-mock") return null;
            return "export function shouldUseDemoData() { return false; }";
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

test("deductions workspace labels v4 trades-focused tax categories", () => {
  const row = mapDeductionTransactionRow({
    transaction_id: "txn-equipment-fuel",
    transaction_date: "2026-08-15",
    tax_category: "equipment_fuel",
    deductibility_status: "fully_deductible",
    classification_status: "auto_classified",
    signed_amount: -40,
    deductible_percent: 100,
    deductible_amount: 40,
    source: "rule_engine",
    requires_review: false,
  });
  assert.equal(row.taxCategoryLabel, "Equipment Fuel");

  const model = buildDeductionsWorkspaceViewModel({
    overview: {
      coverage: { classifiedCount: 1 },
      totals: {},
      categories: [
        { taxCategory: "shipping_freight_delivery", transactionCount: 1 },
        { taxCategory: "commissions_referral_fees", transactionCount: 1 },
        { taxCategory: "retirement_contributions", transactionCount: 1 },
      ],
    },
  });
  assert.deepEqual(model.categories.map((category) => category.categoryLabel), [
    "Shipping, Freight & Delivery",
    "Commissions & Referral Fees",
    "Retirement Contributions",
  ]);
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

test("transaction rows preserve Needs Tax Review null deduction semantics", () => {
  const row = mapDeductionTransactionRow({
    transactionId: "txn-holding",
    date: "2026-07-01",
    merchantName: "Supply Co",
    qboAccountName: "Supplies",
    signedAmount: -2450,
    absoluteAmount: 2450,
    taxCategory: "tax_review_holding",
    deductibilityStatus: "not_yet_determined",
    deductiblePercent: null,
    deductibleAmount: null,
    classificationStatus: "needs_tax_review",
    requiresReview: true,
    metadata: { is_holding: true },
  });
  assert.equal(row.taxCategoryLabel, "Needs Tax Review");
  assert.equal(row.taxTreatmentLabel, "Not yet determined");
  assert.equal(row.statusLabel, "Needs tax review");
  assert.equal(row.deductiblePercent, null);
  assert.equal(row.deductibleAmount, null);
});

test("deduction detail modal renders Needs Tax Review holding option and copy", async () => {
  const { DeductionMonthDetailModal } = await loadTaxDashboardInternals();
  const selection = makeReviewSelection({
    accountName: "Supplies",
    taxCategory: "supplies_materials",
    monthKey: "2026-03",
    longLabel: "March 2026",
    amount: 2450,
  });
  const html = renderToStaticMarkup(React.createElement(DeductionMonthDetailModal, {
    selection,
    onClose: () => {},
    onSendToTaxReview: async () => {},
    onBulkUpdateClassifications: async () => {},
    onAssignTaxClassification: async () => {},
    onRefresh: async () => {},
    readOnly: false,
  }));
  assert.match(html, /Keep in Needs input/);
  assert.match(html, /will remain visible and will not affect deduction totals until it is reviewed/);
  assert.match(html, /Bookkeeping category may be wrong/);
});

test("deductions matrix keeps holding-only account month clickable and non-deductible", async () => {
  const { buildDeductionAccountMatrix } = await loadTaxDashboardInternals();
  const row = mapDeductionTransactionRow({
    transactionId: "txn-holding",
    date: "2026-03-15",
    merchantName: "Supply Co",
    qboAccountId: "acct-supplies",
    qboAccountName: "Supplies",
    signedAmount: -2450,
    absoluteAmount: 2450,
    taxCategory: "tax_review_holding",
    deductibilityStatus: "not_yet_determined",
    deductiblePercent: null,
    deductibleAmount: null,
    classificationStatus: "needs_tax_review",
    requiresReview: true,
    metadata: { is_holding: true },
  });
  const matrix = buildDeductionAccountMatrix([row], 2026);
  const cell = matrix.accounts[0].months["2026-03"];
  assert.equal(cell.transactions.length, 1);
  assert.equal(cell.authoritativeDeductibleTotal, 0);
  assert.equal(cell.proposedDeductibleTotal, 0);
  assert.equal(cell.needsTaxReviewTransactionCount, 1);
  assert.equal(cell.needsTaxReviewGrossExpense, 2450);
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

test("fallback-only production state is presented as bookkeeping evidence, not a customer approval queue", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /technical_evidence_incomplete/);
  assert.match(dashboard, /Needs bookkeeping details/);
  assert.match(dashboard, /Bookkeeping evidence/);
  assert.doesNotMatch(dashboard, /Run processed/);
});

test("unresolved fallback rows remain visible as bookkeeping details without a manual job trigger", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /Needs bookkeeping details/);
  assert.match(dashboard, /buildTaxDeductionsLifecycleProjection/);
  assert.match(dashboard, /BOOKKEEPING_EVIDENCE_REQUIRED/);
  assert.doesNotMatch(dashboard, /onClick=\{openBackfillPreview\}/);
});

test("classification activity remains automatic while the deductions surface offers only Refresh", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /ClassificationProgressSummary/);
  assert.match(dashboard, /Bizzi is reviewing them\. No action is needed from you\./);
  assert.match(dashboard, /deductionsUpdating \? "Updating" : "Refresh"/);
  assert.doesNotMatch(dashboard, />Update deductions</);
});

test("manual Refresh bypasses cached read-only tax resources and exposes result state", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const hook = fs.readFileSync("src/hooks/tax/useTaxDeductions.js", "utf8");
  const client = fs.readFileSync("src/services/tax/taxApiClient.js", "utf8");
  assert.match(dashboard, /const refreshDeductions = deductions\.refresh/);
  assert.match(dashboard, /onClick=\{refreshDeductions\}/);
  assert.match(dashboard, /deductionsUpdating \? "Updating" : "Refresh"/);
  assert.match(dashboard, /deductions\.refreshError/);
  assert.match(dashboard, /overviewProjection\?\.refreshedAt \|\| deductions\.overview\?\.meta\?\.generatedAt/);
  assert.match(dashboard, /Updated \{formatDateLocal\(updatedAt\)\}/);
  assert.match(hook, /load\(\{ \.\.\.options, refresh: true \}\)/);
  assert.match(hook, /setLastRefreshedAt\(workspace\?\.refreshedAt/);
  assert.match(client, /getTaxWorkspace\(\{ businessId, year, refresh = false, signal \}/);
  assert.match(client, /bypassCache: refresh/);
  assert.doesNotMatch(hook, /refresh:[\s\S]{0,240}prepareTaxClassifications/);
});

test("tax deductions overview prefetch is read-only and mounted after business context resolves", () => {
  const prefetchHook = fs.readFileSync("src/hooks/tax/useTaxDeductionsPrefetch.js", "utf8");
  const apiClient = fs.readFileSync("src/services/tax/taxApiClient.js", "utf8");
  const main = fs.readFileSync("src/main.jsx", "utf8");

  assert.match(prefetchHook, /getTaxWorkspace\(\{ businessId, year \}\)/);
  assert.match(prefetchHook, /if \(!enabled \|\| loading \|\| !businessId/);
  assert.match(prefetchHook, /requestIdleCallback/);
  assert.match(prefetchHook, /setTimeout\(callback, 0\)/);
  assert.match(main, /<DashboardTaxPrefetcher \/>/);
  assert.match(main, /<BusinessProvider>[\s\S]*<DashboardTaxPrefetcher \/>[\s\S]*<FullDashboardLayout \/>/);

  const workspaceRead = apiClient.match(/export async function getTaxWorkspace[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(workspaceRead, /\/api\/tax\/workspace/);
  assert.doesNotMatch(workspaceRead, /prepareTaxClassifications|runTaxClassification|runTaxCalculation|QuickBooks|Plaid|POST|PATCH|DELETE/);
});

test("tax API cache dedupes in-flight overview requests between prefetch and route load", () => {
  const apiClient = fs.readFileSync("src/services/tax/taxApiClient.js", "utf8");
  const cachedGet = apiClient.match(/async function cachedGet[\s\S]*?\n}\n\nfunction getCachedValue/)?.[0] || "";
  assert.match(cachedGet, /if \(inflight\.has\(cacheKey\)\) return waitForCaller\(inflight\.get\(cacheKey\), signal\)/);
  assert.match(cachedGet, /inflight\.set\(cacheKey, promise\)/);
  assert.doesNotMatch(cachedGet, /if \(!signal && inflight\.has/);
  assert.match(apiClient, /function taxDeductionsOverviewPath/);
  assert.match(apiClient, /cacheKey: key\("taxWorkspace:tax-workspace-v1", params\)/);
});

test("deductions hook stages cold loading and keeps cached data visible during refresh", () => {
  const hook = fs.readFileSync("src/hooks/tax/useTaxDeductions.js", "utf8");
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(hook, /getTaxWorkspace\(\{ businessId, year, refresh, signal \}\)/);
  assert.match(hook, /setWorkspaceProjection\(workspace\)/);
  assert.match(hook, /const loadSecondaryDetails = useCallback/);
  assert.match(hook, /fetchAllPostedTransactions/);
  assert.match(hook, /getTaxClassifications/);
  assert.doesNotMatch(hook, /getCachedTaxDeductionsOverview/);
  assert.match(dashboard, /const initialDeductionsLoading = deductionsRenderState\.showInitialLoading/);
  assert.match(dashboard, /disabled=\{deductions\.refreshing \|\| !hasUsableDeductionsData\}/);
  assert.match(hook, /if \(!overviewRef\.current\) setError\(overviewResult\.reason\)/);
  assert.doesNotMatch(hook, /setError\(Object\.values\(errors\)\[0\]/);
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
  assert.match(dashboard, /Deduction estimate summary/);
  assert.match(dashboard, /Based on \{authoritativeMatrixIncludedCount\} expense transaction/);
  assert.doesNotMatch(dashboard, />Update deductions</);
  assert.match(dashboard, /deductionsUpdating \? "Updating" : "Refresh"/);
  assert.match(dashboard, /Estimated/);
  assert.match(dashboard, /Needs input/);
  assert.match(dashboard, /Needs bookkeeping details/);
  assert.match(dashboard, /Estimated payment amount pending/);
  assert.match(hook, /getTaxWorkspace/);
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
  assert.match(dashboard, /Expense category/);
  assert.match(dashboard, /authoritativeDeductibleTotal/);
  assert.match(dashboard, /proposedDeductibleTotal/);
  assert.match(dashboard, /standardRuleDeductibleTotal/);
  assert.match(dashboard, /needsInputDeductibleTotal/);
  assert.doesNotMatch(dashboard, /cell\.deductibleTotal/);
});

test("Tax Dashboard renders a single estimate summary before the matrix-first Deductions workspace", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const summaryShell = dashboard.slice(
    dashboard.indexOf('<section className="mt-5 rounded-2xl border border-emerald-300/10'),
    dashboard.indexOf("<WorkspaceViewTabs")
  );
  assert.match(dashboard, /Deductions overview/);
  assert.match(dashboard, /Questions for you/);
  assert.match(dashboard, /All transactions/);
  assert.match(dashboard, /workspaceView === "overview"/);
  assert.match(dashboard, /workspaceView === "needs_attention"/);
  assert.match(dashboard, /DeductionsIncludedDisclosure/);
  assert.match(dashboard, /DeductionAccountMatrix/);
  assert.match(summaryShell, /Estimated deductible expenses/);
  assert.match(summaryShell, /formatCurrencyLocal\(estimatedDeductibleExpenses\)/);
  assert.match(summaryShell, /authoritativeMatrixIncludedCount/);
  assert.doesNotMatch(summaryShell, /customerWorkflow\.technicalCount/);
  assert.doesNotMatch(summaryShell, /Reviewed|Standard estimates|Questions for you/);
  assert.match(dashboard, /posted transactions evaluated · \$\{matrixIncludedCount\} expense transactions included in the deductions matrix/);
});

test("Tax Dashboard matrix drilldown scopes cells by GL account, month, and authority", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /function MatrixCell/);
  assert.match(dashboard, /openCell\("reviewed"\)/);
  assert.match(dashboard, /openCell\("standard_rule"\)/);
  assert.match(dashboard, /openCell\("needs_input"\)/);
  assert.match(dashboard, /openCell\("proposed"\)/);
  assert.match(dashboard, /openCell\("standard_mileage"\)/);
  assert.match(dashboard, /selectedAuthority: authority/);
  assert.match(dashboard, /const isReviewDetail = transactions\.some/);
  assert.match(dashboard, /hasReviewedTaxTreatment\(row\)/);
  assert.match(dashboard, /hasStandardRuleTaxTreatment\(row\)/);
  assert.match(dashboard, /classificationBucket\(row\) === "needs_review" \|\| classificationBucket\(row\) === "unclassified"/);
  assert.match(dashboard, /cell\.customerInputTransactionCount > 0/);
  assert.doesNotMatch(dashboard, /const hasRenderableState = cell\.authoritativeDeductibleTotal > 0/);
  assert.doesNotMatch(dashboard, /cell\.autoTransactionCount > 0/);
  assert.match(dashboard, /return <span className="block px-2 py-1\.5 text-\[12px\] text-white\/22" role="img" aria-label="No activity">—<\/span>/);
});

test("Tax launch overview keeps customer copy concise and puts the matrix before rules", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const customerShell = dashboard.slice(
    dashboard.indexOf("function TaxDashboardDeductions"),
    dashboard.indexOf("const CLASSIFICATION_TABS")
  );
  const summaryIndex = customerShell.indexOf("Deduction estimate summary");
  const tabsIndex = customerShell.indexOf("<WorkspaceViewTabs");
  const disclosureIndex = customerShell.indexOf("<DeductionsIncludedDisclosure");
  const matrixIndex = customerShell.indexOf("<DeductionAccountMatrix");
  const rulesIndex = customerShell.indexOf("<DeductionDecisionRulesPanel");

  assert.match(customerShell, /Preliminary bookkeeping estimate—not a tax return\./);
  assert.match(customerShell, /Estimates are based on expenses posted to QuickBooks\. Items that need more information are excluded until reviewed\./);
  assert.match(customerShell, /Updated \{formatDateLocal\(updatedAt\)\}/);
  assert.match(customerShell, /projectedQuestionGroups/);
  assert.match(customerShell, /Transaction details are temporarily unavailable/);
  assert.doesNotMatch(customerShell, /deterministic tax rules|stable transaction identities|QBO GL account|Classification status|How the displayed states reconcile/);
  assert.ok(summaryIndex > -1 && tabsIndex > summaryIndex);
  assert.ok(disclosureIndex > tabsIndex && matrixIndex > disclosureIndex);
  assert.ok(rulesIndex > matrixIndex, "Rules must appear after the monthly matrix.");

  assert.match(dashboard, /<details className="group mt-4 rounded-2xl[^>]*data-tax-rules-defaults>/);
  assert.match(dashboard, /Rules and defaults/);
  assert.match(dashboard, /Set defaults for vehicle, rent, and utility expenses\. You can change them anytime\./);
  assert.match(dashboard, /Choose how vehicle expenses are calculated\./);
  assert.match(dashboard, /Set the business-use percentage for rent or lease expenses\./);
  assert.match(dashboard, /Set a business-use percentage for selected utility expenses\./);
  assert.match(dashboard, /No defaults set yet\./);
  assert.doesNotMatch(dashboard, /Your deduction rules|Company-specific|No company deduction rules have been saved yet/);
});

test("Tax deduction summary uses the bridge population, keeps workflow counts secondary, and labels question tabs accessibly", async () => {
  const {
    DeductionsIncludedDisclosure,
    WorkspaceViewTabs,
    describeOutsideMatrixActivity,
    resolveDeductionsPopulationCounts,
  } = await loadTaxDashboardInternals();
  const populationBridge = {
    identity_comparison: { identity_match: true },
    tax_scope: {
      posted_transactions_evaluated_count: 709,
      deductions_matrix_expense_count: 685,
      posted_non_expense_outside_deductions_count: 24,
      conservation_ok: true,
      dispositions: {
        expense_cogs_in_matrix: 685,
        income_outside_deductions: 8,
        transfer_or_card_payment_not_deduction: 6,
        owner_or_equity_not_deduction: 3,
        refund_credit_or_asset_not_deduction: 5,
        incomplete_or_unresolved: 2,
      },
    },
  };
  const projection = {
    canonicalCount: 709,
    counts: {
      reviewed: 43,
      standard_rule_applied: 145,
      standard_rule_estimated_no_action: 0,
      customer_input_required: 435,
      bookkeeping_evidence_required: 50,
      technical_update_pending: 0,
      tax_review_required: 0,
      ambiguous: 12,
    },
  };
  const counts = resolveDeductionsPopulationCounts({
    transactionCount: 999,
    populationBridge,
    projection,
  });

  assert.equal(counts.evaluatedCount, 709);
  assert.equal(counts.matrixIncludedCount, 685, "The server bridge takes precedence over a local matrix fallback.");
  assert.equal(counts.outsideMatrixCount, 24);
  assert.equal(counts.conservationOk, true);
  assert.equal(counts.evaluatedCount, counts.matrixIncludedCount + counts.outsideMatrixCount);
  assert.equal(
    describeOutsideMatrixActivity({ income_outside_deductions: 8, incomplete_or_unresolved: 2 }),
    "Outside the matrix includes income, and records without sufficient bookkeeping evidence."
  );

  const disclosure = renderToStaticMarkup(React.createElement(DeductionsIncludedDisclosure, {
    transactionCount: 999,
    populationBridge,
    projection,
  }));
  assert.match(disclosure, /709 posted transactions evaluated · 685 expense transactions included in the deductions matrix · 24 outside deductions/);
  assert.match(disclosure, /Expense and COGS in the matrix:<\/span> 685\./);
  assert.match(disclosure, /Outside the deductions matrix:<\/span> 24\./);
  assert.match(disclosure, /income, transfers or credit-card payments, owner or equity activity, refunds, credits, or asset activity, and records without sufficient bookkeeping evidence/);
  assert.match(disclosure, /Supporting workflow details/);
  assert.match(disclosure, /These counts may overlap with the transaction populations above and are not added together\./);
  assert.match(disclosure, /Outside deductions means the transaction was evaluated but does not belong in the expense-deduction matrix/);

  const mismatched = renderToStaticMarkup(React.createElement(DeductionsIncludedDisclosure, {
    transactionCount: 685,
    populationBridge: { ...populationBridge, identity_comparison: { identity_match: false } },
    projection,
  }));
  assert.match(mismatched, /Transaction totals are updating\./);
  assert.doesNotMatch(mismatched, /709 posted transactions evaluated ·/);

  const tabs = renderToStaticMarkup(React.createElement(WorkspaceViewTabs, {
    value: "overview",
    onChange: () => {},
    questionGroupCount: 9,
  }));
  assert.match(tabs, /Questions for you · 9/);
  assert.match(tabs, /aria-label="Questions for you, 9 questions requiring an answer"/);
  assert.match(tabs, /type="button"/);

  const zeroQuestionTabs = renderToStaticMarkup(React.createElement(WorkspaceViewTabs, {
    value: "overview",
    onChange: () => {},
    questionGroupCount: 0,
  }));
  assert.match(zeroQuestionTabs, /Questions for you · 0/);
  assert.match(zeroQuestionTabs, /aria-label="Questions for you, no questions requiring an answer"/);
});

test("Tax matrix launch labels retain accessible details and grouped decision navigation", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");

  assert.match(dashboard, /Blue: Estimated/);
  assert.match(dashboard, /Green: Reviewed/);
  assert.match(dashboard, /Yellow: Needs input/);
  assert.match(dashboard, /const includedTransactionCount = Number\(matrix\?\.transactionCount \|\| 0\);/);
  assert.match(dashboard, /Monthly deductions/);
  assert.match(dashboard, /expense transaction\$\{includedTransactionCount === 1 \? "" : "s"\} included/);
  assert.match(dashboard, /<th[^>]*>Expense category<\/th>/);
  assert.match(dashboard, /role="img" aria-label="No activity">—<\/span>/);
  assert.match(dashboard, /Reviewed deduction/);
  assert.match(dashboard, /Estimated deduction/);
  assert.match(dashboard, /Expenses to review · Needs input/);
  assert.match(dashboard, /onClick=\{\(\) => openCell\("needs_input"\)\}/);
  assert.match(dashboard, /onOpenDecision\(\{ group, scope: "account_year", selectedMonth: month\.key \}\)/);
});

test("deduction modal native selects explicitly request a dark popup palette", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const deductionSelects = [...dashboard.matchAll(/<select[\s\S]*?<\/select>/g)].map((match) => match[0]);

  assert.ok(deductionSelects.length > 0);
  for (const select of deductionSelects) {
    assert.match(select, /data-deduction-modal-select/);
    assert.match(select, /dark-dropdown/);
    assert.match(select, /\[color-scheme:dark\]/);
    assert.match(select, /style=\{\{ colorScheme: "dark" \}\}/);
    assert.match(select, /option className="bg-\[#0f1312\] text-white"/);
  }
});

test("Tax customer summary keeps identity reconciliation internal and protects the chat composer clearance", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");

  assert.match(dashboard, /function TaxLifecycleConservationSummary/);
  assert.match(dashboard, /stable transaction identities =/);
  assert.match(dashboard, /\{readOnly \? <TaxLifecycleConservationSummary/);
  assert.match(dashboard, /pb-\[calc\(var\(--chat-clearance,156px\)\+24px\)\]/);
  assert.match(dashboard, /sticky left-0/);
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
  assert.equal(confirmedMatrix.transactionCount, 1);
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

test("matrix amount contract separates reviewed deductions, estimates, and gross expenses awaiting input", async () => {
  const {
    buildDeductionAccountMatrix,
    buildMatrixAuthorityTotals,
    buildMatrixCellAmountProjection,
  } = await loadTaxDashboardInternals();
  const common = {
    date: "2026-05-12",
    qboAccountId: "meals",
    qboAccountName: "Meals",
    amount: 100,
    signedAmount: -100,
    direction: "OUTFLOW",
    taxCategory: "business_meals",
    taxCategoryLabel: "Business Meals",
    deductiblePercent: 50,
    deductibleAmount: 50,
    classificationSource: "rule_engine",
    matchedRuleCode: "meals_gl_v3",
    taxScopeDisposition: "expense_cogs_in_matrix",
  };
  const matrix = buildDeductionAccountMatrix([
    { ...common, id: "reviewed", status: "user_confirmed", requiresReview: false },
    { ...common, id: "estimated", status: "auto_classified", requiresReview: false },
    { ...common, id: "needs-input", status: "needs_review", requiresReview: true },
  ], 2026, { scope: "overview" });
  const may = matrix.accounts[0].months["2026-05"];
  const contract = buildMatrixCellAmountProjection(may);

  assert.deepEqual(contract.reviewed, {
    status: "reviewed", display_amount_cents: 5000, amount_kind: "reviewed_deduction", transaction_count: 1, label: "Reviewed deduction",
  });
  assert.deepEqual(contract.estimated, {
    status: "estimated", display_amount_cents: 5000, amount_kind: "deductible_estimate", transaction_count: 1, label: "Estimated deduction",
  });
  assert.deepEqual(contract.needs_input, {
    status: "needs_input", display_amount_cents: 10000, amount_kind: "gross_expense", transaction_count: 1, label: "Expenses to review",
  });
  assert.equal(buildMatrixAuthorityTotals(matrix).authoritativeDeductibleTotal, 100);
  assert.equal(buildMatrixAuthorityTotals(matrix).proposedDeductibleTotal, 50, "The legacy proposed field remains drill-down-only and is excluded from the headline total.");

  assert.deepEqual(buildMatrixCellAmountProjection({ customerInputTransactionCount: 1 }).needs_input, {
    status: "needs_input", display_amount_cents: null, amount_kind: "unavailable", transaction_count: 1, label: "Needs input",
  });
});

test("standard-rule estimates stay in the matrix while factual questions, technical evidence, and income stay correctly partitioned", async () => {
  const {
    buildCustomerDeductionsWorkflow,
    buildDeductionAccountMatrix,
    classificationBucket,
    filterAttentionWorkspaceRows,
    isStandardRuleProposal,
    requiresCustomerTaxInput,
  } = await loadTaxDashboardInternals();
  const base = {
    date: "2026-09-15",
    amount: 100,
    signedAmount: -100,
    direction: "OUTFLOW",
    deductiblePercent: 100,
    deductibleAmount: 100,
    status: "needs_review",
    requiresReview: true,
    taxScopeDisposition: "expense_cogs_in_matrix",
  };
  const rows = [{
    ...base,
    id: "software-rule",
    qboAccountId: "software",
    qboAccountName: "Software",
    taxCategory: "software_subscriptions",
    classificationSource: "rule_engine",
    matchedRuleCode: "software_gl_v3",
  }, {
    ...base,
    id: "meal-question",
    qboAccountId: "meals",
    qboAccountName: "Meals",
    taxCategory: "business_meals",
    deductiblePercent: 50,
    deductibleAmount: 50,
    classificationSource: "rule_engine",
    matchedRuleCode: "meals_gl_v3",
  }, {
    ...base,
    id: "income-outside",
    qboAccountId: "sales",
    qboAccountName: "Sales of Product Income",
    taxCategory: "income",
    signedAmount: 250,
    direction: "INFLOW",
    taxScopeDisposition: "income_outside_deductions",
  }, {
    ...base,
    id: "missing-evidence",
    qboAccountId: null,
    qboAccountName: "Unmapped QuickBooks account",
    taxCategory: "unresolved",
    taxScopeDisposition: "incomplete_or_unresolved",
  }];

  assert.equal(isStandardRuleProposal(rows[0]), true);
  assert.equal(requiresCustomerTaxInput(rows[0]), false);
  assert.equal(requiresCustomerTaxInput(rows[1]), true);
  assert.equal(classificationBucket(rows[2]), "outside_deductions");
  assert.equal(classificationBucket(rows[3]), "technical_evidence_incomplete");

  const workflow = buildCustomerDeductionsWorkflow(rows);
  assert.equal(workflow.reviewedCount, 0);
  assert.equal(workflow.standardRuleCount, 1);
  assert.equal(workflow.customerInputCount, 1);
  assert.equal(workflow.customerDecisionCount, 1);
  assert.equal(workflow.technicalCount, 1);
  const workspaceRows = rows.map((row) => ({ ...row, classificationBucket: classificationBucket(row) }));
  assert.deepEqual(filterAttentionWorkspaceRows(workspaceRows, "needs_review").map((row) => row.id), ["meal-question"]);
  assert.deepEqual(filterAttentionWorkspaceRows(workspaceRows, "unclassified").map((row) => row.id), ["missing-evidence"]);

  const matrix = buildDeductionAccountMatrix(rows, 2026, { scope: "overview" });
  assert.deepEqual(matrix.accounts.map((account) => account.name).sort(), ["Meals", "Software"]);
  const software = matrix.accounts.find((account) => account.name === "Software").months["2026-09"];
  const meals = matrix.accounts.find((account) => account.name === "Meals").months["2026-09"];
  assert.equal(software.standardRuleDeductibleTotal, 100);
  assert.equal(software.standardRuleTransactionCount, 1);
  assert.equal(meals.needsInputDeductibleTotal, 50);
  assert.equal(meals.customerInputTransactionCount, 1);
});

test("Tax Dashboard derives modal aggregate status from selected cell rows", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /function aggregateClassificationStatus\(rows = \[\]\)/);
  assert.match(dashboard, /const aggregateStatus = useMemo\(\(\) => aggregateClassificationStatus\(transactions\), \[transactions\]\)/);
  assert.match(dashboard, /buckets\.length > 1[\s\S]{0,100}label: "Mixed treatment"/);
  assert.match(dashboard, /bucket === "needs_review"[\s\S]{0,100}label: "Needs input"/);
  assert.match(dashboard, /<DetailPill tone=\{aggregateStatus\.tone\}>/);
  assert.doesNotMatch(dashboard, /cell\.selectedAuthority === "proposed" \? "Needs review" : "Auto-classified"/);
});

test("Tax Dashboard row semantics distinguish auto-classified and review-required treatment", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.doesNotMatch(dashboard, /Treatment pending/);
  assert.match(dashboard, /Fully deductible/);
  assert.match(dashboard, /% deductible/);
  assert.match(dashboard, /Expense-category rule/);
  assert.match(dashboard, /Depends on business use/);
  assert.match(dashboard, /Review required/);
});

test("Tax Dashboard uses a deductions loading skeleton and keeps the single Refresh action truthful", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /function DeductionsLoadingState/);
  assert.match(dashboard, /Loading your \{year\} deductions…/);
  assert.match(dashboard, /Loading your latest saved summary and transaction details/);
  assert.match(dashboard, /motion-safe:animate-spin/);
  assert.match(dashboard, /initialDeductionsLoading \? \(/);
  assert.match(dashboard, /role="status" aria-busy="true" aria-live="polite"/);
  assert.match(dashboard, /\{deductionsUpdating \? "Updating" : "Refresh"\}/);
  assert.doesNotMatch(dashboard, />Update deductions</);
});

test("Tax Dashboard counts meaningful needs-review coverage and labels expense-category rule sources", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /coverage\.needsReviewCount/);
  assert.match(dashboard, /coverage\.needs_review_count/);
  assert.match(dashboard, /source === "rule_engine" \|\| hasRuleIdentity/);
  assert.match(dashboard, /Expense-category rule/);
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
  assert.match(dashboard, /Bizzi is reviewing them\. No action is needed from you\./);
  assert.match(dashboard, /Some transactions aren’t included in this estimate yet/);
  assert.match(dashboard, /No action is needed from you/);
  assert.doesNotMatch(dashboard, /Run processed/);
  assert.doesNotMatch(dashboard, /Run remaining/);
  assert.doesNotMatch(dashboard, /0 of \$\{total\} complete/);
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

test("automatic deduction updates are observable without a customer-started job", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const hook = fs.readFileSync("src/hooks/tax/useTaxDeductions.js", "utf8");
  assert.doesNotMatch(hook, /const result = await prepareTaxClassifications[\s\S]{0,120}await load\(\)/);
  assert.match(hook, /setClassificationJobStatus\(status \|\| null\)/);
  assert.match(dashboard, /Bizzi is reviewing them\. No action is needed from you\./);
  assert.doesNotMatch(dashboard, /setTrackedPrepareRun/);
  assert.doesNotMatch(dashboard, /setPrepareCompletionNotice/);
  assert.doesNotMatch(dashboard, /onClick=\{openBackfillPreview\}/);
  assert.doesNotMatch(dashboard, /lastTerminalJobRef/);
  assert.doesNotMatch(dashboard, /dispatchBizziToast/);
  assert.doesNotMatch(dashboard, /bizzy:toast/);
});

test("no customer-visible manual preparation run is tracked in Deductions", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.doesNotMatch(dashboard, /trackedPrepareRun/);
  assert.doesNotMatch(dashboard, /prepareCompletionNotice/);
  assert.doesNotMatch(dashboard, /openBackfillPreview/);
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
  assert.match(dashboard, /Tax treatment unavailable/);
  assert.match(dashboard, /taxDataUnavailable/);
  assert.match(dashboard, /classificationBucket\(row\) === "unclassified"/);
});

test("Tax Dashboard groups Questions for You by a stable annual decision identity", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const attentionReviewGroups = dashboard.slice(
    dashboard.indexOf("function AttentionReviewGroups"),
    dashboard.indexOf("function taxRowId")
  );
  assert.match(dashboard, /function buildAttentionReviewGroups/);
  assert.match(dashboard, /buildTaxDeductionsLifecycleProjection/);
  assert.match(dashboard, /function toDecisionActionGroup/);
  assert.match(dashboard, /CUSTOMER_QUESTION_SECTIONS/);
  assert.match(dashboard, /function buildCustomerQuestionSections/);
  assert.match(dashboard, /customerQuestionSummaryText\(deductions\.allTransactions \? customerWorkflow\.customerDecisionCount/);
  assert.match(dashboard, /Answer these to finish your \{year\} deduction estimates\./);
  assert.match(dashboard, /Manage deduction defaults/);
  assert.doesNotMatch(dashboard, /Review individual transactions|one_transaction/);
  assert.doesNotMatch(attentionReviewGroups, /need your answer|total transactions in this category|future posted transactions|grouped questions|affected transactions/);
  assert.match(attentionReviewGroups, /total<\/p>/);
  assert.match(attentionReviewGroups, /Estimated deduction if confirmed:/);
  assert.match(attentionReviewGroups, /Deduction not estimated yet/);
  assert.match(attentionReviewGroups, /lg:grid-cols-2/);
  assert.match(attentionReviewGroups, /pb-\[calc\(var\(--chat-clearance,156px\)\+16px\)\]/);
  assert.doesNotMatch(dashboard, /Reviewed decisions/);
  assert.match(dashboard, /Rules and defaults/);
  assert.match(dashboard, /workspaceView === "overview"[\s\S]*?<DeductionDecisionRulesPanel/);
  const questionsBranchStart = dashboard.indexOf('workspaceView === "needs_attention"');
  const questionsBranch = dashboard.slice(
    questionsBranchStart,
    dashboard.indexOf('      ) : (', questionsBranchStart)
  );
  assert.doesNotMatch(questionsBranch, /DeductionDecisionRulesPanel/);
  assert.match(dashboard, /Some were personal expenses/);
  assert.match(dashboard, /View"\} \{rows\.length\} affected transaction/);
  assert.match(dashboard, /const visibleRows = expanded \? matchingRows\.slice\(0, 100\) : \[\]/);
  assert.match(dashboard, /confirmGroupedDeductionDecision/);
  assert.match(dashboard, /idempotencyKey/);
  assert.doesNotMatch(dashboard, /ids\.slice\(index, index \+ 100\)/);
});

test("Tax Dashboard presents all customer questions by authoritative decision type without changing their stable IDs", async () => {
  const {
    AttentionReviewGroups,
    buildCustomerQuestionSections,
    customerQuestionPreview,
    customerQuestionSummaryText,
  } = await loadTaxDashboardInternals();
  const makeGroup = ({ name, kind, count, total, preview, ids }) => ({
    key: `${name}:${kind}`,
    qboAccountName: name,
    decision: { kind },
    actionableTransactionCount: count,
    grossTotal: total,
    proposedDeductibleTotal: preview,
    canApply: true,
    stableTransactionIds: { actionable: ids },
  });
  const groups = [
    makeGroup({ name: "Meals", kind: "confirm_business_purpose", count: 171, total: 4463, preview: 2232, ids: ["meals-1", "meals-2"] }),
    makeGroup({ name: "Parking", kind: "confirm_business_purpose", count: 61, total: 371, preview: 0, ids: ["parking-1"] }),
    makeGroup({ name: "Lyft/Uber", kind: "confirm_business_purpose", count: 8, total: 94, preview: 0, ids: ["rideshare-1"] }),
    makeGroup({ name: "Transportation", kind: "confirm_business_purpose", count: 3, total: 82, preview: 0, ids: ["transport-1"] }),
    makeGroup({ name: "Phone Bill", kind: "business_use_percent", count: 5, total: 252, preview: 0, ids: ["phone-1"] }),
    makeGroup({ name: "Rent", kind: "business_use_percent", count: 5, total: 8923, preview: 0, ids: ["rent-1"] }),
    makeGroup({ name: "Electric", kind: "utility_allocation", count: 4, total: 244, preview: 0, ids: ["electric-1"] }),
    makeGroup({ name: "Utilities", kind: "utility_allocation", count: 2, total: 115, preview: 0, ids: ["utilities-1"] }),
    makeGroup({ name: "Gas", kind: "vehicle_method", count: 61, total: 3483, preview: 0, ids: ["gas-1"] }),
  ];
  const sections = buildCustomerQuestionSections(groups);

  assert.equal(groups.reduce((total, group) => total + group.actionableTransactionCount, 0), 320);
  assert.equal(customerQuestionSummaryText(sections.reduce((total, section) => total + section.groups.length, 0), 320), "9 questions covering 320 transactions");
  assert.deepEqual(sections.map(({ title, groups: sectionGroups }) => [title, sectionGroups.length]), [
    ["Confirm business use", 4],
    ["Set business-use percentage", 4],
    ["Choose vehicle method", 1],
  ]);
  assert.deepEqual(
    sections.flatMap((section) => section.groups.flatMap((group) => group.stableTransactionIds.actionable)).sort(),
    groups.flatMap((group) => group.stableTransactionIds.actionable).sort(),
    "presentation grouping must not alter the authoritative stable-ID population"
  );
  assert.equal(customerQuestionPreview(groups[0]), "$2,232");
  assert.equal(customerQuestionPreview(groups[1]), null);
  assert.doesNotMatch(String(customerQuestionPreview), /[*/]/, "question cards display server projections without calculating deductions");

  const html = renderToStaticMarkup(React.createElement(AttentionReviewGroups, {
    groups,
    readOnly: false,
    onOpenDecision: () => {},
  }));
  assert.match(html, /Confirm business use[^]*?· 4/);
  assert.match(html, /Set business-use percentage[^]*?· 4/);
  assert.match(html, /Choose vehicle method[^]*?· 1/);
  assert.match(html, /171 transactions · \$4,463 total/);
  assert.match(html, /Were these business meals\?/);
  assert.match(html, /Estimated deduction if confirmed: \$2,232/);
  assert.match(html, /How do you track vehicle expenses\?/);
  assert.match(html, /What percentage was used for business\?/);
  assert.match(html, /Deduction not estimated yet/);
  assert.match(html, /Review meals/);
  assert.match(html, /Choose vehicle method/);
  assert.match(html, /Set percentage/);
  assert.doesNotMatch(html, /gross|need your answer|total transactions in this category|future posted transactions/);
});

test("Tax review dialog loads an authoritative preview before rendering amounts or submission controls", async () => {
  const { ReviewDecisionModal, GroupedDecisionPreviewState, toDecisionActionGroup, decisionPopulation, decisionTransactionIds } = await loadTaxDashboardInternals();
  const pending = ["meal-1", "meal-2"].map((id) => ({
    id,
    transactionId: id,
    date: "2026-06-15",
    vendor: "Meal vendor",
    amount: 20,
    qboAccountId: "meals",
    qboAccountName: "Meals",
    taxCategory: "business_meals",
    taxCategoryLabel: "Business Meals",
    deductiblePercent: 50,
    status: "needs_review",
    requiresReview: true,
    raw: { transactionId: id },
  }));
  const reviewed = {
    ...pending[0],
    id: "meal-reviewed",
    transactionId: "meal-reviewed",
    status: "user_confirmed",
    requiresReview: false,
    raw: { transactionId: "meal-reviewed" },
  };
  const group = toDecisionActionGroup({
    id: "decision:meals",
    decisionType: "business_use_confirmation",
    qboAccountName: "Meals",
    rows: [...pending, reviewed],
    pendingRows: pending,
    reviewedRows: [reviewed],
    categoryTransactionCount: 3,
    actionableTransactionCount: 2,
    alreadyResolvedCount: 1,
    explicitlyExcludedCount: 0,
    months: ["2026-05", "2026-06"],
    grossAmount: 60,
    estimatedDeductibleAmount: 30,
  });
  assert.deepEqual(decisionPopulation(group), {
    categoryTransactionCount: 3,
    actionableTransactionCount: 2,
    alreadyResolvedCount: 1,
    explicitlyExcludedCount: 0,
    isConserved: true,
  });

  const html = renderToStaticMarkup(React.createElement(ReviewDecisionModal, {
    decision: { group, scope: "account_year" },
    taxYear: 2026,
    readOnly: false,
    onClose: () => {},
    onApply: async () => ({}),
    onOpenVehicleWorkflow: () => {},
  }));
  assert.match(html, /Review Meals/);
  assert.match(html, /3 Meals transactions in 2026/);
  assert.match(html, /2 still need your answer; 1 already has a reviewed treatment/);
  assert.match(html, /Loading this question/);
  assert.match(html, /No changes will be made without a current preview/);
  assert.doesNotMatch(html, /\$0|0 transactions|View 0 affected transactions|Confirm business meals/);

  const technicalFailure = renderToStaticMarkup(React.createElement(GroupedDecisionPreviewState, {
    state: "preview_error",
    requestId: "safe-request-1",
    onRetry: () => {},
  }));
  assert.match(technicalFailure, /We couldn’t load this question\. No changes were made\./);
  assert.match(technicalFailure, /Request ID: safe-request-1/);
  assert.match(technicalFailure, /Retry/);
  assert.doesNotMatch(technicalFailure, /no longer needs an answer/);

  const resolved = renderToStaticMarkup(React.createElement(GroupedDecisionPreviewState, {
    state: "preview_resolved",
    requestId: null,
    onRetry: () => {},
  }));
  assert.match(resolved, /This question no longer needs an answer\./);
  assert.deepEqual(decisionTransactionIds(group.rows, "all_business"), ["meal-1", "meal-2"]);
  assert.deepEqual(decisionTransactionIds(group.rows, "some_personal", ["meal-2"]), ["meal-1"]);
  assert.deepEqual(decisionTransactionIds(group.rows, "unsure"), []);
});

test("auto-classified deduction detail uses estimated, customer-facing evidence and a bounded transaction list", async () => {
  const { DeductionMonthDetailModal } = await loadTaxDashboardInternals();
  const selection = makeReviewSelection({
    accountName: "Software",
    taxCategory: "software_subscriptions",
    monthKey: "2026-06",
    longLabel: "June 2026",
    deductiblePercent: 100,
    amount: 200,
  });
  selection.cell.transactions[0] = {
    ...selection.cell.transactions[0],
    taxTreatment: "fully_deductible",
    taxTreatmentLabel: "Fully deductible",
    status: "auto_classified",
    statusLabel: "Auto-classified",
    requiresReview: false,
    deductibleAmount: 200,
  };
  selection.cell.authoritativeDeductibleTotal = 200;
  selection.cell.proposedDeductibleTotal = 0;
  const html = renderToStaticMarkup(React.createElement(DeductionMonthDetailModal, {
    selection,
    onClose: () => {},
    onRefresh: async () => {},
  }));

  assert.match(html, /Estimated/);
  assert.match(html, /Estimated deductible/);
  assert.match(html, /Why this estimate/);
  assert.match(html, /Transactions \(1\)/);
  assert.doesNotMatch(html, /expense-category rule evidence|Classification evidence|transactions loaded/);
});

test("review dialogs trap focus, close with Escape, and fail vehicle questions closed", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /function ReviewDecisionModal/);
  assert.match(dashboard, /event\.key === "Escape"/);
  assert.match(dashboard, /const focusable = getFocusableElements\(modalRef\.current\)/);
  assert.match(dashboard, /Vehicle setup unavailable/);
  assert.match(dashboard, /not linked to a verified vehicle for this tax year/);
  assert.doesNotMatch(dashboard, /Continue to vehicle setup/);
  assert.doesNotMatch(dashboard, /Review vehicle transactions/);
});

test("Tax Dashboard displays explicit decision actions instead of generic zero-dollar conclusions", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /Set business-use percentage/);
  assert.match(dashboard, /Edit business-use percentage/);
  assert.match(dashboard, /Confirm business use/);
  assert.match(dashboard, /Choose vehicle method/);
  assert.match(dashboard, /Vehicle setup unavailable/);
  assert.match(dashboard, /reviewDecisionForRow\(row\)\.actionLabel/);
  assert.match(dashboard, /Needs input/);
  assert.match(dashboard, /Standard estimate/);
});

test("Tax Dashboard recomputes review-required proposed amounts from percent instead of trusting gross stored totals", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /classificationBucket\(row\) === "needs_review"[\s\S]{0,220}Math\.abs\(normalizeMoney\(row\.amount\)\) \* \(percent \/ 100\)/);
  assert.match(dashboard, /function roundCurrency/);
  assert.doesNotMatch(dashboard, /const proposedAmount = bucket === "needs_review" \? row\.deductibleAmount/);
});

test("Tax Dashboard review decisions reuse existing override authority and preserve audit history", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const hook = fs.readFileSync("src/hooks/tax/useTaxDeductions.js", "utf8");
  const service = fs.readFileSync("src/services/tax/taxClassificationOverride.service.js", "utf8");
  assert.match(dashboard, /deductions\.bulkUpdateClassifications/);
  assert.match(dashboard, /reason: "Assigned from Deductions review\."/);
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
  assert.match(dashboard, /Estimated deductible/);
  assert.match(dashboard, /Estimated percentage/);
  assert.match(dashboard, /The estimate shown is based on the category and details currently available/);
  assert.match(dashboard, /Not calculated/);
  assert.doesNotMatch(dashboard, /cell\.selectedAuthority === "proposed" \? "Proposed needs-review amounts" : "Automatic deductions"/);
  assert.doesNotMatch(dashboard, /Why this needs review/);
  assert.match(dashboard, /Why this estimate/);
  assert.match(dashboard, /estimated from the \$\{accountName \|\| "posted"\} category in QuickBooks/);
  assert.match(dashboard, /No additional information is currently required/);
  assert.doesNotMatch(dashboard, /QuickBooks categorized/);
  assert.doesNotMatch(dashboard, /Sourced from posted QuickBooks/);
  assert.doesNotMatch(dashboard, /This row already has confirmed rule-engine treatment/);
});

test("Deduction detail modal renders customer-facing review explanations and resolution workflows", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /These expenses are in the Meals category in QuickBooks/);
  assert.match(dashboard, /These expenses are in the Utilities category in QuickBooks/);
  assert.match(dashboard, /Tell us what portion was used for business/);
  assert.match(dashboard, /These expenses are in a transportation category in QuickBooks/);
  assert.match(dashboard, /These expenses are in a vehicle expense category in QuickBooks/);
  assert.match(dashboard, /Choose how you track this vehicle’s business use before Bizzi estimates the deduction/);
  assert.match(dashboard, /These expenses are in the Supplies category in QuickBooks/);
  assert.match(dashboard, /Needs input/);
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
  assert.doesNotMatch(dashboard, /value="unsure" current=\{vehicleMethod\}/);
  assert.doesNotMatch(dashboard, /value="needs_tax_review" current=\{vehicleMethod\}/);
  assert.match(dashboard, /Until then, these expenses stay in Needs input/);
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
  assert.match(dashboard, /Business use percentage/);
  assert.match(dashboard, /Save and confirm/);
  assert.match(dashboard, /Not sure yet/);
  assert.match(dashboard, /How do you deduct vehicle expenses/);
  assert.match(dashboard, /Standard mileage/);
  assert.match(dashboard, /Actual vehicle expenses/);
  assert.match(dashboard, /context\.kind === "vehicle_method" \? "Decide later"/);
  assert.match(dashboard, /Vehicle setup unavailable/);
  assert.match(dashboard, /Confirm selected as business meals/);
  assert.match(dashboard, /Mark selected as personal meals/);
  assert.match(dashboard, /Confirm selected as business trips/);
  assert.match(dashboard, /Mark selected as personal or commuting/);
  assert.match(dashboard, /Leave personal or undocumented expenses unselected so they stay in Needs input/);
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

  assert.match(html, /Needs input/);
  assert.match(html, /Set business use/);
  assert.match(html, /How much of this account is used for business/);
  assert.match(html, /100% business/);
  assert.match(html, /Mixed business and personal use/);
  assert.match(html, /Personal - 0%/);
  assert.match(html, /Estimated percentage<\/div><div[^>]*>Not estimated yet<\/div>/);
  assert.match(html, /selected/);
  assert.match(html, /in expenses/);
  assert.doesNotMatch(html, /Apply to/);
  assert.doesNotMatch(html, /All matching QBO GL transactions for 2026/);
  assert.match(html, /Save and confirm/);
  assert.match(html, /Not sure yet/);
  assert.match(html, /These expenses are in the Utilities category in QuickBooks/);
  assert.match(html, /Tell us what portion was used for business/);
  assert.doesNotMatch(html, /calculated the confirmed deduction/);
  assert.doesNotMatch(html, /QuickBooks categorized/);
  assert.doesNotMatch(html, /Why this needs review/);
  assert.doesNotMatch(html, /This GL account going forward/);
});

test("Deduction detail modal keeps Gas unresolved when verified vehicle identity is unavailable", async () => {
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

  assert.match(html, /Needs input/);
  assert.match(html, /Choose vehicle deduction method/);
  assert.match(html, /not linked to a verified vehicle for this tax year/);
  assert.match(html, /remain in Needs input/);
  assert.doesNotMatch(html, /name="deduction-vehicle-method"/);
  assert.doesNotMatch(html, /Standard mileage/);
  assert.doesNotMatch(html, /Actual vehicle expenses/);
  assert.match(html, /Vehicle setup unavailable/);
  assert.match(html, /disabled/);
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
  assert.match(dashboard, /Leave personal or undocumented expenses unselected so they stay in Needs input/);
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

  assert.match(html, /Reviewed treatment/);
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
  assert.match(dashboard, /Return to Needs input/);
  assert.match(dashboard, /clearUserOverride: true/);
  assert.match(routes, /allowUserConfirmedEdit/);
  assert.match(service, /hasProtectedConfirmedAuthority/);
  assert.match(service, /input\.allowUserConfirmedEdit/);
  assert.match(migration, /when v_item \? 'user_override'/);
});

test("annual deductions bank lookups stay below proxy request-line limits", () => {
  const engine = fs.readFileSync("src/services/tax/taxDeductionsEngine.js", "utf8");
  assert.match(engine, /BANK_TRANSACTION_CHUNK_SIZE = 100/);
  assert.match(engine, /transactionIds\.slice\(i, i \+ BANK_TRANSACTION_CHUNK_SIZE\)/);
  assert.doesNotMatch(engine, /transactionIds\.slice\(i, i \+ 500\)/);
});

test("Tax workspace keeps null classification and missing treatment evidence visible", () => {
  const nullClassification = mapDeductionTransactionRow({
    transactionId: "null-classification",
    classification: null,
    date: "2026-10-01",
    qboAccountId: "expense-1",
    qboAccountName: "Meals",
    absoluteAmount: 17,
  });
  const missingCategory = mapDeductionTransactionRow({
    transactionId: "missing-category",
    classification: { taxTreatment: "ordinary_expense" },
    date: "2026-10-02",
    qboAccountId: "expense-2",
    qboAccountName: "Meals",
    absoluteAmount: 18,
  });
  const missingTreatment = mapDeductionTransactionRow({
    transactionId: "missing-treatment",
    classification: { taxCategory: "business_meals" },
    date: "2026-10-03",
    qboAccountId: "expense-3",
    qboAccountName: "Meals",
    absoluteAmount: 19,
  });
  const unresolved = mapDeductionTransactionRow({
    transactionId: "valid-unresolved",
    classificationStatus: "needs_review",
    taxCategory: "unclassified",
    taxTreatment: "not_determined",
    date: "2026-10-04",
    qboAccountId: "expense-4",
    qboAccountName: "Meals",
    absoluteAmount: 20,
  });

  for (const row of [nullClassification, missingCategory, missingTreatment]) {
    assert.equal(row.taxDataUnavailable, true);
    assert.equal(row.taxCategory, null);
    assert.equal(row.taxTreatment, null);
    assert.equal(row.taxCategoryLabel, "Tax treatment unavailable");
    assert.equal(row.taxTreatmentLabel, "Bookkeeping follow-up");
  }
  assert.equal(unresolved.taxDataUnavailable, false);
  assert.equal(unresolved.taxCategory, "unresolved");
  assert.equal(unresolved.taxTreatmentLabel, "Not determined");
});

test("Tax Dashboard does not combine mismatched refresh snapshots or crash on nullable rule state", async () => {
  const {
    DeductionDecisionRuleEditor,
    DeductionDecisionRulesPanel,
    TaxDashboardDeductions,
    buildClassificationWorkspaceRows,
  } = await loadTaxDashboardInternals();
  const workspaceRows = buildClassificationWorkspaceRows({
    allTransactions: {
      taxSnapshotId: 2,
      rows: [{
        transactionId: "fresh-classification",
        date: "2026-10-12",
        qboAccountId: "meals-id",
        qboAccountName: "Meals",
        absoluteAmount: 24,
        taxCategory: "business_meals",
        taxTreatment: "ordinary_expense",
        classificationStatus: "auto_classified",
        taxScopeDisposition: "expense_cogs_in_matrix",
      }],
    },
    postedTransactions: {
      taxSnapshotId: 1,
      rows: [{ transactionId: "stale-posted", transactionDate: "2026-10-12", qboAccountId: "meals-id", qboAccountName: "Meals", absoluteAmount: 99 }],
    },
    isDemo: false,
  });
  assert.equal(workspaceRows.length, 1);
  assert.equal(workspaceRows[0].id, "fresh-classification");

  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(DeductionDecisionRuleEditor, {
    rule: null,
    readOnly: true,
    onClose: () => {},
    onSave: async () => {},
  })));
  const rulesHtml = renderToStaticMarkup(React.createElement(DeductionDecisionRulesPanel, {
    rules: [null],
    readOnly: true,
    onChangeRule: () => {},
  }));
  assert.match(rulesHtml, /Tax treatment unavailable/);
  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(TaxDashboardDeductions, {
    businessId: null,
    year: 2026,
    readOnly: true,
  })));
});

test("built-in deduction defaults stay GL-scoped while grouping related Gas, Rent, and Utilities accounts", async () => {
  const { buildDeductionDefaultSetupOptions, DeductionDefaultSetupEditor } = await loadTaxDashboardInternals();
  const setups = buildDeductionDefaultSetupOptions({
    year: 2026,
    workspaceRows: [
      { id: "gas-transaction", qboAccountName: "Gas", taxCategory: "vehicle" },
      { id: "rent-transaction", qboAccountName: "Office Rent", taxCategory: "rent" },
      { id: "electric-transaction", qboAccountName: "Electric", taxCategory: "utilities" },
      { id: "internet-transaction", qboAccountName: "Internet & Wi-Fi", taxCategory: "utilities" },
      { id: "water-transaction", qboAccountName: "Water/Sewer", taxCategory: "utilities" },
      { id: "meals-transaction", qboAccountName: "Meals", taxCategory: "business_meals" },
    ],
    rules: [
      {
        id: "gas-rule",
        accountName: "Gas",
        accountKey: "gas",
        taxCategory: "vehicle",
        taxTreatment: "vehicle_standard_mileage_no_separate_gas",
        deductiblePercent: 0,
      },
      {
        id: "electric-rule",
        accountName: "Electric",
        accountKey: "electric",
        taxCategory: "utilities",
        taxTreatment: "utilities_business_use_percentage",
        deductiblePercent: 100,
      },
    ],
  });

  const gas = setups.find((setup) => setup.id === "vehicle");
  const rent = setups.find((setup) => setup.id === "rent");
  const utilities = setups.find((setup) => setup.id === "utilities");
  assert.equal(gas.status, "configured");
  assert.equal(gas.initialVehicleMethod, "standard_mileage");
  assert.deepEqual(gas.accountOptions.map((account) => account.accountName), ["Gas"]);
  assert.equal(rent.status, "not_started");
  assert.deepEqual(rent.accountOptions.map((account) => account.accountName), ["Office Rent"]);
  assert.equal(utilities.status, "partial");
  assert.deepEqual(utilities.accountOptions.map((account) => account.accountName), ["Electric", "Internet & Wi-Fi", "Water/Sewer"]);
  assert.equal(utilities.accountOptions.find((account) => account.accountName === "Electric").hasSavedRule, true);
  assert.equal(utilities.accountOptions.find((account) => account.accountName === "Water/Sewer").hasSavedRule, false);

  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(DeductionDefaultSetupEditor, {
    setup: null,
    readOnly: true,
    onClose: () => {},
    onSave: async () => {},
  })));
});

test("Tax deductions keep editable defaults collapsed below the monthly workspace", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const defaultsIndex = dashboard.indexOf("<DeductionDecisionRulesPanel");
  const tabsIndex = dashboard.indexOf("<WorkspaceViewTabs");
  const matrixIndex = dashboard.indexOf("<DeductionAccountMatrix");
  assert.ok(defaultsIndex > -1, "built-in deduction defaults should be rendered");
  assert.ok(defaultsIndex > matrixIndex && matrixIndex > tabsIndex, "deduction defaults should appear after the matrix");
  assert.match(dashboard, /Rules and defaults/);
  assert.match(dashboard, /future posted transactions/);
  assert.match(dashboard, /transaction-specific exception can still be reviewed separately/);
});
