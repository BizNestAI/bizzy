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

test("Tax Dashboard does not present missing classification authority as zero deductible", () => {
  const dashboard = fs.readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(dashboard, /No deduction total is shown until classification authority exists/);
  assert.doesNotMatch(dashboard, /0 deductible/);
});
