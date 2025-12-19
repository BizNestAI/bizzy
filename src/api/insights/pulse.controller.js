// File: /src/api/insights/pulse.controller.js
import { supabase } from '../../services/supabaseAdmin.js';
import dayjs from 'dayjs';
import fetch from 'node-fetch';

async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`fetch failed: ${url} -> ${r.status}`);
  return r.json();
}

async function fetchSignals(business_id) {
  const headers = { 'x-business-id': business_id };
  const API = process.env.API_BASE || 'http://localhost:5050';

  let acc = null;
  try {
    acc = await getJSON(`${API}/api/accounting/metrics?business_id=${business_id}`, headers);
  } catch(e) { acc = null; }

  // Normalize
  const revenue_mom   = clampNum(acc?.revenue_mom, -1, 1);   // month-over-month revenue growth
  const expense_mom   = clampNum(acc?.expense_mom, -1, 1);   // month-over-month expense growth
  const profit_margin = clampNum(acc?.profit_margin, 0, 1);  // 0..1
  const cashflow_mom  = clampNum(acc?.cashflow_mom ?? 0, -1, 1);

  return { revenue_mom, expense_mom, profit_margin, cashflow_mom };
}
function clampNum(n, min, max) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.max(min, Math.min(max, n));
}

// ---- Tunable weights / thresholds ----
const WEIGHTS = {
  BASE: 50,
  REVENUE: 40,     // +40 * revenue_mom
  EXPENSE: 30,     // -30 * expense_mom
  MARGIN:  60,     // +60 * (profit_margin - MARGIN_FLOOR)
  MARGIN_FLOOR: 0.10, // 10% baseline
  CASHFLOW: 30     // +30 * cashflow_mom
};

function calculatePulse({ revenue_mom, expense_mom, profit_margin, cashflow_mom }) {
  let score = WEIGHTS.BASE;

  const revenuePoints = WEIGHTS.REVENUE * revenue_mom;
  const expensePoints = -WEIGHTS.EXPENSE * expense_mom;
  const marginPoints  = WEIGHTS.MARGIN  * ((profit_margin ?? 0) - WEIGHTS.MARGIN_FLOOR);
  const cashflowPoints = WEIGHTS.CASHFLOW * cashflow_mom;

  score += revenuePoints + expensePoints + marginPoints + cashflowPoints;
  score = Math.round(Math.max(0, Math.min(100, score)));

  let status = 'watch';
  if (score >= 70) status = 'healthy';
  else if (score < 50) status = 'at_risk';

  const breakdown = {
    base: { value: WEIGHTS.BASE, points: WEIGHTS.BASE, note: 'Neutral baseline' },
    revenue: {
      value: revenue_mom, // e.g. +0.12 means +12% MoM
      weight: WEIGHTS.REVENUE,
      points: round1(revenuePoints),
      note: revenue_mom >= 0 ? 'Revenue growing' : 'Revenue shrinking'
    },
    expense: {
      value: expense_mom,
      weight: WEIGHTS.EXPENSE,
      points: round1(expensePoints),
      note: expense_mom > 0 ? 'Expenses rising' : 'Expenses falling'
    },
    margin: {
      value: profit_margin,
      weight: WEIGHTS.MARGIN,
      floor: WEIGHTS.MARGIN_FLOOR,
      points: round1(marginPoints),
      note: profit_margin >= WEIGHTS.MARGIN_FLOOR ? 'Margin above floor' : 'Margin below floor'
    },
    cashflow: {
      value: cashflow_mom,
      weight: WEIGHTS.CASHFLOW,
      points: round1(cashflowPoints),
      note: cashflow_mom >= 0 ? 'Cashflow improving' : 'Cashflow declining'
    }
  };

  return { score, status, breakdown };
}
function round1(n) { return Math.round(n * 10) / 10; }

export async function getPulse(req, res) {
  try {
    const business_id = req.query.business_id || req.query.businessId || req.headers['x-business-id'];
    if (!business_id) return res.status(400).json({ error: 'missing business_id' });

    const signals = await fetchSignals(business_id);
    const { score, status, breakdown } = calculatePulse(signals);

    return res.json({
      pulse_score: score,
      status,
      breakdown, // ⬅️ EXPLANATION INCLUDED
      signals,   // raw inputs for debugging/analytics
      weights: WEIGHTS, // optional, useful if you show weights in UI
      generated_at: new Date().toISOString()
    });
  } catch (e) {
    console.error('[pulse] failed', e);
    return res.json({
      pulse_score: 50,
      status: 'watch',
      breakdown: null,
      signals: {},
      generated_at: new Date().toISOString(),
      diag: e.message
    });
  }
}
