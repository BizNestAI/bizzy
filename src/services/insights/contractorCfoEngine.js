import { supabase as defaultSupabase } from '../supabaseAdmin.js';
import {
  CONTRACTOR_CFO_RULES,
  evaluateContractorCfoRules,
} from './contractorCfoRules.js';
import {
  getRuleSensitivityAdjustments,
  shouldInsertInsight,
} from './insightDedupeService.js';
import { buildTaxInsightContext } from './context/buildTaxInsightContext.js';
import { applyActiveBookkeepingScope, getBookkeepingStartDate } from '../bookkeeping/bookkeepingScope.js';

const MODULE = 'contractor_cfo';
const DEFAULT_TRIGGER = 'scheduled';
const DEFAULT_LIMIT = 20;
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205']);
const COLUMN_ERROR_CODES = new Set(['42703', 'PGRST204']);

const SEVERITY_RANK = {
  critical: 4,
  warn: 3,
  warning: 3,
  info: 2,
  low: 1,
};

const CATEGORY_RANK = {
  cash_flow: 90,
  bookkeeping_reconciliation: 80,
  collections: 75,
  tax: 70,
  labor_payroll: 65,
  job_costing: 60,
  forecasts_health: 55,
  expenses: 50,
  change_orders: 45,
  tax_payment_due: 73,
  tax_reserve_gap: 72,
  tax_safe_harbor_gap: 71,
  tax_liability_change: 70,
  tax_profile_incomplete: 70,
  tax_entity_unknown: 70,
  tax_classification_review: 69,
  tax_confidence_low: 68,
  tax_state_unavailable: 67,
  tax_source_stale: 66,
  tax_payment_missing: 65,
  tax_projection_risk: 65,
  tax_deduction_opportunity: 64,
  tax_capitalizable_review: 64,
  tax_positive_progress: 50,
  tax_rule_support_changed: 50,
};

const DAY_MS = 24 * 60 * 60 * 1000;

let supabase = defaultSupabase;

export function __setContractorCfoEngineTestDeps(deps = {}) {
  supabase = deps.supabase || defaultSupabase;
}

function nowIso() {
  return new Date().toISOString();
}

function monthStart(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

function priorMonthStart(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
}

function monthKey(dateText) {
  return String(dateText || '').slice(0, 7);
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function dateMs(value) {
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function sum(rows = [], getter) {
  return rows.reduce((total, row) => total + toNumber(getter(row)), 0);
}

function maxDate(values = []) {
  const timestamps = values
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));
  if (!timestamps.length) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function isMissingSourceError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return (
    MISSING_TABLE_CODES.has(error?.code) ||
    msg.includes('does not exist') ||
    msg.includes('could not find the table') ||
    msg.includes('schema cache')
  );
}

function recordSourceIssue(snapshot, source, error) {
  const issue = {
    source,
    reason: isMissingSourceError(error) ? 'missing_source' : 'query_failed',
    message: error?.message || String(error || 'unknown error'),
  };
  snapshot.meta.missing_sources.push(issue);
}

async function safeRows(snapshot, source, table, buildQuery, fallback = []) {
  try {
    const base = supabase.from(table).select('*').eq('business_id', snapshot.businessId);
    const query = buildQuery ? buildQuery(base) : base;
    const { data, error } = await query;
    if (error) {
      recordSourceIssue(snapshot, source, error);
      return fallback;
    }
    return Array.isArray(data) ? data : fallback;
  } catch (error) {
    recordSourceIssue(snapshot, source, error);
    return fallback;
  }
}

function findMonthRow(rows, targetMonth) {
  const target = monthKey(targetMonth);
  return [...(rows || [])]
    .sort((a, b) => rowTimestamp(b) - rowTimestamp(a))
    .find((row) => monthKey(row.month || row.period || row.as_of || row.date) === target) || null;
}

function latestRow(rows, dateKeys = ['as_of', 'updated_at', 'created_at', 'month', 'period']) {
  return [...(rows || [])].sort((a, b) => {
    const ad = dateKeys.map((key) => new Date(a?.[key]).getTime()).find(Number.isFinite) || 0;
    const bd = dateKeys.map((key) => new Date(b?.[key]).getTime()).find(Number.isFinite) || 0;
    return bd - ad;
  })[0] || null;
}

function extractMetricValue(rows, key) {
  const row = latestRow((rows || []).filter((item) => item.key === key || item.metric_key === key));
  return row ? toNumber(row.value ?? row.metric_value ?? row.amount, null) : null;
}

function rowTimestamp(row) {
  return ['as_of', 'date', 'period', 'month', 'created_at', 'updated_at']
    .map((key) => dateMs(row?.[key]))
    .find(Number.isFinite) || 0;
}

function withinDays(dateText, nowText, days) {
  const ts = dateMs(dateText);
  const now = dateMs(nowText);
  if (ts == null || now == null) return false;
  return ts <= now && now - ts <= days * DAY_MS;
}

function isActiveCategorization(row) {
  const status = String(row?.status || '').toLowerCase();
  return (
    row?.is_archived !== true &&
    row?.deleted_at == null &&
    !['archived', 'deleted', 'duplicate_internal', 'duplicate_in_qbo', 'replaced'].includes(status)
  );
}

async function loadActiveBankTransactionIds(snapshot, limit = 1000) {
  const bookkeepingStartDate = await getBookkeepingStartDate(supabase, snapshot.businessId);
  const rows = await safeRows(
    snapshot,
    'bank_transactions_active_ids',
    'bank_transactions',
    (q) => applyActiveBookkeepingScope(q.eq('is_archived', false), bookkeepingStartDate).limit(limit)
  );
  snapshot.meta.sources.bank_transactions_active_ids = rows.length;
  return new Set(rows.map((row) => row.id).filter(Boolean));
}

function filterToActiveTransactionRows(rows, activeIds) {
  return (rows || []).filter((row) => {
    if (!isActiveCategorization(row)) return false;
    if (!row.transaction_id || !activeIds?.size) return true;
    return activeIds.has(row.transaction_id);
  });
}

function extractMetricValueAtOrBefore(rows, key, timestamp) {
  const row = [...(rows || [])]
    .filter((item) => item.key === key || item.metric_key === key)
    .filter((item) => {
      const ts = rowTimestamp(item);
      return ts > 0 && ts <= timestamp;
    })
    .sort((a, b) => rowTimestamp(b) - rowTimestamp(a))[0];
  return row ? toNumber(row.value ?? row.metric_value ?? row.amount, null) : null;
}

async function loadBusinessContext(snapshot) {
  snapshot.business = {
    businessId: snapshot.businessId,
    current_month: snapshot.currentMonth,
    prior_month: snapshot.priorMonth,
    current_date: snapshot.now,
  };
}

async function loadFinancialMetrics(snapshot) {
  const rows = await safeRows(snapshot, 'financial_metrics', 'financial_metrics', (q) => q.limit(500));
  snapshot.meta.sources.financial_metrics = rows.length;

  const current = findMonthRow(rows, snapshot.currentMonth);
  const prior = findMonthRow(rows, snapshot.priorMonth);
  const cashBalance = extractMetricValue(rows, 'cash_balance');
  const explicitCashBalance7dAgo =
    extractMetricValue(rows, 'cash_balance_7d_ago') ??
    extractMetricValue(rows, 'cash_balance_week_ago');
  const historicalCashBalance7dAgo = extractMetricValueAtOrBefore(
    rows,
    'cash_balance',
    new Date(snapshot.now).getTime() - 7 * DAY_MS
  );

  snapshot.financials = {
    revenue_current_period: toNumber(current?.total_revenue ?? current?.revenue ?? current?.income, null),
    revenue_recent_average: null,
    expenses_current_period: toNumber(current?.total_expenses ?? current?.expenses, null),
    expenses_prior_period: toNumber(prior?.total_expenses ?? prior?.expenses, null),
    gross_margin_pct: toNumber(current?.profit_margin ?? current?.gross_margin_pct ?? current?.margin_pct, null),
    prior_gross_margin_pct: toNumber(prior?.profit_margin ?? prior?.gross_margin_pct ?? prior?.margin_pct, null),
    net_profit: toNumber(current?.net_profit, null),
  };

  const recentRevenue = [...rows]
    .filter((row) => row.total_revenue != null || row.revenue != null || row.income != null)
    .filter((row) => monthKey(row.month || row.period || row.as_of || row.date) !== monthKey(snapshot.currentMonth))
    .sort((a, b) => rowTimestamp(b) - rowTimestamp(a))
    .map((row) => toNumber(row.total_revenue ?? row.revenue ?? row.income))
    .filter((value) => value > 0)
    .slice(0, 4);
  if (recentRevenue.length > 1) {
    snapshot.financials.revenue_recent_average = recentRevenue.reduce((a, b) => a + b, 0) / recentRevenue.length;
  }

  if (cashBalance != null) {
    snapshot.cash.balance = cashBalance;
  }
  if (explicitCashBalance7dAgo != null || historicalCashBalance7dAgo != null) {
    snapshot.cash.balance_7d_ago = explicitCashBalance7dAgo ?? historicalCashBalance7dAgo;
  }
}

async function loadPlaidAccounts(snapshot) {
  const rows = await safeRows(snapshot, 'plaid_accounts', 'plaid_accounts', (q) => q.limit(100));
  snapshot.meta.sources.plaid_accounts = rows.length;
  if (!rows.length) return;

  const balance = sum(rows, (row) => row.current_balance ?? row.available_balance ?? row.balance_current ?? row.balance ?? 0);
  if (snapshot.cash.balance == null) snapshot.cash.balance = balance;
  snapshot.cash.bank_balances = rows.map((row) => ({
    id: row.id,
    name: row.name || row.account_name || row.official_name,
    balance: toNumber(row.current_balance ?? row.available_balance ?? row.balance_current ?? row.balance),
    last_sync_at: row.last_sync_at || row.updated_at || null,
  }));
  snapshot.plaid.last_sync_at = maxDate(rows.map((row) => row.last_sync_at || row.updated_at || row.created_at));
}

async function loadForecasts(snapshot) {
  const cashflowRows = await safeRows(snapshot, 'cashflow_forecast', 'cashflow_forecast', (q) => q.limit(100));
  const monthlyRows = await safeRows(snapshot, 'monthly_forecast', 'monthly_forecast', (q) => q.limit(100));
  snapshot.meta.sources.cashflow_forecast = cashflowRows.length;
  snapshot.meta.sources.monthly_forecast = monthlyRows.length;

  const latest = latestRow(cashflowRows) || latestRow(monthlyRows);
  if (!latest) return;

  snapshot.cash.runway_months = toNumber(latest.runway_months ?? latest.cash_runway_months, null);
  snapshot.cash.projected_ending_cash_30d = toNumber(
    latest.projected_ending_cash_30d ??
      latest.projected_cash_30d ??
      latest.ending_cash ??
      latest.forecasted_cash,
    null
  );
  snapshot.forecast.runway_months = snapshot.cash.runway_months;
  snapshot.forecast.projected_cash_30d = snapshot.cash.projected_ending_cash_30d;
  snapshot.forecast.variance_amount = toNumber(latest.variance_amount ?? latest.cash_variance_amount, null);
  snapshot.forecast.variance_pct = toNumber(latest.variance_pct ?? latest.cash_variance_pct, null);
}

async function loadExpenseTotals(snapshot) {
  const rows = await safeRows(snapshot, 'expense_totals_monthly', 'expense_totals_monthly', (q) => q.limit(500));
  snapshot.meta.sources.expense_totals_monthly = rows.length;

  const currentRows = rows.filter((row) => monthKey(row.month || row.period) === monthKey(snapshot.currentMonth));
  const priorRows = rows.filter((row) => monthKey(row.month || row.period) === monthKey(snapshot.priorMonth));
  const priorByCategory = new Map(priorRows.map((row) => [String(row.category || '').toLowerCase(), toNumber(row.amount)]));
  const currentTotal = sum(currentRows, (row) => row.amount);
  const priorTotal = sum(priorRows, (row) => row.amount);

  snapshot.expenses.current_month_total = snapshot.financials.expenses_current_period ?? currentTotal;
  snapshot.expenses.prior_month_total = snapshot.financials.expenses_prior_period ?? priorTotal;
  snapshot.expenses.category_totals = currentRows.map((row) => ({
    category: row.category,
    amount: toNumber(row.amount),
  }));
  snapshot.expenses.category_spikes = currentRows.map((row) => {
    const category = String(row.category || '').toLowerCase();
    const current = toNumber(row.amount);
    const prior = priorByCategory.get(category) || 0;
    const delta = current - prior;
    return {
      category: row.category,
      amount: current,
      delta_amount: delta,
      delta_pct: prior > 0 ? (delta / prior) * 100 : 0,
    };
  });

  const categoryLike = (pattern) => snapshot.expenses.category_spikes.find((row) => pattern.test(String(row.category || '')));
  snapshot.expenses.fuel = categoryLike(/fuel|gas|vehicle/i);
  snapshot.expenses.meals = categoryLike(/meal|food|restaurant/i);
  snapshot.expenses.misc = categoryLike(/misc|office|supplies/i);
  snapshot.expenses.software = (() => {
    const row = categoryLike(/software|subscription|saas/i);
    if (!row) return null;
    const prior = priorByCategory.get(String(row.category || '').toLowerCase()) || 0;
    return { current: row.amount, baseline: prior, delta_pct: row.delta_pct };
  })();
}

async function loadAr(snapshot) {
  const agingRows = await safeRows(snapshot, 'ar_aging', 'ar_aging', (q) => q.limit(500));
  let rows = agingRows;
  if (!rows.length) {
    rows = await safeRows(snapshot, 'invoices', 'invoices', (q) => q.limit(500));
  }
  snapshot.meta.sources.ar = rows.length;

  const openRows = rows.filter((row) => !row.status || ['open', 'due', 'overdue', 'sent'].includes(String(row.status).toLowerCase()));
  const totalOpen = sum(openRows, (row) => row.amount_due ?? row.balance ?? row.amount ?? 0);
  const overdue = openRows.filter((row) => {
    const daysPastDue = toNumber(row.days_past_due, null);
    if (daysPastDue != null) return daysPastDue > 0;
    if (!row.due_date) return false;
    return new Date(row.due_date).getTime() < new Date(snapshot.now).getTime();
  });
  const overdueTotal = sum(overdue, (row) => row.amount_due ?? row.balance ?? row.amount ?? 0);

  snapshot.ar.total_open = totalOpen;
  snapshot.ar.overdue_total = overdueTotal;
  snapshot.ar.overdue_percent = totalOpen > 0 ? (overdueTotal / totalOpen) * 100 : 0;
  snapshot.ar.overdue_invoices = overdue.map((row) => ({
    id: row.id || row.invoice_id,
    invoice_id: row.invoice_id || row.id,
    customer: row.customer || row.customer_name || row.client_name,
    amount_due: toNumber(row.amount_due ?? row.balance ?? row.amount),
    due_date: row.due_date,
    days_past_due: toNumber(row.days_past_due, 0),
  }));
  snapshot.ar.invoices_due_soon = openRows
    .filter((row) => row.due_date && new Date(row.due_date).getTime() >= new Date(snapshot.now).getTime())
    .map((row) => ({
      id: row.id || row.invoice_id,
      invoice_id: row.invoice_id || row.id,
      customer: row.customer || row.customer_name || row.client_name,
      amount_due: toNumber(row.amount_due ?? row.balance ?? row.amount),
      due_date: row.due_date,
    }));
  snapshot.ar.collections_last_7d = sum(
    rows.filter((row) => withinDays(row.paid_at || row.payment_date || row.last_payment_at, snapshot.now, 7)),
    (row) => row.paid_amount ?? row.amount_paid ?? row.amount ?? row.balance ?? 0
  );
}

async function loadJobs(snapshot) {
  const jobRows = await safeRows(snapshot, 'jobs_profitability', 'jobs_profitability', (q) => q.limit(300));
  snapshot.meta.sources.jobs_profitability = jobRows.length;
  snapshot.jobs.active = jobRows
    .filter((row) => !row.status || !['complete', 'completed', 'closed'].includes(String(row.status).toLowerCase()))
    .map(normalizeJobRow);
  snapshot.jobs.completed_recent = jobRows
    .filter((row) => ['complete', 'completed', 'closed'].includes(String(row.status || '').toLowerCase()))
    .map(normalizeJobRow);

  const assignmentRows = await safeRows(snapshot, 'job_assignment_suggestions', 'job_assignment_suggestions', (q) => q.limit(500));
  snapshot.meta.sources.job_assignment_suggestions = assignmentRows.length;
  snapshot.jobs.unassigned_costs_total = sum(
    assignmentRows.filter((row) => String(row.status || '').toLowerCase() === 'pending'),
    (row) => row.amount ?? row.transaction_amount ?? row.allocated_amount ?? 0
  );
}

function normalizeJobRow(row) {
  const revenue = toNumber(row.revenue ?? row.total_revenue ?? row.actual_revenue);
  const cost = toNumber(row.cost ?? row.total_cost ?? row.actual_cost);
  const marginPct = toNumber(row.margin_pct ?? row.gross_margin_pct ?? (revenue ? ((revenue - cost) / revenue) * 100 : 0));
  const target = toNumber(row.target_margin_pct ?? row.target_margin_percent ?? row.target_margin ?? 30);
  return {
    id: row.id || row.job_id,
    job_id: row.job_id || row.id,
    name: row.job_name || row.name || row.title,
    revenue,
    cost,
    margin_pct: marginPct,
    target_margin_pct: target,
    cost_overrun_pct: toNumber(row.cost_overrun_pct ?? row.over_budget_pct, 0),
    material_overrun_pct: toNumber(row.material_overrun_pct ?? row.materials_over_budget_pct, 0),
    updated_at: row.updated_at,
  };
}

async function loadChangeOrders(snapshot) {
  const rows = await safeRows(snapshot, 'job_change_orders', 'job_change_orders', (q) => q.limit(300));
  snapshot.meta.sources.job_change_orders = rows.length;

  snapshot.change_orders.approved_unbilled_total = sum(
    rows.filter((row) => ['client_approved', 'approved'].includes(String(row.status || '').toLowerCase())),
    (row) => (row.approved_price ?? row.proposed_price ?? 0) - (row.billed_amount ?? 0)
  );
  snapshot.change_orders.billed_unpaid_total = sum(
    rows.filter((row) => ['billed'].includes(String(row.status || '').toLowerCase())),
    (row) => (row.billed_amount ?? row.approved_price ?? row.proposed_price ?? 0) - (row.paid_amount ?? 0)
  );
  snapshot.change_orders.proposed = rows
    .filter((row) => String(row.status || '').toLowerCase() === 'proposed')
    .map((row) => ({ id: row.id, title: row.title, proposed_at: row.proposed_at || row.created_at }));

  const potentialRows = await safeRows(snapshot, 'potential_change_orders', 'potential_change_orders', (q) => q.limit(100));
  snapshot.meta.sources.potential_change_orders = potentialRows.length;
  snapshot.change_orders.potential = potentialRows
    .filter((row) => String(row.status || '').toLowerCase() === 'pending' && !row.dismissed_at)
    .map((row) => ({
      id: row.id,
      title: row.title,
      reason: row.explanation,
      estimated_extra_cost: row.estimated_extra_cost,
      suggested_price: row.suggested_price,
      confidence_score: row.confidence_score,
    }));
}

async function loadTax(snapshot) {
  const context = await buildTaxInsightContext({
    supabase,
    businessId: snapshot.businessId,
    now: new Date(snapshot.now),
  });
  snapshot.taxInsightContext = context;
  snapshot.meta.sources.tax_calculation_runs = context.currentRun ? 1 + Number(Boolean(context.previousRun)) : 0;
  snapshot.meta.sources.tax_payments = context.payments?.rows?.length || 0;
  snapshot.meta.sources.transaction_tax_classifications = context.deductionsCoverage?.totalEligibleTransactionCount || 0;
  snapshot.tax = {
    projected_liability: toNumber(context.summary?.projectedTotalTax ?? context.currentRun?.estimated_total_tax, null),
    prior_projected_liability: toNumber(context.previousRun?.estimated_total_tax, null),
    reserve_gap: toNumber(context.reserve?.reserveGap ?? context.reserve?.gap ?? context.summary?.reserveGap, null),
    next_due_date: nextTaxDeadline(context.deadlines, snapshot.now)?.dueDate || null,
    next_due_amount: toNumber(nextTaxDeadline(context.deadlines, snapshot.now)?.amount, null),
    latest_run_id: context.currentRun?.id || null,
    latest_run_status: context.currentRun?.status || null,
    missing_category_review_count: context.deductionsCoverage?.needsReviewCount || 0,
  };
}

function nextTaxDeadline(deadlines, now) {
  const rows = Array.isArray(deadlines)
    ? deadlines
    : Array.isArray(deadlines?.items)
      ? deadlines.items
      : Array.isArray(deadlines?.upcoming)
        ? deadlines.upcoming
        : [];
  const nowMs = new Date(now).getTime();
  return rows
    .filter((row) => {
      const ts = new Date(row?.dueDate || row?.date || row?.due_on).getTime();
      return Number.isFinite(ts) && ts >= nowMs;
    })
    .sort((a, b) => new Date(a.dueDate || a.date || a.due_on) - new Date(b.dueDate || b.date || b.due_on))[0] || null;
}

async function loadBookkeeping(snapshot) {
  const rows = await safeRows(snapshot, 'bookkeeping_health', 'bookkeeping_health', (q) => q.limit(1));
  snapshot.meta.sources.bookkeeping_health = rows.length;
  const health = rows[0];
  if (health) {
    snapshot.bookkeeping.uncategorized_count = toNumber(health.uncategorized_count, 0);
    snapshot.bookkeeping.needs_review_count = toNumber(health.needs_review_count, 0);
    snapshot.bookkeeping.plaid_last_sync_at = health.last_sync_at || null;
  }

  const activeBankTransactionIds = await loadActiveBankTransactionIds(snapshot);
  const catRows = await safeRows(snapshot, 'transaction_categorizations', 'transaction_categorizations', (q) => q.limit(1000));
  const cats = filterToActiveTransactionRows(catRows, activeBankTransactionIds);
  snapshot.meta.sources.transaction_categorizations = cats.length;
  const nowMs = new Date(snapshot.now).getTime();
  snapshot.bookkeeping.qbo_posting_failures = cats.filter((row) => row.post_error || ['failed_post', 'post_failed', 'blocked'].includes(String(row.status || '').toLowerCase())).length;
  snapshot.bookkeeping.stale_pending_review_count = cats.filter((row) => {
    const status = String(row.status || '').toLowerCase();
    const created = new Date(row.created_at || row.updated_at).getTime();
    return ['needs_review', 'uncategorized'].includes(status) && Number.isFinite(created) && (nowMs - created) / (24 * 60 * 60 * 1000) >= 7;
  }).length;
  snapshot.bookkeeping.oldest_pending_review_days = Math.max(
    0,
    ...cats
      .filter((row) => ['needs_review', 'uncategorized'].includes(String(row.status || '').toLowerCase()))
      .map((row) => {
        const created = new Date(row.created_at || row.updated_at).getTime();
        return Number.isFinite(created) ? Math.floor((nowMs - created) / (24 * 60 * 60 * 1000)) : 0;
      })
  );

  const runs = await safeRows(snapshot, 'reconciliation_runs', 'reconciliation_runs', (q) => q.limit(20));
  snapshot.meta.sources.reconciliation_runs = runs.length;
  const run = latestRow(runs, ['last_checked_at', 'created_at', 'updated_at']);
  if (run) {
    snapshot.reconciliation.status = run.status || null;
    snapshot.reconciliation.last_checked_at = run.last_checked_at || run.created_at || null;
  }
}

async function buildSnapshot(businessId, options = {}) {
  const date = new Date(options.now || Date.now());
  const snapshot = {
    businessId,
    business_id: businessId,
    now: date.toISOString(),
    currentMonth: monthStart(date),
    priorMonth: priorMonthStart(date),
    meta: {
      trigger: options.trigger || DEFAULT_TRIGGER,
      missing_sources: [],
      sources: {},
    },
    business: {},
    cash: {},
    plaid: {},
    forecast: {},
    financials: {},
    expenses: {},
    ar: {},
    jobs: {},
    change_orders: {},
    tax: {},
    bookkeeping: {},
    reconciliation: {},
  };

  await loadBusinessContext(snapshot);
  await Promise.all([
    loadFinancialMetrics(snapshot),
    loadPlaidAccounts(snapshot),
    loadForecasts(snapshot),
    loadExpenseTotals(snapshot),
    loadAr(snapshot),
    loadJobs(snapshot),
    loadChangeOrders(snapshot),
    loadTax(snapshot),
    loadBookkeeping(snapshot),
  ]);

  return snapshot;
}

function sortInsights(a, b) {
  const severityDelta = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
  if (severityDelta) return severityDelta;
  const categoryDelta = (CATEGORY_RANK[b.category] || 0) - (CATEGORY_RANK[a.category] || 0);
  if (categoryDelta) return categoryDelta;
  return toNumber(b.confidence_score) - toNumber(a.confidence_score);
}

function toInsertRow(candidate, businessId, trigger) {
  const primary = candidate.primary_cta || {};
  const secondary = candidate.secondary_cta || {};
  return {
    business_id: businessId,
    user_id: null,
    module: MODULE,
    type: 'insight',
    title: candidate.title,
    body: candidate.body,
    severity: candidate.severity,
    category: candidate.category,
    confidence_score: candidate.confidence_score,
    metrics: candidate.metrics || [],
    recommended_actions: candidate.recommended_actions || [],
    primary_cta: candidate.primary_cta || null,
    primary_cta_label: primary.label || null,
    primary_cta_action: primary.action || null,
    primary_cta_payload: primary.payload || null,
    secondary_cta: candidate.secondary_cta || null,
    secondary_cta_label: secondary.label || null,
    secondary_cta_action: secondary.action || null,
    secondary_cta_payload: secondary.payload || null,
    tags: [candidate.category, candidate.rule_id].filter(Boolean),
    source_event_id: candidate.dedupe_key,
    dedupe_key: candidate.dedupe_key,
    trigger_source: trigger || candidate.trigger_source || DEFAULT_TRIGGER,
    source_refs: candidate.source_refs || [],
    expires_at: candidate.expires_at || null,
    snoozed_until: null,
    is_read: false,
    created_at: nowIso(),
  };
}

function toCompactInsertRow(candidate, businessId, trigger) {
  return {
    business_id: businessId,
    user_id: null,
    module: MODULE,
    type: 'insight',
    title: candidate.title,
    body: candidate.body,
    severity: candidate.severity,
    primary_cta: candidate.primary_cta || null,
    secondary_cta: candidate.secondary_cta || null,
    tags: [candidate.category, candidate.rule_id].filter(Boolean),
    source_event_id: candidate.dedupe_key || `${trigger}:${candidate.rule_id}`,
    expires_at: candidate.expires_at || null,
    snoozed_until: null,
    is_read: false,
    created_at: nowIso(),
  };
}

function shouldRetryCompact(error) {
  return COLUMN_ERROR_CODES.has(error?.code) || /column .* does not exist|schema cache/i.test(error?.message || '');
}

async function insertInsight(candidate, businessId, trigger) {
  const row = toInsertRow(candidate, businessId, trigger);
  const { error } = await supabase.from('insights').insert(row);
  if (!error) return { inserted: true, compact: false };

  if (!shouldRetryCompact(error)) {
    return { inserted: false, error };
  }

  console.warn('[contractor-cfo-insights] full insight insert failed; retrying compact insert', {
    businessId,
    rule_id: candidate.rule_id,
    dedupe_key: candidate.dedupe_key,
    reason: error?.message || String(error || 'unknown error'),
  });

  const compact = toCompactInsertRow(candidate, businessId, trigger);
  const retry = await supabase.from('insights').insert(compact);
  return retry.error
    ? { inserted: false, error: retry.error }
    : { inserted: true, compact: true };
}

export async function runContractorCfoInsightsForBusiness(businessId, options = {}) {
  if (!businessId) {
    return { ok: false, inserted: 0, skipped: 0, candidates: [], missing_sources: [], error: 'missing_business_id' };
  }

  const trigger = options.trigger || DEFAULT_TRIGGER;
  const limit = Math.max(1, Number(options.limit || DEFAULT_LIMIT));
  const snapshot = await buildSnapshot(businessId, { ...options, trigger });

  const ruleMap = new Map(CONTRACTOR_CFO_RULES.map((rule) => [rule.id, rule]));
  const sensitivity = await getRuleSensitivityAdjustments(businessId);
  const candidates = evaluateContractorCfoRules(snapshot, { limit: Math.max(limit * 2, limit) })
    .sort(sortInsights)
    .slice(0, Math.max(limit * 2, limit));
  await resolveStaleTaxInsights({ businessId, activeCandidates: candidates });

  const selected = [];
  let skipped = 0;

  for (const candidate of candidates) {
    const rule = ruleMap.get(candidate.rule_id);
    const adjustment = sensitivity.rules?.[candidate.rule_id] || {};
    const minConfidence = (rule?.minConfidence || 0) + (adjustment.minConfidenceBump || 0);
    if (candidate.confidence_score < minConfidence) {
      skipped += 1;
      continue;
    }

    const dedupe = await shouldInsertInsight({
      businessId,
      candidate,
      cooldownHours: (rule?.cooldownHours || 24) * (adjustment.cooldownMultiplier || 1),
      force: Boolean(options.force),
    });
    if (!dedupe.shouldInsert) {
      skipped += 1;
      continue;
    }

    selected.push(candidate);
    if (selected.length >= limit) break;
  }

  let inserted = 0;
  for (const candidate of selected) {
    const result = await insertInsight(candidate, businessId, trigger);
    if (result.inserted) {
      inserted += 1;
    } else {
      skipped += 1;
      console.error('[contractor-cfo-insights] insert failed', result.error?.message || result.error);
    }
  }

  return {
    ok: true,
    inserted,
    skipped,
    candidates: selected,
    missing_sources: snapshot.meta.missing_sources,
  };
}

async function resolveStaleTaxInsights({ businessId, activeCandidates = [] } = {}) {
  const activeKeys = new Set(
    activeCandidates
      .filter((candidate) => String(candidate.category || '').startsWith('tax_') || candidate.category === 'tax')
      .map((candidate) => candidate.dedupe_key)
      .filter(Boolean)
  );
  let rows = [];
  try {
    const { data, error } = await supabase
      .from('insights')
      .select('id,business_id,module,category,dedupe_key,status,dismissed_at')
      .eq('business_id', businessId)
      .eq('module', MODULE)
      .limit(500);
    if (error) return { resolved: 0, error };
    rows = data || [];
  } catch (error) {
    return { resolved: 0, error };
  }

  const stale = rows.filter((row) => {
    const category = String(row.category || '').toLowerCase();
    const status = String(row.status || '').toLowerCase();
    if (!(category === 'tax' || category.startsWith('tax_'))) return false;
    if (row.dismissed_at || ['dismissed', 'deleted', 'archived', 'resolved'].includes(status)) return false;
    return row.dedupe_key && !activeKeys.has(row.dedupe_key);
  });

  for (const row of stale) {
    try {
      await supabase
        .from('insights')
        .update({ status: 'resolved', dismissed_at: new Date().toISOString() })
        .eq('id', row.id);
    } catch {
      // Resolution is best-effort; stale alerts should not block fresh insight generation.
    }
  }
  return { resolved: stale.length };
}

export default runContractorCfoInsightsForBusiness;
