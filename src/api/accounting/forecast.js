// File: /src/api/accounting/forecast.js
import express from 'express';
import {
  generateCashFlowForecast,
  upsertForecastRows,
} from './generateCashFlowForecast.js';
import { supabase } from '../../services/supabaseAdmin.js';
import { isAdminViewRequest, sendAdminViewReadOnlyUnavailable } from '../_shared/tenantAuth.js';

const router = express.Router();

/**
 * GET /api/accounting/forecast
 * Returns (and upserts) a 2–12 month cash-flow forecast.
 * Query:
 *  - userId (required)
 *  - businessId (required)
 *  - months (optional, default 12; clamped 2–12)
 *  - mockOnly=true|false (optional; forces mock generation)
 */
router.get('/', async (req, res) => {
  const businessId = req.business?.id || req.auth?.businessId || req.query.businessId || req.query.business_id;
  const userId = req.auth?.userId || req.user?.id || req.query.userId || req.query.user_id;
  let { months = '12', mockOnly } = req.query;

  if ((!userId && !isAdminViewRequest(req)) || !businessId) {
    return res.status(400).json({ error: 'Missing userId or businessId' });
  }

  // Normalize inputs
  months = Math.max(2, Math.min(12, parseInt(months, 10) || 12));
  const forceMock = String(mockOnly).toLowerCase() === 'true';

  try {
    if (isAdminViewRequest(req)) {
      const { data, error } = await supabase
        .from('cashflow_forecast')
        .select('*')
        .eq('business_id', businessId)
        .order('month', { ascending: true })
        .limit(months);

      if (error) {
        console.error('[Forecast Cache Fetch Error]', error?.message || error);
        return res.status(500).json({ error: 'Failed to fetch cash flow forecast.' });
      }
      if (!Array.isArray(data) || data.length === 0) {
        return sendAdminViewReadOnlyUnavailable(res, { error: 'admin_view_read_only_data_unavailable' });
      }
      res.set('Cache-Control', 'private, max-age=30');
      return res.status(200).json({
        forecast: data,
        admin_view_cache_only: true,
      });
    }

    const forecast = await generateCashFlowForecast({
      userId,
      businessId,
      months,
      forceMock,
    });

    // Light caching of identical queries during a session
    res.set('Cache-Control', 'private, max-age=30');
    return res.status(200).json({ forecast });
  } catch (err) {
    console.error('[Forecast Error]', err);
    return res.status(500).json({ error: 'Failed to generate cash flow forecast.' });
  }
});

/**
 * POST /api/accounting/forecast/override
 * Persist user overrides coming from the Forecast Editor table.
 * Body: {
 *   userId: string,
 *   businessId: string,
 *   rows: [{
 *     month: 'YYYY-MM' | 'YYYY-MM-DD',
 *     revenue, expenses, cash_in?, cash_out?, net_cash?, ending_cash?
 *   }]
 * }
 */
router.post('/override', async (req, res) => {
  const { userId, businessId, rows } = req.body || {};
  if (!userId || !businessId || !Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'Missing userId, businessId, or rows' });
  }

  try {
    const normalized = rows.map(normalizeRow);
    await upsertForecastRows({ userId, businessId, rows: normalized, source: 'manual' });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[Forecast Override Error]', err);
    return res.status(500).json({ error: 'Failed to save overrides.' });
  }
});

/* ----------------------- helpers ----------------------- */

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Accepts 'YYYY-MM' or 'YYYY-MM-DD' or Date; returns 'YYYY-MM-01'
function toMonthDate(v) {
  if (typeof v === 'string') {
    // 'YYYY-MM'
    if (/^\d{4}-\d{2}$/.test(v)) return `${v}-01`;
    // 'YYYY-MM-DD'
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v.slice(0, 7) + '-01';
  }
  const d = new Date(v || Date.now());
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

function normalizeRow(r) {
  const month = toMonthDate(r.month);
  const revenue = toNum(r.revenue ?? r.forecasted_revenue);
  const expenses = toNum(r.expenses ?? r.forecasted_expenses);

  // Keep AR/AP/loan portions that were already baked into cash_in/out if present
  const cash_in = toNum(r.cash_in ?? revenue);
  const cash_out = toNum(r.cash_out ?? expenses);
  const net_cash = toNum(r.net_cash ?? cash_in - cash_out);
  const ending_cash = toNum(r.ending_cash ?? 0);

  return {
    // required by your schema (userId/businessId are attached in upsert helper)
    month,
    revenue,
    expenses,
    cash_in,
    cash_out,
    net_cash,
    ending_cash,
    source: 'manual',
    updated_at: new Date().toISOString(),
  };
}

export default router;
