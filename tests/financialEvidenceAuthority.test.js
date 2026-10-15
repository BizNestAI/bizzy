import test from "node:test";
import assert from "node:assert/strict";
import { resolveCanonicalEvidencePeriods, FinancialEvidenceConfigurationError } from "../src/services/evidence/financialEvidencePeriods.js";
import { calculateCategoryRankings, calculatePerformance, calculatePeriodChanges } from "../src/services/evidence/financialEvidenceFormulas.js";
import { acquireExactRangePnlEvidence, buildFinancialEvidencePackage, EvidenceUnavailableError, findUsableExactRangePnlEvidence, modelFacingEvidenceProjection, resolveFinancialEvidencePackage, validateProviderReportIdentity } from "../src/services/evidence/exactRangePnlEvidence.js";

function envelope(overrides = {}) {
  return {
    reportName: "ProfitAndLoss",
    realmId: "realm-1",
    report: { Header: { ReportName: "ProfitAndLoss", StartPeriod: "2026-10-01", EndPeriod: "2026-10-14", Currency: "USD", Option: [{ Name: "ReportBasis", Value: "Cash" }] } },
    ...overrides,
  };
}

test("exact QBO identity requires proven Cash basis, realm, dates, and currency", () => {
  const expected = { realm_id: "realm-1", start: "2026-10-01", end: "2026-10-14", currency: "USD" };
  assert.deepEqual(validateProviderReportIdentity({ envelope: envelope(), expected }), { accounting_basis: "Cash", currency: "USD", start: expected.start, end: expected.end });
  const missingBasis = envelope(); delete missingBasis.report.Header.Option;
  assert.throws(() => validateProviderReportIdentity({ envelope: missingBasis, expected }), (error) => error instanceof EvidenceUnavailableError && error.code === "qbo_report_basis_unproven");
  const accrual = envelope(); accrual.report.Header.Option[0].Value = "Accrual";
  assert.throws(() => validateProviderReportIdentity({ envelope: accrual, expected }), /qbo_report_basis_mismatch/);
  assert.throws(() => validateProviderReportIdentity({ envelope: envelope({ realmId: "other" }), expected }), /qbo_report_realm_mismatch/);
  assert.throws(() => validateProviderReportIdentity({ envelope: envelope({ report: { Header: { ...envelope().report.Header, EndPeriod: "2026-10-31" } } }), expected }), /qbo_report_period_mismatch/);
  assert.throws(() => validateProviderReportIdentity({ envelope: envelope({ report: { Header: { ...envelope().report.Header, Currency: "CAD" } } }), expected }), /qbo_report_currency_mismatch/);
});

test("period resolver compares equivalent elapsed days and discloses shortened February", () => {
  const october = resolveCanonicalEvidencePeriods({ timezone: "America/Los_Angeles", now: new Date("2026-10-14T20:00:00Z"), intent: "financial_period_changes" });
  assert.deepEqual(october.period, { start: "2026-10-01", end: "2026-10-14", timezone: "America/Los_Angeles", is_partial: true });
  assert.deepEqual(october.comparison_period, { start: "2026-09-01", end: "2026-09-14" });
  const march = resolveCanonicalEvidencePeriods({ timezone: "UTC", now: new Date("2025-03-31T12:00:00Z"), intent: "financial_period_changes" });
  assert.equal(march.comparison_period.end, "2025-02-28");
  assert.deepEqual(march.warnings, ["comparison_period_shortened_to_prior_month_end"]);
});

test("period resolver respects timezone rollover and refuses missing configuration", () => {
  const utc = resolveCanonicalEvidencePeriods({ timezone: "UTC", now: new Date("2026-10-01T01:00:00Z"), intent: "financial_month_performance" });
  const la = resolveCanonicalEvidencePeriods({ timezone: "America/Los_Angeles", now: new Date("2026-10-01T01:00:00Z"), intent: "financial_month_performance" });
  assert.equal(utc.period.end, "2026-10-01");
  assert.equal(la.period.end, "2026-09-30");
  assert.throws(() => resolveCanonicalEvidencePeriods({ timezone: null, intent: "financial_month_performance" }), FinancialEvidenceConfigurationError);
});

test("performance is decimal-safe, reconciled, preserves negatives, and returns null zero margin", () => {
  assert.deepEqual(calculatePerformance({ revenue: "0.00", cogs: "10.00", expenses: "5.00", other_income: "0.00", other_expense: "0.00", net_profit: "-15.00" }), {
    revenue: "0.00", cogs: "10.00", operating_expenses: "5.00", other_income: "0.00", other_expense: "0.00", net_profit: "-15.00", net_margin_percent: null, reconciliation_difference: "0.00",
  });
  const negativeRevenue = calculatePerformance({ revenue: "-10.00", cogs: "0.00", expenses: "0.00", other_income: "0.00", other_expense: "0.00", net_profit: "-10.00" });
  assert.equal(negativeRevenue.revenue, "-10.00");
  assert.equal(negativeRevenue.net_margin_percent, "100.0000");
  assert.throws(() => calculatePerformance({ revenue: "10.00", cogs: "0", expenses: "0", other_income: "0", other_expense: "0", net_profit: "9.98" }), /net_income_reconciliation_failed/);
});

test("categories use stable leaf IDs, avoid parent subtotals, and separate signed COGS and expenses", () => {
  const accounts = [
    { qbo_account_id: "parent", account_name: "Sales", account_path: "Sales", account_type: "Income", total_amount: "150.00", is_subtotal: true },
    { qbo_account_id: "i1", account_name: "Labor", account_path: "Sales:Labor", account_type: "Income", total_amount: "100.00", is_leaf: true },
    { qbo_account_id: "i2", account_name: "Materials", account_path: "Sales:Materials", account_type: "Income", total_amount: "50.00", is_leaf: true },
    { qbo_account_id: "c1", account_name: "Materials", account_path: "COGS:Materials", account_type: "Cost of Goods Sold", total_amount: "40.00", is_leaf: true },
    { qbo_account_id: "e1", account_name: "Refund", account_path: "Expenses:Refund", account_type: "Expense", total_amount: "-5.00", is_leaf: true },
  ];
  const ranked = calculateCategoryRankings(accounts);
  assert.equal(ranked.income.length, 2);
  assert.equal(ranked.income[0].qbo_account_id, "i1");
  assert.equal(ranked.income[0].share_percent, "66.6667");
  assert.equal(ranked.cost_of_goods_sold[0].amount, "40.00");
  assert.equal(ranked.operating_expenses[0].amount, "-5.00");
  assert.throws(() => calculateCategoryRankings([{ account_type: "Income", total_amount: "1.00" }]), /stable_account_identity_required/);
});

test("period changes handle prior zero, sign reversals, contra values, and deterministic materiality", () => {
  const current = { metrics: { revenue: "100", cogs: "20", operating_expenses: "30", other_income: "0", other_expense: "0", net_profit: "50" }, accounts: [
    { qbo_account_id: "b", account_name: "B", account_path: "B", account_type: "Income", total_amount: "-20", is_leaf: true },
    { qbo_account_id: "a", account_name: "A", account_path: "A", account_type: "Expense", total_amount: "10", is_leaf: true },
  ] };
  const prior = { metrics: { revenue: "0", cogs: "10", operating_expenses: "20", other_income: "0", other_expense: "0", net_profit: "-30" }, accounts: [
    { qbo_account_id: "b", account_name: "B", account_path: "B", account_type: "Income", total_amount: "20", is_leaf: true },
    { qbo_account_id: "a", account_name: "A", account_path: "A", account_type: "Expense", total_amount: "-10", is_leaf: true },
  ] };
  const changes = calculatePeriodChanges(current, prior);
  assert.equal(changes.metric_changes[0].percentage_change, null);
  assert.equal(changes.metric_changes.at(-1).sign_reversal, true);
  assert.equal(changes.top_category_changes[0].key, "b");
  assert.equal(changes.top_category_changes[0].sign_reversal, true);
});

test("model projection is bounded and rejects incomplete evidence", () => {
  const row = { id: "pkg", intent: "financial_month_performance", period: {}, comparison_period: null, accounting_basis: "Cash", currency: "USD", sources: [], formula_version: "v1", metrics: { revenue: "10.00" }, warnings: [], completeness: "complete", reconciliation: { status: "reconciled" }, raw_transactions: [{ secret: true }] };
  assert.equal(modelFacingEvidenceProjection(row).raw_transactions, undefined);
  assert.throws(() => modelFacingEvidenceProjection({ ...row, completeness: "partial" }), /evidence_package_unavailable/);
});

test("cache lookup isolates the complete identity and rejects stale evidence", async () => {
  const calls = [];
  const row = { accounting_basis: "Cash", completeness_status: "complete", reconciliation_status: "reconciled", refreshed_at: "2026-10-14T11:55:00Z" };
  const query = { select() { return this; }, eq(key, value) { calls.push([key, value]); return this; }, is(key, value) { calls.push([key, value]); return this; }, order() { return this; }, limit() { return this; }, async maybeSingle() { return { data: row, error: null }; } };
  const args = { db: { from: () => query }, businessId: "biz-1", period: { start: "2026-10-01", end: "2026-10-14" }, configuration: { qbo_realm_id: "realm-1", reporting_timezone: "America/New_York", home_currency: "CAD", provider_schema_version: "75" }, now: new Date("2026-10-14T12:00:00Z"), maxAgeMs: 600_000 };
  assert.equal(await findUsableExactRangePnlEvidence(args), row);
  assert.deepEqual(Object.fromEntries(calls), { business_id: "biz-1", qbo_realm_id: "realm-1", report_type: "ProfitAndLoss", accounting_basis: "Cash", source_start_date: "2026-10-01", source_end_date: "2026-10-14", reporting_timezone: "America/New_York", currency: "CAD", provider_schema_version: "75", completeness_status: "complete", reconciliation_status: "reconciled", failure_code: null });
  assert.equal(await findUsableExactRangePnlEvidence({ ...args, now: new Date("2026-10-14T13:00:00Z") }), null);
});

test("mocked exact-range acquisition propagates currency and verifies both report identities", async () => {
  const report = envelope();
  const detail = envelope({ reportName: "GeneralLedger", report: { Header: { ...envelope().report.Header, ReportName: "GeneralLedger" } } });
  const seen = [];
  const result = await acquireExactRangePnlEvidence({
    db: {}, businessId: "biz", period: { start: "2026-10-01", end: "2026-10-14" },
    configuration: { business_id: "biz", qbo_realm_id: "realm-1", reporting_timezone: "UTC", home_currency: "USD", provider_schema_version: "75" },
    cacheLoader: async () => null,
    fetchReport: async (request) => { seen.push(request); return report; }, fetchDetail: async () => detail, fetchAccounts: async () => [],
    normalizePayload: () => ({ summary: { revenue: "100.00", cogs: "20.00", expenses: "30.00", other_income: "5.00", other_expense: "2.00", net_profit: "53.00", raw_header: {} }, accounts: [], reconciliation: { status: "valid" } }),
    persist: async ({ evidence }) => evidence, now: new Date("2026-10-14T12:00:00Z"),
  });
  assert.equal(result.currency, "USD"); assert.equal(result.metrics.net_profit, "53.00"); assert.equal(result.accounting_basis, "Cash");
  assert.equal(seen[0].accountingMethod, "Cash");
});

test("identical content gets a fresh immutable observation while request retries remain idempotent", async () => {
  const rows = new Map();
  const persist = async ({ evidence }) => {
    const key = `${evidence.business_id}:${evidence.ingestion_request_id}`;
    if (!rows.has(key)) rows.set(key, Object.freeze({ ...evidence }));
    return rows.get(key);
  };
  const configuration = { business_id: "biz", qbo_realm_id: "realm-1", reporting_timezone: "UTC", home_currency: "USD", provider_schema_version: "75" };
  const report = envelope();
  const detail = envelope({ reportName: "GeneralLedger", report: { Header: { ...envelope().report.Header, ReportName: "GeneralLedger" } } });
  let revenue = "100.00";
  const acquire = (requestId, now) => acquireExactRangePnlEvidence({
    db: {}, businessId: "biz", period: { start: "2026-10-01", end: "2026-10-14" }, configuration,
    ingestionRequestId: requestId, now, cacheLoader: async () => null, fetchReport: async () => report,
    fetchDetail: async () => detail, fetchAccounts: async () => [],
    normalizePayload: () => ({ summary: { revenue, cogs: "20.00", expenses: "30.00", other_income: "5.00", other_expense: "2.00", net_profit: String(Number(revenue) - 47) + ".00", raw_header: {} }, accounts: [], reconciliation: { status: "valid" } }),
    persist,
  });
  const first = await acquire("request-1", new Date("2026-10-14T12:00:00Z"));
  const second = await acquire("request-2", new Date("2026-10-14T12:16:00Z"));
  assert.notEqual(first.id, second.id);
  assert.equal(first.source_fingerprint, second.source_fingerprint);
  assert.notEqual(first.observed_at, second.observed_at);
  const [retryA, retryB] = await Promise.all([acquire("request-3", new Date("2026-10-14T12:17:00Z")), acquire("request-3", new Date("2026-10-14T12:17:00Z"))]);
  assert.equal(retryA.id, retryB.id);
  revenue = "101.00";
  const restated = await acquire("request-4", new Date("2026-10-14T12:18:00Z"));
  assert.notEqual(restated.source_fingerprint, second.source_fingerprint);
});

test("YTD book-profit package uses reconciled Cash evidence and mandatory disclaimer", async () => {
  const evidence = { id: "e1", accounting_basis: "Cash", completeness_status: "complete", reconciliation_status: "reconciled", reconciliation_difference: "0.00", currency: "USD", metrics: { net_profit: "123.45" }, accounts: [], source_fingerprint: "abc", generated_at: "2026-10-14T12:00:00Z", refreshed_at: "2026-10-14T12:00:00Z" };
  const configQuery = { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: { business_id: "biz", status: "verified", qbo_realm_id: "realm", reporting_timezone: "UTC", home_currency: "USD", provider_schema_version: "75", verified_at: "2026-01-01T00:00:00Z" }, error: null }; } };
  const result = await buildFinancialEvidencePackage({ db: { from: () => configQuery }, businessId: "biz", intent: "tax_ytd_book_profit", now: new Date("2026-10-14T12:00:00Z"), evidenceLoader: async () => evidence, persist: async ({ packageRow }) => packageRow });
  assert.deepEqual(result.period, { start: "2026-01-01", end: "2026-10-14", timezone: "UTC", is_partial: true });
  assert.equal(result.metrics.book_profit, "123.45");
  assert.ok(result.warnings.includes("Book profit—not taxable income or estimated tax liability."));
});

test("deterministic evidence unavailability is persisted distinctly from operational failure", async () => {
  const persist = async ({ packageRow }) => packageRow;
  const missingConfigDb = { from: () => ({ select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: null, error: null }; } }) };
  const unavailable = await resolveFinancialEvidencePackage({ db: missingConfigDb, businessId: "biz", intent: "financial_month_performance", persist, evidenceLoader: async () => { throw new Error("must not run"); } });
  assert.equal(unavailable.completeness, "unavailable");
  assert.equal(unavailable.metrics.unavailable_reason, "authoritative_reporting_configuration_unavailable");
  const operationalDb = { from: () => ({ select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: null, error: new Error("database_offline") }; } }) };
  await assert.rejects(resolveFinancialEvidencePackage({ db: operationalDb, businessId: "biz", intent: "financial_month_performance", persist }), /database_offline/);
});
