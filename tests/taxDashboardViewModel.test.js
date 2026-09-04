import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTaxDashboardViewModel } from "../src/components/Tax/taxDashboardViewModel.js";

test("dashboard view model preserves null and known zero distinctly", () => {
  const model = buildTaxDashboardViewModel({
    meta: { taxYear: 2026, status: "completed" },
    readiness: { estimateReady: true, reserveReady: true },
    summary: {
      projectedTotalTax: null,
      taxPaidAndWithheldYtd: 0,
      remainingProjectedLiability: null,
    },
  });
  assert.equal(model.primaryMetrics.projectedTotalTax, null);
  assert.equal(model.primaryMetrics.paidAndWithheldYtd, 0);
  assert.equal(model.primaryMetrics.remainingLiability, null);
});

test("dashboard view model treats null tax profile as missing setup instead of throwing", () => {
  const model = buildTaxDashboardViewModel({
    meta: { taxYear: 2026, status: "unavailable" },
    readiness: {
      status: "unavailable",
      estimateReady: false,
      reserveReady: false,
      setupState: { code: "profile_incomplete" },
    },
    profile: null,
    summary: {},
  });

  assert.equal(model.status.isUnavailable, true);
  assert.deepEqual(model.profileSummary.fields, []);
  assert.equal(model.profileSummary.complete, false);
  assert.equal(model.status.setupState.message, "Complete your tax profile so Bizzi can estimate your federal and state taxes.");
});

test("dashboard view model exposes a date-only next deadline KPI model", () => {
  const model = buildTaxDashboardViewModel({
    meta: { taxYear: 2026, status: "completed" },
    readiness: { estimateReady: true, reserveReady: true },
    profile: { primaryTaxState: "NC" },
    deadlines: [
      { type: "estimated_payment", label: "Q3 estimated payment", dueDate: "2026-09-15", status: "upcoming" },
    ],
    summary: { projectedTotalTax: 24800 },
  });

  assert.equal(model.primaryMetrics.nextDeadline.date, "2026-09-15");
  assert.equal(model.primaryMetrics.nextDeadline.label, "Q3 estimated payment");
  assert.equal(model.primaryMetrics.nextDeadline.type, "estimated_payment");
  assert.equal(model.primaryMetrics.nextPaymentAmount, null);
});

test("dashboard view model preserves ready-to-classify state without profile setup copy", () => {
  const model = buildTaxDashboardViewModel({
    data_status: "ready_to_classify",
    meta: { taxYear: 2026, status: "ready_to_classify" },
    readiness: {
      estimateReady: false,
      setupState: {
        code: "ready_to_classify",
        message: "Your Tax Profile is complete. Prepare your posted QuickBooks transactions for tax treatment.",
      },
    },
    classification_summary: {
      posted_transaction_count: 205,
      classified_transaction_count: 0,
      unclassified_transaction_count: 205,
      review_required_transaction_count: 0,
      processing_transaction_count: 0,
      failed_transaction_count: 0,
    },
    surface_readiness: {
      liability: {
        status: "ready_to_classify",
        ready: false,
        message: "Your Tax Profile is complete. Prepare your posted QuickBooks transactions for tax treatment.",
      },
      deductions: {
        status: "ready_to_classify",
        ready: false,
        message: "205 posted QuickBooks transactions are awaiting tax classification before deductible totals can be calculated.",
      },
      deadline: {
        status: "available",
        ready: true,
        amount_status: "estimated_payment_amount_pending",
      },
    },
    deadlines: [{ label: "Federal estimated tax Q3", dueDate: "2026-09-15", status: "upcoming" }],
  });

  assert.equal(model.status.setupState.code, "ready_to_classify");
  assert.equal(model.classificationSummary.postedTransactionCount, 205);
  assert.equal(model.classificationSummary.unclassifiedTransactionCount, 205);
  assert.equal(model.surfaceReadiness.deadline.ready, true);
  assert.equal(model.surfaceReadiness.deadline.amountStatus, "estimated_payment_amount_pending");
  assert.match(model.narrative, /Prepare your posted QuickBooks transactions/);
  assert.doesNotMatch(model.narrative, /Complete your tax profile/i);
});

test("dashboard view model represents partial federal-only state and safe harbor unavailable", () => {
  const model = buildTaxDashboardViewModel({
    meta: { taxYear: 2026, status: "partial" },
    readiness: {
      status: "partial",
      estimateReady: true,
      reserveReady: false,
      setupState: { code: "state_rules_missing", status: "partial" },
    },
    summary: { projectedFederalTax: 12000, projectedStateTax: null },
    safeHarbor: {
      status: "unavailable",
      warnings: [{ code: "prior_year_tax_missing", message: "Prior-year tax is required." }],
    },
    reserve: { status: "setup_incomplete", reserveBalance: null },
    confidence: { level: "medium", score: 74, estimateReady: true, reserveReady: false },
  });
  assert.equal(model.status.isPartial, true);
  assert.equal(model.status.estimateReady, true);
  assert.equal(model.status.reserveReady, false);
  assert.equal(model.status.setupState.message, "Federal estimate is available. State tax is not yet supported for this setup.");
  assert.equal(model.taxBreakdown.federalIncomeTax, 12000);
  assert.equal(model.taxBreakdown.stateTax, null);
  assert.equal(model.safeHarbor.status, "unavailable");
  assert.equal(model.safeHarbor.requiredAnnual, null);
  assert.equal(model.primaryMetrics.reserveGap, null);
});

test("dashboard view model renders unknown LLC election setup without component amounts", () => {
  const model = buildTaxDashboardViewModel({
    meta: { taxYear: 2026, status: "partial" },
    readiness: { estimateReady: false, setupState: { code: "entity_unknown" } },
    profile: { entityType: "unknown", taxElection: "unknown" },
    summary: { projectedFederalTax: 0, projectedSelfEmploymentTax: 0 },
  });
  assert.equal(model.status.estimateReady, false);
  assert.equal(model.status.setupState.message, "Tell Bizzi how your LLC is taxed before using this estimate.");
  assert.equal(model.taxBreakdown.isUnknownEntity, true);
  assert.equal(model.taxBreakdown.selfEmploymentTax, null);
});

test("dashboard view model distinguishes sole proprietor and S-Corp breakdown semantics", () => {
  const soleProp = buildTaxDashboardViewModel({
    meta: { taxYear: 2026 },
    readiness: { estimateReady: true },
    profile: { entityType: "sole_proprietor", taxElection: "sole_proprietor" },
    summary: { projectedFederalTax: 9000, projectedSelfEmploymentTax: 3500, projectedStateTax: 1200 },
  });
  assert.equal(soleProp.taxBreakdown.selfEmploymentTax, 3500);
  assert.equal(soleProp.taxBreakdown.sCorpContext, null);

  const sCorp = buildTaxDashboardViewModel({
    meta: { taxYear: 2026 },
    readiness: { estimateReady: true },
    profile: { entityType: "s_corp", taxElection: "s_corp" },
    summary: { projectedFederalTax: 9000, projectedSelfEmploymentTax: 0, projectedStateTax: 1200 },
  });
  assert.equal(sCorp.taxBreakdown.selfEmploymentTax, null);
  assert.match(sCorp.taxBreakdown.sCorpContext, /pass-through income/);
});

test("dashboard view model surfaces QBI deferred and confidence readiness", () => {
  const model = buildTaxDashboardViewModel({
    meta: { taxYear: 2026 },
    readiness: { estimateReady: true, reserveReady: false },
    confidence: {
      level: "low",
      score: 42,
      blockers: [{ code: "classification_review", message: "Review transactions." }],
      improvementActions: [{ code: "review", label: "Review transactions", route: "/tax" }],
    },
    supportedButDeferred: [{ code: "qbi_deduction", message: "QBI deferred." }],
  });
  assert.equal(model.confidence.level, "low");
  assert.equal(model.confidence.estimateReady, true);
  assert.equal(model.confidence.reserveReady, false);
  assert.equal(model.confidence.topBlocker.message, "Review transactions.");
  assert.equal(model.confidence.topImprovementAction.label, "Review transactions");
  assert.equal(model.taxBreakdown.qbiDeferred, true);
});

test("TaxDashboard consumes canonical overview and excludes stale integrations", () => {
  const source = readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  assert.match(source, /useTaxOverview/);
  assert.doesNotMatch(source, /useTaxLiability/);
  assert.doesNotMatch(source, /getHeroInsight|TEMP_DEBUG|AgendaWidget|useRightExtras|setRightExtras/);
  assert.doesNotMatch(source, /fetch\(|calculate-tax-liability|\/api\/tax\//);
  assert.match(source, /refreshCalculation/);
  assert.doesNotMatch(source, /setTaxYear|tax-year-select/);
});

test("TaxDashboard layout keeps responsive stacking and loading skeletons", () => {
  const source = readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const trendCard = readFileSync("src/components/Tax/TaxTrendCard.jsx", "utf8");
  assert.match(source, /grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4/);
  assert.match(source, /xl:grid-cols-\[minmax\(0,1\.45fr\)_minmax\(320px,0\.85fr\)\]/);
  assert.match(trendCard, /As of/);
  assert.doesNotMatch(trendCard, /Updated just now|lastRefreshed|RefreshCw/);
  assert.match(source, /DashboardSkeleton/);
  assert.match(source, /Keeping the last calculation on screen/);
});
