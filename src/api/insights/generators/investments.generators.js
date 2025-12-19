// src/api/gpt/insights/generators/investments.generators.js
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

      const { data, error } = await supabase
        .from('insights')
        .insert(r)
        .select('id')
        .single();

      if (!error && data) out.push(data.id);
    } catch { /* ignore per-row error */ }
  }
  return out;
}

const fmtMoney = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const pct = (v) => `${(Number(v || 0)).toFixed(1)}%`;
const safe = (s) => (s || '').toString().trim();

/* ============================================================================
   1) PORTFOLIO CHANGE (latest vs prior)
   Table: investment_balances_history (as_of, total_value)
============================================================================ */
export async function genPortfolioChange({ userId, pctThresh = 3 }) {
  if (!userId) return [];
  const { data, error } = await supabase
    .from('investment_balances_history')
    .select('as_of,total_value')
    .eq('user_id', userId)
    .order('as_of', { ascending: false })
    .limit(2);
  if (error || !data || data.length < 2) return [];
  const [latest, prev] = data;
  const last = Number(latest.total_value || 0);
  const prior = Number(prev.total_value || 0);
  if (!prior) return [];
  const change = ((last - prior) / prior) * 100;
  if (Math.abs(change) < pctThresh) return [];

  const row = {
    user_id: userId,
    module: 'investments',
    title: `Portfolio ${change > 0 ? 'up' : 'down'} ${Math.abs(change).toFixed(1)}%`,
    body: `From ${new Date(prev.as_of).toLocaleDateString()} to ${new Date(latest.as_of).toLocaleDateString()}.`,
    severity: Math.abs(change) >= 5 ? 'warn' : 'info',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open Investments', route: '/dashboard/investments' },
    tags: ['investments','performance'],
    source_event_id: `inv:change:${latest.as_of}`,
  };
  await insertInsightsDedup([row]);
  return [row];
}

/* ============================================================================
   2) CONCENTRATION RISK
   Table: positions_view (user_id, symbol, name, weight_pct, asset_class, security_id)
============================================================================ */
export async function genConcentrationRisk({ userId, weightPct = 25, max = 3 }) {
  if (!userId) return [];
  const { data, error } = await supabase
    .from('positions_view')
    .select('symbol,name,weight_pct,security_id') // adjust field names if needed
    .eq('user_id', userId)
    .order('weight_pct', { ascending: false })
    .limit(50);
  if (error || !data) return [];

  const risky = (data || []).filter(p => Number(p.weight_pct || 0) >= weightPct).slice(0, max);

  const rows = risky.map(p => ({
    user_id: userId,
    module: 'investments',
    title: `Concentration risk: ${safe(p.symbol) || safe(p.name)}`,
    body: `Position is ${pct(p.weight_pct)} of portfolio.`,
    severity: 'warn',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Review holdings', route: '/dashboard/investments' },
    tags: ['investments','concentration', p.symbol || ''],
    source_event_id: `inv:concentration:${p.security_id || p.symbol || p.name}`,
  }));

  await insertInsightsDedup(rows);
  return rows;
}

/* ============================================================================
   3) HIGH CASH DRAG
   Table: positions_view (asset_class or classify cash)
   Heuristic: sum of cash-like positions weight_pct > threshold
============================================================================ */
export async function genHighCashDrag({ userId, cashThreshPct = 10 }) {
  if (!userId) return [];
  const { data, error } = await supabase
    .from('positions_view')
    .select('symbol,name,weight_pct,asset_class') // asset_class may be 'cash'
    .eq('user_id', userId)
    .limit(200);
  if (error || !data) return [];

  const isCash = (row) => {
    const ac = (row.asset_class || '').toLowerCase();
    const sym = (row.symbol || '').toUpperCase();
    const nm = (row.name || '').toLowerCase();
    return ac.includes('cash') || ['CASH','USD'].includes(sym) || nm.includes('cash') || nm.includes('money market');
  };

  const cashPct = (data || []).filter(isCash).reduce((a, b) => a + Number(b.weight_pct || 0), 0);
  if (cashPct < cashThreshPct) return [];

  const row = {
    user_id: userId,
    module: 'investments',
    title: `High cash drag: ${pct(cashPct)} in cash`,
    body: `Consider deploying excess cash to your target allocation.`,
    severity: 'info',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Review allocation', route: '/dashboard/investments' },
    tags: ['investments','cash'],
    source_event_id: `inv:cash_drag:${new Date().toISOString().slice(0,10)}`,
  };
  await insertInsightsDedup([row]);
  return [row];
}

/* ============================================================================
   4) UNDERPERFORMING HOLDINGS (30d)
   Tables:
     - positions_view (security_id, weight_pct, symbol)
     - prices_cache   (security_id, return_30d_pct, as_of)  // if missing, generator returns []
============================================================================ */
export async function genUnderperformers30d({ userId, zThresh = -1.0, minWeightPct = 2, max = 5 }) {
  if (!userId) return [];
  const { data: pos, error: e1 } = await supabase
    .from('positions_view')
    .select('security_id,symbol,name,weight_pct')
    .eq('user_id', userId)
    .limit(200);
  if (e1 || !pos || !pos.length) return [];

  // Only consider meaningful weights
  const candidates = pos.filter(p => Number(p.weight_pct || 0) >= minWeightPct && p.security_id);

  // Pull 30d return from prices_cache for these securities
  const ids = candidates.map(p => p.security_id);
  const { data: px, error: e2 } = await supabase
    .from('prices_cache')
    .select('security_id,return_30d_pct,as_of') // adjust if your column differs
    .in('security_id', ids);
  if (e2 || !px || !px.length) return [];

  const mapRet = new Map(px.map(r => [r.security_id, Number(r.return_30d_pct || 0)]));
  const scored = candidates
    .map(p => ({ ...p, r30: mapRet.get(p.security_id) }))
    .filter(p => typeof p.r30 === 'number');

  if (scored.length < 6) return []; // need enough to compute a reasonable distribution

  const mean = scored.reduce((a, b) => a + b.r30, 0) / scored.length;
  const sd = Math.sqrt(scored.reduce((a, b) => a + Math.pow(b.r30 - mean, 2), 0) / scored.length);
  if (!isFinite(sd) || sd === 0) return [];

  const under = scored
    .map(p => ({ ...p, z: (p.r30 - mean) / sd }))
    .filter(p => p.z <= zThresh)
    .sort((a, b) => a.z - b.z)
    .slice(0, max);

  const rows = under.map(p => ({
    user_id: userId,
    module: 'investments',
    title: `Underperformer: ${safe(p.symbol) || safe(p.name)}`,
    body: `30d return ${pct(p.r30)} (weighted ${pct(p.weight_pct)}). Consider trimming.`,
    severity: 'info',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Review holdings', route: '/dashboard/investments' },
    tags: ['investments','underperformer', p.symbol || ''],
    source_event_id: `inv:under30d:${p.security_id}`,
  }));

  await insertInsightsDedup(rows);
  return rows;
}

/* ============================================================================
   5) NO CONTRIBUTION THIS MONTH
   Tables:
     - investment_contributions_monthly (period 'YYYY-MM', amount)
     - investment_contributions_ytd (amount_ytd?) optional
============================================================================ */
export async function genNoContributionThisMonth({ userId }) {
  if (!userId) return [];
  // Pull last 4 months to compute cadence
  const { data, error } = await supabase
    .from('investment_contributions_monthly')
    .select('period,amount')
    .eq('user_id', userId)
    .order('period', { ascending: false })
    .limit(4);
  if (error || !data || !data.length) return [];

  const [cur, ...prev] = data;
  const prevAvg = prev.length ? prev.reduce((a, b) => a + Number(b.amount || 0), 0) / prev.length : 0;
  const curAmt = Number(cur.amount || 0);

  if (curAmt > 0 || prevAvg <= 0) return [];

  const row = {
    user_id: userId,
    module: 'investments',
    title: `No contribution recorded this month`,
    body: `You averaged ${fmtMoney(prevAvg)} in the prior ${prev.length} month(s). Consider making this month’s contribution.`,
    severity: 'info',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open Investments', route: '/dashboard/investments' },
    tags: ['investments','contributions'],
    source_event_id: `inv:no_contrib:${cur.period}`,
  };
  await insertInsightsDedup([row]);
  return [row];
}

/* ============================================================================
   6) PENDING WEALTH MOVES (nudges)
   Table: wealth_moves_history (id, move_title, status)
============================================================================ */
export async function genPendingWealthMoves({ userId, max = 5 }) {
  if (!userId) return [];
  const { data, error } = await supabase
    .from('wealth_moves_history')
    .select('id,move_title,status,created_at')
    .eq('user_id', userId)
    .in('status', ['recommended','queued'])  // adjust to your statuses
    .order('created_at', { ascending: false })
    .limit(20);
  if (error || !data) return [];
  const rows = (data || []).slice(0, max).map(m => ({
    user_id: userId,
    module: 'investments',
    title: `Review planned move: ${safe(m.move_title)}`,
    body: `Queued recommendation — review & apply.`,
    severity: 'info',
    is_read: false,
    primary_cta: { action: 'open_route', label: 'Open Wealth Moves', route: '/dashboard/investments' },
    tags: ['investments','moves'],
    source_event_id: `inv:move:${m.id}`,
  }));
  await insertInsightsDedup(rows);
  return rows;
}

/* ============================================================================
   Aggregator
============================================================================ */
export async function generateInvestmentsInsights(opts) {
  const { userId } = opts || {};
  const batches = await Promise.allSettled([
    genPortfolioChange({ userId, pctThresh: 3 }),
    genConcentrationRisk({ userId, weightPct: 25 }),
    genHighCashDrag({ userId, cashThreshPct: 10 }),
    genUnderperformers30d({ userId, zThresh: -1.0, minWeightPct: 2 }),
    genNoContributionThisMonth({ userId }),
    genPendingWealthMoves({ userId }),
  ]);

  const total = batches
    .map(p => (p.status === 'fulfilled' ? (p.value?.length || 0) : 0))
    .reduce((a, b) => a + b, 0);

  return { ok: true, inserted: total };
}
