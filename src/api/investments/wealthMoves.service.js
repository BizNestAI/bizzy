// ============================================================================
// File: /src/api/investments/wealthMoves.service.js
// Purpose: Generate up to 3 monthly "Wealth Moves" using GPT + your real data
// Caches per user/month in wealth_moves_history; supports force-regeneration.
// ============================================================================
import { supabase } from '../../services/supabaseAdmin.js';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** Allowed tags/urgency enums (guard-rail for GPT + post-validate) */
const TAGS = [
  'Tax Strategy',
  'Growth',
  'Diversification',
  'Risk Management',
  'Cash Optimization',
  'Retirement Readiness',
];
const URGENCY = ['High', 'Medium', 'Low'];

export async function generateWealthMoves(user_id, { force = false } = {}) {
  if (!user_id) throw new Error('missing_user_id');

  const now = new Date();
  const month_ym = `${now.getUTCFullYear()}-${String(
    now.getUTCMonth() + 1
  ).padStart(2, '0')}`;

  // 0) Return cached for the month unless force
  if (!force) {
    const cached = await getCachedMoves(user_id, month_ym);
    if (cached) return { month_ym, ...cached };
  }

  // 1) Gather context from your DB (Prompts #2–#4, #6)
  const [profile, balances, allocation, trajectory, contribRoom, lastMonthMoves] =
    await Promise.all([
      getWealthProfile(user_id),
      getBalancesAgg(user_id),
      getAllocationAgg(user_id),
      getLatestTrajectory(user_id),
      getContributionRoom(user_id), // may be null if #6 not built yet
      getLastMonthMoves(user_id),
    ]);

  const context = {
    as_of: now.toISOString(),
    month_ym,
    profile,
    balances,
    allocation,
    trajectory,
    contribution_room: contribRoom,
  };

  // 2) Compose GPT prompt (Bizzy voice + constraints)
  const sys = `
You are Bizzy, an AI financial co-founder for home service & construction business owners.
You generate up to 3 *specific, timely* monthly Wealth Moves, not generic advice.
Be proactive, clear, confident, and motivating. Consider taxes, retirement, risk, and cash needs.
Return STRICT JSON matching the schema below. Do not include prose outside JSON.

Rules:
- Prioritize urgency (deadlines, contribution windows) and impact.
- Avoid repeating last month's moves unless context materially changed (surplus/shortfall delta, unused room changed, etc.).
- Use the user's data AS IS; if a field is missing, acknowledge the uncertainty and still propose a reasonable move.
- Keep move_title short. Keep description in Bizzy's voice.
- estimated_impact should include a number with a unit and a short assumption note (e.g., "$600 tax savings assuming 24% bracket").
- Choose 1–3 tags from: ${TAGS.join(', ')}.
- urgency must be one of: ${URGENCY.join(', ')}.

JSON schema:
{
  "moves": [
    {
      "move_title": "string",
      "description": "string",
      "urgency": "High|Medium|Low",
      "estimated_impact": "string",
      "tags": ["Tax Strategy" | "Growth" | "Diversification" | "Risk Management" | "Cash Optimization" | "Retirement Readiness"],
      "scenario_context": "string (optional)"
    }
  ],
  "rationale_bullets": ["string", "string"]  // optional, for Learn More
}
`.trim();

  const userMsg = {
    context,
    last_month_moves: lastMonthMoves?.moves || [],
    ask: 'Generate up to 3 moves for the current month. Avoid duplicates unless the context changed meaningfully.',
  };

  // 3) Call GPT with JSON response enforced
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.5,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: JSON.stringify(userMsg) },
    ],
  });

  const raw = safeJson(completion?.choices?.[0]?.message?.content) || {};
  let moves = Array.isArray(raw.moves) ? raw.moves : [];

  // 4) Post-validate & normalize
  moves = normalizeMoves(moves);
  // Avoid repeats if nothing changed materially
  moves = filterRepeatsIfNoChange(moves, lastMonthMoves, { balances, trajectory, contribRoom });

  // Fallback if GPT returned nothing
  if (moves.length === 0) {
    moves = ruleBasedFallback({ profile, balances, allocation, trajectory, contribRoom });
  }

  // Cap at 3
  moves = moves.slice(0, 3);

  const payload = {
    month_ym,
    moves,
    meta: {
      generated_at: now.toISOString(),
      used_force: !!force,
      source: 'gpt+rules',
    },
  };

  // 5) Cache (upsert) current month result
  await upsertMoves(user_id, month_ym, payload);

  return payload;
}

/* ----------------------------------------------------------------------------
 * Helpers: data fetching
 * --------------------------------------------------------------------------*/
async function getCachedMoves(user_id, month_ym) {
  const { data, error } = await supabase
    .from('wealth_moves_history')
    .select('moves_json')
    .eq('user_id', user_id)
    .eq('month_ym', month_ym)
    .maybeSingle();

  if (error) {
    console.warn('[wealth-moves] cache read error:', error.message);
    return null;
  }
  return data?.moves_json || null;
}

async function upsertMoves(user_id, month_ym, payload) {
  const row = {
    user_id,
    month_ym,
    moves_json: payload,
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };
  const { error } = await supabase
    .from('wealth_moves_history')
    .upsert(row, { onConflict: 'user_id,month_ym' });
  if (error) console.warn('[wealth-moves] upsert error:', error.message);
}

async function getLastMonthMoves(user_id) {
  const d = new Date();
  // previous month
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const ym = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;

  const { data, error } = await supabase
    .from('wealth_moves_history')
    .select('moves_json')
    .eq('user_id', user_id)
    .eq('month_ym', ym)
    .maybeSingle();
  if (error) {
    console.warn('[wealth-moves] last month read error:', error.message);
    return null;
  }
  return data?.moves_json || null;
}

async function getWealthProfile(user_id) {
  const { data, error } = await supabase
    .from('wealth_profile')
    .select('*')
    .eq('user_id', user_id)
    .maybeSingle();
  if (error) {
    console.warn('[wealth-moves] wealth_profile error:', error.message);
    return {};
  }
  return data || {};
}

// Aggregated balances from investment_balances_latest (Prompt #3)
async function getBalancesAgg(user_id) {
  const { data, error } = await supabase
    .from('investment_balances_latest')
    .select('balance_usd, ytd_gain_usd, asset_allocation_json')
    .eq('user_id', user_id);
  if (error) {
    console.warn('[wealth-moves] balances error:', error.message);
    return { total_balance_usd: 0, ytd_gain_usd: 0 };
  }
  const total = (data || []).reduce((a, r) => a + (Number(r.balance_usd) || 0), 0);
  const ytd = (data || []).reduce((a, r) => a + (Number(r.ytd_gain_usd) || 0), 0);
  return { total_balance_usd: total, ytd_gain_usd: ytd, accounts: data || [] };
}

// Aggregated allocation across accounts
async function getAllocationAgg(user_id) {
  const { data, error } = await supabase
    .from('investment_balances_latest')
    .select('asset_allocation_json')
    .eq('user_id', user_id);
  if (error || !data) return null;
  const merged = {};
  for (const row of data) {
    const alloc = row.asset_allocation_json || {};
    for (const [k, v] of Object.entries(alloc)) {
      merged[k] = (merged[k] || 0) + Number(v || 0);
    }
  }
  // Normalize to percentages out of total sum if values are not already percentages
  const sum = Object.values(merged).reduce((a, b) => a + b, 0) || 1;
  const pct = {};
  for (const [k, v] of Object.entries(merged)) {
    // If the values already look like % (sum ~100 ± 10), keep as-is
    pct[k] = (sum > 110 ? (v / sum) * 100 : v);
  }
  return pct;
}

async function getLatestTrajectory(user_id) {
  const { data, error } = await supabase
    .from('retirement_projection_history')
    .select('results_json')
    .eq('user_id', user_id)
    .order('month_ym', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn('[wealth-moves] trajectory read error:', error.message);
    return null;
  }
  return data?.results_json || null;
}

// Placeholder for Prompt #6 — if not implemented, returns null
async function getContributionRoom(user_id) {
  try {
    const { data, error } = await supabase
      .from('contribution_limits_latest')
      .select('*')
      .eq('user_id', user_id);
    if (error || !data) return null;
    // Expecting rows like: { account_type: 'Roth IRA', used: 4500, limit: 7000 }
    return data;
  } catch (e) {
    return null;
  }
}

/* ----------------------------------------------------------------------------
 * Helpers: GPT post-processing
 * --------------------------------------------------------------------------*/
function normalizeMoves(moves) {
  const seen = new Set();
  const out = [];

  for (const m of moves) {
    if (!m || typeof m !== 'object') continue;
    let title = String(m.move_title || '').trim().slice(0, 100);
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const urgency = URGENCY.includes(m.urgency) ? m.urgency : 'Medium';
    const tags = Array.isArray(m.tags)
      ? m.tags.filter((t) => TAGS.includes(t)).slice(0, 3)
      : [];

    out.push({
      move_title: title,
      description: String(m.description || '').trim().slice(0, 600),
      urgency,
      estimated_impact: String(m.estimated_impact || '').trim().slice(0, 140),
      tags: tags.length ? tags : ['Retirement Readiness'],
      scenario_context: m.scenario_context
        ? String(m.scenario_context).trim().slice(0, 240)
        : undefined,
    });
  }
  return out;
}

function filterRepeatsIfNoChange(moves, lastMonth, { balances, trajectory, contribRoom }) {
  if (!lastMonth?.moves?.length) return moves;

  const changed = materialChangeSinceLastMonth(lastMonth, { balances, trajectory, contribRoom });
  if (changed) return moves; // allow repeats when context changed

  const lastTitles = new Set(
    lastMonth.moves.map((m) => String(m.move_title || '').toLowerCase())
  );

  const filtered = moves.filter((m) => !lastTitles.has(m.move_title.toLowerCase()));
  // If we filtered everything, keep at least one move to avoid empty response
  return filtered.length ? filtered : moves.slice(0, 1);
}

function materialChangeSinceLastMonth(lastMonth, { balances, trajectory, contribRoom }) {
  // Heuristic: >3% net worth delta OR surplus/shortfall status changed OR contribution room changed materially
  let changed = false;

  try {
    const prev = Number(lastMonth?.meta?.balances_total || 0);
    const curr = Number(balances?.total_balance_usd || 0);
    if (prev && Math.abs(curr - prev) / prev > 0.03) changed = true;
  } catch {}

  try {
    const prevStatus = lastMonth?.meta?.trajectory_status;
    const currStatus = trajectory?.status;
    if (prevStatus && currStatus && prevStatus !== currStatus) changed = true;
  } catch {}

  try {
    const prevRoom = JSON.stringify(lastMonth?.meta?.contribution_room || null);
    const currRoom = JSON.stringify(contribRoom || null);
    if (prevRoom !== currRoom) changed = true;
  } catch {}

  return changed;
}

/* ----------------------------------------------------------------------------
 * Helpers: Fallback rules if GPT fails
 * --------------------------------------------------------------------------*/
function ruleBasedFallback({ profile, balances, allocation, trajectory, contribRoom }) {
  const moves = [];
  const total = Number(balances?.total_balance_usd || 0);
  const cashPct = Number((allocation && allocation.Cash) || 0);
  const status = trajectory?.status;

  // 1) If too much cash
  if (cashPct >= 20) {
    moves.push({
      move_title: 'Trim Excess Cash',
      description:
        `You’re holding ~${cashPct.toFixed(0)}% in cash. Consider moving $5,000–$10,000 into a broad market ETF to reduce cash drag.`,
      urgency: 'Medium',
      estimated_impact: `+$100–$200/yr vs. cash (assumes 2% excess return)`,
      tags: ['Growth', 'Cash Optimization'],
      scenario_context: 'Reallocate $10k → expected long-run gain improves; volatility increases moderately.',
    });
  }

  // 2) If shortfall
  if (status === 'shortfall') {
    moves.push({
      move_title: 'Increase Monthly Contributions',
      description:
        `Your projection shows a shortfall at retirement. Increasing contributions by $250–$500/mo can close the gap faster.`,
      urgency: 'High',
      estimated_impact: `+$3,000–$6,000/yr added contributions; improved success probability`,
      tags: ['Retirement Readiness', 'Growth'],
      scenario_context: 'Add $300/mo → goal may be reached ~6–12 months sooner depending on returns.',
    });
  }

  // 3) If contribution room exists
  if (Array.isArray(contribRoom) && contribRoom.length) {
    const open = contribRoom.find((r) => Number(r.limit || 0) > Number(r.used || 0));
    if (open) {
      const rem = Math.max(0, Number(open.limit) - Number(open.used));
      moves.push({
        move_title: `Use Remaining ${open.account_type} Room`,
        description:
          `You still have ~${fmtUSD(rem)} available in your ${open.account_type}. Filling this reduces taxes and accelerates growth.`,
        urgency: 'High',
        estimated_impact: `${fmtUSD(rem * 0.22)} tax savings (assumes 22% bracket)`,
        tags: ['Tax Strategy', 'Retirement Readiness'],
        scenario_context: `Contribute ${fmtUSD(Math.min(2000, rem))} this month to stay on track.`,
      });
    }
  }

  if (moves.length === 0) {
    moves.push({
      move_title: 'Rebalance to Target Allocation',
      description:
        'Markets shift; a quick rebalance back to your target (e.g., 70/30) reduces unintended risk.',
      urgency: 'Low',
      estimated_impact: 'Lower tracking error; risk alignment benefits over time',
      tags: ['Risk Management', 'Diversification'],
    });
  }

  return moves.slice(0, 3);
}

function fmtUSD(n) {
  const v = Math.round(Number(n || 0));
  return `$${v.toLocaleString()}`;
}

function safeJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return null;
  }
}
