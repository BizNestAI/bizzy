import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { Buffer } from "node:buffer";
import express from "express";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const { default: taxRouter } = await import("../src/api/tax/index.js");
const { getTaxCalculationWorkpaper } = await import("../src/services/tax/workpaper/taxWorkpaper.service.js");

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const HISTORICAL_RUN_ID = "44444444-4444-4444-8444-444444444444";
const LATEST_RUN_ID = "55555555-5555-4555-8555-555555555555";
const LEGACY_RUN_ID = "66666666-6666-4666-8666-666666666666";
const PARTIAL_RUN_ID = "77777777-7777-4777-8777-777777777777";
const FAILURE_RUN_ID = "88888888-8888-4888-8888-888888888888";

test("GET /api/tax/calculations/:runId/workpaper returns a complete canonical persisted workpaper", async () => {
  const app = createApp(baseStore());
  const res = await request(app, `/api/tax/calculations/${RUN_ID}/workpaper?businessId=${BUSINESS_ID}`, { token: "valid-user" });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const workpaper = res.body.data;
  assert.equal(workpaper.run.id, RUN_ID);
  assert.equal(workpaper.run.workpaperStatus, "complete");
  assert.equal(workpaper.basis.entityType, "single_member_llc");
  assert.equal(workpaper.summary.projectedAnnualTax, 24800);
  assert.equal(workpaper.summary.taxAttributableThroughToday, 13158);
  assert.equal(workpaper.summary.confirmedPayments, 12400);
  assert.equal(workpaper.summary.confirmedPaymentsAndWithholding, 12400);
  assert.equal(workpaper.summary.remainingProjectedLiability, 12400);
  assert.equal(workpaper.summary.recommendedReserve, 12400);
  assert.equal(workpaper.reconciliation.ready, true);
  assert.equal(workpaper.reconciliation.incomeBridgeBalanced, true);
  assert.equal(workpaper.reconciliation.paymentBridgeBalanced, true);
  assert.ok(workpaper.narrative.includes("projects total 2026 tax of $24,800"));
  assert.ok(workpaper.narrative.includes("$182,000 of actual income and $130,000 of projected remaining-year income"));
  assert.deepEqual(workpaper.sections.map((section) => section.code), [
    "source_period_income",
    "projected_remaining_year_income",
    "annual_income_bridge",
    "deductions",
    "business_taxable_income_bridge",
    "federal_bridge",
    "state_bridge",
    "total_tax_components",
    "payment_application_snapshot",
    "remaining_liability",
    "reserve_bridge",
    "through_date_tax",
  ]);
});

test("GET /api/tax/workpaper resolves the latest persisted run and supports section-level loading", async () => {
  const app = createApp(baseStore());
  const res = await request(app, `/api/tax/workpaper?businessId=${BUSINESS_ID}&tax_year=2026&section=remaining_liability`, { token: "valid-user" });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.run.id, LATEST_RUN_ID);
  assert.equal(res.body.data.sections.length, 1);
  assert.equal(res.body.data.sections[0].code, "remaining_liability");
  assert.equal(res.body.data.summary.remainingProjectedLiability, 12400);
  assert.equal(res.body.data.summary.projectedAnnualTax, 24800);
});

test("workpaper service returns partial sections, review items, assumptions, and material limitations", async () => {
  const store = baseStore();
  const workpaper = await getTaxCalculationWorkpaper({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    runId: PARTIAL_RUN_ID,
  });

  assert.equal(workpaper.run.workpaperStatus, "partial");
  assert.ok(workpaper.narrative.includes("partial"));
  assert.ok(workpaper.reviewItems.some((item) => item.code === "federal_bridge:qbi_deduction"));
  assert.ok(workpaper.exclusions.some((item) => item.includes("QBI deduction")));
  assert.ok(workpaper.assumptions.includes("Revenue projection uses current-year run-rate."));
});

test("workpaper service returns legacy runs without fabricating detailed bridges", async () => {
  const store = baseStore();
  const workpaper = await getTaxCalculationWorkpaper({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    runId: LEGACY_RUN_ID,
  });

  assert.equal(workpaper.run.workpaperStatus, "legacy_incomplete");
  assert.equal(workpaper.sections.length, 0);
  assert.equal(workpaper.summary.projectedAnnualTax, 24000);
  assert.equal(workpaper.summary.taxAttributableThroughToday, null);
  assert.equal(workpaper.reconciliation.ready, false);
  assert.ok(workpaper.suggestedAction.includes("newer tax calculation"));
});

test("historical immutable workpaper uses the persisted historical payment and rule snapshot", async () => {
  const store = baseStore();
  const workpaper = await getTaxCalculationWorkpaper({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    runId: HISTORICAL_RUN_ID,
  });

  assert.equal(workpaper.run.id, HISTORICAL_RUN_ID);
  assert.equal(workpaper.summary.confirmedPayments, 1000);
  assert.deepEqual(workpaper.paymentApplication.appliedPaymentIds, ["old-fed-est"]);
  assert.ok(workpaper.ruleVersions.some((row) => row.rule === "federalIncomeTaxBrackets" && row.version === "fed-2026-v0"));
  assert.equal(workpaper.history.immutable, true);
});

test("workpaper output exposes rule versions, payment snapshot, reserve bridge, and source metadata without raw ids in labels", async () => {
  const store = baseStore();
  const workpaper = await getTaxCalculationWorkpaper({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    runId: RUN_ID,
  });
  const paymentSection = workpaper.sections.find((section) => section.code === "payment_application_snapshot");
  const paymentLine = paymentSection.lines.find((line) => line.code === "payment_application_snapshot:fed-est");
  const incomeLine = workpaper.sections.find((section) => section.code === "source_period_income").lines[0];
  const reserveSection = workpaper.sections.find((section) => section.code === "reserve_bridge");

  assert.ok(workpaper.ruleVersions.some((row) => row.scope === "federal" && row.rule === "federalIncomeTaxBrackets"));
  assert.deepEqual(workpaper.paymentApplication.appliedPaymentIds, ["fed-est", "state-est"]);
  assert.equal(paymentLine.label, "Federal Estimated Payment");
  assert.equal(paymentLine.label.includes("fed-est"), false);
  assert.equal(paymentLine.source.referencesAvailable, true);
  assert.equal(paymentLine.paymentDetail.date, "2026-04-15");
  assert.equal(paymentLine.paymentDetail.jurisdiction, "federal");
  assert.equal(paymentLine.paymentDetail.paymentType, "estimated_payment");
  assert.equal(paymentLine.paymentDetail.taxYear, 2026);
  assert.equal(paymentLine.paymentDetail.period, "q1");
  assert.equal(paymentLine.paymentDetail.source, "manual");
  assert.equal(paymentLine.paymentDetail.confirmationStatus, "confirmed");
  assert.equal(paymentLine.paymentDetail.appliedComponent, "payments");
  assert.equal(paymentLine.paymentDetail.appliedAmount, 12400);
  assert.equal(incomeLine.source.count, 3);
  assert.ok(incomeLine.source.historicalSnapshotWarning);
  assert.equal(reserveSection.subtotal, 12400);
  const recommendedReserve = reserveSection.lines.find((line) => line.code === "reserve_bridge:recommended_reserve");
  const currentReserve = reserveSection.lines.find((line) => line.code === "reserve_bridge:current_reserve_balance");
  assert.equal(workpaper.summary.recommendedReserve, reserveSection.subtotal);
  assert.equal(workpaper.summary.currentReserve, 4000);
  assert.equal(workpaper.summary.reserveGap, 8400);
  assert.equal(workpaper.summary.suggestedTransfer, 8400);
  assert.equal(recommendedReserve.reserveDetail.nextDeadline, "2026-09-15");
  assert.equal(recommendedReserve.reserveDetail.confirmedPaymentsConsidered, 12400);
  assert.equal(recommendedReserve.reserveDetail.policySource, "profile");
  assert.equal(currentReserve.reserveDetail.currentReserveSource, "manual");
  assert.match(recommendedReserve.explanation, /current reserve balance is shown separately/);
});

test("workpaper deduction bridge exposes category children, source filters, and historical warnings from persisted ledger lines", async () => {
  const store = baseStore();
  const workpaper = await getTaxCalculationWorkpaper({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    runId: HISTORICAL_RUN_ID,
  });
  const deductions = workpaper.sections.find((section) => section.code === "deductions");
  const parent = deductions.lines.find((line) => line.code === "deductions:estimated_deductible_expenses");
  const materials = deductions.lines.find((line) => line.code === "deductions:category:supplies_materials");
  const meals = deductions.lines.find((line) => line.code === "deductions:category:meals");
  const capitalized = deductions.lines.find((line) => line.code === "deductions:capitalized_items");
  const excluded = deductions.lines.find((line) => line.code === "deductions:excluded_transfers_owner_activity");

  assert.equal(parent.amount, 14200);
  assert.equal(materials.parentCode, parent.code);
  assert.equal(materials.deductionCategory.categoryCode, "supplies_materials");
  assert.equal(materials.deductionCategory.grossAmount, 10000);
  assert.equal(materials.deductionCategory.deductibleAmount, 10000);
  assert.equal(materials.deductionCategory.transactionCount, 42);
  assert.equal(materials.deductionCategory.ruleCode, "supplies_materials_ordinary");
  assert.equal(materials.deductionCategory.ruleVersion, "deduction-v1");
  assert.equal(materials.source.endpoint.includes("/api/tax/deductions/transactions?"), true);
  assert.equal(materials.drillDown.type, "deductions_workspace");
  assert.equal(materials.drillDown.params.workspacePath.includes("/dashboard/tax?"), true);
  assert.equal(materials.drillDown.params.workspacePath.includes("taxCategory=supplies_materials"), true);
  assert.ok(materials.source.historicalSnapshotWarning.includes("Current transaction view may differ"));
  assert.equal(meals.deductionCategory.deductiblePercentage, 50);
  assert.equal(meals.deductionCategory.nondeductibleAmount, 1150);
  assert.equal(capitalized.amount, 2500);
  assert.equal(excluded.amount, 600);
});

test("reconciliation failures are explicit and do not return a ready workpaper", async () => {
  const store = baseStore();
  const workpaper = await getTaxCalculationWorkpaper({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    runId: FAILURE_RUN_ID,
  });

  assert.equal(workpaper.reconciliation.status, "out_of_balance");
  assert.equal(workpaper.reconciliation.ready, false);
  assert.equal(workpaper.reconciliation.taxComponentsBalanced, false);
  assert.equal(workpaper.reconciliation.taxComponentsBalancedDifference, 100);
  assert.ok(workpaper.narrative.includes("material reconciliation checks did not balance"));
});

test("workpaper response is not populated from frontend Tax Drivers fallback data", async () => {
  const store = baseStore();
  const workpaper = await getTaxCalculationWorkpaper({
    supabase: makeSupabase(store),
    businessId: BUSINESS_ID,
    runId: RUN_ID,
  });
  const text = JSON.stringify(workpaper);

  assert.equal(Object.hasOwn(workpaper, "drivers"), false);
  assert.equal(text.includes("Business income included"), false);
  assert.equal(text.includes("Tax Drivers"), false);
  assert.ok(text.includes("Actual business revenue YTD"));
});

function createApp(store) {
  const app = express();
  app.use(express.json());
  app.locals.supabase = makeSupabase(store);
  app.use("/api/tax", authStub, taxRouter);
  return app;
}

function authStub(req, res, next) {
  const auth = req.headers.authorization || "";
  if (auth === "Bearer valid-user") {
    req.user = { id: USER_ID };
    return next();
  }
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

async function request(app, path, { token } = {}) {
  const chunks = [];
  const req = new Readable({ read() { this.push(null); } });
  req.method = "GET";
  req.url = path;
  req.headers = {};
  if (token) req.headers.authorization = `Bearer ${token}`;
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  res.headers = {};
  res.setHeader = (key, value) => { res.headers[String(key).toLowerCase()] = value; };
  res.getHeader = (key) => res.headers[String(key).toLowerCase()];
  res.removeHeader = (key) => { delete res.headers[String(key).toLowerCase()]; };
  res.write = (chunk) => {
    if (chunk) chunks.push(Buffer.from(chunk));
    return true;
  };
  res.end = (chunk) => {
    if (chunk) chunks.push(Buffer.from(chunk));
    res.emit("finish");
  };
  res.statusCode = 200;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => {
    res.setHeader("content-type", "application/json");
    chunks.push(Buffer.from(JSON.stringify(payload)));
    res.end();
    return res;
  };
  res.send = (payload) => {
    chunks.push(Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)));
    res.end();
    return res;
  };

  await new Promise((resolve, reject) => {
    res.on("finish", resolve);
    res.on("error", reject);
    app.handle(req, res, reject);
  });
  const text = Buffer.concat(chunks).toString("utf8");
  return { statusCode: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null, text };
}

function baseStore() {
  return {
    business_profiles: [{ id: BUSINESS_ID, user_id: USER_ID }],
    tax_calculation_runs: [
      run({ id: RUN_ID, completed_at: "2026-07-19T12:00:00Z" }),
      run({ id: HISTORICAL_RUN_ID, completed_at: "2026-07-18T12:00:00Z", estimated_total_tax: 24000, payments_ytd: 1000, rule_version_map: ruleMap("fed-2026-v0"), payment_application_summary: { appliedPaymentIds: ["old-fed-est"], totalApplied: 1000 } }),
      run({ id: LATEST_RUN_ID, completed_at: "2026-07-20T12:00:00Z" }),
      run({ id: LEGACY_RUN_ID, completed_at: "2026-07-01T12:00:00Z", workpaper_status: "legacy_incomplete", estimated_total_tax: 24000, payments_ytd: 1000, remaining_projected_liability: 23000, recommended_reserve: 23000 }),
      run({ id: PARTIAL_RUN_ID, completed_at: "2026-07-19T13:00:00Z", workpaper_status: "partial", warnings: [{ code: "filing_status_unconfirmed", message: "filing status has not been confirmed" }] }),
      run({ id: FAILURE_RUN_ID, completed_at: "2026-07-19T14:00:00Z", workpaper_reconciliation_status: "out_of_balance", workpaper_reconciliation: reconciliation(false) }),
    ],
    tax_calculation_workpaper_lines: [
      ...linesForRun(RUN_ID),
      ...linesForRun(LATEST_RUN_ID),
      ...linesForRun(HISTORICAL_RUN_ID, { annualTax: 24000, payments: 1000, remaining: 23000, reserve: 23000, paymentId: "old-fed-est", ruleVersion: "fed-2026-v0" }),
      ...linesForRun(PARTIAL_RUN_ID, { partial: true }),
      ...linesForRun(FAILURE_RUN_ID),
    ],
  };
}

function run(overrides = {}) {
  return {
    id: RUN_ID,
    business_id: BUSINESS_ID,
    tax_year: 2026,
    as_of_date: "2026-07-19",
    status: "completed",
    workpaper_status: "complete",
    workpaper_version: "tax-workpaper-v1",
    calculation_version: "canonical-tax-v1",
    calculation_type: "full_estimate",
    entity_type: "single_member_llc",
    entity_path: "single_member_llc_disregarded",
    tax_election: "disregarded_entity",
    filing_status: "single",
    state_code: "NC",
    accounting_method: "cash",
    estimated_total_tax: 24800,
    payments_ytd: 12400,
    withholding_ytd: 0,
    remaining_projected_liability: 12400,
    recommended_reserve: 12400,
    confidence_score: 84,
    confidence_level: "good",
    assumptions: ["Revenue projection uses current-year run-rate."],
    warnings: [],
    missing_inputs: [],
    source_freshness: { transactionClassifications: { status: "available", label: "Books through July 19" } },
    source_lineage_summary: {
      taxProfileId: "profile-v1",
      taxProfileUpdatedAt: "2026-07-01T00:00:00Z",
      transactionClassifications: { count: 3 },
      taxPayments: { count: 2 },
      reserveSnapshotId: "reserve-snapshot-1",
    },
    payment_application_summary: { appliedPaymentIds: ["fed-est", "state-est"], totalApplied: 12400 },
    rule_version_map: ruleMap(),
    workpaper_reconciliation_status: "reconciled",
    workpaper_reconciliation: reconciliation(true),
    created_at: "2026-07-19T12:00:00Z",
    completed_at: "2026-07-19T12:00:00Z",
    ...overrides,
  };
}

function linesForRun(runId, overrides = {}) {
  const annualTax = overrides.annualTax ?? 24800;
  const payments = overrides.payments ?? 12400;
  const remaining = overrides.remaining ?? Math.max(0, annualTax - payments);
  const reserve = overrides.reserve ?? remaining;
  const paymentId = overrides.paymentId ?? "fed-est";
  const ruleVersion = overrides.ruleVersion ?? "fed-2026-v1";
  const partial = overrides.partial === true;
  return [
    line(runId, "source_period_income:actual_business_revenue_ytd", "Actual business revenue YTD", "source_period_income", 182000, { status: "confirmed", isActual: true, sourceType: "transaction_tax_classifications", sourceRefs: [{ type: "transaction_tax_classification", count: 3 }] }),
    line(runId, "projected_remaining_year_income:projected_remaining_business_revenue", "Projected remaining business revenue", "projected_remaining_year_income", 130000, { status: "projected", isProjection: true }),
    line(runId, "projected_remaining_year_income:projection_method", "Projection method", "projected_remaining_year_income", null, { status: "projected", formulaCode: "actual_run_rate", metadata: { method: "actual_run_rate" } }),
    line(runId, "annual_income_bridge:actual_ytd_income", "Actual YTD income", "annual_income_bridge", 182000, { status: "confirmed", isActual: true }),
    line(runId, "annual_income_bridge:projected_remaining_income", "Projected remaining income", "annual_income_bridge", 130000, { status: "projected", isProjection: true }),
    line(runId, "annual_income_bridge:projected_annual_income", "Projected annual income", "annual_income_bridge", 312000),
    line(runId, "deductions:confirmed_deductible_expenses", "Confirmed deductible expenses", "deductions", 50000, { status: "confirmed" }),
    line(runId, "deductions:estimated_deductible_expenses", "Estimated deductible expenses", "deductions", 14200, { status: "estimated" }),
    line(runId, "deductions:category:supplies_materials", "Materials", "deductions", 10000, deductionCategory({ parentCode: "deductions:estimated_deductible_expenses", categoryCode: "supplies_materials", grossAmount: 10000, deductibleAmount: 10000, transactionCount: 42, ruleCode: "supplies_materials_ordinary" })),
    line(runId, "deductions:category:contract_labor", "Contract labor", "deductions", 3050, deductionCategory({ parentCode: "deductions:estimated_deductible_expenses", categoryCode: "contract_labor", grossAmount: 3050, deductibleAmount: 3050, transactionCount: 14, ruleCode: "contract_labor_ordinary" })),
    line(runId, "deductions:category:meals", "Meals", "deductions", 1150, deductionCategory({ parentCode: "deductions:estimated_deductible_expenses", categoryCode: "meals", grossAmount: 2300, deductiblePercent: 50, deductibleAmount: 1150, nondeductibleAmount: 1150, transactionCount: 8, ruleCode: "meals_50_percent" })),
    line(runId, "deductions:capitalized_items", "Capitalized expenses", "deductions", 2500, { status: "calculated", sourceType: "transaction_tax_classifications", sourceRefs: [{ type: "transaction_tax_classification", count: 1 }] }),
    line(runId, "deductions:excluded_transfers_owner_activity", "Excluded transfers and owner activity", "deductions", 600, { status: "excluded", sourceType: "transaction_tax_classifications", sourceRefs: [{ type: "transaction_tax_classification", count: 2 }] }),
    line(runId, "business_taxable_income_bridge:projected_business_taxable_profit", "Projected business taxable profit", "business_taxable_income_bridge", 247800),
    line(runId, "federal_bridge:federal_taxable_income", "Federal taxable income", "federal_bridge", 180000, { ruleVersions: { federalIncomeTaxBrackets: ruleVersion } }),
    line(runId, "federal_bridge:qbi_deduction", "QBI deduction", "federal_bridge", null, { status: partial ? "unavailable" : "not_applicable", materiality: partial ? "high" : "low", explanation: "QBI deduction is unavailable until QBI support is complete." }),
    line(runId, "state_bridge:state_taxable_income", "State taxable income", "state_bridge", 180000, { ruleVersions: { individualIncomeTax: "nc-2026-v1" } }),
    line(runId, "total_tax_components:federal_income_tax", "Federal income tax", "total_tax_components", 18000),
    line(runId, "total_tax_components:state_individual_income_tax", "State individual income tax", "total_tax_components", 6800),
    line(runId, "total_tax_components:projected_annual_tax", "Projected annual tax", "total_tax_components", annualTax),
    line(runId, `payment_application_snapshot:${paymentId}`, paymentId, "payment_application_snapshot", payments, {
      status: "confirmed",
      sourceType: "tax_payments",
      sourceRefs: [{ type: "tax_payment", id: paymentId, count: 1 }],
      metadata: {
        paymentId,
        date: "2026-04-15",
        jurisdiction: "federal",
        state: null,
        paymentType: "estimated_payment",
        taxYear: 2026,
        period: "q1",
        source: "manual",
        confirmationStatus: "confirmed",
        appliedComponent: "payments",
        appliedAmount: payments,
      },
    }),
    line(runId, "remaining_liability:projected_annual_tax", "Projected annual tax", "remaining_liability", annualTax),
    line(runId, "remaining_liability:confirmed_applicable_payments", "Confirmed applicable payments", "remaining_liability", payments),
    line(runId, "remaining_liability:confirmed_withholding", "Confirmed withholding", "remaining_liability", 0),
    line(runId, "remaining_liability:remaining_projected_liability", "Remaining projected liability", "remaining_liability", remaining),
    line(runId, "reserve_bridge:remaining_projected_liability", "Remaining projected liability", "reserve_bridge", remaining),
    line(runId, "reserve_bridge:tax_expected_before_next_deadline", "Tax expected before next deadline", "reserve_bridge", 3500, { parentCode: "reserve_bridge:recommended_reserve", metadata: { nextDeadline: "2026-09-15" } }),
    line(runId, "reserve_bridge:expected_later_year_liability", "Expected later-year liability", "reserve_bridge", Math.max(0, reserve - 3500), { parentCode: "reserve_bridge:recommended_reserve" }),
    line(runId, "reserve_bridge:confirmed_scheduled_payments", "Confirmed scheduled payments", "reserve_bridge", null, { status: "unavailable", displaySign: "subtract" }),
    line(runId, "reserve_bridge:timing_requirement", "Timing requirement", "reserve_bridge", null, { metadata: { planningDate: "2026-07-19", targetDate: "2026-09-15", nextDeadline: "2026-09-15", daysUntilNextDeadline: 58, weeklySetAside: 1013.79, monthlySetAside: 4377.59 } }),
    line(runId, "reserve_bridge:reserve_policy_adjustment", "Reserve policy adjustment", "reserve_bridge", reserve, { parentCode: "reserve_bridge:recommended_reserve", formulaCode: "remaining_liability", metadata: { strategyUsed: "remaining_liability", policySource: "profile", policyVersion: "reserve-policy-v1" } }),
    line(runId, "reserve_bridge:uncertainty_adjustment", "Supported uncertainty adjustment", "reserve_bridge", 0, { parentCode: "reserve_bridge:recommended_reserve", percentage: 0, metadata: { bufferPercent: 0 } }),
    line(runId, "reserve_bridge:reserve_policy", "Reserve policy", "reserve_bridge", null, { status: "confirmed", metadata: { source: "profile", strategy: "remaining_liability", version: "reserve-policy-v1" } }),
    line(runId, "reserve_bridge:recommended_reserve", "Recommended reserve", "reserve_bridge", reserve, { explanation: "Recommended reserve differs from projected annual tax because it starts with remaining projected liability; current reserve balance is shown separately and does not reduce liability.", metadata: { planningDate: "2026-07-19", nextDeadline: "2026-09-15", confirmedPaymentsConsidered: payments, policyUsed: "remaining_liability", policySource: "profile", confidence: 0.84, currentReserveSource: "manual", reserveSnapshotId: "reserve-snapshot-1" } }),
    line(runId, "reserve_bridge:current_reserve_balance", "Current reserve balance", "reserve_bridge", 4000, { status: "confirmed", explanation: "Current reserve balance is shown for planning only and does not reduce projected tax liability.", metadata: { reserveSource: "manual", lastVerifiedAt: "2026-07-19T12:00:00Z" } }),
    line(runId, "reserve_bridge:reserve_gap", "Reserve gap", "reserve_bridge", Math.max(0, reserve - 4000)),
    line(runId, "reserve_bridge:suggested_transfer", "Suggested transfer", "reserve_bridge", Math.max(0, reserve - 4000), { metadata: { transferAffordable: Math.max(0, reserve - 4000), liquidityFloor: 10000 } }),
    line(runId, "reserve_bridge:safe_harbor_payment_target", "Safe-harbor payment target", "reserve_bridge", null, { status: "unavailable" }),
    line(runId, "through_date_tax:tax_attributable_through_date", "Tax attributable through today", "through_date_tax", 13158, { metadata: { calculationMethod: "annualized_actual_ytd_tax_calculation", methodVersion: "through-date-tax-v1" } }),
  ];
}

function deductionCategory({
  parentCode,
  categoryCode,
  grossAmount,
  deductiblePercent = 100,
  deductibleAmount,
  nondeductibleAmount = 0,
  capitalizableAmount = 0,
  needsReviewAmount = 0,
  transactionCount,
  ruleCode,
} = {}) {
  const params = new URLSearchParams({ panel: "deductions", year: "2026", asOfDate: "2026-07-19", taxCategory: categoryCode });
  const api = new URLSearchParams({ businessId: BUSINESS_ID, year: "2026", asOfDate: "2026-07-19", taxCategory: categoryCode });
  return {
    parentCode,
    sourceType: "transaction_tax_classifications",
    sourceRefs: [{ type: "transaction_tax_classification", count: transactionCount, filter: { taxCategory: categoryCode }, drillDownEndpoint: `/api/tax/deductions/transactions?${api.toString()}` }],
    ruleRefs: [{ type: "tax_deduction_rule", label: ruleCode, version: "deduction-v1", supportLevel: "supported" }],
    ruleVersions: { [ruleCode]: "deduction-v1" },
    drillDownType: "deductions_workspace",
    drillDownParams: { workspacePath: `/dashboard/tax?${params.toString()}`, apiEndpoint: `/api/tax/deductions/transactions?${api.toString()}`, historicalRunId: RUN_ID, historicalSnapshotAvailable: false },
    metadata: { categoryCode, grossAmount, deductiblePercent, deductibleAmount, nondeductibleAmount, capitalizableAmount, needsReviewAmount, treatmentStatus: "fully_deductible", transactionCount, confidenceLevel: "high", ruleCode, ruleVersion: "deduction-v1" },
  };
}

function line(runId, code, label, section, amount, overrides = {}) {
  return {
    id: `${runId}:${code}`,
    run_id: runId,
    business_id: BUSINESS_ID,
    tax_year: 2026,
    code,
    label,
    section,
    parent_code: overrides.parentCode || null,
    sort_order: overrides.sortOrder ?? sortOrder(code),
    amount,
    quantity: null,
    percentage: overrides.percentage ?? null,
    display_sign: overrides.displaySign || null,
    status: overrides.status || "calculated",
    support_level: overrides.supportLevel || "supported",
    confidence: overrides.confidence ?? 0.84,
    formula_code: overrides.formulaCode || null,
    formula_description: overrides.formulaDescription || null,
    rule_refs: overrides.ruleRefs || [],
    rule_versions: overrides.ruleVersions || {},
    explanation: overrides.explanation || `${label} comes from the persisted immutable tax workpaper ledger.`,
    source_type: overrides.sourceType || null,
    source_refs: overrides.sourceRefs || [],
    is_projection: overrides.isProjection === true,
    is_actual: overrides.isActual === true,
    materiality: overrides.materiality || null,
    drill_down_type: overrides.drillDownType || null,
    drill_down_params: overrides.drillDownParams || {},
    metadata: overrides.metadata || {},
    created_at: "2026-07-19T12:00:00Z",
  };
}

function sortOrder(code) {
  const order = [
    "source_period_income",
    "projected_remaining_year_income",
    "annual_income_bridge",
    "deductions",
    "business_taxable_income_bridge",
    "federal_bridge",
    "state_bridge",
    "total_tax_components",
    "payment_application_snapshot",
    "remaining_liability",
    "reserve_bridge",
    "through_date_tax",
  ];
  return order.indexOf(code.split(":")[0]) * 100 + 10;
}

function ruleMap(federalVersion = "fed-2026-v1") {
  return {
    federal: { federalIncomeTaxBrackets: federalVersion, standardDeduction: "standard-2026-v1" },
    state: { individualIncomeTax: "nc-2026-v1" },
    projection: { method: "projection-run-rate-v1" },
    reserve: { policy: "remaining-liability-v1" },
  };
}

function reconciliation(ok) {
  return {
    ok,
    checks: [
      check("annual_income_bridge:projected_annual_income", true),
      check("deductions:estimated_deductible_expenses", true),
      check("business_taxable_income_bridge:projected_business_taxable_profit", true),
      check("federal_bridge:federal_taxable_income", true),
      check("state_bridge:state_taxable_income", true),
      check("total_tax_components:projected_annual_tax", ok, ok ? 0 : 100),
      check("remaining_liability:remaining_projected_liability", true),
      check("reserve_bridge:recommended_reserve", true),
    ],
  };
}

function check(code, ok, difference = 0) {
  return { code, status: ok ? "reconciled" : "out_of_balance", difference };
}

function makeSupabase(store) {
  return {
    store,
    from(table) {
      store[table] ||= [];
      return new Query(table, store);
    },
  };
}

class Query {
  constructor(table, store) {
    this.table = table;
    this.store = store;
    this.rows = [...(store[table] || [])];
  }
  select() { return this; }
  eq(field, value) {
    this.rows = this.rows.filter((row) => String(row[field]) === String(value));
    return this;
  }
  in(field, values) {
    const set = new Set(values.map(String));
    this.rows = this.rows.filter((row) => set.has(String(row[field])));
    return this;
  }
  order(field, options = {}) {
    const dir = options.ascending === false ? -1 : 1;
    this.rows = [...this.rows].sort((a, b) => {
      const av = a[field] ?? "";
      const bv = b[field] ?? "";
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return this;
  }
  limit(n) {
    this.rows = this.rows.slice(0, n);
    return this;
  }
  maybeSingle() {
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  then(resolve) {
    return Promise.resolve({ data: this.rows, error: null }).then(resolve);
  }
}
