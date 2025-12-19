// File: /src/api/accounting/forecastAccuracy.js
import express from 'express';
import { supabase } from '../../services/supabaseAdmin.js';

const router = express.Router();

const MOCK = [
  { month: '2024-08', month_label: 'Aug 2024', forecastRevenue: 20000, actualRevenue: 18500, forecastExpenses: 15000, actualExpenses: 14800 },
  { month: '2024-09', month_label: 'Sep 2024', forecastRevenue: 21000, actualRevenue: 20800, forecastExpenses: 16000, actualExpenses: 15800 },
  { month: '2024-10', month_label: 'Oct 2024', forecastRevenue: 21500, actualRevenue: 21200, forecastExpenses: 16500, actualExpenses: 16700 },
  { month: '2024-11', month_label: 'Nov 2024', forecastRevenue: 22000, actualRevenue: 21800, forecastExpenses: 17000, actualExpenses: 17500 },
  { month: '2024-12', month_label: 'Dec 2024', forecastRevenue: 22500, actualRevenue: 22500, forecastExpenses: 17500, actualExpenses: 17000 },
  { month: '2025-01', month_label: 'Jan 2025', forecastRevenue: 23000, actualRevenue: 24000, forecastExpenses: 18000, actualExpenses: 18500 },
].map(r => ({ ...r, forecastProfit: r.forecastRevenue - r.forecastExpenses, actualProfit: r.actualRevenue - r.actualExpenses, source: 'mock' }));

/** Safe Supabase query: never throws, returns [] on table missing/permission errors */
async function safeQ(run, label) {
  try {
    const { data, error } = await run();
    if (error) {
      if (error.code === '42P01' || error.code === '42501') {
        console.warn(`[fvA] ${label}: ${error.message} — using mock.`);
        return [];
      }
      console.warn(`[fvA] ${label} error:`, error.message);
      return [];
    }
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn(`[fvA] ${label} exception:`, e?.message || e);
    return [];
  }
}

/** Format to 'YYYY-MM' key and 'Mon YYYY' label */
function ymKey(d) {
  const dt = new Date(d);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}
function labelFor(d) {
  return new Date(d).toLocaleString('default', { month: 'short', year: 'numeric' });
}

/**
 * GET /api/accounting/forecast-accuracy
 * Query: userId, businessId, months=6
 * Returns rows with: month, month_label, forecastRevenue/Expenses/Profit, actualRevenue/Expenses/Profit
 */
router.get('/', async (req, res) => {
  const { userId, businessId } = req.query;
  const months = Math.max(3, Math.min(12, parseInt(req.query.months || '6', 10)));

  if (!userId || !businessId) {
    return res.status(400).json({ error: 'Missing userId or businessId' });
  }

  // Pull last ~12 months of actuals and forecasts, then merge in JS
  const [actuals, forecasts] = await Promise.all([
    safeQ(
      () =>
        supabase
          .from('financial_metrics')
          .select('month, total_revenue, total_expenses, net_profit')
          .eq('business_id', businessId)
          .order('month', { ascending: true })
          .limit(14),
      'financial_metrics'
    ),
    // Prefer cashflow_forecast (our canonical), but we’ll also try monthly_forecast if needed
    safeQ(
      () =>
        supabase
          .from('cashflow_forecast')
          .select('month, revenue, expenses')
          .eq('business_id', businessId)
          .order('month', { ascending: true })
          .limit(14),
      'cashflow_forecast'
    ),
  ]);

  let result = [];
  if (actuals.length && forecasts.length) {
    const fMap = new Map(
      forecasts.map((f) => [ymKey(f.month), f])
    );

    result = actuals
      .map((a) => {
        const key = ymKey(a.month);
        const f = fMap.get(key);
        if (!f) return null;

        const fr = Number(f.revenue || 0);
        const fe = Number(f.expenses || 0);
        const fp = fr - fe;

        const ar = Number(a.total_revenue || 0);
        const ae = Number(a.total_expenses || 0);
        const ap = Number(a.net_profit ?? (ar - ae));

        return {
          month: `${key}-01`,
          month_label: labelFor(a.month),
          forecastRevenue: fr,
          forecastExpenses: fe,
          forecastProfit: fp,
          actualRevenue: ar,
          actualExpenses: ae,
          actualProfit: ap,
          source: 'live',
        };
      })
      .filter(Boolean);

    // Keep the last N months
    result = result.slice(-months);
  }

  if (!result.length) {
    return res.status(200).json({ usingMock: true, rows: MOCK.slice(-months) });
  }

  return res.status(200).json({ usingMock: false, rows: result });
});

export default router;
