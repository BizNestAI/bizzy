// File: /src/api/insights/headline.controller.js
/* global process */
import dayjs from 'dayjs';
import { supabase } from '../../services/supabaseAdmin.js';
import fetch from 'node-fetch';
import { attachCTA } from './headline.cta.js';

const CONTRACTOR_CFO_MODULE = 'contractor_cfo';

/* ---------------- Seeded variety helpers (deterministic) ----------- */
function seedFrom(str = '') {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h || 0x9e3779b9) >>> 0;
}
function mulberry32(a) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function chance(rng, p) { return rng() < p; }

/* ---------------- Variant banks for generic greetings -------------- */
const BANK = {
  greet: [
    'Welcome back', 'Good to see you', 'Hey there', 'Morning', 'Let’s get after it',
    'Heads up', 'Quick note', 'Back at it', 'Ready when you are',
  ],
  verbLead: [
    'I can', 'Want me to', 'I’m ready to', 'I’ll', 'If you’d like I can',
  ],
  actions: [
    'run a quick health check', 'review this week’s jobs', 'watch cash, tax, and pipeline',
    'scan yesterday’s numbers', 'prep a simple priority list', 'check what moved overnight',
  ],
  focuses: [
    'cash', 'tax', 'pipeline', 'AR/collections', 'margin', 'spend vs budget', 'leads & ads',
  ],
  closers: [
    'You focus on the work.', 'So you don’t have to.', 'I’ll flag anything at risk.',
    'I can draft next steps.', 'I’ll keep it tight and actionable.',
  ],
  connectors: ['—', '–', '—', '—'], // prefer em dash styling
};

const DEFAULTS = [
  "Welcome back — want me to run a quick health check on your cash, taxes, or jobs?",
  "Good to see you — I can review this week’s jobs and flag anything at risk.",
  "Hey there — I’ll watch your cash flow and taxes so you can focus on work.",
  "Welcome back — I can scan cash, AR, jobs, and tax readiness.",
  "Morning — I can prep a simple priority list so you don’t have to.",
  "Let’s get after it — want me to check what moved overnight?",
  "Good to see you again — I can scan yesterday’s numbers and flag anything at risk.",
];

/** Compose a daily generic headline with seeded variety. */
function composeGenericHeadline(rng) {
  const g   = pick(rng, BANK.greet);
  const v   = pick(rng, BANK.verbLead);
  const a   = pick(rng, BANK.actions);
  const c   = pick(rng, BANK.connectors);
  const withFocus = chance(rng, 0.65);
  const f = withFocus ? ` on ${pick(rng, BANK.focuses)}` : '';
  const endAsQ = chance(rng, 0.55);
  const closer = chance(rng, 0.5) ? ` ${pick(rng, BANK.closers)}` : '';
  const body = `${v} ${a}${f}${endAsQ ? '?' : '.'}${closer}`;
  return `${g} ${c} ${body}`.replace(/\s+/g, ' ').trim();
}

/* ----------------- Snapshot fetchers (unchanged) ------------------- */
async function getAccountingSnapshot(business_id) {
  try {
    const r = await fetch(`${process.env.API_BASE}/api/accounting/metrics?business_id=${business_id}`, { headers: { 'x-business-id': business_id }});
    if (!r.ok) throw new Error('acc metrics failed');
    return await r.json();
  } catch { return null; }
}
async function getTaxSnapshot(business_id) {
  try {
    const r = await fetch(`${process.env.API_BASE}/api/tax/snapshot?business_id=${business_id}`, { headers: { 'x-business-id': business_id }});
    if (!r.ok) throw new Error('tax snapshot failed');
    return await r.json();
  } catch { return null; }
}
async function getUpcomingDeadline(business_id) {
  const today = dayjs().startOf('day').toDate();
  const next14 = dayjs().add(14, 'day').startOf('day').toDate();

  const { data, error } = await supabase
    .from('bizzy_deadlines')
    .select('*')
    .eq('business_id', business_id)
    .in('status', ['upcoming','due'])
    .gte('due_date', today.toISOString().slice(0,10))
    .lte('due_date', next14.toISOString().slice(0,10))
    .order('due_date', { ascending: true })
    .limit(1);
  if (error) return null;
  return data?.[0] || null;
}

/* --------------- Rule scoring → data-driven headline --------------- */
function chooseHeadline({ acc, tax, deadline, rng }) {
  if (deadline) {
    const days = dayjs(deadline.due_date).diff(dayjs(), 'day');
    const when = days <= 0 ? 'today' : (days === 1 ? 'tomorrow' : `in ${days} days`);
    return {
      kind: 'tax',
      headline: `Heads up — “${deadline.title}” is due ${when}. Want me to prep a quick checklist?`,
      data: { /* optional metadata */ due_in_days: days }
    };
  }

  if (acc?.revenue_mom > 0.10 && acc?.payroll_ratio > 0.35) {
    return {
      kind: 'finance',
      headline: `Revenue is trending up ${Math.round(acc.revenue_mom*100)}% vs last month, but payroll is your top expense. Want me to walk through fixes?`,
      data: { metric: 'payroll_ratio' }
    };
  }

  if (tax?.readiness_pct != null && tax.readiness_pct < 0.80) {
    return {
      kind: 'tax',
      headline: `Tax readiness is at ${Math.round(tax.readiness_pct*100)}%. Want me to model next payment so there are no surprises?`,
      data: {}
    };
  }

  const line = composeGenericHeadline(rng);
  return { kind: 'generic', headline: line, data: {} };
}

/* ----------------------- Controller entrypoint --------------------- */
export async function getDailyHeadline(req, res) {
  try {
    const business_id = req.query.business_id || req.query.businessId || req.headers['x-business-id'];
    const user_id     = req.query.user_id     || req.query.userId     || req.headers['x-user-id'];
    if (!business_id) return res.status(400).json({ error: 'missing business_id' });

    // Legacy dashboard-only endpoint. Every DB read/write is business-scoped, and
    // cached payload metadata is pinned to contractor_cfo so old widgets cannot
    // reintroduce stale module rows.
    const today = dayjs().format('YYYY-MM-DD');

    // 1) cache per business per day
    const { data: cached, error: selErr } = await supabase
      .from('bizzy_headlines')
      .select('*')
      .eq('business_id', business_id)
      .eq('valid_for', today)
      .maybeSingle();

    if (!selErr && cached) {
      return res.json({
        headline: cached.headline,
        kind: cached.kind,
        data: { ...(cached.data || {}), legacy_dashboard_only: true, module: CONTRACTOR_CFO_MODULE },
        legacy_dashboard_only: true,
        module: CONTRACTOR_CFO_MODULE,
      });
    }

    // 2) seed RNG with business + date → variety per day per account
    const seed = seedFrom(`${business_id}|${today}`);
    const rng  = mulberry32(seed);

    // 3) compute from snapshots or generic composition
    const [acc, tax, deadline] = await Promise.all([
      getAccountingSnapshot(business_id),
      getTaxSnapshot(business_id),
      getUpcomingDeadline(business_id)
    ]);

    let pick = chooseHeadline({ acc, tax, deadline, rng });
    pick = attachCTA(pick, { rng }); // 👈 make CTA module-aware & varied with the same seed

    // 4) store cache
    await supabase.from('bizzy_headlines').insert({
      business_id,
      user_id,
      headline: pick.headline,
      kind: pick.kind,
      data: { ...(pick.data || {}), legacy_dashboard_only: true, module: CONTRACTOR_CFO_MODULE },
      valid_for: today
    });

    return res.json({
      ...pick,
      data: { ...(pick.data || {}), legacy_dashboard_only: true, module: CONTRACTOR_CFO_MODULE },
      legacy_dashboard_only: true,
      module: CONTRACTOR_CFO_MODULE,
    });
  } catch (e) {
    console.error('[headline] failed', e);
    const idx = Math.floor((Date.now()/86400000)) % DEFAULTS.length;
    return res.json({
      kind: 'generic',
      headline: DEFAULTS[idx],
      data: { legacy_dashboard_only: true, module: CONTRACTOR_CFO_MODULE },
      legacy_dashboard_only: true,
      module: CONTRACTOR_CFO_MODULE,
    });
  }
}
