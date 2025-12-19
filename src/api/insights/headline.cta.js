// File: /src/api/insights/headline.cta.js
// Build a chat CTA (label, intent, prompt) from a {kind, headline} pick.
// Module-aware, keyword-aware, with optional seeded variety via rng.

/* ----------------------- RNG (optional) ------------------------- */
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
function ensureRng(opts) {
  if (opts?.rng) return opts.rng;
  const seed = seedFrom(`${opts?.seed || 'bizzi'}|${Date.now() >> 17}`); // minor stability
  return mulberry32(seed);
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

/* ----------------------- Intent names --------------------------- */
// Match files you showed in /src/api/gpt/intents
const INTENTS = {
  // finance
  fin_overview:            'fin_overview',
  cash_runway:             'cash_runway',
  job_profitability:       'job_profitability',
  pricing_strategy:        'pricing_strategy',
  forecast_generate:       'forecast_generate',
  expense_spike:           'expense_spike',
  // marketing
  mkt_overview:            'mkt_overview',
  lead_followup:           'lead_followup',
  review_request_flow:     'review_request_flow',
  // tax
  tax_overview:            'tax_overview',
  tax_liability_estimate:  'tax_liability_estimate',
  tax_deadlines:           'tax_deadlines',
  // ops / calendar
  calendar_schedule:       'calendar_schedule',
  job_status:              'job_status',
  // generic
  daily_health:            'affordability_check', // or add a dedicated intent if you prefer
};

/* -------------------- Label / Prompt banks ---------------------- */
// A few variants per module so copy feels alive.
const LABELS = {
  finance:   ['Review cash & margin', 'Check cash runway', 'Tighten AR follow-ups'],
  marketing: ['Review leads & ads', 'Check last week’s ROI', 'Follow up on warm leads'],
  tax:       ['Check tax readiness', 'Estimate quarterly tax', 'See upcoming deadlines'],
  ops:       ['Review this week’s jobs', 'Build this week’s schedule', 'Flag at-risk jobs'],
  generic:   ['Run health check', 'Quick health scan', 'Short version, please'],
};

const PROMPTS = {
  // Finance
  [INTENTS.fin_overview]:
    'Review cash, AR/collections, payroll ratio, and margin for the last 30 days. Summarize top risks and give 2–3 actions.',
  [INTENTS.cash_runway]:
    'Calculate cash runway using current cash, recent burn, and upcoming known payments. Surface quick wins to extend runway.',
  [INTENTS.job_profitability]:
    'Review job profitability (top/bottom 3). Explain drivers and suggest price or labor adjustments.',
  [INTENTS.pricing_strategy]:
    'Evaluate pricing vs margin targets. Recommend price changes by service line and expected impact.',
  [INTENTS.forecast_generate]:
    'Generate a 90-day forecast with base/optimistic/conservative scenarios. Highlight assumptions.',
  [INTENTS.expense_spike]:
    'Identify any expense spikes by category from the last 14 days and explain reasons. Suggest mitigations.',
  // Marketing
  [INTENTS.mkt_overview]:
    'Review leads and ad performance for the last 7 days. Summarize wins/losses and propose next 2–3 moves.',
  [INTENTS.lead_followup]:
    'List warm leads that need follow-up this week and draft 2–3 outreach options.',
  [INTENTS.review_request_flow]:
    'Create a short plan to request Google reviews from recent customers. Draft 2 messages.',
  // Tax
  [INTENTS.tax_overview]:
    'Check tax readiness and next due dates. Outline what to prepare and any quick wins.',
  [INTENTS.tax_liability_estimate]:
    'Estimate quarterly tax liability given recent profit. Provide a safe payment suggestion and reminders.',
  [INTENTS.tax_deadlines]:
    'List upcoming tax deadlines and what to do for each. Offer to add reminders.',
  // Ops
  [INTENTS.calendar_schedule]:
    'Review this week’s jobs and flag any at risk (labor/material delays or schedule conflicts). Suggest actions.',
  [INTENTS.job_status]:
    'Summarize job status by crew for this week. Flag blockers, and propose schedule updates.',
  // Generic
  [INTENTS.daily_health]:
    'Run a quick health check on cash, tax, and pipeline. Give the short version and 2–3 next actions.',
};

/* ----------------------- Keyword routers ------------------------ */
const ROUTES = [
  // finance
  { rx: /\b(cash|runway|burn|collections|ar|receivables)\b/i,         intent: INTENTS.cash_runway,       kind: 'finance' },
  { rx: /\b(margin|payroll|cogs|gross)\b/i,                           intent: INTENTS.fin_overview,      kind: 'finance' },
  { rx: /\b(job|profitability|wip)\b/i,                               intent: INTENTS.job_profitability, kind: 'finance' },
  { rx: /\b(pricing|price|quote)\b/i,                                 intent: INTENTS.pricing_strategy,  kind: 'finance' },
  { rx: /\b(forecast|projection|plan)\b/i,                            intent: INTENTS.forecast_generate, kind: 'finance' },
  { rx: /\b(spike|unexpected|over[- ]?budget|variance)\b/i,           intent: INTENTS.expense_spike,     kind: 'finance' },
  // marketing
  { rx: /\b(leads?|ads?|campaign|spend|cpc|cpa|roi)\b/i,              intent: INTENTS.mkt_overview,      kind: 'marketing' },
  { rx: /\b(follow\s*up|lead follow)\b/i,                             intent: INTENTS.lead_followup,     kind: 'marketing' },
  { rx: /\b(review request|google reviews?)\b/i,                      intent: INTENTS.review_request_flow,kind:'marketing' },
  // tax
  { rx: /\b(estimated|liability|quarterly|payment)\b/i,               intent: INTENTS.tax_liability_estimate, kind:'tax' },
  { rx: /\b(deadline|due|irs|fil(e|ing))\b/i,                         intent: INTENTS.tax_deadlines,     kind: 'tax' },
  { rx: /\b(readiness|tax review)\b/i,                                intent: INTENTS.tax_overview,      kind: 'tax' },
  // ops
  { rx: /\b(jobs?|schedule|crew|calendar|install)\b/i,                intent: INTENTS.calendar_schedule, kind: 'ops' },
  { rx: /\b(status|at[- ]risk)\b/i,                                   intent: INTENTS.job_status,        kind: 'ops' },
];

function inferIntentFromHeadline(headline = '', kind = 'generic') {
  for (const r of ROUTES) if (r.rx.test(headline)) return r.intent;
  switch (kind) {
    case 'finance':   return INTENTS.fin_overview;
    case 'marketing': return INTENTS.mkt_overview;
    case 'tax':       return INTENTS.tax_overview;
    case 'ops':       return INTENTS.calendar_schedule;
    default:          return INTENTS.daily_health;
  }
}

function defaultLabelForKind(kind, rng) {
  const bank = LABELS[kind] || LABELS.generic;
  return pick(rng, bank);
}

/**
 * Build a module-aware chat CTA from a chosen headline.
 * @param {{kind: string, headline: string, data?: object}} pick
 * @param {{ rng?: ()=>number, seed?: string }} [opts]
 * @returns {{cta:'chat', label:string, intent:string, prompt:string}}
 */
export function buildHeadlineCTA(pick, opts = {}) {
  const rng = ensureRng(opts);
  const kind = pick?.kind || 'generic';
  const headline = pick?.headline || '';

  // If the controller has already provided a prompt/intent/label, respect it
  if (pick?.data?.prompt && pick?.data?.intent) {
    return {
      cta: 'chat',
      label: pick.data.label || defaultLabelForKind(kind, rng),
      intent: pick.data.intent,
      prompt: pick.data.prompt,
    };
  }

  // Otherwise infer intent & compose module-aware copy
  const intent  = inferIntentFromHeadline(headline, kind);
  const label   = defaultLabelForKind(kind, rng);
  const prompt  = PROMPTS[intent] || PROMPTS[INTENTS.daily_health];

  return { cta: 'chat', label, intent, prompt };
}

/**
 * Attach CTA into pick.data (non-destructive). Accepts rng for deterministic variety.
 * @param {{kind:string, headline:string, data?:object}} pick
 * @param {{ rng?: ()=>number, seed?: string }} [opts]
 * @returns same object with data.cta fields
 */
export function attachCTA(pick, opts) {
  const built = buildHeadlineCTA(pick, opts);
  return { ...pick, data: { ...(pick.data || {}), ...built } };
}
