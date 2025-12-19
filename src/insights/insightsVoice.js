// /src/api/insights/insightsVoice.js
// Deterministic, varied “Bizzi voice” for Insights (no LLM).
// - Seeded variety per insight (stable across reloads).
// - Module-aware phrasing & tone.
// - Pulls posture hints from personaSpec to stay on-brand.

import { bizzyPersona } from '../api/gpt/brain/personaSpec.js';

/* ----------------------------- Utilities ----------------------------- */

// Simple seeded PRNG (xorshift32) from a string
function seedFrom(str = '') {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // ensure non-zero
  return (h || 0x9e3779b9) >>> 0;
}
function xorshift32(state) {
  state ^= state << 13; state >>>= 0;
  state ^= state >>> 17; state >>>= 0;
  state ^= state << 5;  state >>>= 0;
  return state >>> 0;
}
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = xorshift32(s);
    // [0,1)
    return (s >>> 0) / 0xFFFFFFFF;
  };
}
function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}
function chance(rng, p) {
  return rng() < p;
}
function ensureEndPunct(s) {
  if (!s) return s;
  return /[.!?]\s*$/.test(s) ? s : s + '.';
}
function normalizeModule(mod) {
  const m = String(mod || 'bizzy').toLowerCase();
  if (m === 'financials') return 'accounting';
  return m;
}
function alreadyBizziAuthored(i) {
  return String(i.author || '').toLowerCase() === 'bizzi';
}

/* ----------------------------- Tone banks (varied) ----------------------------- */

const TONE_PREFIX = {
  celebrate: [
    'Great news — ',
    'Love this — ',
    'Nice win — ',
    'Good momentum — ',
  ],
  nudge: [
    'Quick nudge: ',
    'Heads-up for you — ',
    'Noted — ',
    'On my radar — ',
  ],
  warn: [
    'Heads up — ',
    'Flagging this — ',
    'Let’s address this — ',
    'Important — ',
  ],
};

const EMPATHY = {
  celebrate: [
    'Well earned.',
    'Let’s build on it.',
    'I’ll keep pushing this forward.',
  ],
  nudge: [
    'I’ve got your back.',
    'We can tighten this up.',
    'I’ll keep watch.',
  ],
  warn: [
    'Totally manageable.',
    'We can steady this.',
    'Let’s get in front of it.',
  ],
};

// Verb variants for “I’m tracking / seeing / watching”
const VERBS_SEE = ['seeing', 'noticing', 'spotting', 'picking up'];
const VERBS_TRACK = ['tracking', 'watching', 'keeping an eye on', 'monitoring'];

// Soft connectors to make copy feel alive
const CONNECTORS = [
  'From the numbers, ',
  'Looking at this, ',
  'Based on what I’m seeing, ',
  'As of today, ',
];

/* ----------------------------- Module-aware lexicon (with variants) ----------------------------- */

const MODULE_LEXICON = {
  accounting: [
    { from: /\bYour current balance is\b/i, to: [
      "I’m " + pickSeed(VERBS_TRACK) + " cash — it’s",
      "Cash looks at about",
      "I’m watching cash flow — it’s",
    ]},
    { from: /\bcash shortfall\b/gi, to: [
      "a cash gap I’m forecasting",
      "a short-term cash squeeze",
      "a projected dip in cash",
    ]},
    { from: /\bCOGS\b/g, to: "COGS (materials + labor)" },
    { from: /\bForecasted\b/gi, to: [
      "I’m forecasting",
      "Projected",
      "Expected",
    ]},
  ],
  marketing: [
    { from: /\bAverage rating\b/gi, to: [
      "I’m seeing an average rating",
      "Ratings are averaging",
      "Reviews are sitting around",
    ]},
    { from: /\breviews?\b/gi, to: [
      "reviews I’m tracking",
      "recent feedback",
      "customer reviews I pulled",
    ]},
    { from: /\bengagement\b/gi, to: [
      "engagement I’m seeing",
      "interaction rate",
      "response activity",
    ]},
  ],
  tax: [
    { from: /\bQuarterly estimated tax payment\b/gi, to: [
      "I’m tracking your quarterly estimated tax payment",
      "Your quarterly estimate is on my radar",
      "Quarterly estimated tax is coming due",
    ]},
    { from: /\bDeadline\b/gi, to: [
      "Deadline I’m watching",
      "Due date I have queued",
      "Cutoff I’m tracking",
    ]},
  ],
  investments: [
    { from: /\bPortfolio\b/gi, to: [
      "Portfolio I’m monitoring",
      "Holdings I’m tracking",
      "Your portfolio",
    ]},
    { from: /\brebalance\b/gi, to: [
      "rebalance (if drift > 5%)",
      "a light rebalance if drift’s high",
      "rebalance when allocations drift",
    ]},
  ],
  bizzy: [
    { from: /\bNo major changes\b/gi, to: [
      "I’m not seeing any major changes",
      "No big swings on my end",
      "Nothing critical moved yet",
    ]},
  ],
};

// helper used above to inject a single seeded verb when building the lexicon
function pickSeed(arr) {
  // placeholder; replaced later with seeded pick inside applyModuleLexicon
  return arr[0];
}

/* ----------------------------- Tone inference ----------------------------- */

function inferTone(i = {}) {
  const sev = String(i.severity || '').toLowerCase();
  if (sev.includes('warn') || sev.includes('risk') || sev.includes('urgent')) return 'warn';
  if (sev.includes('info')) return 'nudge';

  const hay = `${i.title || ''} ${i.body || ''}`.toLowerCase();
  if (/\b(up|record|new high|growth|won|closed|improved|better)\b/.test(hay)) return 'celebrate';
  if (/\b(low|down|shortfall|over budget|decline|late)\b/.test(hay)) return 'warn';
  return 'nudge';
}

/* ----------------------------- Rewriters ----------------------------- */

function firstPersonTitle(t = '') {
  return t
    .replace(/^Your /i, 'I’m watching your ')
    .replace(/^Forecasted /i, 'I’m forecasting ')
    .trim();
}

function firstPersonBody(b = '') {
  let out = b
    .replace(/\bYour current balance is\b/i, "I’m " + pickSeed(VERBS_TRACK) + " cash — it’s")
    .replace(/(^|\.\s+)(Your )/g, (_m, p1) => `${p1}I’m seeing your `)
    .replace(/\bconsider\b/gi, 'let’s consider');
  return out;
}

function applyModuleLexicon(modKey, text = '', rng) {
  const rules = MODULE_LEXICON[modKey] || [];
  let out = text;
  for (const { from, to } of rules) {
    const variants = Array.isArray(to) ? to : [to];
    const choice = pick(rng, variants);
    out = out.replace(from, choice);
  }
  // Also randomize “I’m tracking/seeing/watching” verbs where generic forms appear
  out = out.replace(/\bI’m tracking\b/gi, `I’m ${pick(rng, VERBS_TRACK)}`);
  out = out.replace(/\bI’m seeing\b/gi,   `I’m ${pick(rng, VERBS_SEE)}`);
  out = out.replace(/\bI’m watching\b/gi, `I’m ${pick(rng, VERBS_TRACK)}`);
  return out;
}

function coachingTail(insight, body, tone, rng) {
  const mod = normalizeModule(insight.module);
  const patterns = bizzyPersona?.domain_posture?.[mod]?.patterns || [];
  const needsDot = !/[.!?]\s*$/.test(body);
  let out = needsDot ? body + '.' : body;

  // Tone-based micro-nudge (20–40% odds to avoid overuse)
  if (tone === 'warn' && chance(rng, 0.35)) {
    out += ' ' + pick(rng, [
      'We can steady this quickly.',
      'Let’s get in front of it.',
      'Totally fixable — want me to take first steps?',
    ]);
  } else if (tone === 'celebrate' && chance(rng, 0.35)) {
    out += ' ' + pick(rng, [
      'Let’s double down while it’s working.',
      'Want me to capture what drove this?',
      'I can turn this into a playbook.',
    ]);
  } else if (chance(rng, 0.2)) {
    out += ' ' + pick(rng, EMPATHY.nudge);
  }

  // Occasionally translate the first module pattern into a soft “let’s” hint
  if (patterns.length && chance(rng, 0.25)) {
    const hint = patterns[0]
      .replace(/^Lead with /i, 'Let’s lead with ')
      .replace(/^Show /i, 'Let’s show ')
      .replace(/^Keep /i, 'Let’s keep ')
      .replace(/^Tie /i, 'Let’s tie ')
      .replace(/^End with /i, 'Let’s end with ');
    out += ' ' + ensureEndPunct(hint);
  }

  return out;
}

function tonePrefix(tone, rng) {
  const bank = TONE_PREFIX[tone] || TONE_PREFIX.nudge;
  return pick(rng, bank);
}

function withConnector(text, rng) {
  // 30% chance to add a light connector to the start of body
  if (!text || !chance(rng, 0.3)) return text;
  return pick(rng, CONNECTORS) + text.charAt(0).toLowerCase() + text.slice(1);
}

/* ----------------------------- Main adapter ----------------------------- */

export function toBizziVoice(insight = {}, opts = {}) {
  if (!insight) return insight;
  if (alreadyBizziAuthored(insight)) return insight;

  // Stable seed per insight → variety without flicker
  const seedBasis =
    insight.id ||
    insight.created_at ||
    (insight.title ? `t:${insight.title}` : 'seed');
  const rng = makeRng(seedFrom(String(seedBasis)));

  const tone = inferTone(insight);
  const mod  = normalizeModule(insight.module);

  // Title
  let title = firstPersonTitle(String(insight.title || ''));
  title = applyModuleLexicon(mod, title, rng);
  title = (tonePrefix(tone, rng) || '') + (title || 'I’ve got an update');

  // Body
  let body = firstPersonBody(String(insight.body || ''));
  body = applyModuleLexicon(mod, body, rng);
  body = withConnector(body, rng);
  body = coachingTail(insight, body, tone, rng);

  return {
    ...insight,
    title,
    body,
    tone,
    author: 'bizzi',
  };
}

export function applyBizziVoice(list = [], opts = {}) {
  return Array.isArray(list) ? list.map(i => toBizziVoice(i, opts)) : [];
}
