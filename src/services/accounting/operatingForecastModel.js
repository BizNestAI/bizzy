import { decimalCents } from '../../utils/forecast/money.js';
import { createHash } from 'node:crypto';
import { buildMonthlyPnlContentFingerprint } from './monthlyPnlContentFingerprint.js';
export const MODEL_VERSION = 'operating_accounts_launch_v1';
export const MODEL_CONFIG = Object.freeze({
  metadataVersion: 1,
  recurringMinActive: 5,
  recurringTolerancePercent: 10,
  variableMinActive: 3,
  weights: [50, 30, 20],
  historyMonths: 12,
  horizonMonths: 12
});
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const cents = decimalCents;
export const money = value => {
  const amount = value / 100;
  if (!Number.isSafeInteger(value) || cents(amount) !== value) throw new Error('money_precision_limit');
  return amount;
};
export function roundRatio(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) throw new Error('money_precision_limit');
  // Symmetric half-away-from-zero, including credits.
  return Math.sign(numerator) * Math.floor((Math.abs(numerator) + denominator / 2) / denominator);
}
export function completedWindow(now, timezone) {
  if (!timezone) throw new Error('reporting_timezone_required');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric'
  }).formatToParts(now);
  const y = Number(parts.find(p => p.type === 'year').value);
  const m = Number(parts.find(p => p.type === 'month').value);
  return Array.from({
    length: 12
  }, (_, i) => new Date(Date.UTC(y, m - 13 + i, 1)).toISOString().slice(0, 10));
}
const sum = values => {
  const result = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(result)) throw new Error('money_precision_limit');
  return result;
};
const median = values => {
  const v = [...values].sort((a, b) => a - b);
  const i = Math.floor(v.length / 2);
  return v.length % 2 ? v[i] : roundRatio(v[i - 1] + v[i], 2);
};
export function projectAccount(series, {
  observedFrom = series.findIndex(v => v !== 0)
} = {}) {
  if (series.length !== 12 || series.some(v => !Number.isSafeInteger(v))) throw new Error('invalid_account_series');
  const first = observedFrom;
  if (!Number.isInteger(first) || first < -1 || first > 11) throw new Error('invalid_observation_start');
  const observed = first < 0 ? series : series.slice(first);
  const recent = series.slice(-6).filter(v => v !== 0);
  const med = recent.length ? median(recent) : 0;
  const normal = recent.filter(v => Math.abs(v - med) * 100 <= Math.abs(med) * MODEL_CONFIG.recurringTolerancePercent);
  let classification, projected;
  if (series.slice(-3).every(v => v === 0)) {
    classification = 'inactive';
    projected = 0;
  } else if (recent.length >= MODEL_CONFIG.recurringMinActive && series[11] !== 0 && normal.length === recent.length) {
    classification = 'recurring';
    projected = median(normal.slice(-3));
  } else if (recent.length >= MODEL_CONFIG.variableMinActive) {
    classification = 'variable';
    // Common denominator: avoid rounding intermediate averages or weights.
    const a = observed.slice(-3),
      b = observed.slice(-6),
      c = observed;
    const [w3, w6, w12] = MODEL_CONFIG.weights;
    projected = roundRatio(w3 * sum(a) * b.length * c.length + w6 * sum(b) * a.length * c.length + w12 * sum(c) * a.length * b.length, 100 * a.length * b.length * c.length);
  } else {
    classification = 'intermittent';
    projected = roundRatio(sum(observed), observed.length);
  }
  return {
    classification,
    projected_cents: projected,
    months_observed: 12,
    averaging_months: observed.length,
    limited_history: first > 0,
    history_basis: 'first_report_observation',
    creation_verified: false,
    recent_cents: series.slice(-6),
    calculation: {
      series_cents: series,
      recent_active_median_cents: med,
      weights: MODEL_CONFIG.weights,
      rounding: 'half_away_from_zero'
    }
  };
}
export function reconcileMonth(snapshot, accounts, businessId, month, config) {
  if (snapshot.business_id !== businessId || snapshot.accounting_method !== 'Cash' || !['current', 'validated'].includes(snapshot.status) || !snapshot.is_current || `${snapshot.review_year}-${String(snapshot.review_month).padStart(2, '0')}-01` !== month) throw new Error('snapshot_identity_mismatch');
  const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const currency = snapshot.currency_code || snapshot.metadata?.financial_content?.currency_code;
  if (currency && currency !== config.home_currency) throw new Error('snapshot_currency_mismatch');
  if (snapshot.source_start_date !== month || snapshot.source_end_date !== end || snapshot.qbo_realm_id !== config.qbo_realm_id) throw new Error('snapshot_period_or_realm_mismatch');
  if (snapshot.metadata?.reconciliation?.status && snapshot.metadata.reconciliation.status !== 'valid') throw new Error('account_summary_mismatch');
  const totals = {
    Income: 0,
    'Cost of Goods Sold': 0,
    Expense: 0,
    'Other Income': 0,
    'Other Expense': 0
  };
  const seen = new Set();
  for (const a of accounts) {
    if (a.business_id !== businessId || a.snapshot_id !== snapshot.id || !(a.account_type in totals) || !a.qbo_account_id) throw new Error('account_identity_missing');
    const key = `${a.account_type}:${a.qbo_account_id}`;
    if (seen.has(key)) throw new Error('duplicate_account_identity');
    seen.add(key);
    totals[a.account_type] += cents(a.total_amount);
  }
  if (totals.Income !== cents(snapshot.revenue) || totals['Cost of Goods Sold'] !== cents(snapshot.cogs) || totals.Expense !== cents(snapshot.expenses) || totals.Income - totals['Cost of Goods Sold'] - totals.Expense + totals['Other Income'] - totals['Other Expense'] !== cents(snapshot.net_profit)) throw new Error('account_summary_mismatch');
  const components = snapshot.metadata?.pnl_components;
  if (components && (components.other_income != null && cents(components.other_income) !== totals['Other Income'] || components.other_expense != null && cents(components.other_expense) !== totals['Other Expense'])) throw new Error('account_summary_mismatch');
  const content = buildMonthlyPnlContentFingerprint({
    snapshot,
    accounts
  });
  if (!content) throw new Error('financial_fingerprint_unavailable');
  const stored = snapshot.metadata?.financial_content?.fingerprint;
  if (stored && stored !== content.fingerprint) throw new Error('financial_fingerprint_mismatch');
  return content.fingerprint;
}
export function buildOperatingModel(months) {
  if (months.length !== 12 || new Set(months.map(m => m.month)).size !== 12) throw new Error('twelve_completed_months_required');
  const firstDate = new Date(`${months[0].month}T00:00:00Z`);
  if (!Number.isFinite(firstDate.getTime()) || months.some((m, i) => m.month !== new Date(Date.UTC(firstDate.getUTCFullYear(), firstDate.getUTCMonth() + i, 1)).toISOString().slice(0, 10))) throw new Error('contiguous_ordered_months_required');
  const series = new Map();
  months.forEach((m, i) => m.accounts.filter(a => ['Income', 'Cost of Goods Sold', 'Expense'].includes(a.account_type)).forEach(a => {
    const key = `${a.account_type}:${a.qbo_account_id}`;
    if (!series.has(key)) series.set(key, {
      qbo_account_id: a.qbo_account_id,
      section: a.account_type,
      observedFrom: i,
      values: Array(12).fill(0)
    });
    series.get(key).values[i] = cents(a.total_amount);
  }));
  const accounts = [...series.values()].sort((a, b) => `${a.section}:${a.qbo_account_id}`.localeCompare(`${b.section}:${b.qbo_account_id}`)).map(a => ({
    qbo_account_id: a.qbo_account_id,
    section: a.section,
    ...projectAccount(a.values, {
      observedFrom: a.observedFrom
    })
  }));
  const total = section => sum(accounts.filter(a => a.section === section).map(a => a.projected_cents));
  const revenue = total('Income'),
    cogs = total('Cost of Goods Sold'),
    expenses = total('Expense');
  const start = new Date(`${months.at(-1).month}T00:00:00Z`);
  const rows = Array.from({
    length: 12
  }, (_, i) => ({
    month: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i + 1, 1)).toISOString().slice(0, 10),
    baseline_revenue: money(revenue),
    baseline_expenses: money(cogs + expenses),
    baseline_operating_net_cash_flow: money(revenue - cogs - expenses),
    effective_revenue: money(revenue),
    effective_expenses: money(cogs + expenses),
    effective_operating_net_cash_flow: money(revenue - cogs - expenses)
  }));
  return {
    rows,
    metadata: {
      schema: 'operating_accounts_v1',
      accounts,
      monthly_cogs: money(cogs),
      monthly_operating_expenses: money(expenses),
      excluded_sections: months.map(m => ({
        month: m.month,
        other_income_cents: sum(m.accounts.filter(a => a.account_type === 'Other Income').map(a => cents(a.total_amount))),
        other_expense_cents: sum(m.accounts.filter(a => a.account_type === 'Other Expense').map(a => cents(a.total_amount))),
        excluded_from_operating_forecast: true
      })),
      limitations: ['creation_dates_unverified', 'flat_baseline', 'no_seasonality', 'no_current_month_actuals']
    }
  };
}
