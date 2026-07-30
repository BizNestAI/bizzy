import test from "node:test";
import assert from "node:assert/strict";

import { buildTaxWorkpaperLedger } from "../src/services/tax/workpaper/taxWorkpaperLedger.js";
import { persistWorkpaperForRun } from "../src/services/tax/runs/taxRunPersistence.service.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

test("canonical workpaper ledger reconciles annual income, deductions, taxable profit, federal, state, total tax, payments, and reserve", () => {
  const workpaper = buildTaxWorkpaperLedger({ canonicalResult: canonicalResult() });

  assert.equal(workpaper.reconciliation.ok, true);
  assert.equal(workpaper.reconciliationStatus, "reconciled");
  assert.equal(line(workpaper, "annual_income_bridge:projected_annual_income").amount, 180000);
  assert.equal(line(workpaper, "deductions:confirmed_deductible_expenses").amount, 15000);
  assert.equal(line(workpaper, "deductions:estimated_deductible_expenses").amount, 20000);
  assert.equal(line(workpaper, "business_taxable_income_bridge:projected_business_taxable_profit").amount, 120000);
  assert.equal(line(workpaper, "federal_bridge:federal_taxable_income").amount, 101522);
  assert.equal(line(workpaper, "state_bridge:state_taxable_income").amount, 101522);
  assert.equal(line(workpaper, "total_tax_components:projected_annual_tax").amount, 42956);
  assert.equal(line(workpaper, "remaining_liability:remaining_projected_liability").amount, 41156);
  assert.equal(line(workpaper, "reserve_bridge:recommended_reserve").amount, 45271.6);
});

test("workpaper ledger persists rule versions and exact payment records applied to the run", async () => {
  const store = storeWithRun("run-1");
  const supabase = { store };
  const workpaper = await persistWorkpaperForRun({
    supabase,
    runId: "run-1",
    businessId: BUSINESS_ID,
    canonicalResult: canonicalResult(),
    finalizedRun: store.tax_calculation_runs[0],
  });

  assert.equal(store.tax_calculation_workpaper_lines.length, workpaper.lineCount || workpaper.lines.length);
  assert.equal(store.tax_calculation_runs[0].workpaper_status, "partial");
  assert.equal(store.tax_calculation_runs[0].calculation_graph_version, "tax-calculation-graph-v1");
  assert.equal(store.tax_calculation_runs[0].calculation_graph_node_count, store.tax_calculation_nodes.length);
  assert.ok(store.tax_calculation_runs[0].calculation_input_snapshot.hash);
  assert.equal(store.tax_calculation_runs[0].rule_version_map.federal.federalIncomeTaxBrackets, "fed-brackets-v1");
  assert.equal(store.tax_calculation_runs[0].rule_version_map.state.individualIncomeTax, "state-v1");
  assert.deepEqual(store.tax_calculation_runs[0].payment_application_summary.appliedPaymentIds, ["fed-est", "fed-wh", "state-est"]);

  const paymentLine = store.tax_calculation_workpaper_lines.find((row) => row.code === "payment_application_snapshot:fed-est");
  const graphNode = store.tax_calculation_nodes.find((row) => row.node_code === "annual_income_bridge:projected_annual_income");
  assert.equal(paymentLine.metadata.paymentId, "fed-est");
  assert.equal(paymentLine.metadata.appliedAmount, 1000);
  assert.equal(paymentLine.source_refs[0].id, "fed-est");
  assert.deepEqual(graphNode.child_node_codes, [
    "annual_income_bridge:actual_ytd_income",
    "annual_income_bridge:projected_remaining_income",
  ]);
  const inputByNodeCode = Object.fromEntries(graphNode.input_values.map((input) => [input.nodeCode, input.amount]));
  assert.equal(inputByNodeCode["annual_income_bridge:actual_ytd_income"], 100000);
  assert.equal(inputByNodeCode["annual_income_bridge:projected_remaining_income"], 80000);
  assert.equal(graphNode.reconciliation_status, "reconciled");
});

test("payment bridge separates confirmed payments, credits, withholding, and unapplied records", () => {
  const payments = [
    payment({ id: "fed-current", jurisdiction: "federal", paymentType: "estimated_payment", amount: 5000, period: "q1", confirmationNumber: "IRS-1" }),
    payment({ id: "state-current", jurisdiction: "state", stateCode: "NC", paymentType: "estimated_payment", amount: 1200, period: "q1" }),
    payment({ id: "withheld", jurisdiction: "federal", paymentType: "withholding", amount: 6200 }),
    payment({ id: "credit-forward", jurisdiction: "federal", paymentType: "prior_year_credit", amount: 700 }),
    payment({ id: "ptet-credit", jurisdiction: "state", stateCode: "NC", paymentType: "ptet_payment", amount: 300, metadata: { ownerCredit: true } }),
    payment({ id: "pending-bank", jurisdiction: "federal", paymentType: "estimated_payment", amount: 900, source: "bank_match", status: "needs_review" }),
    payment({ id: "voided", jurisdiction: "federal", paymentType: "estimated_payment", amount: 800, status: "voided" }),
    payment({ id: "prior-year", jurisdiction: "federal", paymentType: "estimated_payment", taxYear: 2025, amount: 600 }),
    payment({ id: "entity-not-credit", jurisdiction: "state", stateCode: "NC", paymentType: "ptet_payment", amount: 500 }),
  ];
  const result = canonicalResult({ projectedTotalTax: 15000, payments });
  setLiabilityAndReserve(result, { projectedTotalTax: 15000, remaining: 1600, applied: 13400, overpayment: 0 });

  const workpaper = buildTaxWorkpaperLedger({ canonicalResult: result });

  assert.equal(line(workpaper, "payment_application_snapshot:confirmed_federal_payments").amount, 5000);
  assert.equal(line(workpaper, "payment_application_snapshot:confirmed_state_payments").amount, 1200);
  assert.equal(line(workpaper, "payment_application_snapshot:confirmed_withholding").amount, 6200);
  assert.equal(line(workpaper, "payment_application_snapshot:confirmed_prior_year_credits").amount, 700);
  assert.equal(line(workpaper, "payment_application_snapshot:confirmed_ptet_entity_credits").amount, 300);
  assert.equal(line(workpaper, "payment_application_snapshot:pending_unapplied_payments").amount, 2800);
  assert.equal(line(workpaper, "remaining_liability:remaining_projected_liability").amount, 1600);
  assert.equal(workpaper.paymentApplicationSummary.totalApplied, 13400);
  assert.deepEqual(workpaper.paymentApplicationSummary.appliedPaymentIds, ["credit-forward", "fed-current", "ptet-credit", "state-current", "withheld"]);
  assert.deepEqual(workpaper.paymentApplicationSummary.unappliedPaymentIds, ["entity-not-credit", "pending-bank", "prior-year", "voided"]);

  const paymentLine = line(workpaper, "payment_application_snapshot:fed-current");
  assert.equal(paymentLine.metadata.date, "2026-04-15");
  assert.equal(paymentLine.metadata.jurisdiction, "federal");
  assert.equal(paymentLine.metadata.paymentType, "estimated_payment");
  assert.equal(paymentLine.metadata.taxYear, 2026);
  assert.equal(paymentLine.metadata.period, "q1");
  assert.equal(paymentLine.metadata.source, "manual");
  assert.equal(paymentLine.metadata.confirmationStatus, "posted");
  assert.equal(paymentLine.metadata.appliedComponent, "payments");
  assert.equal(paymentLine.metadata.appliedAmount, 5000);
  assert.equal(line(workpaper, "payment_application_snapshot:pending-bank").metadata.unappliedReason, "not_confirmed");
  assert.equal(line(workpaper, "payment_application_snapshot:voided").metadata.unappliedReason, "voided");
  assert.equal(line(workpaper, "payment_application_snapshot:prior-year").metadata.unappliedReason, "different_tax_year");
});

test("payment snapshot can derive projected overpayment without mutating historical runs", async () => {
  const store = {
    ...storeWithRun("run-1"),
    tax_calculation_runs: [
      ...storeWithRun("run-1").tax_calculation_runs,
      { ...storeWithRun("run-2").tax_calculation_runs[0] },
    ],
  };
  const supabase = { store };
  const first = canonicalResult({
    projectedTotalTax: 1000,
    payments: [
      payment({ id: "fed-a", jurisdiction: "federal", amount: 800 }),
      payment({ id: "withholding-a", jurisdiction: "federal", paymentType: "withholding", amount: 500 }),
    ],
  });
  first.liability.remainingProjectedLiability = null;
  first.liability.projectedOverpayment = null;
  await persistWorkpaperForRun({ supabase, runId: "run-1", businessId: BUSINESS_ID, canonicalResult: first, finalizedRun: store.tax_calculation_runs[0] });
  const firstRemaining = store.tax_calculation_workpaper_lines.find((row) => row.run_id === "run-1" && row.code === "remaining_liability:remaining_projected_liability");
  const firstOverpayment = store.tax_calculation_workpaper_lines.find((row) => row.run_id === "run-1" && row.code === "remaining_liability:projected_overpayment");
  const firstSnapshot = JSON.stringify(store.tax_calculation_workpaper_lines.filter((row) => row.run_id === "run-1"));

  const later = canonicalResult({
    projectedTotalTax: 1000,
    payments: [
      payment({ id: "fed-a", jurisdiction: "federal", amount: 800 }),
      payment({ id: "withholding-a", jurisdiction: "federal", paymentType: "withholding", amount: 500 }),
      payment({ id: "late-payment", jurisdiction: "state", stateCode: "NC", amount: 1000 }),
    ],
  });
  later.liability.remainingProjectedLiability = null;
  later.liability.projectedOverpayment = null;
  await persistWorkpaperForRun({ supabase, runId: "run-2", businessId: BUSINESS_ID, canonicalResult: later, finalizedRun: store.tax_calculation_runs[1] });

  assert.equal(firstRemaining.amount, 0);
  assert.equal(firstOverpayment.amount, 300);
  assert.equal(JSON.stringify(store.tax_calculation_workpaper_lines.filter((row) => row.run_id === "run-1")), firstSnapshot);
  assert.deepEqual(store.tax_calculation_runs.find((row) => row.id === "run-1").payment_application_summary.appliedPaymentIds, ["fed-a", "withholding-a"]);
  assert.deepEqual(store.tax_calculation_runs.find((row) => row.id === "run-2").payment_application_summary.appliedPaymentIds, ["fed-a", "late-payment", "withholding-a"]);
});

test("reserve bridge uses Reserve Engine outputs and current reserve does not reduce liability", () => {
  const result = canonicalResult({
    projectedTotalTax: 20000,
    payments: [
      payment({ id: "fed-paid", jurisdiction: "federal", amount: 5000 }),
      payment({ id: "state-paid", jurisdiction: "state", stateCode: "NC", amount: 2500 }),
    ],
  });
  setLiabilityAndReserve(result, { projectedTotalTax: 20000, remaining: 12500, applied: 7500, overpayment: 0 });
  result.reserve.liability.nextPaymentAmount = 3500;
  result.reserve.liability.safeHarborGap = 4500;
  result.reserve.reserve.targetBeforeBuffer = 12500;
  result.reserve.reserve.bufferAmount = 0;
  result.reserve.reserve.bufferPercent = 0;
  result.reserve.reserve.recommendedReserve = 12500;
  result.reserve.reserve.currentReserve = 4000;
  result.reserve.reserve.reserveGap = 8500;
  result.reserve.reserve.immediateTransferRecommended = 8500;
  result.reserve.reserve.reserveSource = "manual";
  result.reserve.cadence = { targetDate: "2026-09-15", daysUntilNextDeadline: 76, weeklySetAside: 782.89, monthlySetAside: 3405.92 };
  result.reserve.cashFlow = { transferAffordable: 6000, liquidityFloor: 10000 };
  result.reserve.confidence = { score: 0.82 };
  result.reserve.policy = { source: "profile", strategy: "remaining_liability", version: "reserve-policy-v1" };

  const workpaper = buildTaxWorkpaperLedger({ canonicalResult: result });

  assert.equal(workpaper.reconciliation.checks.find((row) => row.code === "reserve_bridge:recommended_reserve").status, "reconciled");
  assert.equal(line(workpaper, "reserve_bridge:remaining_projected_liability").amount, 12500);
  assert.equal(line(workpaper, "reserve_bridge:tax_expected_before_next_deadline").amount, 3500);
  assert.equal(line(workpaper, "reserve_bridge:expected_later_year_liability").amount, 9000);
  assert.equal(line(workpaper, "reserve_bridge:reserve_policy_adjustment").amount, 12500);
  assert.equal(line(workpaper, "reserve_bridge:uncertainty_adjustment").amount, 0);
  assert.equal(line(workpaper, "reserve_bridge:recommended_reserve").amount, 12500);
  assert.equal(line(workpaper, "reserve_bridge:current_reserve_balance").amount, 4000);
  assert.equal(line(workpaper, "reserve_bridge:reserve_gap").amount, 8500);
  assert.equal(line(workpaper, "reserve_bridge:suggested_transfer").amount, 8500);
  assert.equal(line(workpaper, "remaining_liability:remaining_projected_liability").amount, 12500);
  assert.match(line(workpaper, "reserve_bridge:current_reserve_balance").explanation, /does not reduce projected tax liability/);
  assert.equal(line(workpaper, "reserve_bridge:recommended_reserve").metadata.policyUsed, "remaining_liability");
  assert.equal(line(workpaper, "reserve_bridge:recommended_reserve").metadata.currentReserveSource, "manual");
});

test("reserve bridge preserves null inputs and discloses unsupported adjustments", () => {
  const result = canonicalResult();
  result.reserve.liability.nextPaymentAmount = null;
  result.reserve.reserve.targetBeforeBuffer = null;
  result.reserve.reserve.bufferAmount = null;
  result.reserve.reserve.bufferPercent = null;
  result.reserve.reserve.recommendedReserve = null;
  result.reserve.reserve.currentReserve = null;
  result.reserve.reserve.reserveGap = null;
  result.reserve.warnings = [{ code: "safe_harbor_unavailable", message: "Safe harbor target is unavailable.", severity: "medium", action: "Verify prior-year tax." }];
  result.reserveInput.recommendedReserveBeforeCashComparison = null;

  const workpaper = buildTaxWorkpaperLedger({ canonicalResult: result });

  assert.equal(line(workpaper, "reserve_bridge:tax_expected_before_next_deadline").amount, null);
  assert.equal(line(workpaper, "reserve_bridge:tax_expected_before_next_deadline").status, "unavailable");
  assert.equal(line(workpaper, "reserve_bridge:recommended_reserve").amount, null);
  assert.equal(line(workpaper, "reserve_bridge:recommended_reserve").status, "unavailable");
  assert.equal(line(workpaper, "reserve_bridge:current_reserve_balance").amount, null);
  assert.equal(line(workpaper, "reserve_bridge:unsupported:safe_harbor_unavailable").status, "review_required");
});

test("historical workpaper remains unchanged after later run with changed payments and rules", async () => {
  const store = {
    ...storeWithRun("run-1"),
    tax_calculation_runs: [
      ...storeWithRun("run-1").tax_calculation_runs,
      { ...storeWithRun("run-2").tax_calculation_runs[0] },
    ],
  };
  const supabase = { store };
  await persistWorkpaperForRun({ supabase, runId: "run-1", businessId: BUSINESS_ID, canonicalResult: canonicalResult(), finalizedRun: store.tax_calculation_runs[0] });
  const firstSnapshot = JSON.stringify(store.tax_calculation_workpaper_lines.filter((row) => row.run_id === "run-1"));

  const later = canonicalResult({
    projectedTotalTax: 50000,
    federalRuleVersion: "fed-brackets-v2",
    payments: [
      payment({ id: "new-fed", jurisdiction: "federal", paymentType: "estimated_payment", amount: 9000 }),
    ],
  });
  await persistWorkpaperForRun({ supabase, runId: "run-2", businessId: BUSINESS_ID, canonicalResult: later, finalizedRun: store.tax_calculation_runs[1] });

  assert.equal(JSON.stringify(store.tax_calculation_workpaper_lines.filter((row) => row.run_id === "run-1")), firstSnapshot);
  assert.equal(store.tax_calculation_runs.find((row) => row.id === "run-1").rule_version_map.federal.federalIncomeTaxBrackets, "fed-brackets-v1");
  assert.deepEqual(store.tax_calculation_runs.find((row) => row.id === "run-1").payment_application_summary.appliedPaymentIds, ["fed-est", "fed-wh", "state-est"]);
  assert.equal(store.tax_calculation_runs.find((row) => row.id === "run-2").rule_version_map.federal.federalIncomeTaxBrackets, "fed-brackets-v2");
});

test("unavailable workpaper values remain null and Tax Drivers fallback is not used in persistence", () => {
  const workpaper = buildTaxWorkpaperLedger({
    canonicalResult: canonicalResult({
      drivers: [{ code: "business_income", label: "Business income included", amount: 999999 }],
    }),
  });

  assert.equal(line(workpaper, "federal_bridge:qbi_deduction").amount, null);
  assert.equal(line(workpaper, "federal_bridge:qbi_deduction").status, "unavailable");
  assert.equal(workpaper.lines.some((row) => row.label === "Business income included"), false);
});

test("deduction category children reconcile to the persisted deduction parent with rule and drill-down lineage", () => {
  const workpaper = buildTaxWorkpaperLedger({ canonicalResult: canonicalResultWithDeductionCategories() });
  const parent = line(workpaper, "deductions:estimated_deductible_expenses");
  const materials = line(workpaper, "deductions:category:supplies_materials");
  const meals = line(workpaper, "deductions:category:meals");
  const equipment = line(workpaper, "deductions:category:equipment_asset");
  const review = line(workpaper, "deductions:category:other");
  const categoryCheck = workpaper.reconciliation.checks.find((row) => row.code === "deductions:category_children");

  assert.equal(parent.amount, 20000);
  assert.equal(categoryCheck.status, "reconciled");
  assert.equal(materials.amount, 15000);
  assert.equal(materials.parent_code, "deductions:estimated_deductible_expenses");
  assert.equal(materials.metadata.grossAmount, 15000);
  assert.equal(materials.metadata.transactionCount, 10);
  assert.equal(materials.metadata.ruleCode, "supplies_materials_ordinary");
  assert.equal(materials.rule_versions.supplies_materials_ordinary, "deduction-rule-v1");
  assert.equal(materials.drill_down_type, "deductions_workspace");
  assert.match(materials.drill_down_params.workspacePath, /\/dashboard\/tax\?/);
  assert.match(materials.drill_down_params.apiEndpoint, /\/api\/tax\/deductions\/transactions\?/);
  assert.equal(meals.metadata.deductiblePercent, 50);
  assert.equal(meals.metadata.grossAmount, 3000);
  assert.equal(meals.amount, 1500);
  assert.equal(meals.metadata.nondeductibleAmount, 1500);
  assert.equal(equipment.amount, 0);
  assert.equal(equipment.metadata.capitalizableAmount, 2500);
  assert.equal(review.status, "review_required");
  assert.equal(review.metadata.needsReviewAmount, 1000);
  assert.equal(line(workpaper, "deductions:excluded_transfers_owner_activity").amount, 600);
});

function line(workpaper, code) {
  const found = workpaper.lines.find((row) => row.code === code);
  assert.ok(found, `missing line ${code}`);
  return found;
}

function storeWithRun(id) {
  return {
    tax_calculation_runs: [{
      id,
      business_id: BUSINESS_ID,
      tax_year: 2026,
      status: "completed",
    }],
    tax_calculation_workpaper_lines: [],
  };
}

function canonicalResult(overrides = {}) {
  const projectedTotalTax = overrides.projectedTotalTax ?? 42956;
  const payments = overrides.payments || [
    payment({ id: "fed-est", jurisdiction: "federal", paymentType: "estimated_payment", amount: 1000 }),
    payment({ id: "fed-wh", jurisdiction: "federal", paymentType: "withholding", amount: 500 }),
    payment({ id: "state-est", jurisdiction: "state", stateCode: "NC", paymentType: "estimated_payment", amount: 300 }),
    payment({ id: "pending", jurisdiction: "federal", paymentType: "estimated_payment", amount: 999, status: "needs_review" }),
  ];
  const totalPaid = payments.filter((row) => ["posted", "confirmed", "active"].includes(row.status)).reduce((sum, row) => sum + row.amount, 0);
  const remaining = Math.max(0, projectedTotalTax - totalPaid);
  return {
    meta: {
      businessId: BUSINESS_ID,
      taxYear: 2026,
      asOfDate: "2026-07-01",
      engineVersions: {
        orchestrator: "orchestrator-v1",
        taxableIncome: "taxable-v1",
        projection: "projection-v1",
        federal: "federal-v1",
        selfEmployment: "se-v1",
        state: "state-v1",
        reserve: "reserve-v1",
      },
      sourceFreshness: { transactionClassifications: "available" },
    },
    profile: {
      profile: { id: "profile-1", updated_at: "2026-06-30T00:00:00Z" },
    },
    actuals: {
      coverage: { classifiedTransactions: 3, confirmedTransactions: 2, needsReviewTransactions: 1 },
      deductions: { categories: [] },
      taxableIncome: {
        revenue: { grossReceipts: 100000, otherBusinessIncome: 0, netBusinessRevenue: 100000 },
        expenses: {
          costOfGoodsSold: 20000,
          deductibleOperatingExpenses: 20000,
          estimatedDeductibleOperatingExpenses: 20000,
          confirmedDeductibleOperatingExpenses: 15000,
          nondeductibleBookExpenses: 0,
          capitalizableExpenditures: 3000,
          needsReviewAmount: 700,
        },
        adjustments: { increasesToTaxableIncome: 0, decreasesToTaxableIncome: 0 },
        businessTaxableIncome: { finalBusinessTaxableIncome: 60000 },
      },
    },
    projection: {
      method: "actual_only",
      actual: { revenue: 100000, taxableBusinessIncome: 60000, throughDate: "2026-07-01", monthsCompleted: 6 },
      projectedFuture: { revenue: 80000, taxableBusinessIncome: 60000, monthly: {} },
      projectedAnnual: { revenue: 180000, cogs: 20000, deductibleExpenses: 40000, taxableBusinessIncome: 120000 },
      methodology: { assumptions: ["Fixture projection."] },
    },
    entity: { entityPath: "single_member_llc_disregarded" },
    federal: {
      incomeTax: {
        meta: { ruleVersions: { federalIncomeTaxBrackets: overrides.federalRuleVersion || "fed-brackets-v1", standardDeduction: "standard-v1" } },
        income: {
          otherIncome: 0,
          adjustedGrossIncome: 111522,
          taxableIncomeAfterQbi: 101522,
          qbiDeduction: 0,
        },
        deductions: { standardDeduction: 10000 },
        tax: {
          federalIncomeTax: 20000,
          creditsApplied: 0,
          bracketBreakdown: [
            { taxableInBracket: 10000, rate: 0.1, tax: 1000 },
            { taxableInBracket: 30000, rate: 0.2, tax: 6000 },
            { taxableInBracket: 61522, rate: 0.2113, tax: 13000 },
          ],
        },
      },
      selfEmploymentTax: {
        meta: { ruleVersions: { selfEmploymentTax: "se-rule-v1" } },
        input: { annualNetBusinessIncome: 120000 },
        result: {
          netEarningsFromSelfEmployment: 110820,
          additionalMedicareTax: 0,
          totalSelfEmploymentTax: 16956,
          deductibleHalfSelfEmploymentTax: 8478,
        },
        detail: { socialSecurity: { taxableBase: 110820, rate: 0.124 } },
      },
    },
    state: {
      stateCode: "NC",
      individualIncomeTax: { status: "verified_calculated", amount: 6000 },
      entityTaxes: { sCorpMinimumTax: 0, sCorpEntityTax: 0, detail: {} },
      incomeTax: {
        meta: { ruleVersions: { individualIncomeTax: "state-v1" } },
        income: {
          federalAdjustedGrossIncomeInput: 111522,
          stateAdjustments: 0,
          stateTaxableIncome: 101522,
        },
        deductions: { standardDeduction: 10000, personalExemption: 0 },
        tax: {
          regularStateIncomeTax: 6000,
          localIncomeTax: null,
          passThroughEntityTax: null,
          sCorpMinimumTax: 0,
          sCorpEntityTax: 0,
          replacementTax: 0,
          grossReceiptsTax: 0,
          payrollExciseTax: 0,
        },
      },
    },
    payments: {
      source: "tax_payments",
      rows: payments,
      federal: { estimatedPayments: payments.filter((p) => p.jurisdiction === "federal" && p.paymentType === "estimated_payment" && p.status === "posted").reduce((s, p) => s + p.amount, 0), withholding: payments.filter((p) => p.jurisdiction === "federal" && p.paymentType === "withholding" && p.status === "posted").reduce((s, p) => s + p.amount, 0), priorYearCredits: 0, refundApplied: 0 },
      state: { estimatedPayments: payments.filter((p) => p.jurisdiction === "state" && p.paymentType === "estimated_payment" && p.status === "posted").reduce((s, p) => s + p.amount, 0), withholding: 0, priorYearCredits: 0, refundApplied: 0 },
    },
    liability: {
      projectedTotalTax,
      projectedOverpayment: 0,
      paymentsAndWithholdingYtd: totalPaid,
      remainingProjectedLiability: remaining,
      ytdTaxGeneratedEstimate: Math.round(projectedTotalTax * (181 / 364) * 100) / 100,
    },
    deadlines: [{ id: "q3", name: "Q3", dueDate: "2026-09-15" }],
    reserve: {
      snapshotId: "reserve-snapshot-1",
      policy: { source: "profile", strategy: "remaining_liability" },
      liability: { remainingProjectedLiability: remaining, nextPaymentAmount: null, nextPaymentDate: "2026-09-15" },
      reserve: { targetBeforeBuffer: remaining, bufferAmount: Math.round(remaining * 0.1 * 100) / 100, bufferPercent: 0.1, recommendedReserve: Math.round(remaining * 1.1 * 100) / 100 },
      cadence: { targetDate: "2026-09-15" },
    },
    reserveInput: { recommendedReserveBeforeCashComparison: Math.round(remaining * 1.1 * 100) / 100 },
    drivers: overrides.drivers || [],
  };
}

function canonicalResultWithDeductionCategories() {
  const result = canonicalResult();
  result.actuals.deductions.categories = [
    category({ taxCategory: "supplies_materials", displayName: "Materials", bookExpenseAmount: 15000, estimatedDeductibleAmount: 15000, transactionCount: 10, ruleCode: "supplies_materials_ordinary" }),
    category({ taxCategory: "contract_labor", displayName: "Contract labor", bookExpenseAmount: 3500, estimatedDeductibleAmount: 3500, transactionCount: 2, ruleCode: "contract_labor_ordinary" }),
    category({ taxCategory: "meals", displayName: "Meals", bookExpenseAmount: 3000, estimatedDeductibleAmount: 1500, nondeductibleAmount: 1500, averageDeductiblePercent: 50, transactionCount: 4, ruleCode: "meals_50_percent" }),
    category({ taxCategory: "equipment_asset", displayName: "Equipment", bookExpenseAmount: 2500, estimatedDeductibleAmount: 0, capitalizableAmount: 2500, averageDeductiblePercent: 0, transactionCount: 1, deductibilityStatus: "capitalizable", ruleCode: "equipment_capitalizable" }),
    category({ taxCategory: "other", displayName: "Other", bookExpenseAmount: 1000, estimatedDeductibleAmount: 0, needsReviewAmount: 1000, transactionCount: 1, status: "needs_review", ruleCode: null }),
  ];
  result.actuals.taxableIncome.expenses.balanceSheetActivityAmount = 600;
  return result;
}

function category(overrides = {}) {
  return {
    taxCategory: "supplies_materials",
    displayName: "Materials",
    bookExpenseAmount: 100,
    estimatedDeductibleAmount: 100,
    confirmedDeductibleAmount: 100,
    nondeductibleAmount: 0,
    capitalizableAmount: 0,
    needsReviewAmount: 0,
    averageDeductiblePercent: 100,
    transactionCount: 1,
    confidenceLevel: "high",
    rules: overrides.ruleCode ? [{ code: overrides.ruleCode, version: "deduction-rule-v1", supportLevel: "supported" }] : [],
    ...overrides,
  };
}

function payment(overrides = {}) {
  return {
    id: "payment",
    jurisdiction: "federal",
    stateCode: null,
    paymentType: "estimated_payment",
    taxYear: 2026,
    paymentDate: "2026-04-15",
    amount: 100,
    source: "manual",
    status: "posted",
    metadata: {},
    ...overrides,
  };
}

function setLiabilityAndReserve(result, { projectedTotalTax, remaining, applied, overpayment = 0 }) {
  result.liability.projectedTotalTax = projectedTotalTax;
  result.liability.paymentsAndWithholdingYtd = applied;
  result.liability.remainingProjectedLiability = remaining;
  result.liability.projectedOverpayment = overpayment;
  result.reserve.liability.remainingProjectedLiability = remaining;
  result.reserve.reserve.targetBeforeBuffer = remaining;
  result.reserve.reserve.bufferAmount = Math.round(remaining * 0.1 * 100) / 100;
  result.reserve.reserve.recommendedReserve = Math.round(remaining * 1.1 * 100) / 100;
  result.reserveInput.recommendedReserveBeforeCashComparison = result.reserve.reserve.recommendedReserve;
}
