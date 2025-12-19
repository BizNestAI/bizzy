// src/api/gpt/insights/generators/email.generators.js
import { supabase } from '../../../services/supabaseAdmin.js';

/** Upsert-like helper: dedupe by (user_id, module, source_event_id) */
async function insertInsightsDedup(rows = []) {
  const out = [];
  for (const r of rows) {
    try {
      if (!r.user_id || !r.module || !r.source_event_id) continue;
      const { data: existing } = await supabase
        .from('insights')
        .select('id')
        .eq('user_id', r.user_id)
        .eq('module', r.module)
        .eq('source_event_id', r.source_event_id)
        .limit(1);
      if (existing && existing.length) continue;
      const { data, error } = await supabase.from('insights').insert(r).select('id').single();
      if (!error && data) out.push(data.id);
    } catch {/* ignore per-row failures */}
  }
  return out;
}

/** Helpers */
const daysAgo  = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
const hoursAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 3600000;
const safe     = (s) => (s || '').toString().trim();
const inInbox  = (labels) => Array.isArray(labels) && labels.includes('INBOX');

const KW = {
  payment:  ['payment','pay','paid','invoice','bill','wire','ach','check','remit'],
  estimate: ['estimate','quote','bid','proposal','pricing'],
  schedule: ['schedule','reschedule','availability','time slot','meeting','book','call','onsite'],
};

function matchAny(text, list) {
  const s = (text || '').toLowerCase();
  return list.some(k => s.includes(k));
}
function anyKeyword(hit) {
  const s = (safe(hit.subject) + ' ' + safe(hit.snippet)).toLowerCase();
  return (
    (matchAny(s, KW.payment)  && 'payment') ||
    (matchAny(s, KW.estimate) && 'estimate') ||
    (matchAny(s, KW.schedule) && 'schedule') ||
    null
  );
}

/* ============================================================================
   0) Base fetch utilities
============================================================================ */
async function fetchRecentThreads({ userId, accountId, sinceIso, limit = 200 }) {
  const { data, error } = await supabase
    .from('email_threads_cache')
    .select('thread_id,subject,snippet,from_name,from_email,last_message_ts,labels,unread,account_id')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .gte('last_message_ts', sinceIso)
    .order('last_message_ts', { ascending: false })
    .limit(limit);
  return error ? [] : (data || []);
}

async function fetchUnread({ userId, accountId, limit = 200 }) {
  const { data, error } = await supabase
    .from('email_threads_cache')
    .select('thread_id,subject,snippet,from_name,from_email,last_message_ts,labels,unread,account_id')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .eq('unread', true)
    .order('last_message_ts', { ascending: false })
    .limit(limit);
  return error ? [] : (data || []);
}

/* ============================================================================
   1) Keyword alerts (payment/estimate/schedule) — recent, any state
============================================================================ */
export async function genEmailKeywordAlerts({ userId, accountId, windowDays = 7, maxPerType = 5 }) {
  if (!userId || !accountId) return [];
  const sinceIso = new Date(Date.now() - windowDays * 86400000).toISOString();
  const rows = await fetchRecentThreads({ userId, accountId, sinceIso });

  const buckets = { payment: [], estimate: [], schedule: [] };
  for (const r of rows) {
    const type = anyKeyword(r);
    if (!type) continue;
    buckets[type].push(r);
  }

  const items = [];
  for (const [type, arr] of Object.entries(buckets)) {
    for (const r of arr.slice(0, maxPerType)) {
      items.push({
        user_id: userId,
        module: 'email',
        account_id: r.account_id,
        title: `${type === 'payment' ? 'Payment/Invoice' : type === 'estimate' ? 'Estimate/Quote' : 'Scheduling'}: ${safe(r.from_name) || safe(r.from_email) || 'Contact'}`,
        body: `${safe(r.subject) || '(no subject)'} — ${daysAgo(r.last_message_ts)} day(s) ago`,
        severity: 'info',
        is_read: false,
        primary_cta: { action: 'open_thread', label: 'Open email', threadId: r.thread_id, accountId },
        tags: ['email', type],
        source_event_id: `email:kw:${type}:${accountId}:${r.thread_id}`,
      });
    }
  }

  await insertInsightsDedup(items);
  return items;
}

/* ============================================================================
   2) Unread priority (keyword + unread + recent hours)
============================================================================ */
export async function genEmailUnreadPriority({ userId, accountId, recentHours = 24, max = 10 }) {
  if (!userId || !accountId) return [];
  const rows = await fetchUnread({ userId, accountId, limit: 300 });
  const hits = rows
    .filter(r => hoursAgo(r.last_message_ts) <= recentHours)
    .map(r => ({ r, type: anyKeyword(r) }))
    .filter(x => !!x.type)
    .slice(0, max);

  const items = hits.map(({ r, type }) => ({
    user_id: userId,
    module: 'email',
    account_id: r.account_id,
    title: `Unread ${type}: ${safe(r.from_name) || safe(r.from_email) || 'Contact'}`,
    body: `${safe(r.subject) || '(no subject)'} — ${hoursAgo(r.last_message_ts).toFixed(1)}h ago`,
    severity: 'warn',
    is_read: false,
    primary_cta: { action: 'open_thread', label: 'Open email', threadId: r.thread_id, accountId },
    tags: ['email','unread', type],
    source_event_id: `email:unread_priority:${type}:${accountId}:${r.thread_id}`,
  }));

  await insertInsightsDedup(items);
  return items;
}

/* ============================================================================
   3) High-volume sender (burst detector)
============================================================================ */
export async function genEmailHighVolumeSender({ userId, accountId, windowDays = 7, minCount = 4, maxSenders = 3 }) {
  if (!userId || !accountId) return [];
  const sinceIso = new Date(Date.now() - windowDays * 86400000).toISOString();
  const rows = await fetchRecentThreads({ userId, accountId, sinceIso, limit: 500 });

  const countBySender = new Map();
  for (const r of rows) {
    const key = (safe(r.from_email) || safe(r.from_name)).toLowerCase();
    if (!key) continue;
    countBySender.set(key, (countBySender.get(key) || 0) + 1);
  }

  const noisy = [...countBySender.entries()]
    .filter(([_, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxSenders);

  const items = noisy.map(([sender, n]) => ({
    user_id: userId,
    module: 'email',
    account_id: accountId,
    title: `High-volume from ${sender}`,
    body: `${n} threads in last ${windowDays} day(s). Consider filtering or replying.`,
    severity: 'info',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open inbox', route: '/dashboard/email' },
    tags: ['email','volume'],
    source_event_id: `email:sender_burst:${accountId}:${sender}:${windowDays}d`,
  }));

  await insertInsightsDedup(items);
  return items;
}

/* ============================================================================
   4) Stalled inbox (INBOX-labeled threads older than X days)
============================================================================ */
export async function genEmailStalledInbox({ userId, accountId, stallDays = 7, max = 20 }) {
  if (!userId || !accountId) return [];
  const { data, error } = await supabase
    .from('email_threads_cache')
    .select('thread_id,subject,from_name,from_email,last_message_ts,labels,account_id')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .order('last_message_ts', { ascending: false })
    .limit(400);
  if (error || !data) return [];

  const hits = (data || [])
    .filter(r => inInbox(r.labels))
    .filter(r => daysAgo(r.last_message_ts) >= stallDays)
    .slice(0, max);

  const items = hits.map(r => ({
    user_id: userId,
    module: 'email',
    account_id: r.account_id,
    title: `Stalled in inbox: ${safe(r.from_name) || safe(r.from_email)}`,
    body: `${safe(r.subject) || '(no subject)'} — ${daysAgo(r.last_message_ts)} day(s) old.`,
    severity: 'info',
    is_read: false,
    primary_cta: { action: 'open_thread', label: 'Open email', threadId: r.thread_id, accountId },
    tags: ['email','stalled'],
    source_event_id: `email:stalled:${accountId}:${r.thread_id}`,
  }));

  await insertInsightsDedup(items);
  return items;
}

/* ============================================================================
   5) Unreplied (heuristic) — keep your existing logic
   NOTE: improves dramatically once email_activity_log is available
============================================================================ */
export async function genEmailUnreplied({ userId, accountId, agingDays = 2, windowDays = 14 }) {
  if (!userId || !accountId) return [];
  const sinceIso = new Date(Date.now() - windowDays * 86400000).toISOString();

  const { data, error } = await supabase
    .from('email_threads_cache')
    .select('thread_id,subject,snippet,from_name,from_email,last_message_ts,labels,unread,account_id')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .gte('last_message_ts', sinceIso)
    .order('last_message_ts', { ascending: false })
    .limit(200);

  if (error || !data) return [];

  const items = data
    .filter(r => r && r.last_message_ts)
    .filter(r => daysAgo(r.last_message_ts) >= agingDays)
    .filter(r => (r.unread === true) || inInbox(r.labels))
    .slice(0, 25)
    .map(r => ({
      user_id: userId,
      module: 'email',
      account_id: r.account_id,
      title: `Unreplied: ${safe(r.from_name) || safe(r.from_email) || 'Contact'}`,
      body: `${safe(r.subject) || '(no subject)'} — last message ${daysAgo(r.last_message_ts)} day(s) ago.`,
      severity: 'info',
      is_read: false,
      primary_cta: { action: 'open_thread', label: 'Open email', threadId: r.thread_id, accountId },
      tags: ['unreplied','email'],
      source_event_id: `email:unreplied:${accountId}:${r.thread_id}`,
    }));

  await insertInsightsDedup(items);
  return items;
}

/* ============================================================================
   6) Aging unread — keep your existing logic
============================================================================ */
export async function genEmailUnreadAging({ userId, accountId, minAgeDays = 3, max = 20 }) {
  if (!userId || !accountId) return [];
  const rows = await fetchUnread({ userId, accountId });
  const items = rows
    .filter(r => daysAgo(r.last_message_ts) >= minAgeDays)
    .slice(0, max)
    .map(r => ({
      user_id: userId,
      module: 'email',
      account_id: r.account_id,
      title: `Aging unread: ${safe(r.from_name) || safe(r.from_email) || 'Contact'}`,
      body: `${safe(r.subject) || '(no subject)'} — unread for ${daysAgo(r.last_message_ts)} day(s).`,
      severity: 'info',
      is_read: false,
      primary_cta: { action: 'open_thread', label: 'Open email', threadId: r.thread_id, accountId },
      tags: ['unread','email'],
      source_event_id: `email:aging_unread:${accountId}:${r.thread_id}`,
    }));
  await insertInsightsDedup(items);
  return items;
}

/* ============================================================================
   7) Daily digest — keep your existing logic
============================================================================ */
export async function genEmailDailyDigest({ userId, accountId }) {
  if (!userId || !accountId) return [];
  const startToday = new Date(); startToday.setHours(0,0,0,0);
  const startIso = startToday.toISOString();

  const { data, error } = await supabase
    .from('email_threads_cache')
    .select('thread_id,subject,from_name,from_email,last_message_ts,unread,account_id')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .gte('last_message_ts', startIso)
    .order('last_message_ts', { ascending: false })
    .limit(200);
  if (error || !data) return [];

  const total = data.length;
  const unread = data.filter(x => x.unread).length;
  const preview = data.slice(0, 3).map(x => safe(x.subject) || '(no subject)').join(' • ');

  const row = {
    user_id: userId,
    module: 'email',
    account_id: accountId,
    title: `New emails today: ${total} (${unread} unread)`,
    body: preview ? `Latest: ${preview}` : 'No new messages yet.',
    severity: 'info',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open inbox', route: '/dashboard/email' },
    tags: ['digest','email'],
    source_event_id: `email:digest:${accountId}:${startIso.slice(0,10)}`,
  };

  await insertInsightsDedup([row]);
  return [row];
}
