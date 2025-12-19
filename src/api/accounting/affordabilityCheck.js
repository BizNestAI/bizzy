// File: /api/accounting/affordabilityCheck.js

import { supabase } from '../../services/supabaseAdmin.js';
import generateBizzyResponse from '../../api/gpt/brain/generateBizzyResponse.js';
import { affordabilityPromptTemplate } from '../../api/gpt/affordabilityPrompt.js';

/* -------------------- helpers -------------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

const MOCK_FORECAST = Array.from({ length: 12 }, (_, i) => {
  const rev = 20000 + i * 500;
  const exp = 15000 + i * 400;
  const net = rev - exp;
  return {
    month_label: new Date(new Date().getFullYear(), new Date().getMonth() + i, 1)
      .toLocaleString('default', { month: 'short', year: 'numeric' }),
    revenue: rev,
    expenses: exp,
    net_cash: net,
    ending_cash: 30000 + (i + 1) * net,
  };
});

const safeQ = async (fn, label) => {
  try {
    const { data, error } = await fn();
    if (error) {
      if (error.code === '42P01' || error.code === '42501') {
        console.warn(`[affordability] ${label}: ${error.message} — using mock/empty.`);
        return [];
      }
      console.warn(`[affordability] ${label} error:`, error.message);
      return [];
    }
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn(`[affordability] ${label} exception:`, e?.message || e);
    return [];
  }
};

const monthlyImpact = (amount, frequency) => {
  const a = Number(amount) || 0;
  const f = String(frequency || 'one-time').toLowerCase();
  switch (f) {
    case 'monthly': return a;
    case 'weekly': return (a * 52) / 12;
    case 'bi-weekly':
    case 'biweekly': return (a * 26) / 12;
    case 'quarterly': return a / 3;
    case 'annually':
    case 'yearly': return a / 12;
    case 'one-time':
    default: return 0; // handled as one-time separately
  }
};

// small currency formatter for human-friendly bullets
function fmt(n) {
  return typeof n === 'number'
    ? n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    : '-';
}

/**
 * Deterministic pre-check:
 * - Adds reasons[] explaining the decision
 * - Adds richer risk_flags
 * - Computes confidence heuristic
 */
function deterministicCheck({ rows, amount, frequency }) {
  const horizon = Math.min(6, rows.length);
  const mImp = monthlyImpact(amount, frequency);
  const isOneTime = String(frequency || '').toLowerCase() === 'one-time';
  const oneTime = isOneTime ? (Number(amount) || 0) : 0;

  const avgNet = Math.round(rows.reduce((s, r) => s + (r.net_cash || 0), 0) / Math.max(1, rows.length));
  const minEndingRow = rows.reduce((min, r) => (r.ending_cash < min.ending_cash ? r : min), rows[0]);
  const maxNetRow = rows.reduce((max, r) => (r.net_cash > max.net_cash ? r : max), rows[0]);

  let end = (rows[0]?.ending_cash || 0) - oneTime;
  let negativeMonthsWithExpense = 0;
  for (let i = 0; i < horizon; i++) {
    const netAfter = (rows[i].net_cash || 0) - mImp - (i === 0 ? oneTime : 0);
    if (netAfter < 0) negativeMonthsWithExpense++;
    end += netAfter;
  }
  const okCount = horizon - negativeMonthsWithExpense;

  let verdict = 'Depends';
  if (okCount >= horizon - 1 && end > 0) verdict = 'Yes';
  else if (okCount <= Math.floor(horizon / 2) || end < 0) verdict = 'No';

  // Risk flags
  const risk_flags = [];
  if (negativeMonthsWithExpense > 0) risk_flags.push('negative_month');
  if (end < 0) risk_flags.push('ending_cash_below_zero');
  if (minEndingRow.ending_cash < 0) risk_flags.push('low_ending_cash');
  if (avgNet > 0 && mImp / avgNet >= 0.5) risk_flags.push('high_impact_vs_net');
  if (isOneTime && oneTime > Math.max(1, rows[0]?.ending_cash) * 0.25) risk_flags.push('large_one_time');

  // Reasons (concise bullets)
  const reasons = [
    `${okCount}/${horizon} months remain cash-positive after the expense.`,
    `Avg monthly net cash ${fmt(avgNet)} vs monthly impact ${fmt(mImp)}.`,
    `Ending cash after horizon ${fmt(end)}${minEndingRow?.month_label ? `; lowest ending cash in ${minEndingRow.month_label} is ${fmt(minEndingRow.ending_cash)}` : ''}.`,
  ];
  if (isOneTime && oneTime > 0) reasons.push(`One-time impact of ${fmt(oneTime)} applied to the first month.`);

  // Recommendations
  const recommendations =
    verdict === 'Yes'
      ? [
          'Proceed, but monitor AR collections and large outgoing payments.',
          'Set a reminder to review cash in ~60 days.',
        ]
      : [
          'Delay start 30–60 days to align with stronger months.',
          'Split the expense into installments if possible.',
          `Target a stronger month (e.g., ${maxNetRow?.month_label || 'a high-cash month'}) or run a short promo to lift cash-in.`,
          'Trim discretionary spend temporarily to offset the impact.',
        ];

  // Confidence heuristic
  const margin = avgNet - mImp;
  const confidence =
    verdict === 'Yes'
      ? Math.max(0.6, Math.min(0.95, 0.7 + margin / Math.max(1000, Math.abs(avgNet)) / 2))
      : verdict === 'No'
      ? Math.max(0.6, Math.min(0.9, 0.7 + Math.abs(margin) / Math.max(1000, Math.abs(avgNet)) / 2))
      : 0.5;

  return {
    verdict,
    rationale:
      verdict === 'Yes'
        ? 'Projected cash flow remains positive and the cash buffer stays above zero across the near-term horizon.'
        : verdict === 'No'
        ? 'The expense would flip multiple months negative or drive ending cash below zero without offsets.'
        : 'Cash is tight in parts of the horizon; small timing/amount adjustments reduce risk.',
    reasons,
    impactSummary: {
      monthlyExpenseImpact: Math.round(mImp),
      oneTimeImpact: Math.round(oneTime),
      monthsReviewed: horizon,
      endCashAfterHorizon: Math.round(end),
    },
    recommendations,
    confidence,
    risk_flags,
  };
}

/* -------------------- handler -------------------- */

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, businessId, expenseName, amount, frequency, startDate, notes } = req.body || {};
  if (!userId || !businessId || !expenseName || amount == null || !frequency) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!isUuid(businessId)) {
    return res.status(400).json({ error: 'Invalid businessId' });
  }

  try {
    // Fetch rows; continue with mock if missing
    const [forecastRows, metrics, balances] = await Promise.all([
      safeQ(
        () =>
          supabase
            .from('cashflow_forecast')
            .select('month, month_label, revenue, expenses, cash_in, cash_out, net_cash, ending_cash')
            .eq('business_id', businessId)
            .order('month'),
        'cashflow_forecast'
      ),
      safeQ(
        () =>
          supabase
            .from('financial_metrics')
            .select('month, total_revenue, total_expenses, net_profit')
            .eq('business_id', businessId)
            .order('month'),
        'financial_metrics'
      ),
      safeQ(
        () =>
          supabase
            .from('balance_sheet_history')
            .select('month, cash')
            .eq('business_id', businessId)
            .order('month', { ascending: false })
            .limit(1),
        'balance_sheet_history'
      ),
    ]);

    const hasForecast = forecastRows && forecastRows.length > 0;
    const rows = (hasForecast ? forecastRows : MOCK_FORECAST).map((r) => ({
      month_label: r.month_label || r.month,
      revenue: Number(r.revenue ?? r.forecasted_revenue ?? 0),
      expenses: Number(r.expenses ?? r.forecasted_expenses ?? 0),
      net_cash:
        Number(r.net_cash ?? (r.cash_in != null && r.cash_out != null ? r.cash_in - r.cash_out : (r.revenue ?? 0) - (r.expenses ?? 0))),
      ending_cash: Number(r.ending_cash ?? r.rolling_balance ?? 0),
    }));

    // 1) Deterministic pre-check
    const deterministic = deterministicCheck({ rows, amount, frequency });

    // If clearly Yes/No, return now (fast path)
    if (deterministic.verdict !== 'Depends') {
      return res.status(200).json({
        success: true,
        source: 'deterministic',
        usingMock: !hasForecast,
        result: {
          expenseName,
          amount: Number(amount) || 0,
          frequency,
          startDate,
          notes,
          ...deterministic,
        },
      });
    }

    // 2) GPT escalation (JSON-only) — build enriched context

// recompute quick stats for context
const horizonMonths = rows.length;
const avgNetCash = Math.round(
  rows.reduce((s, r) => s + (r.net_cash || 0), 0) / Math.max(1, horizonMonths)
);
const minEndingRow = rows.reduce(
  (min, r) => ((r.ending_cash || 0) < (min.ending_cash || 0) ? r : min),
  rows[0] || { ending_cash: 0, month_label: '' }
);
const negativeMonths = rows.filter((r) => (r.net_cash || 0) < 0).length;

const mImp = monthlyImpact(amount, frequency);
const oneTime = String(frequency || '').toLowerCase() === 'one-time' ? (Number(amount) || 0) : 0;

// simulate negatives with expense for context
let negWithExpense = 0;
for (let i = 0; i < Math.min(6, rows.length); i++) {
  const netAfter = (rows[i].net_cash || 0) - mImp - (i === 0 ? oneTime : 0);
  if (netAfter < 0) negWithExpense++;
}

// ---- compat-safe "lastActual" and "startingCash" (no .at / no ?.[] ) ----
const hasMetrics = Array.isArray(metrics) && metrics.length > 0;
const lastMetric = hasMetrics ? metrics[metrics.length - 1] : null;
const lastActual = hasMetrics
  ? {
      revenue: Number((lastMetric && lastMetric.total_revenue) || 0),
      expenses: Number((lastMetric && lastMetric.total_expenses) || 0),
      profit: Number(
        lastMetric && lastMetric.net_profit != null
          ? lastMetric.net_profit
          : (Number((lastMetric && lastMetric.total_revenue) || 0) -
             Number((lastMetric && lastMetric.total_expenses) || 0))
      ),
    }
  : null;

const hasBalances = Array.isArray(balances) && balances.length > 0;
const startingCash = Number(
  hasBalances
    ? (balances[0].cash || 0)
    : (rows.length ? (rows[0].ending_cash || 0) : 0)
);

// ---- build the context object ----
const context = {
  stats: {
    lastActual,
    startingCash,
    forecastStats: {
      horizonMonths,
      avgNetCash,
      minEndingCash: minEndingRow.ending_cash,
      minEndingMonth: minEndingRow.month_label,
      negativeMonths,
      negativeMonthsWithExpense: negWithExpense,
    },
    expenseStats: {
      monthlyImpact: Math.round(mImp),
      oneTimeImpact: Math.round(oneTime),
    },
  },
  // small sample: first 3 + last 3
  rows: rows.slice(0, 3).concat(rows.slice(Math.max(0, rows.length - 3))),
};


    const prompt = affordabilityPromptTemplate({
      expenseName,
      amount: Number(amount) || 0,
      frequency,
      startDate,
      notes,
      context,
    });

    const raw = await generateBizzyResponse({
      prompt,
      type: 'affordability_check',
    });

    // Accept either parsed object or string JSON; fallback to deterministic if parse fails
    let model;
    try {
      model = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      model = null;
    }

    const finalResult = model && typeof model === 'object' ? model : deterministic;

    return res.status(200).json({
      success: true,
      source: model ? 'gpt' : 'deterministic_fallback',
      usingMock: !hasForecast,
      result: {
        expenseName,
        amount: Number(amount) || 0,
        frequency,
        startDate,
        notes,
        ...finalResult,
      },
    });
  } catch (err) {
    console.error('[AffordabilityCheck] Internal error:', err?.message || err);
    return res.status(500).json({ error: 'Internal server error', detail: String(err?.message || err) });
  }
}
