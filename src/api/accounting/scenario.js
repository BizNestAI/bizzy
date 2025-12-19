// File: /src/api/accounting/scenarios.js
import express from 'express';
import { supabase } from '../../services/supabaseAdmin.js';
import {
  saveScenarioToSupabase,
  updateScenario,
  loadUserScenarios,
  loadScenarioWithItems,
  deleteScenario,
} from '../../services/accounting/scenarioService.js';
import { generateScenarioForecast } from '../../utils/generateScenarioForecast.js';

const router = express.Router();

/* ---------- helpers ---------- */
const safeQ = async (fn, label) => {
  try {
    const { data, error } = await fn();
    if (error) {
      if (error.code === '42P01' || error.code === '42501') {
        console.warn(`[scenarios] ${label}: ${error.message}`);
        return [];
      }
      console.warn(`[scenarios] ${label} error:`, error.message);
      return [];
    }
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn(`[scenarios] ${label} exception:`, e?.message || e);
    return [];
  }
};

/* ---------- list user scenarios ---------- */
router.get('/list', async (req, res) => {
  const { userId, businessId } = req.query;
  if (!userId || !businessId) return res.status(400).json({ error: 'Missing userId or businessId' });

  const out = await loadUserScenarios(userId, businessId);
  if (!out.success) return res.status(500).json({ error: out.error });
  return res.status(200).json({ scenarios: out.scenarios });
});

/* ---------- get scenario + items ---------- */
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const out = await loadScenarioWithItems(id);
  if (!out.success) return res.status(500).json({ error: out.error });
  return res.status(200).json({ scenario: out.scenario, items: out.items });
});

/* ---------- create ---------- */
router.post('/save', async (req, res) => {
  const out = await saveScenarioToSupabase(req.body || {});
  if (!out.success) return res.status(400).json({ error: out.error });
  return res.status(200).json({ scenarioId: out.scenarioId });
});

/* ---------- update (overwrite items) ---------- */
router.post('/update', async (req, res) => {
  const out = await updateScenario(req.body || {});
  if (!out.success) return res.status(400).json({ error: out.error });
  return res.status(200).json({ scenarioId: out.scenarioId });
});

/* ---------- delete ---------- */
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const { userId } = req.query;
  const out = await deleteScenario(id, userId);
  if (!out.success) return res.status(400).json({ error: out.error });
  return res.status(200).json({ ok: true });
});

/* ---------- preview: apply items to baseline and return adjusted rows ---------- */
/**
 * Body:
 * {
 *   userId, businessId,
 *   scenario_items: [...],
 *   baselineForecast?: [...]        // optional, if not provided we fetch from DB
 * }
 */
router.post('/preview', async (req, res) => {
  const { userId, businessId, scenario_items, baselineForecast } = req.body || {};
  if (!userId || !businessId || !Array.isArray(scenario_items)) {
    return res.status(400).json({ error: 'Missing userId, businessId or scenario_items' });
  }

  // Use provided baseline or fetch from DB
  let baseline = Array.isArray(baselineForecast) ? baselineForecast : [];

  if (baseline.length === 0) {
    baseline = await safeQ(
      () =>
        supabase
          .from('cashflow_forecast')
          .select('month, month_label, revenue, expenses, cash_in, cash_out, net_cash, ending_cash')
          .eq('business_id', businessId)
          .order('month'),
      'cashflow_forecast'
    );
  }

  // Optional: starting cash from balance sheet
  const bs = await safeQ(
    () =>
      supabase
        .from('balance_sheet_history')
        .select('month, cash')
        .eq('business_id', businessId)
        .order('month', { ascending: false })
        .limit(1),
    'balance_sheet_history'
  );
  const startingCash = bs && bs[0] ? Number(bs[0].cash || 0) : undefined;

  try {
    const adjusted = generateScenarioForecast(baseline, scenario_items, { startingCash });
    return res.status(200).json({ forecast: adjusted });
  } catch (e) {
    console.error('[scenarios/preview] error', e);
    return res.status(500).json({ error: 'Failed to generate scenario preview' });
  }
});

export default router;
