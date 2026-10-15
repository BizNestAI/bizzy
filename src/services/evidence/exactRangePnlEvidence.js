import { createHash, randomUUID } from "node:crypto";
import { FINANCIAL_EVIDENCE_FORMULA_VERSION, calculateCategoryRankings, calculatePerformance, calculatePeriodChanges } from "./financialEvidenceFormulas.js";
import { resolveCanonicalEvidencePeriods } from "./financialEvidencePeriods.js";

export const EVIDENCE_SCHEMA_VERSION = "qbo-pnl-exact-range-v1";
export const PACKAGE_SCHEMA_VERSION = "business-evidence-package-v1";
export const DEFAULT_EVIDENCE_MAX_AGE_MS = 15 * 60 * 1000;
export const CANONICAL_EVIDENCE_INTENTS = new Set([
  "financial_month_performance", "financial_income_categories", "financial_expense_categories", "financial_period_changes",
  "tax_ytd_book_profit", "tax_transactions_needing_review", "tax_professional_readiness",
]);

export class EvidenceUnavailableError extends Error {
  constructor(code, details = {}) { super(code); this.code = code; this.details = details; this.deterministic = true; }
}

export async function loadReportingConfiguration({ db, businessId }) {
  const { data, error } = await db.from("business_financial_reporting_config").select("business_id,qbo_realm_id,reporting_timezone,home_currency,provider_schema_version,verified_at,status").eq("business_id", businessId).maybeSingle();
  if (error) throw error;
  if (!data || data.status !== "verified" || !data.reporting_timezone || !data.home_currency || !data.qbo_realm_id || !data.verified_at) {
    throw new EvidenceUnavailableError("authoritative_reporting_configuration_unavailable");
  }
  return data;
}

export function validateProviderReportIdentity({ envelope, expected, allowedReportNames = ["ProfitAndLoss"] }) {
  const report = envelope?.report;
  const header = report?.Header || report?.ReportHeader;
  if (!header) throw new EvidenceUnavailableError("qbo_report_header_missing");
  const basis = headerOption(header, "reportbasis");
  if (!basis) throw new EvidenceUnavailableError("qbo_report_basis_unproven");
  if (String(basis).toLowerCase() !== "cash") throw new EvidenceUnavailableError("qbo_report_basis_mismatch", { returned_basis: basis });
  const actualReport = String(envelope.reportName || header.ReportName || "").replace(/\s/g, "").toLowerCase();
  if (!allowedReportNames.map((name) => name.toLowerCase()).includes(actualReport)) throw new EvidenceUnavailableError("qbo_report_type_mismatch");
  if (String(envelope.realmId || "") !== String(expected.realm_id)) throw new EvidenceUnavailableError("qbo_report_realm_mismatch");
  if (header.StartPeriod !== expected.start || header.EndPeriod !== expected.end) throw new EvidenceUnavailableError("qbo_report_period_mismatch", { returned_start: header.StartPeriod, returned_end: header.EndPeriod });
  const currency = String(header.Currency || header.CurrencyCode || header.HomeCurrency || headerOption(header, "currency") || "").toUpperCase();
  if (!currency) throw new EvidenceUnavailableError("qbo_report_currency_unproven");
  if (currency !== String(expected.currency).toUpperCase()) throw new EvidenceUnavailableError("qbo_report_currency_mismatch", { returned_currency: currency });
  return { accounting_basis: "Cash", currency, start: header.StartPeriod, end: header.EndPeriod };
}

export async function acquireExactRangePnlEvidence({
  db, businessId, period, configuration, fetchReport = null, fetchAccounts = null, normalizePayload = null,
  fetchDetail = null,
  cacheLoader = findUsableExactRangePnlEvidence, now = new Date(), maxAgeMs = DEFAULT_EVIDENCE_MAX_AGE_MS,
  ingestionRequestId = randomUUID(),
  persist = persistExactRangePnlEvidence,
}) {
  if (!businessId || configuration.business_id !== businessId) throw new EvidenceUnavailableError("business_scope_mismatch");
  const cached = await cacheLoader({ db, businessId, period, configuration, now, maxAgeMs });
  if (cached) return cached;
  // The QBO ingestion module initializes the server-only Supabase client. Load it
  // only on the provider path so pure validation/formula consumers remain inert.
  if (!fetchReport || !fetchAccounts || !normalizePayload || !fetchDetail) {
    const qbo = await import("../bookkeeping/qboMonthlyPnlIngestionService.js");
    fetchReport ||= qbo.fetchQboReport;
    fetchAccounts ||= qbo.fetchQboChartOfAccounts;
    normalizePayload ||= qbo.normalizeQboPnlSnapshotPayload;
    fetchDetail ||= qbo.fetchPreferredDetailReport;
  }
  const request = { businessId, realmId: configuration.qbo_realm_id, startDate: period.start, endDate: period.end, accountingMethod: "Cash" };
  const summaryEnvelope = await fetchReport({ ...request, reportName: "ProfitAndLoss" });
  const identity = validateProviderReportIdentity({ envelope: summaryEnvelope, expected: { realm_id: configuration.qbo_realm_id, start: period.start, end: period.end, currency: configuration.home_currency } });
  const detailEnvelope = await fetchDetail({ ...request, fetchReport });
  validateProviderReportIdentity({
    envelope: detailEnvelope,
    expected: { realm_id: configuration.qbo_realm_id, start: period.start, end: period.end, currency: configuration.home_currency },
    allowedReportNames: ["profitandlossdetail", "generalledger"],
  });
  const accounts = await fetchAccounts({ businessId });
  const [year, month] = period.start.split("-").map(Number);
  const normalized = normalizePayload({
    businessId, reviewYear: year, reviewMonth: month, realmId: configuration.qbo_realm_id,
    accountingMethod: identity.accounting_basis, sourceStartDate: period.start, sourceEndDate: period.end,
    summaryReport: summaryEnvelope.report, detailReport: detailEnvelope.report, detailReportName: detailEnvelope.reportName,
    qboAccounts: accounts,
  });
  if (!["valid", "valid_with_nonmaterial_rounding"].includes(normalized.reconciliation?.status)) throw new EvidenceUnavailableError("qbo_report_unreconciled");
  const performance = calculatePerformance(normalized.summary);
  const sourceFingerprint = safeHash({ summary: normalized.summary, accounts: normalized.accounts, reconciliation: normalized.reconciliation });
  const generatedAt = now.toISOString();
  const evidence = {
    id: randomUUID(), ingestion_request_id: ingestionRequestId, business_id: businessId, qbo_realm_id: configuration.qbo_realm_id, report_type: "ProfitAndLoss",
    accounting_basis: "Cash", source_start_date: period.start, source_end_date: period.end,
    reporting_timezone: configuration.reporting_timezone, currency: identity.currency,
    provider_schema_version: configuration.provider_schema_version || "qbo-minor-75",
    evidence_schema_version: EVIDENCE_SCHEMA_VERSION, source_fingerprint: sourceFingerprint,
    provider_generated_at: providerTimestamp(summaryEnvelope.report), observed_at: generatedAt,
    generated_at: generatedAt, refreshed_at: generatedAt, completeness_status: "complete",
    reconciliation_status: "reconciled", reconciliation_difference: performance.reconciliation_difference,
    formula_version: FINANCIAL_EVIDENCE_FORMULA_VERSION, metrics: performance,
    accounts: normalized.accounts.map(projectAccount), source_metadata: { summary_report: "ProfitAndLoss", detail_report: detailEnvelope.reportName },
  };
  return persist({ db, evidence });
}

export async function findUsableExactRangePnlEvidence({ db, businessId, period, configuration, now = new Date(), maxAgeMs = DEFAULT_EVIDENCE_MAX_AGE_MS }) {
  const { data, error } = await db.from("qbo_pnl_exact_range_evidence").select("*")
    .eq("business_id", businessId).eq("qbo_realm_id", configuration.qbo_realm_id)
    .eq("report_type", "ProfitAndLoss").eq("accounting_basis", "Cash")
    .eq("source_start_date", period.start).eq("source_end_date", period.end)
    .eq("reporting_timezone", configuration.reporting_timezone).eq("currency", configuration.home_currency)
    .eq("provider_schema_version", configuration.provider_schema_version || "qbo-minor-75")
    .eq("completeness_status", "complete").eq("reconciliation_status", "reconciled")
    .is("failure_code", null).order("refreshed_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const refreshedAt = Date.parse(data.refreshed_at);
  if (!Number.isFinite(refreshedAt) || now.getTime() - refreshedAt > maxAgeMs) return null;
  assertUsableEvidence(data);
  return data;
}

export async function buildFinancialEvidencePackage({ db, businessId, intent, now = new Date(), evidenceLoader = acquireExactRangePnlEvidence, persist = persistEvidencePackage }) {
  if (!CANONICAL_EVIDENCE_INTENTS.has(intent)) throw new EvidenceUnavailableError("unsupported_evidence_intent");
  const configuration = await loadReportingConfiguration({ db, businessId });
  const periods = resolveCanonicalEvidencePeriods({ timezone: configuration.reporting_timezone, now, intent });
  const current = await evidenceLoader({ db, businessId, period: periods.period, configuration });
  assertUsableEvidence(current);
  let comparison = null;
  if (intent === "financial_period_changes") {
    comparison = await evidenceLoader({ db, businessId, period: { ...periods.comparison_period, timezone: periods.period.timezone, is_partial: true }, configuration });
    assertUsableEvidence(comparison);
  }
  const metrics = metricsForIntent(intent, current, comparison);
  const warnings = [...periods.warnings];
  if (intent === "tax_ytd_book_profit") warnings.push("Book profit—not taxable income or estimated tax liability.");
  const packageRow = {
    id: randomUUID(), schema_version: PACKAGE_SCHEMA_VERSION, intent, business_id: businessId,
    period: periods.period, comparison_period: periods.comparison_period, accounting_basis: "Cash", currency: current.currency,
    sources: [sourceRef(current), ...(comparison ? [sourceRef(comparison)] : [])], completeness: "complete",
    reconciliation: { status: "reconciled", difference: current.reconciliation_difference },
    formula_version: FINANCIAL_EVIDENCE_FORMULA_VERSION, metrics, warnings,
  };
  return persist({ db, packageRow });
}

export async function resolveFinancialEvidencePackage(options) {
  try {
    return await buildFinancialEvidencePackage(options);
  } catch (error) {
    if (!(error instanceof EvidenceUnavailableError)) throw error;
    const unavailable = {
      id: randomUUID(), schema_version: PACKAGE_SCHEMA_VERSION, intent: options.intent, business_id: options.businessId,
      period: null, comparison_period: null, accounting_basis: "Cash", currency: null, sources: [],
      completeness: "unavailable", reconciliation: { status: "unavailable", difference: null },
      formula_version: FINANCIAL_EVIDENCE_FORMULA_VERSION, metrics: { unavailable_reason: error.code },
      warnings: ["Required verified financial evidence is unavailable."],
    };
    return (options.persist || persistEvidencePackage)({ db: options.db, packageRow: unavailable });
  }
}

export function modelFacingEvidenceProjection(packageRow) {
  if (packageRow.completeness !== "complete" || packageRow.reconciliation?.status !== "reconciled") throw new EvidenceUnavailableError("evidence_package_unavailable");
  return { id: packageRow.id, intent: packageRow.intent, period: packageRow.period, comparison_period: packageRow.comparison_period, accounting_basis: packageRow.accounting_basis, currency: packageRow.currency, sources: packageRow.sources, formula_version: packageRow.formula_version, metrics: packageRow.metrics, warnings: packageRow.warnings };
}

export async function persistExactRangePnlEvidence({ db, evidence }) {
  const { data, error } = await db.from("qbo_pnl_exact_range_evidence").insert(evidence).select("*").single();
  if (error?.code === "23505") {
    const existing = await db.from("qbo_pnl_exact_range_evidence").select("*")
      .eq("business_id", evidence.business_id).eq("ingestion_request_id", evidence.ingestion_request_id).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) return existing.data;
  }
  if (error) throw error;
  return data;
}
async function persistEvidencePackage({ db, packageRow }) {
  const { data, error } = await db.from("business_evidence_packages").insert(packageRow).select("*").single();
  if (error) throw error;
  return data;
}
function assertUsableEvidence(row) { if (!row || row.accounting_basis !== "Cash" || row.completeness_status !== "complete" || row.reconciliation_status !== "reconciled") throw new EvidenceUnavailableError("required_pnl_evidence_unavailable"); }
function metricsForIntent(intent, current, comparison) {
  if (intent === "financial_month_performance") return current.metrics;
  if (intent === "financial_income_categories") return { income_categories: calculateCategoryRankings(current.accounts).income };
  if (intent === "financial_expense_categories") { const r = calculateCategoryRankings(current.accounts); return { cost_of_goods_sold: r.cost_of_goods_sold, operating_expenses: r.operating_expenses }; }
  if (intent === "financial_period_changes") return calculatePeriodChanges({ metrics: current.metrics, accounts: current.accounts }, { metrics: comparison.metrics, accounts: comparison.accounts });
  if (intent === "tax_ytd_book_profit") return { book_profit: current.metrics.net_profit, required_statement: "Book profit—not taxable income or estimated tax liability." };
  return {};
}
function projectAccount(row) { return { qbo_account_id: row.qbo_account_id || null, account_name: row.account_name, account_path: row.account_path || row.account_name, account_type: row.account_type, account_subtype: row.account_subtype || null, total_amount: String(row.total_amount), is_leaf: row.metadata?.is_subtotal !== true, is_subtotal: row.metadata?.is_subtotal === true }; }
function sourceRef(row) { return { type: "qbo_profit_and_loss", evidence_id: row.id, source_fingerprint: row.source_fingerprint, generated_at: row.generated_at, refreshed_at: row.refreshed_at }; }
function safeHash(value) { return createHash("sha256").update(stable(value)).digest("hex"); }
function stable(value) { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function headerOption(header, wanted) { const options = [...(header.Option || []), ...(header.Options || [])]; const hit = options.find((item) => String(item?.Name || item?.name || "").replace(/[_\s-]/g, "").toLowerCase() === wanted); return hit?.Value || hit?.value || null; }
function providerTimestamp(report) {
  const value = report?.Header?.Time || report?.ReportHeader?.Time || null;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
