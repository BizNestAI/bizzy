// /api/insights/snooze.js (POST {id, until, businessId})
import { supabase } from '../../services/supabaseAdmin.js';

function parseSnoozeUntil(value) {
  const raw = String(value || '').trim().toLowerCase();
  const date = raw === 'now' ? new Date() : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export default async function handler(req, res) {
  try {
    const { id, until } = req.body || {};
    const businessId = req.body?.businessId || req.query?.businessId || req.headers?.['x-business-id'] || null;
    if (!id || !until) return res.status(400).json({ error: 'missing id/until' });
    if (!businessId) return res.status(400).json({ error: 'missing businessId' });

    const untilIso = parseSnoozeUntil(until);
    if (!untilIso) return res.status(400).json({ error: 'invalid until' });

    const { data, error } = await supabase
      .from('insights')
      .update({ snoozed_until: untilIso })
      .eq('id', id)
      .eq('business_id', businessId)
      .select('id');

    if (error) return res.status(500).json({ error: 'snooze_failed' });
    if (!data || data.length === 0) return res.status(404).json({ error: 'insight_not_found' });
    return res.json({ ok: true, id, until: untilIso });
  } catch (error) {
    console.error('[insights/snooze] failed', error?.message || error);
    return res.status(500).json({ error: 'snooze_failed' });
  }
}
