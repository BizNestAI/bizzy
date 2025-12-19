// ============================================================================
// File: /src/api/investments/wealthPulse.service.js
// Prompt #7 – Monthly Wealth Pulse Summary Generator (backend service)
// - Aggregates metrics across modules
// - Deterministic rulebook builds a baseline narrative first
// - GPT (if available) refines/edits baseline (never contradicts hard facts)
// - Upserts one row per user/month into monthly_wealth_pulse
// - CTAs are objects: { text, kind, due_at?, route?, params? }
// - Cron helpers to auto-generate on the 1st of every month
// ============================================================================

import { supabase } from '../../services/supabaseAdmin.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GPT_MODEL = process.env.WEALTH_PULSE_MODEL || 'gpt-4o-mini';
const USE_MOCKS = process.env.MOCK_INVESTMENTS === 'true'; // <— NEW

// ----------------------------------------------------------------------------
// Public API (NAMED EXPORTS)
// ----------------------------------------------------------------------------

export async function getWealthPulse(user_id, { year, month, force = false } = {}) {
  if (!user_id) throw new Error('missing_user_id');

  const { Y, M, monthYM, startISO, endISO } = resolveMonth(year, month);

  // 1) cached
  if (!force) {
    const cached = await readPulse(user_id, monthYM);
    if (cached) return cached;
  }

  // 2) metrics (with graceful fallbacks)
  const [
    netWorthBlock,    // { nowUsd, prevUsd, method, hadData }
    accountPerf,      // { topMovers, contribMethod, hadData }
    contribMonth,
    trajectoryBlock,  // null if no data
    wealthMovesBlock,
  ] = await Promise.all([
    getNetWorthBlock(user_id, startISO, endISO),
    getAccountPerformance(user_id, startISO, endISO),
    getContributionsForMonth(user_id, Y, M),
    getTrajectoryBlock(user_id, endISO),
    getWealthMovesBlock(user_id, monthYM),
  ]);

  // NEW: mock or early fallback if we truly have no synced data
  const noSyncedData =
    !netWorthBlock?.hadData &&
    !trajectoryBlock &&
    (!accountPerf?.hadData || !(accountPerf?.topMovers?.length)) &&
    (contribMonth == null || contribMonth === 0);

  if (USE_MOCKS || noSyncedData) {
    return buildMockPulse({ user_id, Y, M, monthYM });
  }

  const metrics = {
    month_ym: monthYM,
    net_worth_now: netWorthBlock?.nowUsd ?? 0,
    net_worth_prev: netWorthBlock?.prevUsd ?? 0,
    net_worth_change_usd:
      (netWorthBlock?.nowUsd ?? 0) - (netWorthBlock?.prevUsd ?? 0),
    net_worth_change_pct: pctChange(
      netWorthBlock?.prevUsd ?? 0,
      netWorthBlock?.nowUsd ?? 0
    ),
    contribution_total_month: contribMonth ?? 0,
    retirement_status: trajectoryBlock?.status || 'unknown',
    retirement_probability:
      trajectoryBlock?.probability_of_success ?? null,
    retirement_change_prob_pp:
      trajectoryBlock?.prob_change_pp ?? null,
    top_account_movers: accountPerf?.topMovers || [],
    notes: {
      nw_method: netWorthBlock?.method,
      contrib_method: accountPerf?.contribMethod || 'ytd_delta_or_zero',
      wealth_moves: wealthMovesBlock || {},
    },
  };

  // 3) Deterministic baseline
  const baseline = rulebookNarrative(metrics, { Y, M });

  // 4) Optional GPT refinement
  const narrative = OPENAI_API_KEY
    ? await refineWithGPT(metrics, baseline, { Y, M })
    : baseline;

  // 5) payload + upsert
  const payload = {
    month_ym: monthYM,
    user_id,
    headline: narrative.headline,
    observations: narrative.observations,
    motivation: narrative.motivation,
    ctas: normalizeCTAs(narrative.ctas, { Y, M }),
    metrics,
    generated_at: new Date().toISOString(),
  };

  await upsertPulse(payload);
  return payload;
}

export async function refreshWealthPulse(user_id, opts) {
  return getWealthPulse(user_id, { ...(opts || {}), force: true });
}

/**
 * CRON: run for all active users for a target month (defaults to current UTC).
 * "Active users" are inferred from any of these tables; adjust as needed.
 */
export async function runWealthPulseCronForAllUsers({ year, month } = {}) {
  const { Y, M } = resolveMonth(year, month);
  const userIds = await getActiveUserIds();

  const results = [];
  for (const uid of userIds) {
    try {
      await getWealthPulse(uid, { year: Y, month: M, force: true });
      results.push({ user_id: uid, ok: true });
    } catch (e) {
      console.warn('[wealth-pulse/cron] user failed', uid, e.message);
      results.push({ user_id: uid, ok: false, error: e.message });
    }
  }
  return { Y, M, count: userIds.length, results };
}

/**
 * Convenience: Call this from your scheduler daily. It will ONLY run on the 1st (UTC).
 */
export async function runMonthlyJobIfFirstOfMonth() {
  const now = new Date();
  if (now.getUTCDate() !== 1) {
    return { ran: false, reason: 'not_first_of_month' };
  }
  const { Y, M } = resolveMonth();
  const out = await runWealthPulseCronForAllUsers({ year: Y, month: M });
  return { ran: true, ...out };
}

// ----------------------------------------------------------------------------
// Aggregation helpers
// ----------------------------------------------------------------------------

// CHANGED: now returns hadData flag
async function getNetWorthBlock(user_id, startISO, endISO) {
  const { data: hist } = await supabase
    .from('investment_balances_history')
    .select('balance_usd, as_of')
    .eq('user_id', user_id)
    .gte('as_of', startISO)
    .lte('as_of', endISO)
    .order('as_of', { ascending: false });

  let hadData = Array.isArray(hist) && hist.length > 0;
  let nowUsd = null;
  if (hadData) {
    nowUsd = sum(hist, (r) => Number(r.balance_usd || 0));
  }

  const prevStart = addMonthsISO(startISO, -1);
  const prevEnd = addMonthsISO(endISO, -1);
  const { data: prevHist } = await supabase
    .from('investment_balances_history')
    .select('balance_usd, as_of')
    .eq('user_id', user_id)
    .gte('as_of', prevStart)
    .lte('as_of', prevEnd)
    .order('as_of', { ascending: false });

  let prevUsd = null;
  if (Array.isArray(prevHist) && prevHist.length) {
    hadData = true;
    prevUsd = sum(prevHist, (r) => Number(r.balance_usd || 0));
  }

  if (nowUsd == null || prevUsd == null) {
    const { data: latest } = await supabase
      .from('investment_balances_latest')
      .select('balance_usd')
      .eq('user_id', user_id);
    if (Array.isArray(latest) && latest.length) {
      hadData = true;
      const total = sum(latest, (r) => Number(r.balance_usd || 0));
      if (nowUsd == null) nowUsd = total;
      if (prevUsd == null) prevUsd = total;
    }
  }

  return {
    nowUsd: nowUsd ?? 0,
    prevUsd: prevUsd ?? 0,
    method: 'history_fallback_latest',
    hadData,
  };
}

// CHANGED: now returns hadData flag
async function getAccountPerformance(user_id, startISO, endISO) {
  const fields = 'account_id, account_name, institution, balance_usd, as_of';
  const { data: nowRows } = await supabase
    .from('investment_balances_history')
    .select(fields)
    .eq('user_id', user_id)
    .gte('as_of', startISO)
    .lte('as_of', endISO)
    .order('as_of', { ascending: false });

  const { data: prevRows } = await supabase
    .from('investment_balances_history')
    .select(fields)
    .eq('user_id', user_id)
    .gte(addMonthsISO(startISO, -1))
    .lte(addMonthsISO(endISO, -1))
    .order('as_of', { ascending: false });

  const latestByAcct = newestByKey(nowRows || [], 'account_id');
  const prevByAcct = newestByKey(prevRows || [], 'account_id');

  let hadData = (nowRows && nowRows.length) || (prevRows && prevRows.length);

  const movers = [];
  for (const [account_id, now] of latestByAcct.entries()) {
    const prev = prevByAcct.get(account_id);
    const nowUsd = Number(now.balance_usd || 0);
    const prevUsd = Number(prev?.balance_usd || 0);
    const delta = nowUsd - prevUsd;
    const pct = pctChange(prevUsd, nowUsd);
    movers.push({
      account: `${now.institution || ''} ${now.account_name || ''}`.trim(),
      change_usd: Math.round(delta),
      change_pct: pct,
    });
  }
  movers.sort((a, b) => Math.abs(b.change_usd) - Math.abs(a.change_usd));

  return {
    topMovers: movers.slice(0, 3),
    contribMethod: 'balances_history_delta',
    hadData: !!hadData,
  };
}

async function getContributionsForMonth(user_id, year, month) {
  const ym = `${year}-${String(month).padStart(2, '0')}`;

  try {
    const { data } = await supabase
      .from('investment_contributions_monthly')
      .select('amount')
      .eq('user_id', user_id)
      .eq('month_ym', ym)
      .maybeSingle();
    if (data) return Number(data.amount || 0);
  } catch {}

  try {
    const { data: cur } = await supabase
      .from('contribution_limits_history')
      .select('contributed_ytd')
      .eq('user_id', user_id)
      .eq('year', year)
      .eq('month', month)
      .maybeSingle();

    const { data: prev } = await supabase
      .from('contribution_limits_history')
      .select('contributed_ytd')
      .eq('user_id', user_id)
      .eq('year', month === 1 ? year - 1 : year)
      .eq('month', month === 1 ? 12 : month - 1)
      .maybeSingle();

    if (cur) {
      const delta =
        Number(cur.contributed_ytd || 0) -
        Number(prev?.contributed_ytd || 0);
      if (!Number.isNaN(delta)) return Math.max(0, delta);
    }
  } catch {}

  return 0;
}

async function getTrajectoryBlock(user_id, endISO) {
  const { data: rows } = await supabase
    .from('retirement_projection_history')
    .select('status, probability_of_success, projected_balance, as_of')
    .eq('user_id', user_id)
    .lte('as_of', endISO)
    .order('as_of', { ascending: false })
    .limit(2);

  if (!rows || !rows.length) return null;

  const cur = rows[0];
  const prev = rows[1];
  const prob_change_pp =
    cur?.probability_of_success != null &&
    prev?.probability_of_success != null
      ? Math.round(
          (cur.probability_of_success - prev.probability_of_success) * 100
        )
      : null;

  return {
    status: cur?.status || 'unknown',
    probability_of_success: cur?.probability_of_success ?? null,
    projected_balance: Number(cur?.projected_balance || 0),
    prob_change_pp,
  };
}

async function getWealthMovesBlock(user_id, month_ym) {
  const { data, error } = await supabase
    .from('wealth_moves_history')
    .select('moves_json')
    .eq('user_id', user_id)
    .eq('month_ym', month_ym)
    .maybeSingle();

  if (error || !data?.moves_json) {
    return { suggested: 0, applied: 0, dismissed: 0, titles: [] };
  }

  const moves = Array.isArray(data.moves_json?.moves) ? data.moves_json.moves : [];
  return {
    suggested: moves.length,
    applied: 0,
    dismissed: 0,
    titles: moves.map((m) => m.move_title).filter(Boolean),
  };
}

// ----------------------------------------------------------------------------
// Deterministic rulebook (pre-GPT)
// ----------------------------------------------------------------------------

function rulebookNarrative(m, { Y, M }) {
  const up = m.net_worth_change_usd >= 0;
  const pct = isFinite(m.net_worth_change_pct)
    ? m.net_worth_change_pct.toFixed(1)
    : '0.0';
  const usdAbs = fmtUSD(Math.abs(m.net_worth_change_usd));

  const headline = up
    ? `Your net worth grew by ${pct}% (+${fmtUSD(m.net_worth_change_usd)}) this month.`
    : `Your net worth slipped by ${pct}% (-${usdAbs}) this month.`;

  const observations = [];

  if (m.contribution_total_month > 0) {
    observations.push({
      text: `You contributed ${fmtUSD(m.contribution_total_month)} this month — strong consistency.`,
      category: 'Contributions',
    });
  } else {
    observations.push({
      text: 'No contributions detected this month — consider a small auto-transfer to stay on pace.',
      category: 'Contributions',
    });
  }

  if (m.retirement_status === 'shortfall' || m.retirement_status === 'at_risk') {
    observations.push({
      text: `Retirement outlook is ${pretty(m.retirement_status)} — nudging monthly contributions can improve your odds.`,
      category: 'Growth',
    });
  } else if (m.retirement_status === 'surplus') {
    observations.push({
      text: 'Retirement trajectory is in surplus — you’re outpacing your target.',
      category: 'Growth',
    });
  }

  if (m.top_account_movers?.length) {
    const top = m.top_account_movers[0];
    observations.push({
      text: `${top.account} moved ${top.change_usd >= 0 ? '+' : '-'}${fmtUSD(Math.abs(top.change_usd))} (${(top.change_pct || 0).toFixed(1)}%).`,
      category: 'Growth',
    });
  }

  const motivation = up
    ? 'Future You is giving you a fist bump right now 🚀'
    : 'Tough month happens — consistency is compounding. Keep feeding the machine.';

  const ctas = [];

  if (m.retirement_status === 'shortfall' || m.retirement_status === 'at_risk') {
    ctas.push({
      text: 'Model +$250/mo in the Retirement Simulator',
      kind: 'simulator',
      route: '/investments/retirement',
      params: { delta_monthly: 250 },
    });
  }

  ctas.push({
    text: 'Add a reminder to max out your HSA before year-end',
    kind: 'calendar',
    due_at: `${Y}-12-31`,
  });

  ctas.push({
    text: 'Review contribution limits and remaining room',
    kind: 'link',
    route: '/investments/contributions',
  });

  return {
    headline,
    observations: observations.slice(0, 3),
    motivation,
    ctas: normalizeCTAs(ctas, { Y, M }).slice(0, 3),
  };
}

// ----------------------------------------------------------------------------
// GPT refinement (post-rulebook)
// ----------------------------------------------------------------------------

async function refineWithGPT(metrics, baseline, { Y, M }) {
  if (!OPENAI_API_KEY) return baseline;

  const sys = [
    'You are Bizzy, an upbeat AI financial co-founder for home service and construction business owners.',
    'You receive: (A) factual metrics and (B) a baseline narrative draft created by deterministic rules.',
    'You may polish wording and order for clarity and motivation, but DO NOT contradict or invent facts.',
    'Keep it concise. 1–2 sentence headline. Max 3 observations. 1 short motivation line.',
    'CTAs MUST remain actionable and truthful; keep at most 3. Prefer object CTAs already given; you may tweak wording.',
    'Return ONLY valid JSON.',
  ].join(' ');

  const user = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `Refine this Monthly Wealth Pulse. Preserve numeric facts exactly.
Metrics:
${JSON.stringify(metrics, null, 2)}

Baseline (from rulebook):
${JSON.stringify(baseline, null, 2)}

JSON schema:
{
  "headline": string,
  "observations": [{ "text": string, "category": "Tax"|"Growth"|"Diversification"|"Contributions" }],
  "motivation": string,
  "ctas": [
    { "text": string, "kind": "calendar"|"simulator"|"insights"|"link", "due_at"?: string(YYYY-MM-DD), "route"?: string, "params"?: object }
  ]
}
`,
      },
    ],
  };

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GPT_MODEL,
        messages: [{ role: 'system', content: sys }, user],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    });

    const j = await r.json();
    const raw = j?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);

    return {
      headline: String(parsed.headline || baseline.headline),
      observations:
        Array.isArray(parsed.observations) && parsed.observations.length
          ? parsed.observations.slice(0, 3)
          : baseline.observations,
      motivation: String(parsed.motivation || baseline.motivation),
      ctas: normalizeCTAs(parsed.ctas?.length ? parsed.ctas : baseline.ctas, { Y, M }).slice(0, 3),
    };
  } catch (e) {
    console.warn('[wealth-pulse] GPT refine failed, using baseline:', e.message);
    return baseline;
  }
}

// ----------------------------------------------------------------------------
// Storage
// ----------------------------------------------------------------------------

async function readPulse(user_id, month_ym) {
  const { data } = await supabase
    .from('monthly_wealth_pulse')
    .select(
      'month_ym, headline, observations, motivation, ctas, metrics, generated_at'
    )
    .eq('user_id', user_id)
    .eq('month_ym', month_ym)
    .maybeSingle();
  if (!data) return null;

  return {
    ...data,
    ctas: normalizeCTAs(data.ctas, ymToParts(data.month_ym)),
  };
}

async function upsertPulse(pulse) {
  const { error } = await supabase
    .from('monthly_wealth_pulse')
    .upsert(
      {
        user_id: pulse.user_id,
        month_ym: pulse.month_ym,
        headline: pulse.headline,
        observations: pulse.observations,
        motivation: pulse.motivation,
        ctas: pulse.ctas,
        metrics: pulse.metrics,
        generated_at: pulse.generated_at,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,month_ym' }
    );
  if (error) throw new Error(error.message);
}

// ----------------------------------------------------------------------------
// Utils
// ----------------------------------------------------------------------------

function resolveMonth(year, month) {
  const now = new Date();
  const Y = Number(year || now.getUTCFullYear());
  const M = Number(month || (now.getUTCMonth() + 1));
  const monthYM = `${Y}-${String(M).padStart(2, '0')}`;
  const start = new Date(Date.UTC(Y, M - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(Y, M, 0, 23, 59, 59));
  return { Y, M, monthYM, startISO: start.toISOString(), endISO: end.toISOString() };
}
function ymToParts(month_ym) {
  const [Y, M] = String(month_ym).split('-').map((x) => Number(x));
  return { Y, M };
}
function addMonthsISO(iso, delta) {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString();
}
function sum(arr, f) {
  return (arr || []).reduce((a, x) => a + (Number(f(x)) || 0), 0);
}
function pctChange(prev, now) {
  const p = Number(prev || 0);
  const n = Number(now || 0);
  if (p <= 0) return n > 0 ? 100 : 0;
  return ((n - p) / p) * 100;
}
function newestByKey(rows, key) {
  const map = new Map();
  for (const r of rows || []) {
    const id = r[key];
    const curr = map.get(id);
    if (!curr || new Date(r.as_of) > new Date(curr.as_of)) map.set(id, r);
  }
  return map;
}
function fmtUSD(n) {
  const v = Math.round(Number(n || 0));
  return `$${v.toLocaleString()}`;
}
function pretty(s) {
  return String(s || '').replace('_', ' ');
}

function normalizeCTAs(ctas, { Y, M }) {
  if (!ctas) return [];
  const arr = Array.isArray(ctas) ? ctas : [ctas];

  return arr
    .map((c) => {
      if (!c) return null;
      if (typeof c === 'string') {
        const lower = c.toLowerCase();
        if (lower.includes('reminder') || lower.includes('deadline')) {
          return { text: c, kind: 'calendar', due_at: `${Y}-12-31` };
        }
        if (lower.includes('model') || lower.includes('+$') || lower.includes('simulator')) {
          return { text: c, kind: 'simulator', route: '/investments/retirement' };
        }
        return { text: c, kind: 'insights' };
      }
      return {
        text: String(c.text || '').slice(0, 300),
        kind: ['calendar', 'simulator', 'insights', 'link'].includes(c.kind) ? c.kind : 'insights',
        due_at: c.due_at ? String(c.due_at) : undefined,
        route: c.route ? String(c.route) : undefined,
        params: typeof c.params === 'object' && c.params ? c.params : undefined,
      };
    })
    .filter(Boolean)
    .slice(0, 3);
}

/** US IRA tax-year contribution deadline: April 15 of next calendar year. */
function iraDeadline(Y) {
  const next = Number(Y) + 1;
  return `${next}-04-15`;
}

// ----------------------------------------------------------------------------
// Discover "active" users for cron
// ----------------------------------------------------------------------------

async function getActiveUserIds() {
  const sets = [];

  const q1 = await supabase
    .from('investment_balances_latest')
    .select('user_id')
    .limit(5000);
  if (Array.isArray(q1.data)) sets.push(new Set(q1.data.map((r) => r.user_id)));

  const q2 = await supabase
    .from('wealth_profile')
    .select('user_id')
    .limit(5000);
  if (Array.isArray(q2.data)) sets.push(new Set(q2.data.map((r) => r.user_id)));

  const all = new Set();
  for (const s of sets) for (const id of s) all.add(id);
  return Array.from(all);
}

// ----------------------------------------------------------------------------
// Mock builder (used when no data or MOCK_INVESTMENTS=true)
// ----------------------------------------------------------------------------

function buildMockPulse({ user_id, Y, M, monthYM }) {
  const metrics = {
    month_ym: monthYM,
    net_worth_now: 0,
    net_worth_prev: 0,
    net_worth_change_usd: 0,
    net_worth_change_pct: 0,
    contribution_total_month: 0,
    retirement_status: 'unknown',
    retirement_probability: 0,
    retirement_change_prob_pp: 0,
    top_account_movers: [],
    notes: { nw_method: 'mock', contrib_method: 'mock', wealth_moves: {} },
  };

  const base = rulebookNarrative(metrics, { Y, M });
  return {
    month_ym: monthYM,
    user_id,
    headline: 'Your net worth remained unchanged this month at $0.',
    observations: base.observations,
    motivation: base.motivation,
    ctas: normalizeCTAs(base.ctas, { Y, M }),
    metrics,
    generated_at: new Date().toISOString(),
  };
}
