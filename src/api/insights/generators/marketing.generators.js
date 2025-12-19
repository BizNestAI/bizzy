// src/api/gpt/insights/generators/marketing.generators.js
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
    } catch { /* ignore per-row errors */ }
  }
  return out;
}

const safe = (s) => (s || '').toString().trim();
const pct  = (v) => `${(Number(v || 0)).toFixed(1)}%`;
const timeStr = (iso) => new Date(iso).toLocaleString();

/* ============================================================================
   1) New reviews (existing behavior, slightly clearer copy)
   Tables: reviews (id, user_id, author, rating, created_at, platform, responded?)
============================================================================ */
export async function genNewReviews({ userId, windowDays = 2 }) {
  if (!userId) return [];
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();

  const { data, error } = await supabase
    .from('reviews')
    .select('id,author,rating,created_at,platform')
    .eq('user_id', userId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error || !data) return [];

  const rows = data.map(r => ({
    user_id: userId,
    module: 'marketing',
    title: `New ${r.platform || 'review'}: ${r.rating}/5`,
    body: `From ${safe(r.author) || 'customer'} — ${timeStr(r.created_at)}`,
    severity: r.rating < 4 ? 'info' : 'info',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open Reviews', route: '/dashboard/marketing' },
    tags: ['reviews','new'],
    source_event_id: `mkt:review:new:${r.id}`,
  }));

  await insertInsightsDedup(rows);
  return rows;
}

/* ============================================================================
   2) Low-rated reviews (action needed)
   Tables: reviews (rating <= threshold)
============================================================================ */
export async function genLowRatedReviews({ userId, windowDays = 14, max = 10, threshold = 3 }) {
  if (!userId) return [];
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();

  const { data, error } = await supabase
    .from('reviews')
    .select('id,author,rating,created_at,platform')
    .eq('user_id', userId)
    .lte('rating', threshold)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error || !data) return [];

  const rows = data.slice(0, max).map(r => ({
    user_id: userId,
    module: 'marketing',
    title: `Respond to ${r.rating}/5 ${r.platform || 'review'}`,
    body: `From ${safe(r.author) || 'customer'} — ${timeStr(r.created_at)}`,
    severity: 'warn',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Reply now', route: '/dashboard/marketing' },
    tags: ['reviews','response_needed'],
    source_event_id: `mkt:review:low:${r.id}`,
  }));

  await insertInsightsDedup(rows);
  return rows;
}

/* ============================================================================
   3) Unresponded reviews (older than N days)
   Tables: reviews (responded boolean or responded_at null)
============================================================================ */
export async function genUnrespondedReviews({ userId, olderThanDays = 5, max = 10 }) {
  if (!userId) return [];
  const before = new Date(Date.now() - olderThanDays * 86400000).toISOString();

  const { data, error } = await supabase
    .from('reviews')
    .select('id,author,created_at,platform,responded,responded_at')
    .eq('user_id', userId)
    .lte('created_at', before)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error || !data) return [];

  const unresp = data
    .filter(r => !(r.responded || r.responded_at)) // not responded
    .slice(0, max)
    .map(r => ({
      user_id: userId,
      module: 'marketing',
      title: `Unresponded ${r.platform || 'review'}`,
      body: `From ${safe(r.author) || 'customer'} — ${timeStr(r.created_at)}`,
      severity: 'warn',
      is_read: false,
      primary_cta: { action: 'open_route', label: 'Reply now', route: '/dashboard/marketing' },
      tags: ['reviews','unresponded'],
      source_event_id: `mkt:review:unresponded:${r.id}`,
    }));

  await insertInsightsDedup(unresp);
  return unresp;
}

/* ============================================================================
   4) Review volume trend (7d vs 30d average)
   Tables: review_stats_daily (date, count_total, platform?)
============================================================================ */
export async function genReviewVolumeTrend({ userId, warnDropPct = 30 }) {
  if (!userId) return [];

  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();

  const { data, error } = await supabase
    .from('review_stats_daily')
    .select('date,count_total') // adjust if your column is named differently
    .eq('user_id', userId)
    .gte('date', since30)
    .order('date', { ascending: false });

  if (error || !data || data.length < 7) return [];

  const last7 = data.slice(0, 7).reduce((a, b) => a + Number(b.count_total || 0), 0) / 7;
  const last30 = data.reduce((a, b) => a + Number(b.count_total || 0), 0) / data.length;

  if (last30 <= 0) return [];
  const drop = ((last30 - last7) / last30) * 100;
  if (drop < warnDropPct) return [];

  const row = {
    user_id: userId,
    module: 'marketing',
    title: `Review volume down ${drop.toFixed(0)}% (7d vs 30d)`,
    body: `Avg last 7d: ${last7.toFixed(1)}, last 30d: ${last30.toFixed(1)}. Consider sending more review requests.`,
    severity: 'warn',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open Reviews', route: '/dashboard/marketing' },
    tags: ['reviews','volume'],
    source_event_id: `mkt:review:trend:${new Date().toISOString().slice(0,10)}`,
  };

  await insertInsightsDedup([row]);
  return [row];
}

/* ============================================================================
   5) Review request conversion (requests → received)
   Tables: review_requests (id, created_at), reviews (created_at)
============================================================================ */
export async function genReviewRequestConversion({ userId, windowDays = 30, warnBelowPct = 8 }) {
  if (!userId) return [];
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();

  const [{ data: reqs }, { data: recs }] = await Promise.all([
    supabase.from('review_requests').select('id,created_at').eq('user_id', userId).gte('created_at', since),
    supabase.from('reviews').select('id,created_at').eq('user_id', userId).gte('created_at', since),
  ]);

  const reqCount = (reqs || []).length;
  const recCount = (recs || []).length;
  if (reqCount <= 0) return [];

  const conv = (recCount / reqCount) * 100;
  if (conv >= warnBelowPct) return [];

  const row = {
    user_id: userId,
    module: 'marketing',
    title: `Review conversion low: ${pct(conv)}`,
    body: `${recCount} received / ${reqCount} requests last ${windowDays}d. Try a second ask or an incentive.`,
    severity: 'warn',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open Reviews', route: '/dashboard/marketing' },
    tags: ['reviews','conversion'],
    source_event_id: `mkt:review:conversion:${windowDays}d:${new Date().toISOString().slice(0,10)}`,
  };

  await insertInsightsDedup([row]);
  return [row];
}

/* ============================================================================
   6) Platform mix shift (share change among sources)
   Tables: review_sources (platform, count, period or date)
============================================================================ */
export async function genPlatformMixShift({ userId, windowPeriods = 6, warnChangePctPt = 10 }) {
  if (!userId) return [];
  // Expect either daily/weekly/monthly periods; latest N periods
  const { data, error } = await supabase
    .from('review_sources')
    .select('period,platform,count')   // adjust column names if needed
    .eq('user_id', userId)
    .order('period', { ascending: false })
    .limit(windowPeriods * 10);

  if (error || !data) return [];

  // Determine latest period and previous average shares by platform
  const periods = [...new Set(data.map(r => r.period))].sort().reverse();
  if (periods.length < 2) return [];

  const latest = periods[0];
  const prev = periods.slice(1, Math.min(windowPeriods, periods.length));

  const byPlat = new Map();
  const share = (arr, p) => {
    const tot = arr.filter(r => r.period === p).reduce((a, b) => a + Number(b.count || 0), 0);
    const out = new Map();
    if (tot === 0) return out;
    for (const r of arr.filter(r => r.period === p)) {
      const k = r.platform || 'other';
      out.set(k, (Number(r.count || 0) / tot) * 100);
    }
    return out;
  };

  const latestShare = share(data, latest);
  const prevAvg = new Map();
  for (const plat of new Set(data.map(r => r.platform))) {
    const vals = [];
    for (const p of prev) {
      const total = data.filter(r => r.period === p).reduce((a, b) => a + Number(b.count || 0), 0);
      if (!total) continue;
      const c = data.filter(r => r.period === p && r.platform === plat).reduce((a, b) => a + Number(b.count || 0), 0);
      vals.push((c / total) * 100);
    }
    if (vals.length) prevAvg.set(plat, vals.reduce((a,b)=>a+b,0)/vals.length);
  }

  const rows = [];
  for (const [plat, curShare] of latestShare.entries()) {
    const avg = prevAvg.get(plat) ?? 0;
    const delta = curShare - avg;
    if (Math.abs(delta) >= warnChangePctPt) {
      rows.push({
        user_id: userId,
        module: 'marketing',
        title: `${plat} share ${delta > 0 ? 'up' : 'down'} ${delta.toFixed(1)} pts`,
        body: `Latest: ${curShare.toFixed(1)}% vs prior avg ${avg.toFixed(1)}%`,
        severity: 'info',
        is_read: false,
        primary_cta: { action: 'open_route', label: 'Open Reviews', route: '/dashboard/marketing' },
        tags: ['reviews','platform_mix', plat],
        source_event_id: `mkt:review:mix:${latest}:${plat}`,
      });
    }
  }

  await insertInsightsDedup(rows);
  return rows;
}

/* ============================================================================
   7) Content cadence gap (no published posts in N days)
   Tables: published_posts (id, published_at, channel, title)
============================================================================ */
export async function genContentCadenceGap({ userId, gapDays = 14 }) {
  if (!userId) return [];
  const since = new Date(Date.now() - gapDays * 86400000).toISOString();

  const { data, error } = await supabase
    .from('published_posts')
    .select('id,published_at,channel,title')
    .eq('user_id', userId)
    .gte('published_at', since)
    .order('published_at', { ascending: false })
    .limit(1);

  if (error) return [];
  // If there is at least one published post in the window, do nothing
  if (data && data.length) return [];

  // Otherwise, get the last published post date to show how long it's been
  const { data: last } = await supabase
    .from('published_posts')
    .select('published_at')
    .eq('user_id', userId)
    .order('published_at', { ascending: false })
    .limit(1);

  const lastDate = last && last.length ? new Date(last[0].published_at).toLocaleDateString() : 'a while';

  const row = {
    user_id: userId,
    module: 'marketing',
    title: `No posts in ${gapDays} days`,
    body: `Last post: ${lastDate}. Keep cadence to stay top-of-mind.`,
    severity: 'info',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Plan a post', route: '/dashboard/marketing' },
    tags: ['content','cadence'],
    source_event_id: `mkt:content_gap:${gapDays}:${new Date().toISOString().slice(0,10)}`,
  };
  await insertInsightsDedup([row]);
  return [row];
}

/* ============================================================================
   8) Social post underperformers (engagement far below median)
   Tables: social_post_metrics (id, post_id, channel, created_at, impressions, clicks, reactions, comments, shares)
============================================================================ */
export async function genSocialUnderperformers({ userId, windowDays = 14, zThresh = -1.2, max = 5 }) {
  if (!userId) return [];
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();

  const { data, error } = await supabase
    .from('social_post_metrics')
    .select('id,post_id,channel,created_at,impressions,clicks,reactions,comments,shares')
    .eq('user_id', userId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error || !data || data.length < 8) return [];

  // Define engagement as (reactions + comments + shares + clicks*0.5) per 1k impressions
  const rows = data.map(r => {
    const eng = Number(r.reactions || 0) + Number(r.comments || 0) + Number(r.shares || 0) + 0.5 * Number(r.clicks || 0);
    const perK = Number(r.impressions || 0) > 0 ? (eng / (r.impressions / 1000)) : 0;
    return { ...r, engPerK: perK };
  });

  const mean = rows.reduce((a, b) => a + b.engPerK, 0) / rows.length;
  const sd = Math.sqrt(rows.reduce((a, b) => a + Math.pow(b.engPerK - mean, 2), 0) / rows.length);

  if (!isFinite(sd) || sd === 0) return [];

  const under = rows
    .map(r => ({ ...r, z: (r.engPerK - mean) / sd }))
    .filter(r => r.z <= zThresh)
    .slice(0, max)
    .map(r => ({
      user_id: userId,
      module: 'marketing',
      title: `Underperforming ${r.channel || 'post'}`,
      body: `Low engagement (${r.engPerK.toFixed(1)}/1k). Try new hook or creative.`,
      severity: 'info',
      is_read: false,
      primary_cta: { action: 'open_route', label: 'Review social', route: '/dashboard/marketing' },
      tags: ['social','underperformer', r.channel || ''],
      source_event_id: `mkt:social:under:${r.id}`,
    }));

  await insertInsightsDedup(under);
  return under;
}

/* ============================================================================
   Aggregator
============================================================================ */
export async function generateMarketingInsights(opts) {
  const { userId } = opts || {};
  const batches = await Promise.allSettled([
    genNewReviews({ userId, windowDays: 2 }),
    genLowRatedReviews({ userId, windowDays: 14, threshold: 3 }),
    genUnrespondedReviews({ userId, olderThanDays: 5 }),
    genReviewVolumeTrend({ userId, warnDropPct: 30 }),
    genReviewRequestConversion({ userId, windowDays: 30, warnBelowPct: 8 }),
    genPlatformMixShift({ userId, windowPeriods: 6, warnChangePctPt: 10 }),
    genContentCadenceGap({ userId, gapDays: 14 }),
    genSocialUnderperformers({ userId, windowDays: 14, zThresh: -1.2 }),
  ]);

  const total = batches
    .map(p => (p.status === 'fulfilled' ? (p.value?.length || 0) : 0))
    .reduce((a, b) => a + b, 0);

  return { ok: true, inserted: total };
}
