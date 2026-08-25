import fetch from "node-fetch";
import { createHash } from "node:crypto";
import { supabase as defaultSupabase } from "../supabaseAdmin.js";
import { getQBOClient as defaultGetQBOClient } from "../../utils/qboClient.js";
import { qbApiBase, qboEnvName } from "../../utils/qboEnv.js";
import {
  getLatestQuickBooksTokenRow,
  getQuickBooksAccessToken,
} from "../quickbooksTokenService.js";
import {
  createOrReplaceMonthlyPnlSnapshot,
  getLatestMonthlyPnlSnapshot,
  getMonthlySourceRange,
  promoteMonthlyPnlSnapshotCurrent,
  QboMonthlyPnlSnapshotError,
} from "./qboMonthlyPnlSnapshotService.js";

const SUMMARY_REPORT = "ProfitAndLoss";
const DETAIL_REPORTS = ["ProfitAndLossDetail", "GeneralLedger"];
const FALLBACK_ALLOWED_STATUSES = new Set([404, 501]);
const PNL_ACCOUNT_TYPES = new Set(["Income", "Cost of Goods Sold", "Expense", "Other Income", "Other Expense"]);
const RECONCILIATION_TOLERANCE = 0.01;

export class QboMonthlyPnlIngestionError extends Error {
  constructor(error, status = 400, details = {}) {
    super(error);
    this.name = "QboMonthlyPnlIngestionError";
    this.error = error;
    this.status = status;
    this.details = details;
  }
}

export async function refreshMonthlyQboPnlSnapshot({
  businessId,
  year,
  month,
  accountingMethod = "Cash",
  db = defaultSupabase,
  fetchReport = fetchQboReport,
  fetchAccounts = fetchQboChartOfAccounts,
  loadContext = loadQboContext,
  persistSnapshot = createOrReplaceMonthlyPnlSnapshot,
  promoteSnapshot = promoteMonthlyPnlSnapshotCurrent,
} = {}) {
  if (!businessId) throw new QboMonthlyPnlIngestionError("missing_business_id", 400);
  const reviewYear = Number(year);
  const reviewMonth = Number(month);
  const { sourceStartDate, sourceEndDate } = getMonthlySourceRange(reviewYear, reviewMonth);
  const qboContext = await loadContext({ businessId });

  let stagedSnapshot = null;
  try {
    const summaryResponse = await fetchReport({
      businessId,
      realmId: qboContext.realmId,
      reportName: SUMMARY_REPORT,
      startDate: sourceStartDate,
      endDate: sourceEndDate,
      accountingMethod,
    });
    const detailResponse = await fetchPreferredDetailReport({
      businessId,
      realmId: qboContext.realmId,
      startDate: sourceStartDate,
      endDate: sourceEndDate,
      accountingMethod,
      fetchReport,
    });
    const qboAccounts = await fetchAccounts({ businessId });
    const normalized = normalizeQboPnlSnapshotPayload({
      businessId,
      reviewYear,
      reviewMonth,
      realmId: qboContext.realmId,
      qboEnvironment: qboContext.qboEnvironment,
      accountingMethod,
      sourceStartDate,
      sourceEndDate,
      summaryReport: summaryResponse.report,
      detailReport: detailResponse.report,
      detailReportName: detailResponse.reportName,
      qboAccounts,
    });

    const persisted = await persistSnapshot({
      businessId,
      reviewYear,
      reviewMonth,
      qboRealmId: qboContext.realmId,
      qboEnvironment: qboContext.qboEnvironment,
      accountingMethod: normalized.summary.accounting_method || accountingMethod,
      sourceStartDate,
      sourceEndDate,
      pulledAt: new Date().toISOString(),
      revenue: normalized.summary.revenue,
      cogs: normalized.summary.cogs,
      expenses: normalized.summary.expenses,
      netProfit: normalized.summary.net_profit,
      rawHash: normalized.raw_hash,
      metadata: normalized.metadata,
      accounts: normalized.accounts,
      transactions: normalized.transactions,
      linkTransactions: true,
      promote: false,
      db,
    });
    stagedSnapshot = persisted.snapshot;
    validatePersistedStagedSnapshotIntegrity({ persisted, normalized });
    const promotedSnapshot = await promoteSnapshot({
      db,
      businessId,
      reviewYear,
      reviewMonth,
      snapshotId: persisted.snapshot.id,
      status: normalized.reconciliation.status === "valid_with_nonmaterial_rounding" ? "current" : "current",
    });
    return {
      ok: true,
      snapshot: promotedSnapshot,
      accounts: persisted.accounts,
      transactions: persisted.transactions,
      linkage: persisted.linkage,
      source: normalized.metadata.source,
    };
  } catch (err) {
    if (stagedSnapshot?.id) {
      await markSnapshotFailedBestEffort({ db, businessId, snapshotId: stagedSnapshot.id, err });
    }
    if (err instanceof QboMonthlyPnlIngestionError || err instanceof QboMonthlyPnlSnapshotError) throw err;
    throw new QboMonthlyPnlIngestionError("qbo_pnl_snapshot_refresh_failed", err?.status || 500, {
      cause: err?.message || String(err),
    });
  }
}

export async function getMonthlyQboPnlSnapshot({
  businessId,
  year,
  month,
  includeAccounts = true,
  includeTransactions = false,
  db = defaultSupabase,
} = {}) {
  return getLatestMonthlyPnlSnapshot({
    businessId,
    reviewYear: Number(year),
    reviewMonth: Number(month),
    includeAccounts,
    includeTransactions,
    db,
  });
}

export async function fetchMonthlyQboPnlAccountTransactions({
  businessId,
  year,
  month,
  accountId,
  page = 1,
  pageSize = 100,
  db = defaultSupabase,
} = {}) {
  const snapshot = await getLatestMonthlyPnlSnapshot({
    businessId,
    reviewYear: Number(year),
    reviewMonth: Number(month),
    includeAccounts: false,
    includeTransactions: false,
    db,
  });
  if (!snapshot) return { snapshot: null, rows: [], totalCount: 0, page, pageSize };
  const account = await resolveSnapshotAccountForDetail({ db, businessId, snapshotId: snapshot.id, accountId });
  if (!account) return { snapshot, rows: [], totalCount: 0, page, pageSize };

  const safePage = Math.max(Number(page) || 1, 1);
  const safePageSize = Math.min(Math.max(Number(pageSize) || 100, 1), 250);
  const start = (safePage - 1) * safePageSize;
  const end = start + safePageSize - 1;
  let query = db
    .from("monthly_review_qbo_pnl_transactions")
    .select("*", { count: "exact" })
    .eq("business_id", businessId)
    .eq("snapshot_id", snapshot.id);
  if (account.qbo_account_id) {
    query = query.eq("qbo_account_id", String(account.qbo_account_id));
  } else {
    query = query.eq("qbo_account_name", account.account_name || account.account_path || "");
  }
  query = query.order("txn_date", { ascending: true }).range(start, end);
  const { data, error, count } = await query;
  if (error) throw new QboMonthlyPnlIngestionError("qbo_pnl_snapshot_transactions_query_failed", 500, { cause: error.message });
  return {
    snapshot,
    rows: Array.isArray(data) ? data : [],
    totalCount: Number(count || 0),
    page: safePage,
    pageSize: safePageSize,
  };
}

async function resolveSnapshotAccountForDetail({ db, businessId, snapshotId, accountId }) {
  const id = String(accountId || "").trim();
  if (!id) return null;
  let query = db
    .from("monthly_review_qbo_pnl_accounts")
    .select("*")
    .eq("business_id", businessId)
    .eq("snapshot_id", snapshotId)
    .eq("qbo_account_id", id)
    .limit(1);
  let { data, error } = await query;
  if (error) throw new QboMonthlyPnlIngestionError("qbo_pnl_snapshot_account_query_failed", 500, { cause: error.message });
  if (Array.isArray(data) && data[0]) return data[0];
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    query = db
      .from("monthly_review_qbo_pnl_accounts")
      .select("*")
      .eq("business_id", businessId)
      .eq("snapshot_id", snapshotId)
      .eq("id", id)
      .limit(1);
    ({ data, error } = await query);
    if (error) throw new QboMonthlyPnlIngestionError("qbo_pnl_snapshot_account_query_failed", 500, { cause: error.message });
    if (Array.isArray(data) && data[0]) return data[0];
  }
  return null;
}

export async function fetchQboReport({
  businessId,
  realmId,
  reportName,
  startDate,
  endDate,
  accountingMethod = "Cash",
  fetchImpl = fetch,
} = {}) {
  if (!businessId) throw new QboMonthlyPnlIngestionError("missing_business_id", 400);
  if (!realmId) throw new QboMonthlyPnlIngestionError("quickbooks_missing_realm_id", 409);
  if (!reportName) throw new QboMonthlyPnlIngestionError("missing_qbo_report_name", 400);
  const accessToken = await getQuickBooksAccessToken(businessId);
  const url = new URL(`${qbApiBase}/v3/company/${realmId}/reports/${reportName}`);
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("accounting_method", accountingMethod);
  url.searchParams.set("minorversion", "75");
  if (reportName === SUMMARY_REPORT) url.searchParams.set("summarize_column_by", "Total");

  const response = await fetchImpl(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw new QboMonthlyPnlIngestionError("qbo_report_fetch_failed", response.status || 502, {
      report_name: reportName,
      provider_status: response.status || null,
      provider_error: summarizeProviderError(json || text),
    });
  }
  if (!json || typeof json !== "object") {
    throw new QboMonthlyPnlIngestionError("qbo_report_malformed", 502, { report_name: reportName });
  }
  return { report: json, reportName, realmId };
}

export async function fetchPreferredDetailReport(args) {
  let lastError = null;
  for (const reportName of DETAIL_REPORTS) {
    try {
      return await args.fetchReport({ ...args, reportName });
    } catch (err) {
      lastError = err;
      if (!isDetailFallbackAllowedError(err)) throw err;
    }
  }
  throw new QboMonthlyPnlIngestionError("qbo_detail_report_unavailable", lastError?.status || 502, {
    attempted_reports: DETAIL_REPORTS,
    cause: lastError?.message || null,
  });
}

export async function fetchQboChartOfAccounts({
  businessId,
  getQBOClient = defaultGetQBOClient,
} = {}) {
  const qbo = await getQBOClient(businessId);
  if (!qbo) throw new QboMonthlyPnlIngestionError("qbo_client_unavailable", 409);
  const data = await new Promise((resolve, reject) => {
    if (typeof qbo.findAccounts !== "function") {
      reject(new QboMonthlyPnlIngestionError("qbo_find_accounts_unavailable", 501));
      return;
    }
    qbo.findAccounts({ Active: true }, (err, result) => (err ? reject(err) : resolve(result)));
  });
  const rows = Array.isArray(data?.QueryResponse?.Account) ? data.QueryResponse.Account : [];
  return rows.map((account) => ({
    id: account?.Id ? String(account.Id) : null,
    name: account?.Name || null,
    fullyQualifiedName: account?.FullyQualifiedName || account?.Name || null,
    type: account?.AccountType || null,
    subType: account?.AccountSubType || null,
    active: account?.Active !== false,
    classification: account?.Classification || null,
    raw: account,
  })).filter((account) => account.id && account.active);
}

export function normalizeQboPnlSnapshotPayload({
  businessId,
  reviewYear,
  reviewMonth,
  realmId,
  qboEnvironment = qboEnvName,
  accountingMethod = "Cash",
  sourceStartDate,
  sourceEndDate,
  summaryReport,
  detailReport,
  detailReportName,
  qboAccounts = [],
} = {}) {
  const summary = parseProfitAndLossSummary(summaryReport, {
    reviewYear,
    reviewMonth,
    sourceStartDate,
    sourceEndDate,
    accountingMethod,
  });
  const resolver = buildAccountIdentityResolver(qboAccounts);
  let accounts = resolveAccountRows(summary.account_rows, resolver);
  const transactions = normalizeDetailTransactions(detailReport, {
    detailReportName,
    sourceStartDate,
    sourceEndDate,
    resolver,
    qboAccounts,
  });
  const reconciliation = reconcileNormalizedPnl({ summary, accounts, transactions, detailReportName });
  accounts = applyDetailCompletenessToAccounts(accounts, reconciliation);
  const metadata = {
    source: {
      summary_report: SUMMARY_REPORT,
      detail_report: detailReportName,
      qbo_realm_id: realmId || null,
      qbo_environment: qboEnvironment,
      account_identity: {
        report_ids_used: accounts.filter((row) => row.qbo_account_id && row.metadata?.identity_source === "report").length,
        coa_resolved: accounts.filter((row) => row.qbo_account_id && row.metadata?.identity_source !== "report").length,
        unresolved: accounts.filter((row) => !row.qbo_account_id).length,
      },
      kpi_source: "qbo_profit_and_loss_summary",
      unposted_bizzi_transactions_included: false,
      qbo_writes: false,
    },
    reconciliation,
  };
  validateNormalizedPayload({
    businessId,
    reviewYear,
    reviewMonth,
    realmId,
    sourceStartDate,
    sourceEndDate,
    summary,
    accounts,
    transactions,
    reconciliation,
  });
  const raw_hash = createHash("sha256")
    .update(stableStringify({ summary: summary.raw_header, accounts, transactions }))
    .digest("hex");
  return { summary, accounts, transactions, metadata, raw_hash, reconciliation };
}

export function parseProfitAndLossSummary(report, {
  reviewYear,
  reviewMonth,
  sourceStartDate,
  sourceEndDate,
  accountingMethod = "Cash",
} = {}) {
  const header = report?.Header || report?.ReportHeader || {};
  const actualStart = header?.StartPeriod || sourceStartDate;
  const actualEnd = header?.EndPeriod || sourceEndDate;
  const reportBasis = findHeaderOption(header, "reportbasis") || accountingMethod;
  if (actualStart !== sourceStartDate || actualEnd !== sourceEndDate) {
    throw new QboMonthlyPnlIngestionError("qbo_summary_date_mismatch", 409, {
      expected_start_date: sourceStartDate,
      expected_end_date: sourceEndDate,
      report_start_date: actualStart,
      report_end_date: actualEnd,
    });
  }

  const totals = {
    revenue: null,
    cogs: null,
    expenses: null,
    other_income: 0,
    other_expense: 0,
    gross_profit: null,
    net_operating_income: null,
    net_other_income: null,
    net_profit: null,
  };
  const accountRows = [];
  let displayOrder = 0;
  walkReportRows(report?.Rows?.Row || [], [], (row, ancestors) => {
    const label = rowLabel(row);
    const amount = amountFromColData(row?.Summary?.ColData || row?.ColData);
    const norm = normalizeLabel(rowTotalLabel(row) || label);
    if (amount !== null) {
      if (/^total income$|^total revenue$/.test(norm)) totals.revenue = amount;
      else if (/^total cost of goods sold$|^total cogs$/.test(norm)) totals.cogs = amount;
      else if (/^gross profit$/.test(norm)) totals.gross_profit = amount;
      else if (/^total expenses$/.test(norm)) totals.expenses = amount;
      else if (/^net operating income$/.test(norm)) totals.net_operating_income = amount;
      else if (/^total other income$/.test(norm)) totals.other_income = amount;
      else if (/^total other expenses?$/.test(norm)) totals.other_expense = amount;
      else if (/^net other income$/.test(norm)) totals.net_other_income = amount;
      else if (/^net income$|^net profit$/.test(norm)) totals.net_profit = amount;
    }
    if (isLeafAccountRow(row) && amount !== null) {
      const section = classifyAccountSection(ancestors);
      if (section) {
        const firstCol = firstColData(row);
        accountRows.push({
          qbo_account_id: firstCol?.id ? String(firstCol.id) : null,
          account_name: label || "Unresolved account",
          account_path: label || null,
          account_type: section,
          account_subtype: null,
          total_amount: amount,
          display_order: displayOrder,
          metadata: {
            qbo_report_row_type: row?.type || null,
            identity_source: firstCol?.id ? "report" : "unresolved",
          },
          raw_ref: safeRawRef(row),
        });
        displayOrder += 1;
      }
    }
  });

  const missing = [];
  if (totals.revenue === null) missing.push("revenue");
  if (totals.expenses === null) missing.push("expenses");
  if (totals.net_profit === null) missing.push("net_profit");
  if (missing.length > 0) {
    throw new QboMonthlyPnlIngestionError("qbo_summary_required_total_missing", 409, { missing });
  }

  const revenue = totals.revenue;
  const cogs = totals.cogs ?? 0;
  const expenses = totals.expenses;
  const netProfit = totals.net_profit;

  return {
    revenue,
    cogs,
    expenses,
    net_profit: netProfit,
    other_income: totals.other_income,
    other_expense: totals.other_expense,
    gross_profit: totals.gross_profit,
    net_operating_income: totals.net_operating_income,
    net_other_income: totals.net_other_income,
    accounting_method: reportBasis,
    source_start_date: sourceStartDate,
    source_end_date: sourceEndDate,
    review_year: Number(reviewYear),
    review_month: Number(reviewMonth),
    account_rows: accountRows,
    raw_header: header,
  };
}

export function normalizeDetailTransactions(report, {
  detailReportName,
  sourceStartDate,
  sourceEndDate,
  resolver,
  qboAccounts = [],
} = {}) {
  const columns = reportColumns(report);
  const rows = [];
  const missingIdentity = [];
  const qboAccountById = new Map(qboAccounts.filter((account) => account?.id).map((account) => [String(account.id), account]));
  walkReportRows(report?.Rows?.Row || [], [], (row, ancestors) => {
    if (!isTransactionDataRow(row)) return;
    const values = columnsToObject(row.ColData, columns);
    const txnDate = normalizeDate(pickValue(values, ["date", "txndate"]));
    if (!txnDate) return;
    if (txnDate < sourceStartDate || txnDate > sourceEndDate) return;
    const accountContext = nearestAccountContext(ancestors);
    const accountName = pickValue(values, ["account", "split", "distributionaccount"]) || accountContext?.name || null;
    const accountRef = resolver.resolve({
      id: firstId(row.ColData, ["account", "split", "distributionaccount"], columns),
      name: accountName,
      path: accountName,
    });
    if (detailReportName === "GeneralLedger" && !isPnlAccount(accountRef.account || qboAccountById.get(String(firstId(row.ColData, ["account", "split", "distributionaccount"], columns) || "")))) {
      return;
    }
    const txnId = firstId(row.ColData, ["txntype", "transactiontype", "type", "num", "docnum"], columns) || null;
    const txnType = pickValue(values, ["txntype", "transactiontype", "type"]) || row?.TxnType || null;
    const amount = amountFromCandidates(values, ["amount", "debit", "credit", "netamount", "total"]);
    const normalized = {
      qbo_txn_id: txnId ? String(txnId) : null,
      qbo_txn_type: txnType || null,
      txn_date: txnDate,
      qbo_account_id: accountRef.account?.id || null,
      qbo_account_name: accountRef.account?.name || accountName || null,
      entity_name: pickValue(values, ["name", "entity", "payee", "vendor", "customer"]),
      payee_name: pickValue(values, ["name", "payee"]),
      customer_name: pickValue(values, ["customer"]),
      vendor_name: pickValue(values, ["vendor"]),
      memo: pickValue(values, ["memo"]),
      description: pickValue(values, ["memo", "description", "name"]),
      amount,
      metadata: {
        detail_report: detailReportName,
        account_identity_status: accountRef.status,
        account_identity_source: accountRef.source,
        mutation_authoritative: Boolean(accountRef.account?.id && accountRef.status === "resolved"),
      },
      raw_ref: safeRawRef(row),
    };
    if (!normalized.qbo_txn_id || !normalized.qbo_txn_type) {
      missingIdentity.push({ txn_date: txnDate, amount, description: normalized.description });
      return;
    }
    rows.push(normalized);
  });
  if (missingIdentity.length > 0) {
    throw new QboMonthlyPnlIngestionError("qbo_detail_transaction_identity_missing", 409, {
      detail_report: detailReportName,
      missing_count: missingIdentity.length,
      examples: missingIdentity.slice(0, 3),
    });
  }
  return rows;
}

export function buildAccountIdentityResolver(accounts = []) {
  const byId = new Map();
  const byPath = new Map();
  const byName = new Map();
  for (const account of accounts) {
    if (!account?.id) continue;
    const shaped = {
      id: String(account.id),
      name: account.name || account.fullyQualifiedName || null,
      path: account.fullyQualifiedName || account.name || null,
      type: account.type || null,
      subType: account.subType || account.account_subtype || null,
    };
    byId.set(shaped.id, shaped);
    addBucket(byPath, normalizePath(shaped.path), shaped);
    addBucket(byName, normalizeLabel(shaped.name), shaped);
  }
  return {
    resolve({ id, name, path } = {}) {
      if (id && byId.has(String(id))) {
        return { status: "resolved", source: "report", account: byId.get(String(id)) };
      }
      const pathKey = normalizePath(path || name);
      const pathMatches = pathKey ? byPath.get(pathKey) || [] : [];
      if (pathMatches.length === 1) return { status: "resolved", source: "coa_path", account: pathMatches[0] };
      if (pathMatches.length > 1) return { status: "ambiguous", source: "coa_path", account: null };
      const nameKey = normalizeLabel(name);
      const nameMatches = nameKey ? byName.get(nameKey) || [] : [];
      if (nameMatches.length === 1) return { status: "resolved", source: "coa_name", account: nameMatches[0] };
      if (nameMatches.length > 1) return { status: "ambiguous", source: "coa_name", account: null };
      return { status: "unresolved", source: "none", account: null };
    },
  };
}

function resolveAccountRows(rows, resolver) {
  return rows.map((row) => {
    const resolved = resolver.resolve({
      id: row.qbo_account_id,
      name: row.account_name,
      path: row.account_path,
    });
    const account = resolved.account;
    const compatible = !account || isCompatiblePnlType(row.account_type, account.type);
    return {
      ...row,
      qbo_account_id: account?.id || row.qbo_account_id || null,
      account_name: account?.name || row.account_name,
      account_path: account?.path || row.account_path || row.account_name,
      account_type: account?.type || row.account_type,
      account_subtype: account?.subType || row.account_subtype || null,
      metadata: {
        ...(row.metadata || {}),
        account_identity_status: compatible ? resolved.status : "type_conflict",
        identity_source: resolved.source,
        report_account_type: row.account_type,
        coa_account_type: account?.type || null,
        mutation_authoritative: Boolean(account?.id && resolved.status === "resolved" && compatible),
      },
    };
  });
}

function validateNormalizedPayload({ sourceStartDate, sourceEndDate, summary, accounts, transactions, reconciliation }) {
  if (summary.source_start_date !== sourceStartDate || summary.source_end_date !== sourceEndDate) {
    throw new QboMonthlyPnlIngestionError("normalized_summary_range_mismatch", 409);
  }
  for (const txn of transactions) {
    if (txn.txn_date < sourceStartDate || txn.txn_date > sourceEndDate) {
      throw new QboMonthlyPnlIngestionError("normalized_detail_outside_selected_month", 409, {
        qbo_txn_id: txn.qbo_txn_id,
        txn_date: txn.txn_date,
      });
    }
  }
  const ambiguous = accounts.filter((row) => row.metadata?.account_identity_status === "ambiguous");
  if (ambiguous.length > 0) {
    throw new QboMonthlyPnlIngestionError("qbo_account_identity_ambiguous", 409, {
      accounts: ambiguous.map((row) => row.account_name),
    });
  }
  const typeConflicts = accounts.filter((row) => row.metadata?.account_identity_status === "type_conflict");
  if (typeConflicts.length > 0) {
    throw new QboMonthlyPnlIngestionError("qbo_account_identity_type_conflict", 409, {
      accounts: typeConflicts.map((row) => row.account_name),
    });
  }
  if (reconciliation?.status === "failed") {
    throw new QboMonthlyPnlIngestionError("qbo_pnl_reconciliation_failed", 409, {
      checks: reconciliation.checks,
      diagnostics: buildSafeReconciliationDiagnostics(reconciliation),
    });
  }
}

function applyDetailCompletenessToAccounts(accounts = [], reconciliation = {}) {
  const byKey = new Map((reconciliation.account_detail_completeness || []).map((row) => [row.key, row]));
  return accounts.map((account) => {
    const key = account.qbo_account_id || `name:${normalizePath(account.account_name)}`;
    const detail = byKey.get(key) || null;
    return {
      ...account,
      metadata: {
        ...(account.metadata || {}),
        detail_completeness: detail?.detail_completeness || "unavailable",
        detail_total: detail?.detail_total ?? null,
        detail_difference: detail?.difference ?? null,
        detail_transaction_count: detail?.detail_transaction_count ?? 0,
      },
    };
  });
}

function buildSafeReconciliationDiagnostics(reconciliation = {}) {
  return {
    detail_report: reconciliation.detail_report || null,
    detail_status: reconciliation.detail_status || null,
    detail_accounts_compared: reconciliation.detail_accounts_compared || 0,
    summary_totals: reconciliation.summary_totals || {},
    account_totals: reconciliation.account_totals || {},
    detail_totals: reconciliation.detail_totals || {},
    parsed_counts: reconciliation.parsed_counts || {},
    account_detail_completeness: reconciliation.account_detail_completeness || [],
    failed_checks: (reconciliation.checks || []).filter((check) => check.status === "failed"),
  };
}

function validatePersistedStagedSnapshotIntegrity({ persisted, normalized }) {
  if (!persisted?.snapshot?.id || persisted.snapshot.is_current) throw new QboMonthlyPnlIngestionError("snapshot_not_staged", 500);
  if (Number(persisted.snapshot.revenue) !== Number(normalized.summary.revenue)) {
    throw new QboMonthlyPnlIngestionError("snapshot_revenue_mismatch", 500);
  }
  if (Number(persisted.snapshot.net_profit) !== Number(normalized.summary.net_profit)) {
    throw new QboMonthlyPnlIngestionError("snapshot_net_profit_mismatch", 500);
  }
}

async function loadQboContext({ businessId }) {
  const row = await getLatestQuickBooksTokenRow(businessId);
  if (!row?.realm_id) throw new QboMonthlyPnlIngestionError("quickbooks_not_connected", 409);
  return {
    realmId: row.realm_id,
    qboEnvironment: row.qbo_env || qboEnvName,
  };
}

async function markSnapshotFailedBestEffort({ db, businessId, snapshotId, err }) {
  await db
    .from("monthly_review_qbo_pnl_snapshots")
    .update({
      is_current: false,
      status: "failed",
      metadata: { error: err?.error || err?.message || String(err) },
      updated_at: new Date().toISOString(),
    })
    .eq("business_id", businessId)
    .eq("id", snapshotId);
}

function walkReportRows(rows = [], ancestors = [], cb = () => {}) {
  for (const row of rows || []) {
    if (!row) continue;
    cb(row, ancestors);
    const next = [...ancestors, row];
    if (Array.isArray(row?.Rows?.Row)) walkReportRows(row.Rows.Row, next, cb);
  }
}

function rowLabel(row) {
  return row?.Header?.ColData?.[0]?.value || row?.Summary?.ColData?.[0]?.value || row?.ColData?.[0]?.value || "";
}

function rowTotalLabel(row) {
  return row?.Summary?.ColData?.[0]?.value || "";
}

function isLeafAccountRow(row) {
  return Array.isArray(row?.ColData) && row.ColData.length > 0 && !Array.isArray(row?.Rows?.Row) && !/^total /i.test(rowLabel(row));
}

function classifyAccountSection(ancestors = []) {
  const labels = ancestors.map(rowLabel).map(normalizeLabel);
  const joined = labels.join(" > ");
  if (/cost of goods sold|cogs/.test(joined)) return "Cost of Goods Sold";
  if (/other income/.test(joined)) return "Other Income";
  if (/other expense/.test(joined)) return "Other Expense";
  if (/income|revenue/.test(joined)) return "Income";
  if (/expense/.test(joined)) return "Expense";
  return null;
}

function isTransactionDataRow(row) {
  if (!Array.isArray(row?.ColData) || row.ColData.length === 0) return false;
  if (Array.isArray(row?.Rows?.Row)) return false;
  if (row?.Summary || row?.Header) return false;
  const type = normalizeLabel(row?.type || "");
  if (type && type !== "data") return false;
  const label = normalizeLabel(rowLabel(row));
  if (!label || /^total /.test(label) || /^subtotal /.test(label)) return false;
  return true;
}

function isPnlAccount(account) {
  return PNL_ACCOUNT_TYPES.has(canonicalPnlType(account?.type || account?.account_type || account?.AccountType));
}

function isCompatiblePnlType(reportType, coaType) {
  if (!coaType) return true;
  const report = canonicalPnlType(reportType);
  const coa = canonicalPnlType(coaType);
  return !report || !coa || report === coa;
}

function canonicalPnlType(value) {
  const norm = normalizeLabel(value);
  if (!norm) return null;
  if (norm === "cost of goods sold" || norm === "cogs") return "Cost of Goods Sold";
  if (norm === "other income") return "Other Income";
  if (norm === "other expense" || norm === "other expenses") return "Other Expense";
  if (norm === "income" || norm === "revenue") return "Income";
  if (norm === "expense" || norm === "expenses") return "Expense";
  return value;
}

function reconcileNormalizedPnl({ summary, accounts, transactions, detailReportName }) {
  const checks = [];
  const accountTotals = {
    revenue: roundMoney(sumAccountRows(accounts, "Income")),
    cogs: roundMoney(sumAccountRows(accounts, "Cost of Goods Sold")),
    expenses: roundMoney(sumAccountRows(accounts, "Expense")),
    other_income: roundMoney(sumAccountRows(accounts, "Other Income")),
    other_expense: roundMoney(sumAccountRows(accounts, "Other Expense")),
  };
  addReconciliationCheck(checks, "summary_vs_accounts.revenue", summary.revenue, accountTotals.revenue);
  addReconciliationCheck(checks, "summary_vs_accounts.cogs", summary.cogs, accountTotals.cogs);
  addReconciliationCheck(checks, "summary_vs_accounts.expenses", summary.expenses, accountTotals.expenses);
  addReconciliationCheck(checks, "summary_vs_accounts.other_income", summary.other_income || 0, accountTotals.other_income);
  addReconciliationCheck(checks, "summary_vs_accounts.other_expense", summary.other_expense || 0, accountTotals.other_expense);
  addReconciliationCheck(
    checks,
    "summary_net_profit_formula",
    summary.net_profit,
    roundMoney(summary.revenue - summary.cogs - summary.expenses + (summary.other_income || 0) - (summary.other_expense || 0))
  );

  const detailByAccount = new Map();
  const detailCountByAccount = new Map();
  for (const txn of transactions) {
    const key = txn.qbo_account_id || `name:${normalizePath(txn.qbo_account_name)}`;
    detailByAccount.set(key, roundMoney((detailByAccount.get(key) || 0) + Number(txn.amount || 0)));
    detailCountByAccount.set(key, (detailCountByAccount.get(key) || 0) + 1);
  }
  const detailTotals = {};
  for (const [key, amount] of detailByAccount.entries()) detailTotals[key] = amount;
  let detailComparable = 0;
  const accountDetailCompleteness = [];
  for (const account of accounts) {
    const key = account.qbo_account_id || `name:${normalizePath(account.account_name)}`;
    const detailTotal = detailByAccount.get(key) || 0;
    const detailCount = detailCountByAccount.get(key) || 0;
    const difference = roundMoney(detailTotal - Number(account.total_amount || 0));
    if (!detailByAccount.has(key)) {
      accountDetailCompleteness.push({
        key,
        account_name: account.account_name,
        account_path: account.account_path || account.account_name || null,
        detail_completeness: Math.abs(roundMoney(account.total_amount)) > RECONCILIATION_TOLERANCE ? "unavailable" : "complete",
        account_total: roundMoney(account.total_amount),
        detail_total: 0,
        difference: roundMoney(-Number(account.total_amount || 0)),
        detail_transaction_count: 0,
      });
      continue;
    }
    const complete = Math.abs(difference) <= RECONCILIATION_TOLERANCE;
    accountDetailCompleteness.push({
      key,
      account_name: account.account_name,
      account_path: account.account_path || account.account_name || null,
      detail_completeness: complete ? "complete" : "incomplete",
      account_total: roundMoney(account.total_amount),
      detail_total: detailTotal,
      difference,
      detail_transaction_count: detailCount,
    });
    if (complete) {
      detailComparable += 1;
      addReconciliationCheck(
        checks,
        `account_vs_detail.${account.account_path || account.account_name}`,
        account.total_amount,
        detailTotal
      );
    }
  }
  const hasIncompleteDetail = accountDetailCompleteness.some((row) => row.detail_completeness !== "complete");
  const failed = checks.filter((check) => check.status === "failed");
  const rounded = checks.filter((check) => check.status === "valid_with_nonmaterial_rounding");
  return {
    status: failed.length > 0 ? "failed" : (rounded.length > 0 ? "valid_with_nonmaterial_rounding" : "valid"),
    tolerance: RECONCILIATION_TOLERANCE,
    detail_status: transactions.length === 0 ? "unavailable" : (hasIncompleteDetail ? "incomplete" : "complete"),
    detail_report: detailReportName,
    detail_accounts_compared: detailComparable,
    summary_totals: {
      revenue: summary.revenue,
      cogs: summary.cogs,
      expenses: summary.expenses,
      other_income: summary.other_income || 0,
      other_expense: summary.other_expense || 0,
      net_profit: summary.net_profit,
    },
    account_totals: accountTotals,
    detail_totals: detailTotals,
    parsed_counts: {
      account_rows: accounts.length,
      detail_rows: transactions.length,
      detail_accounts: detailByAccount.size,
    },
    account_detail_completeness: accountDetailCompleteness,
    checks,
  };
}

function addReconciliationCheck(checks, name, expected, actual) {
  const left = roundMoney(expected);
  const right = roundMoney(actual);
  const difference = roundMoney(right - left);
  const abs = Math.abs(difference);
  checks.push({
    name,
    expected: left,
    actual: right,
    difference,
    status: abs === 0 ? "valid" : (abs <= RECONCILIATION_TOLERANCE ? "valid_with_nonmaterial_rounding" : "failed"),
  });
}

function nearestAccountContext(ancestors = []) {
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const row = ancestors[i];
    const label = rowLabel(row);
    if (label && !/^total /i.test(label)) {
      const id = row?.Header?.ColData?.[0]?.id || row?.ColData?.[0]?.id || null;
      return { name: label, id };
    }
  }
  return null;
}

function firstColData(row) {
  const col = row?.ColData?.[0] || row?.Header?.ColData?.[0] || row?.Summary?.ColData?.[0] || null;
  return col || null;
}

function amountFromColData(cols = []) {
  if (!Array.isArray(cols)) return null;
  for (let i = cols.length - 1; i >= 0; i -= 1) {
    const parsed = parseMoney(cols[i]?.value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function amountFromCandidates(values, keys) {
  for (const key of keys) {
    const parsed = parseMoney(values[key]);
    if (parsed !== null) return parsed;
  }
  return 0;
}

function parseMoney(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).replace(/[$,]/g, "").trim();
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text);
  const number = Number.parseFloat(text.replace(/[()]/g, ""));
  if (!Number.isFinite(number)) return null;
  return negative ? -number : number;
}

function sumAccountRows(rows, type) {
  return rows.filter((row) => row.account_type === type).reduce((sum, row) => sum + Number(row.total_amount || 0), 0);
}

function roundMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function findHeaderOption(header, name) {
  const wanted = normalizeLabel(name);
  return (header?.Option || []).find((item) => normalizeLabel(item?.Name) === wanted)?.Value || null;
}

function reportColumns(report) {
  return (report?.Columns?.Column || []).map((col, index) => ({
    key: normalizeColumnKey(col?.ColTitle || col?.ColType || `col_${index}`),
    title: col?.ColTitle || col?.ColType || `col_${index}`,
    index,
  }));
}

function columnsToObject(colData = [], columns = []) {
  const out = {};
  colData.forEach((col, index) => {
    const key = columns[index]?.key || `col_${index}`;
    out[key] = col?.value ?? null;
    if (col?.id) out[`${key}_id`] = String(col.id);
  });
  return out;
}

function pickValue(values, keys) {
  for (const key of keys) {
    if (values[key] !== null && values[key] !== undefined && String(values[key]).trim()) return String(values[key]).trim();
  }
  return null;
}

function firstId(colData, keys, columns) {
  for (let i = 0; i < colData.length; i += 1) {
    const key = columns[i]?.key;
    if (keys.includes(key) && colData[i]?.id) return String(colData[i].id);
  }
  return null;
}

function normalizeColumnKey(value) {
  const normalized = normalizeLabel(value).replace(/\s+/g, "");
  const aliases = {
    transactiontype: "txntype",
    transactiondate: "date",
    docnumber: "docnum",
    distributionaccount: "distributionaccount",
    memodescription: "memo",
    splitaccount: "split",
  };
  return aliases[normalized] || normalized;
}

function normalizeDate(value) {
  if (!value) return null;
  const direct = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  if (direct) return direct[0];
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeLabel(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizePath(value) {
  return String(value || "").toLowerCase().replace(/\s*:\s*/g, ":").replace(/\s+/g, " ").trim();
}

function addBucket(map, key, value) {
  if (!key) return;
  const bucket = map.get(key) || [];
  bucket.push(value);
  map.set(key, bucket);
}

function safeRawRef(row) {
  return {
    type: row?.type || null,
    group: row?.group || null,
    col_data: Array.isArray(row?.ColData) ? row.ColData : undefined,
    header: row?.Header || undefined,
    summary: row?.Summary || undefined,
  };
}

function summarizeProviderError(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 500);
  return JSON.stringify(value).slice(0, 500);
}

function isDetailFallbackAllowedError(err) {
  if (err?.error === "qbo_report_malformed") return false;
  const status = Number(err?.status || err?.details?.provider_status || 0);
  if (FALLBACK_ALLOWED_STATUSES.has(status)) return true;
  if (status !== 400) return false;
  const providerText = String(err?.details?.provider_error || err?.message || "").toLowerCase();
  return /unsupported|not supported|not found|unknown report|invalid report|report .* unavailable/.test(providerText);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export default {
  buildAccountIdentityResolver,
  fetchMonthlyQboPnlAccountTransactions,
  fetchPreferredDetailReport,
  fetchQboChartOfAccounts,
  fetchQboReport,
  getMonthlyQboPnlSnapshot,
  normalizeDetailTransactions,
  normalizeQboPnlSnapshotPayload,
  parseProfitAndLossSummary,
  refreshMonthlyQboPnlSnapshot,
};
