// /src/api/insights/list.js
import { supabase } from '../../services/supabaseAdmin.js'; 
import { applyBizziVoice } from '../../insights/insightsVoice.js'; // ⬅️ add this file alongside list.js

// GET /api/insights/list?businessId=&userId=&module=&accountId=&since=&after=&before=&only_unread=&limit=&voice=
export default async function listHandler(req, res) {
  try {
    const {
      businessId,
      business_id,
      userId,
      user_id,
      module: moduleKey,
      accountId,
      account_id,
      since,
      after,               // alias of since
      before,              // fetch older than this ISO time (optional)
      only_unread,         // 1 | true
      limit = 20,
      voice = 'bizzi',     // ⬅️ new: 'bizzi' | 'none'
    } = req.query;

    const biz  = businessId || business_id || null;
    const uid  = userId || user_id || null;
    const acct = accountId || account_id || null;

    if (!biz && !uid) {
      return res.status(400).json({ error: 'missing businessId or userId' });
    }

    // Normalize and validate date cursors
    const toIso = (v) => {
      try {
        if (!v) return null;
        const d = new Date(v);
        if (!Number.isFinite(d.getTime())) return null;
        return d.toISOString();
      } catch { return null; }
    };

    const sinceIso   = toIso(since || after);
    const beforeIso  = toIso(before);
    const lim        = Math.max(1, Math.min(Number(limit) || 20, 100));
    const unreadOnly = String(only_unread || '').toLowerCase();
    const wantVoice  = String(voice || 'bizzi').toLowerCase() !== 'none';

    // ------------------------
    // 1) canonical query
    // ------------------------
    let q = supabase
      .from('insights')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(lim);

    if (biz) q = q.eq('business_id', biz);
    if (uid) q = q.eq('user_id', uid);
    if (moduleKey && moduleKey !== 'all') q = q.eq('module', moduleKey);
    if (acct) q = q.eq('account_id', acct);
    if (unreadOnly === '1' || unreadOnly === 'true') q = q.eq('is_read', false);
    if (sinceIso)  q = q.gte('created_at', sinceIso);
    if (beforeIso) q = q.lt('created_at', beforeIso);

    const { data, error } = await q;

    if (!error) {
      let enriched = await withSeenFlag({ items: data || [], uid });
      if (wantVoice) enriched = applyBizziVoice(enriched); // ⬅️ apply Bizzi voice
      return res.json({ items: enriched });
    }

    // ------------------------
    // 2) fallback → insights_history
    // ------------------------
    const fb = await supabase
      .from('insights_history')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(lim);

    if (fb.error) {
      console.error('[insights/list] fallback query failed:', fb.error);
      return res.json({ items: [] });
    }

    // Map rows to canonical shape
    let rows = (fb.data || []).map(r => ({
      id: r.id,
      business_id: r.business_id ?? null,
      user_id: r.user_id ?? null,
      module: r.module ?? (r.metrics?.module ?? 'bizzy'),
      account_id: r.account_id ?? null,
      type: 'insight',
      severity: r.severity ?? 'medium',
      title: r.title ?? r.metrics?.title ?? null,
      body: r.body ?? r.metrics?.body ?? null,
      primary_cta: r.primary_cta ?? null,
      secondary_cta: r.secondary_cta ?? null,
      tags: r.tags ?? null,
      source_event_id: r.source_event_id ?? null,
      created_at: r.created_at,
      expires_at: r.expires_at ?? null,
      snoozed_until: r.snoozed_until ?? null,
      is_read: r.is_read ?? false,
    }));

    // Apply same filters post-hoc (history may lack identical schema/types)
    if (biz)  rows = rows.filter(r => r.business_id === biz);
    if (uid)  rows = rows.filter(r => r.user_id === uid);
    if (moduleKey && moduleKey !== 'all') rows = rows.filter(r => (r.module || '').toLowerCase() === moduleKey.toLowerCase());
    if (acct) rows = rows.filter(r => (r.account_id || '') === acct);
    if (unreadOnly === '1' || unreadOnly === 'true') rows = rows.filter(r => !r.is_read);
    if (sinceIso)  rows = rows.filter(r => new Date(r.created_at) >= new Date(sinceIso));
    if (beforeIso) rows = rows.filter(r => new Date(r.created_at) <  new Date(beforeIso));

    let enriched = await withSeenFlag({ items: rows, uid });
    if (wantVoice) enriched = applyBizziVoice(enriched); // ⬅️ apply Bizzi voice
    return res.json({ items: enriched });

  } catch (e) {
    console.error('[insights/list] error:', e);
    // Fail-soft so the UI doesn't blank if the DB is empty/misconfigured
    return res.json({ items: [] });
  }
}

/**
 * Attach `is_seen` from insight_reads for this user.
 * If no uid is provided, items are returned unchanged (is_seen undefined).
 */
async function withSeenFlag({ items = [], uid }) {
  if (!uid || !items.length) return items;

  const ids = items.map(i => i.id).filter(Boolean);
  if (!ids.length) return items;

  const { data: seenRows, error } = await supabase
    .from('insight_reads')
    .select('insight_id')
    .eq('user_id', uid)
    .in('insight_id', ids);

  if (error) return items;

  const seenSet = new Set((seenRows || []).map(r => r.insight_id));
  return items.map(i => ({ ...i, is_seen: seenSet.has(i.id) }));
}
