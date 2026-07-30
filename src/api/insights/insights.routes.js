// File: /src/api/insights/insights.routes.js
import { Router } from 'express';
import { supabase } from '../../services/supabaseAdmin.js';
import { getDailyHeadline } from './headline.controller.js';
import { getPulse } from './pulse.controller.js';
import { getTop3Alerts } from './top3.controller.js';
import listHandler from './list.js';                // ✅ centralized list handler (now supports `voice`)
import { generateAllInsights } from './generators/runAll.js';
import { generateContractorCfoInsights } from './generators/contractorCfo.generators.js';
import { markInsightFeedback } from '../../services/insights/insightDedupeService.js';
import { requireAuth } from '../gpt/middlewares/requireAuth.js';

const router = Router();
const DEFAULT_INSIGHTS_MODULE = 'contractor_cfo';
const MODULE_ALIASES = new Map([
  ['accounting', DEFAULT_INSIGHTS_MODULE],
  ['financials', DEFAULT_INSIGHTS_MODULE],
  ['bizzy', DEFAULT_INSIGHTS_MODULE],
]);

function parseSnoozeUntil(value) {
  const raw = String(value || '').trim().toLowerCase();
  const date = raw === 'now' ? new Date() : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function readBusinessId(req) {
  return (
    req.body?.businessId ||
    req.body?.business_id ||
    req.query?.businessId ||
    req.query?.business_id ||
    req.header('x-business-id') ||
    req.user?.business_id ||
    null
  );
}

function parseForce(value) {
  if (value === true) return true;
  return String(value || '').toLowerCase() === 'true';
}

router.get('/health', (_req, res) => res.json({ ok: true, module: 'insights' }));

// ——— Normalization / defaults for GET routes ———
router.use((req, _res, next) => {
  if (req.method === 'GET') {
    // Default to Bizzi's first-person voice unless explicitly disabled
    if (!req.query.voice) req.query.voice = 'bizzi';
    // Normalize module casing early (helps consistent filtering downstream)
    if (req.path === '/list') {
      const requestedModule = String(req.query.module || DEFAULT_INSIGHTS_MODULE).toLowerCase();
      req.query.module = MODULE_ALIASES.get(requestedModule) || requestedModule;
    } else if (req.query.module) {
      req.query.module = String(req.query.module).toLowerCase();
    }
  }
  next();
});

// Legacy dashboard-only endpoints. The live InsightsRail uses /list only.
// Auth is required and all controller reads/writes must be scoped by businessId/x-business-id.
// These endpoints are kept for old dashboard widgets and must only return contractor_cfo payloads.
router.get('/headline', requireAuth, getDailyHeadline);
router.get('/pulse', requireAuth, getPulse);
router.get('/top3', requireAuth, getTop3Alerts);

/**
 * GET /api/insights/list
 * Query:
 *   businessId, userId?, module?, accountId?, since?/after?, before?, only_unread?, limit?, voice? ('bizzi' | 'none')
 * Behavior:
 *   - Delegated to ./list.js (defaults to contractor_cfo, supports legacy module aliases)
 *   - Applies Bizzi voice by default; set voice=none to return neutral/system phrasing
 *   - Returns { items: [...] }
 */
router.get('/list', listHandler);

// POST /api/insights/generate
router.post('/generate', requireAuth, async (req, res) => {
  try {
    const businessId = readBusinessId(req);
    if (!businessId) return res.status(400).json({ error: 'missing businessId' });
    const trigger = req.body?.trigger || req.query?.trigger || 'manual';
    const force = parseForce(req.body?.force ?? req.query?.force);
    const r = await generateAllInsights({ businessId, trigger, force });
    res.json(r);
  } catch (e) {
    console.error('[insights/generate] error:', e);
    res.status(500).json({ ok: false, error: 'generate_failed' });
  }
});

router.post('/contractor-cfo/run', requireAuth, async (req, res) => {
  try {
    const businessId = readBusinessId(req);
    if (!businessId) return res.status(400).json({ ok: false, error: 'missing businessId' });
    const trigger = req.body?.trigger || req.query?.trigger || 'manual';
    const force = parseForce(req.body?.force ?? req.query?.force);
    const result = await generateContractorCfoInsights({ businessId, trigger, force });
    return res.json(result);
  } catch (e) {
    console.error('[insights/contractor-cfo/run] error:', e);
    return res.status(500).json({ ok: false, error: 'contractor_cfo_generate_failed' });
  }
});

// POST /api/insights/seen  { ids: string[], userId? }
router.post('/seen', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
    const userId = req.body?.userId || req.header('x-user-id') || null;
    const businessId = readBusinessId(req);
    if (!ids.length || !userId) return res.status(400).json({ ok: false, error: 'missing ids/userId' });
    if (!businessId) return res.status(400).json({ ok: false, error: 'missing businessId' });

    const { data: canonical, error: canonicalError } = await supabase
      .from('insights')
      .select('id')
      .eq('business_id', businessId)
      .in('id', ids);
    if (canonicalError) return res.status(500).json({ ok: false, error: 'seen_lookup_failed' });

    const found = new Set((canonical || []).map((row) => row.id));
    if (found.size !== ids.length) {
      const missing = ids.filter((id) => !found.has(id));
      const fb = await supabase
        .from('insights_history')
        .select('id')
        .eq('business_id', businessId)
        .in('id', missing);
      if (fb.error) return res.status(500).json({ ok: false, error: 'seen_lookup_failed' });
      (fb.data || []).forEach((row) => found.add(row.id));
    }

    if (found.size !== ids.length) return res.status(404).json({ ok: false, error: 'insight_not_found' });

    const rows = ids.map(id => ({ user_id: userId, insight_id: id, seen_at: new Date().toISOString() }));

    const { error } = await supabase
      .from('insight_reads')
      .upsert(rows, { onConflict: 'user_id,insight_id' });

    if (error) return res.status(500).json({ ok: false, error: 'upsert_failed' });
    res.json({ ok: true, count: rows.length });
  } catch (e) {
    console.error('[insights] mark-seen hard error:', e);
    res.status(500).json({ ok: false, error: 'seen_failed' });
  }
});

/**
 * POST /api/insights/mark-read { id, userId? }
 * Tries `insights` first; falls back to `insights_history` if necessary.
 */
router.post('/mark-read', async (req, res) => {
  try {
    const { id } = req.body || {};
    const businessId = readBusinessId(req);
    if (!id) return res.status(400).json({ error: 'missing id' });
    if (!businessId) return res.status(400).json({ error: 'missing businessId' });

    // canonical
    let { data, error } = await supabase
      .from('insights')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', id)
      .eq('business_id', businessId)
      .select('id');

    // fallback
    if (error || !data || data.length === 0) {
      const fb = await supabase
        .from('insights_history')
        .update({ is_read: true })
        .eq('id', id)
        .eq('business_id', businessId)
        .select('id');

      if (fb.error) {
        console.error('[insights] mark-read failed both tables:', { err1: error?.message, err2: fb.error.message });
        return res.status(500).json({ error: 'mark_read_failed' });
      }
      if (!fb.data || fb.data.length === 0) {
        return res.status(404).json({ error: 'insight_not_found' });
      }
    }

    res.json({ ok: true, id });
  } catch (e) {
    console.error('[insights] mark-read hard error:', e);
    res.status(500).json({ error: 'mark_read_failed' });
  }
});

/**
 * POST /api/insights/snooze { id, until, businessId? }
 * Tries `insights` first; falls back to `insights_history` if necessary.
 */
router.post('/snooze', async (req, res) => {
  try {
    const { id, until } = req.body || {};
    const businessId = req.body?.businessId || req.query?.businessId || req.header('x-business-id') || null;
    if (!id || !until) return res.status(400).json({ error: 'missing id/until' });
    if (!businessId) return res.status(400).json({ error: 'missing businessId' });

    const untilIso = parseSnoozeUntil(until);
    if (!untilIso) return res.status(400).json({ error: 'invalid until' });

    // canonical
    let { data, error } = await supabase
      .from('insights')
      .update({ snoozed_until: untilIso })
      .eq('id', id)
      .eq('business_id', businessId)
      .select('id');

    // fallback
    if (error || !data || data.length === 0) {
      const fb = await supabase
        .from('insights_history')
        .update({ snoozed_until: untilIso })
        .eq('id', id)
        .eq('business_id', businessId)
        .select('id');

      if (fb.error) {
        console.error('[insights] snooze failed both tables:', { err1: error?.message, err2: fb.error.message });
        return res.status(500).json({ error: 'snooze_failed' });
      }
      if (!fb.data || fb.data.length === 0) {
        return res.status(404).json({ error: 'insight_not_found' });
      }
    }

    res.json({ ok: true, id, until: untilIso });
  } catch (e) {
    console.error('[insights] snooze hard error:', e);
    res.status(500).json({ error: 'snooze_failed' });
  }
});

/**
 * POST /api/insights/feedback { insightId, feedback, userId?, notes?, businessId? }
 */
router.post('/feedback', async (req, res) => {
  try {
    const businessId = req.body?.businessId || req.query?.businessId || req.header('x-business-id') || null;
    const insightId = req.body?.insightId || req.body?.id || null;
    const feedback = req.body?.feedback || null;
    const userId = req.body?.userId || req.header('x-user-id') || null;
    const notes = req.body?.notes || null;

    if (!businessId) return res.status(400).json({ ok: false, error: 'missing businessId' });
    if (!insightId || !feedback) return res.status(400).json({ ok: false, error: 'missing insightId/feedback' });

    const result = await markInsightFeedback({ businessId, insightId, feedback, userId, notes });
    if (!result.ok) {
      const status = result.error === 'invalid_feedback'
        ? 400
        : result.error === 'insight_not_found'
          ? 404
          : 500;
      return res.status(status).json(result);
    }

    res.json(result);
  } catch (e) {
    console.error('[insights] feedback hard error:', e);
    res.status(500).json({ ok: false, error: 'feedback_failed' });
  }
});

export default router;
