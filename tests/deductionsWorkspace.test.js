import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import {
  buildDeductionsWorkspaceViewModel,
  mapDeductionTransactionRow,
} from "../src/components/Tax/Deductions/deductionsWorkspaceViewModel.js";

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
  assert.equal(row.statusLabel, "Estimated");
  assert.equal(row.amount, 240);
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
  assert.match(dashboard, /label="Processing"/);
  assert.match(dashboard, /bizzi-progress-fill/);
  assert.match(dashboard, /aria-live="polite"/);
});

test("Tax Dashboard does not let processed job count masquerade as classified count", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /processedTotal: jobProcessed/);
  assert.doesNotMatch(dashboard, /classifiedTotal: jobProcessed/);
  assert.match(dashboard, /bucketClassified/);
});

test("Prepare deductions accepts quickly and refreshes via polling, not a blocking full reload", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const hook = fs.readFileSync("src/hooks/tax/useTaxDeductions.js", "utf8");
  assert.doesNotMatch(hook, /const result = await prepareTaxClassifications[\s\S]{0,120}await load\(\)/);
  assert.match(hook, /setClassificationJobStatus\(job \|\| null\)/);
  assert.match(dashboard, /Deductions preparation started\./);
  assert.match(dashboard, /Starting deductions preparation\.\.\./);
  assert.match(dashboard, /Deductions preparation complete\./);
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
