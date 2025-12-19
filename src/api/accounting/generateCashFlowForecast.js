// File: /src/api/accounting/generateCashFlowForecast.js
import { supabase } from '../../services/supabaseAdmin.js';

/* ---------- UUID + month helpers (for safe inserts) ---------- */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
/** Fallback UUID for demo/dev when userId is not a UUID */
const DEMO_USER_UUID = process.env.DEMO_USER_UUID || '00000000-0000-0000-0000-000000000000';

/** Accepts 'YYYY-MM' | 'YYYY-MM-DD' | Date | undefined → 'YYYY-MM-01' */
function toMonthDate(v) {
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}$/.test(v)) return `${v}-01`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v.slice(0, 10);
  }
  const d = new Date(v || Date.now());
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/**
 * Generates a 2–12 month forward-looking cash flow forecast.
 * - Uses Supabase historicals when available (populated via QuickBooks sync).
 * - Robust mock fallback when tables are missing or empty.
 * - Upserts results into `cashflow_forecast` idempotently on (business_id, month).
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.businessId
 * @param {number} [opts.months=12]
 * @param {boolean} [opts.forceMock=false]
 * @returns {Promise<Array<ForecastRow>>}
 */
export async function generateCashFlowForecast({
  userId,
  businessId,
  months = 12,
  forceMock = false,
}) {
  if (!userId || !businessId) throw new Error('Missing userId or businessId');

  // Normalize horizon
  months = Math.max(2, Math.min(12, Number.isFinite(+months) ? +months : 12));

  const HIST_MONTHS = 12;

  // Safe query helper: returns [] on "table missing" / "no privilege" and logs others
  async function safeQuery(fn, label) {
    try {
      const { data, error } = await fn();
      if (error) {
        // 42P01 undefined_table, 42501 insufficient_privilege
        if (error.code === '42P01' || error.code === '42501') {
          console.warn(`[forecast] ${label}: ${error.message} — continuing with mock.`);
          return [];
        }
        console.warn(`[forecast] ${label} error:`, error.message || error);
        return [];
      }
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.warn(`[forecast] ${label} exception:`, e?.message || e);
      return [];
    }
  }

  // 1) Pull recent historicals (if QuickBooks has synced)
  const [metrics, bs] = await Promise.all([
    safeQuery(
      () =>
        supabase
          .from('financial_metrics')
          .select('month, total_revenue, total_expenses, net_profit')
          .eq('business_id', businessId)
          .order('month', { ascending: true })
          .limit(HIST_MONTHS),
      'financial_metrics'
    ),
    safeQuery(
      () =>
        supabase
          .from('balance_sheet_history')
          .select('month, cash, accounts_receivable, accounts_payable, loans')
          .eq('business_id', businessId)
          .order('month', { ascending: false })
          .limit(1),
      'balance_sheet_history'
    ),
  ]);

  const hasHistoricals = !forceMock && metrics.length >= 3;
  const latestBS = bs[0] || null;

  // 2) Seed values (AR/AP/Loans/Cash) — use BS if present, else safe defaults
  const seed = {
    startCash: n(latestBS?.cash, 30000),
    arInflow: n(latestBS?.accounts_receivable, 0),
    apOutflow: n(latestBS?.accounts_payable, 0),
    loanOutflow: n(latestBS?.loans, 0),
  };

  // 3) Choose baseline model
  const baseline = hasHistoricals
    ? deriveBaselineFromHistoricals(metrics)
    : getMockBaseline();

  // 4) Build horizon & forecast forward
  const horizon = buildMonthSequence(months); // [{ ym, label }]
  const rows = [];
  let rolling = seed.startCash;

  for (let i = 0; i < horizon.length; i++) {
    const revenue = Math.max(
      0,
      Math.round(
        baseline.revenue.start * Math.pow(1 + baseline.revenue.growth, i) +
          noise(baseline.revenue.noisePct)
      )
    );

    const expenses = Math.max(
      0,
      Math.round(
        baseline.expenses.start * Math.pow(1 + baseline.expenses.growth, i) +
          noise(baseline.expenses.noisePct)
      )
    );

    const cash_in = revenue + seed.arInflow;
    const cash_out = expenses + seed.loanOutflow + seed.apOutflow;
    const net_cash = cash_in - cash_out;
    rolling += net_cash;

    rows.push({
      user_id: isUuid(userId) ? userId : DEMO_USER_UUID,   // ✅ always a valid UUID
      business_id: businessId,
      month: toMonthDate(`${horizon[i].ym}-01`),           // ✅ DATE-compatible
      month_label: horizon[i].label,                       // optional for UI
      revenue,
      expenses,
      cash_in,
      cash_out,
      net_cash,
      ending_cash: rolling,
      source: hasHistoricals ? 'historical+model' : 'mock',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  // 5) Persist idempotently (keeps any per-month overrides intact)
  await upsertForecastRows({ userId, businessId, rows, source: rows[0]?.source });

  return rows;
}

/**
 * Upserts forecast rows into `cashflow_forecast`.
 * Exposed so /override can reuse it.
 */
export async function upsertForecastRows({ userId, businessId, rows, source = 'manual' }) {
  if (!Array.isArray(rows) || rows.length === 0) return;

  const prepared = rows.map((r) => ({
    ...r,
    month: toMonthDate(r.month),                                   // ✅ normalize MONTH
    user_id: isUuid(r.user_id) ? r.user_id
            : (isUuid(userId) ? userId : DEMO_USER_UUID),          // ✅ always a UUID
    business_id: r.business_id ?? businessId,
    source: r.source ?? source,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from('cashflow_forecast')
    .upsert(prepared, { onConflict: 'business_id,month' });

  if (error) throw new Error('Failed to upsert forecast: ' + error.message);
}

/* -------------------------- helpers -------------------------- */

function deriveBaselineFromHistoricals(metrics) {
  // metrics ascending by month
  const rev = metrics.map((m) => n(m.total_revenue, 0));
  const exp = metrics.map((m) => n(m.total_expenses, 0));

  const startRevenue = rev.at(-1) || average(rev) || 20000;
  const startExpenses = exp.at(-1) || average(exp) || 15000;

  // Approx monthly growth via simple linear regression slope / last value
  const gRev = clamp(estimateMonthlyGrowth(rev), -0.15, 0.15);
  const gExp = clamp(estimateMonthlyGrowth(exp), -0.15, 0.15);

  return {
    revenue: { start: startRevenue, growth: gRev, noisePct: 0.03 },
    expenses: { start: startExpenses, growth: gExp, noisePct: 0.03 },
  };
}

function getMockBaseline() {
  return {
    revenue: { start: 20000, growth: 0.02, noisePct: 0.02 },
    expenses: { start: 15000, growth: 0.018, noisePct: 0.02 },
  };
}

function buildMonthSequence(n) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < n; i++) {
    const dt = new Date(d);
    dt.setMonth(d.getMonth() + i);
    const ym = dt.toISOString().slice(0, 7); // YYYY-MM
    const label = dt.toLocaleString('default', { month: 'short', year: 'numeric' });
    out.push({ ym, label });
  }
  return out;
}

function average(arr) {
  if (!arr?.length) return 0;
  return arr.reduce((s, v) => s + (Number(v) || 0), 0) / arr.length;
}

function noise(pct = 0.02) {
  const r = (Math.random() - 0.5) * 2; // [-1, 1]
  return r * pct * 1000;               // tiny dollars to avoid flat lines
}

function estimateMonthlyGrowth(series) {
  if (!series || series.length < 3) return 0;
  const n = series.length;
  const xs = Array.from({ length: n }, (_, i) => i); // 0..n-1
  const xMean = average(xs);
  const yMean = average(series);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (series[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den; // dollars per month
  const last = series[n - 1] || 1;
  return clamp(slope / Math.max(1, last), -0.25, 0.25);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function n(v, d = 0) { const x = Number(v); return Number.isFinite(x) ? x : d; }
