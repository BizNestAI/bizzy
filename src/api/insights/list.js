// /src/api/insights/list.js
import { supabase as defaultSupabase } from '../../services/supabaseAdmin.js'; 
import { applyBizziVoice } from '../../insights/insightsVoice.js'; // ⬅️ add this file alongside list.js

const DEFAULT_MODULE = 'contractor_cfo';
const LEGACY_MODULE_ALIASES = new Map([
  ['accounting', DEFAULT_MODULE],
  ['financials', DEFAULT_MODULE],
  ['bizzy', DEFAULT_MODULE],
]);
const HIDDEN_STATUSES = new Set(['dismissed', 'deleted', 'archived', 'resolved']);

let supabase = defaultSupabase;

export function __setInsightsListTestDeps(deps = {}) {
  supabase = deps.supabase || defaultSupabase;
}

function normalizeModuleKey(value) {
  const raw = String(value || DEFAULT_MODULE).trim().toLowerCase();
  if (!raw || raw === 'all') return DEFAULT_MODULE;
  return LEGACY_MODULE_ALIASES.get(raw) || raw;
}

function toIso(value) {
  try {
    if (!value) return null;
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function isFutureIso(value, nowMs = Date.now()) {
  if (!value) return false;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) && ts > nowMs;
}

function isPastIso(value, nowMs = Date.now()) {
  if (!value) return false;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) && ts < nowMs;
}

function normalizeCta(row = {}, prefix) {
  const cta = row[`${prefix}_cta`] || {};
  return {
    [`${prefix}_cta`]: row[`${prefix}_cta`] ?? null,
    [`${prefix}_cta_label`]: row[`${prefix}_cta_label`] ?? cta.label ?? null,
    [`${prefix}_cta_action`]: row[`${prefix}_cta_action`] ?? cta.action ?? null,
    [`${prefix}_cta_payload`]:
      row[`${prefix}_cta_payload`] ??
      cta.payload ??
      (cta.route ? { route: cta.route } : null),
  };
}

function normalizeInsightRow(row = {}, { moduleKey } = {}) {
  const metrics = row.metrics || {};
  const normalizedModule = normalizeModuleKey(row.module ?? metrics.module ?? moduleKey);

  return {
    id: row.id,
    business_id: row.business_id ?? null,
    user_id: row.user_id ?? null,
    module: normalizedModule,
    account_id: row.account_id ?? null,
    type: row.type ?? 'insight',
    severity: row.severity ?? metrics.severity ?? 'medium',
    category: row.category ?? metrics.category ?? null,
    confidence_score: row.confidence_score ?? metrics.confidence_score ?? null,
    dedupe_key: row.dedupe_key ?? metrics.dedupe_key ?? null,
    trigger_source: row.trigger_source ?? metrics.trigger_source ?? null,
    title: row.title ?? metrics.title ?? null,
    body: row.body ?? metrics.body ?? null,
    ...normalizeCta(row, 'primary'),
    ...normalizeCta(row, 'secondary'),
    tags: row.tags ?? metrics.tags ?? null,
    source_event_id: row.source_event_id ?? metrics.source_event_id ?? null,
    created_at: row.created_at,
    expires_at: row.expires_at ?? null,
    snoozed_until: row.snoozed_until ?? null,
    is_read: row.is_read ?? false,
    read_at: row.read_at ?? null,
    is_seen: row.is_seen,
    status: row.status ?? null,
    dismissed_at: row.dismissed_at ?? null,
  };
}

function visibleInsight(row, { biz, uid, moduleKey, acct, unreadOnly, sinceIso, beforeIso, nowMs }) {
  if (!row || row.business_id !== biz) return false;
  if (uid && row.user_id && row.user_id !== uid) return false;
  if (normalizeModuleKey(row.module) !== moduleKey) return false;
  if (acct && (row.account_id || '') !== acct) return false;
  if (unreadOnly && row.is_read) return false;
  if (sinceIso && new Date(row.created_at) < new Date(sinceIso)) return false;
  if (beforeIso && new Date(row.created_at) >= new Date(beforeIso)) return false;
  if (row.snoozed_until && isFutureIso(row.snoozed_until, nowMs)) return false;
  if (row.expires_at && isPastIso(row.expires_at, nowMs)) return false;
  if (row.dismissed_at) return false;
  if (row.status && HIDDEN_STATUSES.has(String(row.status).toLowerCase())) return false;
  return true;
}

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

    const biz  = businessId || business_id || req.header('x-business-id') || null;
    const uid  = userId || user_id || null;
    const acct = accountId || account_id || null;

    if (!biz) {
      return res.status(400).json({ error: 'missing businessId' });
    }

    const sinceIso   = toIso(since || after);
    const beforeIso  = toIso(before);
    const lim        = Math.max(1, Math.min(Number(limit) || 20, 100));
    const unreadOnly = String(only_unread || '').toLowerCase();
    const onlyUnread = unreadOnly === '1' || unreadOnly === 'true';
    const wantVoice  = String(voice || 'bizzi').toLowerCase() !== 'none';
    const moduleFilter = normalizeModuleKey(moduleKey);
    const nowMs = Date.now();
    const dbLimit = Math.min(lim * 3, 300);

    // ------------------------
    // 1) canonical query
    // ------------------------
    let q = supabase
      .from('insights')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(dbLimit)
      .eq('business_id', biz)
      .eq('module', moduleFilter);

    if (acct) q = q.eq('account_id', acct);
    if (onlyUnread) q = q.eq('is_read', false);
    if (sinceIso)  q = q.gte('created_at', sinceIso);
    if (beforeIso) q = q.lt('created_at', beforeIso);

    const { data, error } = await q;

    if (!error) {
      const visibleRows = (data || [])
        .map((row) => normalizeInsightRow(row, { moduleKey: moduleFilter }))
        .filter((row) => visibleInsight({
          ...row,
          module: row.module || moduleFilter,
        }, { biz, uid, moduleKey: moduleFilter, acct, unreadOnly: onlyUnread, sinceIso, beforeIso, nowMs }))
        .slice(0, lim);

      let enriched = await withSeenFlag({ items: visibleRows, uid });
      if (wantVoice) enriched = applyBizziVoice(enriched); // ⬅️ apply Bizzi voice
      return res.json({ items: enriched });
    }

    // ------------------------
    // 2) fallback → insights_history
    // ------------------------
    let fbq = supabase
      .from('insights_history')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(dbLimit)
      .eq('business_id', biz);

    if (sinceIso)  fbq = fbq.gte('created_at', sinceIso);
    if (beforeIso) fbq = fbq.lt('created_at', beforeIso);

    const fb = await fbq;

    if (fb.error) {
      console.error('[insights/list] fallback query failed:', fb.error?.message || fb.error);
      return res.json({ items: [] });
    }

    const rows = (fb.data || [])
      .map((row) => normalizeInsightRow(row, { moduleKey: moduleFilter }))
      .filter((row) => visibleInsight(row, { biz, uid, moduleKey: moduleFilter, acct, unreadOnly: onlyUnread, sinceIso, beforeIso, nowMs }))
      .slice(0, lim);

    let enriched = await withSeenFlag({ items: rows, uid });
    if (wantVoice) enriched = applyBizziVoice(enriched); // ⬅️ apply Bizzi voice
    return res.json({ items: enriched });

  } catch (e) {
    console.error('[insights/list] error:', e?.message || e);
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
