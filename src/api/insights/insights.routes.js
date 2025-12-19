// File: /src/api/insights/insights.routes.js
import { Router } from 'express';
import { supabase } from '../../services/supabaseAdmin.js';
import { getDailyHeadline } from './headline.controller.js';
import { getPulse } from './pulse.controller.js';
import { getTop3Alerts } from './top3.controller.js';
import listHandler from './list.js';                // ✅ centralized list handler (now supports `voice`)
import { generateAllInsights } from './generators/runAll.js';

const router = Router();

router.get('/health', (_req, res) => res.json({ ok: true, module: 'insights' }));

// ——— Normalization / defaults for GET routes ———
router.use((req, _res, next) => {
  if (req.method === 'GET') {
    // Default to Bizzi's first-person voice unless explicitly disabled
    if (!req.query.voice) req.query.voice = 'bizzi';
    // Normalize module casing early (helps consistent filtering downstream)
    if (req.query.module) req.query.module = String(req.query.module).toLowerCase();
  }
  next();
});

// Daily greeting / nudge for the dashboard
// GET /api/insights/headline?businessId=...&userId=...
router.get('/headline', getDailyHeadline);

// Pulse + Top3 (unchanged)
router.get('/pulse', getPulse);
router.get('/top3', getTop3Alerts);

/**
 * GET /api/insights/list
 * Query:
 *   businessId?, userId?, module?, accountId?, since?/after?, before?, only_unread?, limit?, voice? ('bizzi' | 'none')
 * Behavior:
 *   - Delegated to ./list.js (supports accountId + email module, cursors, unread filter)
 *   - Applies Bizzi voice by default; set voice=none to return neutral/system phrasing
 *   - Returns { items: [...] }
 */
router.get('/list', listHandler);

// POST /api/insights/generate
router.post('/generate', async (req, res) => {
  try {
    const userId = req.body?.userId || req.query.userId;
    const businessId = req.body?.businessId || req.query.businessId;
    const accountId = req.body?.accountId || req.query.accountId;
    if (!userId && !businessId) return res.status(400).json({ error: 'missing userId or businessId' });
    const r = await generateAllInsights({ userId, businessId, accountId });
    res.json(r);
  } catch (e) {
    console.error('[insights/generate] error:', e);
    res.status(500).json({ ok: false, error: 'generate_failed' });
  }
});

// POST /api/insights/seen  { ids: string[], userId? }
router.post('/seen', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
    const userId = req.body?.userId || req.header('x-user-id') || null;
    if (!ids.length || !userId) return res.status(400).json({ ok: false, error: 'missing ids/userId' });

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
    if (!id) return res.status(400).json({ error: 'missing id' });

    // canonical
    let { data, error } = await supabase
      .from('insights')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', id)
      .select('id');

    // fallback
    if (error || !data || data.length === 0) {
      const fb = await supabase
        .from('insights_history')
        .update({ is_read: true })
        .eq('id', id)
        .select('id');

      if (fb.error) {
        console.error('[insights] mark-read failed both tables:', { err1: error?.message, err2: fb.error.message });
        return res.status(500).json({ error: 'mark_read_failed' });
      }
    }

    res.json({ ok: true, id });
  } catch (e) {
    console.error('[insights] mark-read hard error:', e);
    res.status(500).json({ error: 'mark_read_failed' });
  }
});

/**
 * POST /api/insights/snooze { id, until }
 * Tries `insights` first; falls back to `insights_history` if necessary.
 */
router.post('/snooze', async (req, res) => {
  try {
    const { id, until } = req.body || {};
    if (!id || !until) return res.status(400).json({ error: 'missing id/until' });

    const untilIso = new Date(until).toISOString();

    // canonical
    let { data, error } = await supabase
      .from('insights')
      .update({ snoozed_until: untilIso })
      .eq('id', id)
      .select('id');

    // fallback
    if (error || !data || data.length === 0) {
      const fb = await supabase
        .from('insights_history')
        .update({ snoozed_until: untilIso })
        .eq('id', id)
        .select('id');

      if (fb.error) {
        console.error('[insights] snooze failed both tables:', { err1: error?.message, err2: fb.error.message });
        return res.status(500).json({ error: 'snooze_failed' });
      }
    }

    res.json({ ok: true, id, until: untilIso });
  } catch (e) {
    console.error('[insights] snooze hard error:', e);
    res.status(500).json({ error: 'snooze_failed' });
  }
});

export default router;
