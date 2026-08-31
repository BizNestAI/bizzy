import { supabase as defaultSupabase } from "../supabaseAdmin.js";
import { qboEnvName } from "../../utils/qboEnv.js";
import { monthKeyFromParts, rangeLastNMonths } from "../../utils/monthKey.js";
import { getLatestQuickBooksTokenRow } from "../quickbooksTokenService.js";
import {
  createOrReplaceMonthlyPnlSnapshot,
  getLatestMonthlyPnlSnapshot,
  promoteMonthlyPnlSnapshotCurrent,
} from "../bookkeeping/qboMonthlyPnlSnapshotService.js";
import {
  fetchQboReport,
  parseProfitAndLossSummary,
  QboMonthlyPnlIngestionError,
} from "../bookkeeping/qboMonthlyPnlIngestionService.js";

export const HEALTH_ACCOUNTING_METHOD = "Accrual";
const TOLERANCE = 0.01;

export class HealthMonthlySnapshotError extends Error {
  constructor(error, status = 400, details = {}) {
    super(error);
    this.name = "HealthMonthlySnapshotError";
    this.error = error;
    this.status = status;
    this.details = details;
  }
}

export async function refreshMonthlyQboFinancialSnapshot({
  db = defaultSupabase,
  businessId,
  year,
  month,
  source = "manual_refresh",
  accountingMethod = HEALTH_ACCOUNTING_METHOD,
  loadContext = loadQboContext,
  fetchReport = fetchQboReport,
  persistSnapshot = createOrReplaceMonthlyPnlSnapshot,
  promoteSnapshot = promoteMonthlyPnlSnapshotCurrent,
} = {}) {
  assertMonthIdentity({ businessId, year, month });
  const reviewYear = Number(year);
  const reviewMonth = Number(month);
  const sourceStartDate = monthKeyFromParts(reviewYear, reviewMonth);
  const sourceEndDate = new Date(Date.UTC(reviewYear, reviewMonth, 0)).toISOString().slice(0, 10);
  const context = await loadContext({ businessId, db });
  const summaryResponse = await fetchReport({
    businessId,
    realmId: context.realmId,
    reportName: "ProfitAndLoss",
    startDate: sourceStartDate,
    endDate: sourceEndDate,
    accountingMethod,
  });
  const parsed = parseProfitAndLossSummary(summaryResponse.report, {
    reviewYear,
    reviewMonth,
    sourceStartDate,
    sourceEndDate,
    accountingMethod,
  });
  validateParsedHealthSummary(parsed);
  const accounts = parsed.account_rows.map((row, index) => ({
    ...row,
    display_order: Number(row.display_order ?? index),
    row_order: Number(row.row_order ?? index),
  }));
  const staged = await persistSnapshot({
    db,
    businessId,
    reviewYear,
    reviewMonth,
    qboRealmId: context.realmId,
    qboEnvironment: context.qboEnvironment,
    accountingMethod: parsed.accounting_method || accountingMethod,
    sourceStartDate,
    sourceEndDate,
    pulledAt: new Date().toISOString(),
    revenue: parsed.revenue,
    cogs: parsed.cogs,
    expenses: parsed.expenses,
    netProfit: parsed.net_profit,
    metadata: {
      source: {
        module: "health",
        refresh_source: source,
        qbo_report: "ProfitAndLoss",
        qbo_writes: false,
        qbo_realm_id: context.realmId,
        qbo_environment: context.qboEnvironment,
        accounting_method: parsed.accounting_method || accountingMethod,
      },
      completeness: {
        snapshot_complete: false,
        compatibility_tables_written: false,
      },
      reconciliation: parsed.reconciliation,
    },
    accounts,
    transactions: [],
    linkTransactions: false,
    promote: false,
  });

  await replaceCompatibilityFinancialRows({
    db,
    businessId,
    year: reviewYear,
    month: reviewMonth,
    snapshot: staged.snapshot,
    accounts: staged.accounts,
  });

  const promoted = await promoteSnapshot({
    db,
    businessId,
    reviewYear,
    reviewMonth,
    snapshotId: staged.snapshot.id,
    status: "current",
  });

  return getMonthlyHealthSummary({
    db,
    businessId,
    year: reviewYear,
    month: reviewMonth,
    snapshot: promoted,
    accounts: staged.accounts,
  });
}

export async function getMonthlyHealthSummary({
  db = defaultSupabase,
  businessId,
  year,
  month,
  snapshot = null,
  accounts = null,
  window = 12,
} = {}) {
  assertMonthIdentity({ businessId, year, month });
  const reviewYear = Number(year);
  const reviewMonth = Number(month);
  const current = snapshot || await getLatestMonthlyPnlSnapshot({
    db,
    businessId,
    reviewYear,
    reviewMonth,
    includeAccounts: true,
    includeTransactions: false,
  });
  if (!current || current.status !== "current" || current.is_current !== true) {
    return {
      data_status: "missing",
      selected_month: monthKeyFromParts(reviewYear, reviewMonth),
      qbo_connection_status: "unknown",
      snapshot: null,
      metrics: null,
      expense_breakdown: [],
      account_breakdown: [],
      series: await getHealthSeries({ db, businessId, year: reviewYear, month: reviewMonth, window }),
      source: "monthly_review_qbo_pnl_snapshots",
    };
  }
  const accountRows = accounts || current.accounts || await selectRows(
    db
      .from("monthly_review_qbo_pnl_accounts")
      .select("*")
      .eq("business_id", businessId)
      .eq("snapshot_id", current.id)
      .order("display_order", { ascending: true })
      .order("row_order", { ascending: true })
  );
  const metrics = metricsFromSnapshot(current);
  const expenseBreakdown = buildExpenseBreakdown(accountRows);
  const monthText = monthKeyFromParts(reviewYear, reviewMonth);
  return {
    data_status: hasFinancialActivity(metrics) ? "available" : "empty",
    selected_month: monthText,
    qbo_connection_status: "connected",
    snapshot: {
      id: current.id,
      status: current.status,
      snapshot_complete: current.status === "current" && current.is_current === true,
      accounting_method: current.accounting_method || HEALTH_ACCOUNTING_METHOD,
      source: current.metadata?.source?.refresh_source || current.metadata?.source?.module || "qbo",
      last_successful_refresh_at: current.pulled_at || current.updated_at || current.created_at || null,
      pulled_at: current.pulled_at || null,
      review_year: current.review_year,
      review_month: current.review_month,
    },
    metrics,
    expense_breakdown: expenseBreakdown,
    account_breakdown: accountRows.map((row) => toLegacyAccountBreakdownRow(row, monthText)),
    series: await getHealthSeries({ db, businessId, year: reviewYear, month: reviewMonth, window }),
    source: "monthly_review_qbo_pnl_snapshots",
  };
}

export async function listAvailableHealthMonths({ db = defaultSupabase, businessId } = {}) {
  if (!businessId) throw new HealthMonthlySnapshotError("missing_business_id", 400);
  const rows = await selectRows(
    db
      .from("monthly_review_qbo_pnl_snapshots")
      .select("id,review_year,review_month,revenue,expenses,net_profit,pulled_at,updated_at,created_at,accounting_method,status,is_current")
      .eq("business_id", businessId)
      .eq("is_current", true)
      .eq("status", "current")
      .order("review_year", { ascending: false })
      .order("review_month", { ascending: false })
  );
  return rows.map((row) => ({
    month: monthKeyFromParts(row.review_year, row.review_month),
    has_activity: hasFinancialActivity(metricsFromSnapshot(row)),
    last_refreshed_at: row.pulled_at || row.updated_at || row.created_at || null,
    accounting_method: row.accounting_method || HEALTH_ACCOUNTING_METHOD,
    snapshot_id: row.id,
  }));
}

export async function getLatestAvailableHealthMonth({ db = defaultSupabase, businessId } = {}) {
  const months = await listAvailableHealthMonths({ db, businessId });
  return months.find((row) => row.has_activity) || months[0] || null;
}

export async function getHealthSeries({ db = defaultSupabase, businessId, year, month, window = 12 } = {}) {
  assertMonthIdentity({ businessId, year, month });
  const months = rangeLastNMonths({ year: Number(year), month: Number(month), n: Math.max(1, Math.min(24, Number(window || 12))) });
  const rows = await selectRows(
    db
      .from("monthly_review_qbo_pnl_snapshots")
      .select("review_year,review_month,revenue,expenses,net_profit,status,is_current")
      .eq("business_id", businessId)
      .eq("is_current", true)
      .eq("status", "current")
  );
  const byMonth = new Map(rows.map((row) => [monthKeyFromParts(row.review_year, row.review_month), row]));
  return {
    revenue: months.map((entry) => {
      const row = byMonth.get(entry.monthKey);
      return { year: entry.year, month: entry.month, revenue: Number(row?.revenue || 0), found: Boolean(row) };
    }),
    profit: months.map((entry) => {
      const row = byMonth.get(entry.monthKey);
      return { year: entry.year, month: entry.month, profit: Number(row?.net_profit || 0), found: Boolean(row) };
    }),
  };
}

export async function bootstrapMissingHealthHistory({
  db = defaultSupabase,
  businessId,
  months = 12,
  startYear = null,
  startMonth = null,
  source = "qbo_connection_bootstrap",
} = {}) {
  if (!businessId) throw new HealthMonthlySnapshotError("missing_business_id", 400);
  const now = new Date();
  const anchorYear = Number(startYear) || now.getFullYear();
  const anchorMonth = Number(startMonth) || now.getMonth() + 1;
  const wanted = rangeLastNMonths({ year: anchorYear, month: anchorMonth, n: Math.max(1, Math.min(36, Number(months || 12))) });
  const existing = new Set((await listAvailableHealthMonths({ db, businessId })).map((row) => row.month));
  const results = [];
  for (const entry of wanted) {
    if (existing.has(entry.monthKey)) {
      results.push({ month: entry.monthKey, status: "skipped_existing" });
      continue;
    }
    try {
      await refreshMonthlyQboFinancialSnapshot({
        db,
        businessId,
        year: entry.year,
        month: entry.month,
        source,
      });
      results.push({ month: entry.monthKey, status: "refreshed" });
    } catch (err) {
      results.push({ month: entry.monthKey, status: "failed", error: err?.error || err?.message || String(err) });
    }
  }
  return { ok: true, months: results };
}

async function replaceCompatibilityFinancialRows({ db, businessId, year, month, snapshot, accounts }) {
  const monthText = monthKeyFromParts(year, month);
  const metrics = metricsFromSnapshot(snapshot);
  const topExpense = buildExpenseBreakdown(accounts)[0]?.category || null;
  await assertNoError(
    db.from("financial_metrics").upsert({
      business_id: businessId,
      month: monthText,
      total_revenue: metrics.totalRevenue,
      total_expenses: metrics.totalExpenses,
      net_profit: metrics.netProfit,
      profit_margin: metrics.profitMargin,
      top_spending_category: topExpense,
      embedding_text: `QBO ${snapshot.accounting_method || HEALTH_ACCOUNTING_METHOD} snapshot for ${monthText}: revenue $${metrics.totalRevenue}, expenses $${metrics.totalExpenses}, net profit $${metrics.netProfit}`,
      updated_at: snapshot.pulled_at || new Date().toISOString(),
    }, { onConflict: "business_id,month" }),
    "financial_metrics_upsert_failed"
  );

  await replaceTableRows({
    db,
    table: "account_breakdown",
    businessId,
    monthText,
    rows: accounts.map((account) => ({
      business_id: businessId,
      month: monthText,
      account_name: account.account_name || "Unresolved account",
      account_type: account.account_type || null,
      balance: Math.abs(Number(account.total_amount || 0)),
      embedding_text: `${account.account_type || "QBO"} account ${account.account_name || "Unresolved account"} has balance $${Math.abs(Number(account.total_amount || 0)).toFixed(2)} for ${monthText}`,
      embedding: null,
    })),
  });

  await replaceTableRows({
    db,
    table: "expense_totals_monthly",
    businessId,
    monthText,
    rows: buildExpenseBreakdown(accounts).map((row) => ({
      business_id: businessId,
      month: monthText,
      category: row.category,
      amount: row.amount,
      source: "qbo_monthly_snapshot",
      updated_at: snapshot.pulled_at || new Date().toISOString(),
    })),
  });
}

async function replaceTableRows({ db, table, businessId, monthText, rows }) {
  await assertNoError(
    db.from(table).delete().eq("business_id", businessId).eq("month", monthText),
    `${table}_delete_failed`
  );
  if (!rows.length) return;
  await assertNoError(db.from(table).insert(rows), `${table}_insert_failed`);
}

function validateParsedHealthSummary(summary) {
  const accountTotals = {
    revenue: sumAccounts(summary.account_rows, "Income"),
    cogs: sumAccounts(summary.account_rows, "Cost of Goods Sold"),
    expenses: sumAccounts(summary.account_rows, "Expense"),
    otherIncome: sumAccounts(summary.account_rows, "Other Income"),
    otherExpense: sumAccounts(summary.account_rows, "Other Expense"),
  };
  assertClose("revenue", summary.revenue, accountTotals.revenue);
  assertClose("cogs", summary.cogs, accountTotals.cogs);
  assertClose("expenses", summary.expenses, accountTotals.expenses);
  const formula = roundMoney(summary.revenue - summary.cogs - summary.expenses + accountTotals.otherIncome - accountTotals.otherExpense);
  assertClose("net_profit", summary.net_profit, formula);
  summary.reconciliation = {
    status: "valid",
    account_totals: accountTotals,
    formula_net_profit: formula,
  };
}

async function loadQboContext({ businessId }) {
  const row = await getLatestQuickBooksTokenRow(businessId);
  if (!row?.realm_id) throw new HealthMonthlySnapshotError("quickbooks_not_connected", 409);
  return { realmId: row.realm_id, qboEnvironment: row.qbo_env || qboEnvName };
}

function metricsFromSnapshot(snapshot) {
  const revenue = roundMoney(snapshot?.revenue);
  const cogs = roundMoney(snapshot?.cogs);
  const expenses = roundMoney(snapshot?.expenses);
  const netProfit = roundMoney(snapshot?.net_profit);
  return {
    totalRevenue: revenue,
    totalExpenses: expenses,
    cogs,
    netProfit,
    profitMargin: revenue > 0 ? roundMoney((netProfit / revenue) * 100) : 0,
  };
}

function buildExpenseBreakdown(accounts = []) {
  const map = new Map();
  for (const account of accounts || []) {
    if (account?.account_type !== "Expense") continue;
    const amount = Math.abs(Number(account.total_amount || account.balance || 0));
    if (!(amount > 0)) continue;
    const category = account.account_name || account.account_path || "Other";
    map.set(category, roundMoney((map.get(category) || 0) + amount));
  }
  return Array.from(map.entries())
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
}

function toLegacyAccountBreakdownRow(account, monthText = null) {
  return {
    account_name: account.account_name,
    account_type: account.account_type,
    balance: Math.abs(Number(account.total_amount || 0)),
    month: account.month || monthText,
    qbo_account_id: account.qbo_account_id || null,
  };
}

function hasFinancialActivity(metrics) {
  return Boolean(
    Number(metrics?.totalRevenue || 0) !== 0 ||
    Number(metrics?.totalExpenses || 0) !== 0 ||
    Number(metrics?.netProfit || 0) !== 0
  );
}

function sumAccounts(rows = [], type) {
  return roundMoney(rows.filter((row) => row.account_type === type).reduce((sum, row) => sum + Math.abs(Number(row.total_amount || 0)), 0));
}

function assertClose(name, expected, actual) {
  if (Math.abs(roundMoney(expected) - roundMoney(actual)) > TOLERANCE) {
    throw new QboMonthlyPnlIngestionError("qbo_health_snapshot_reconciliation_failed", 409, {
      check: name,
      expected: roundMoney(expected),
      actual: roundMoney(actual),
    });
  }
}

async function selectRows(query) {
  const { data, error } = await query;
  if (error) throw new HealthMonthlySnapshotError("health_snapshot_query_failed", 500, { cause: error.message });
  return Array.isArray(data) ? data : [];
}

async function assertNoError(query, errorName) {
  const { error } = await query;
  if (error) throw new HealthMonthlySnapshotError(errorName, 500, { cause: error.message });
}

function assertMonthIdentity({ businessId, year, month }) {
  if (!businessId) throw new HealthMonthlySnapshotError("missing_business_id", 400);
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new HealthMonthlySnapshotError("invalid_year", 400);
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new HealthMonthlySnapshotError("invalid_month", 400);
}

function roundMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

export default {
  HEALTH_ACCOUNTING_METHOD,
  bootstrapMissingHealthHistory,
  getHealthSeries,
  getLatestAvailableHealthMonth,
  getMonthlyHealthSummary,
  listAvailableHealthMonths,
  refreshMonthlyQboFinancialSnapshot,
};
