// File: /src/api/gpt/bizzySystemPrompt.js
//
// Purpose:
//  - Provide the *business/context* system message only (no tone/voice here).
//  - Persona (voice) + formatting (style) are composed via persona/helpers.
//  - Summarize context compactly; include small task hints (schedule JSON, affordability).
//  - Do NOT force output structure; style block appended last controls formatting.
//

// Style-only composers (legacy) — still available if you need them directly
import {
  buildChatStyleSystemMessages,     // ChatGPT-like compact paragraphs, no headings by default
  buildStyleSystemMessages,         // scaffolded/templated style with headings (opt-in)
} from '../brain/styleSpec.js';

// NEW: bring in persona-aware composer so we can select chat vs scaffolded
import { buildPersonaSystems } from './persona.helpers.js';

// ───────────────────────────────────────────────────────────────────────────────
// Tiny format helpers (keep output compact inside a system message)
// ───────────────────────────────────────────────────────────────────────────────
function fmtUsd(n) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '$0';
  return '$' + (Math.round(v) === v ? v.toString() : v.toFixed(2));
}
function fmtPct(n) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '0%';
  // handle 0.25 (25%) or already-in-% 25
  const isAlreadyPercent = v > 1;
  const out = isAlreadyPercent ? v : v * 100;
  return (Math.round(out * 10) / 10) + '%';
}
function shortList(arr, max = 5) {
  if (!Array.isArray(arr) || arr.length === 0) return 'N/A';
  return arr.slice(0, max).join('; ');
}
function safeText(s) {
  return (s ?? '').toString().trim();
}

// ───────────────────────────────────────────────────────────────────────────────
// Core: build the *context-only* system prompt (no persona/style here)
// ───────────────────────────────────────────────────────────────────────────────
export function buildBizzySystemPrompt({
  intent,
  hasContext,
  memoryContext = '',
  businessProfile = null,
  monthlyMetrics = [],
  topAccounts = [],
  moveSuggestions = [],
  forecastData = [],
  recentChat = [],
  scheduleHint,
  affordHint,
  metricHint,
  periodHint,
  demoSnapshot = null,
  webContext = '',
  hasWebContext = false,
  webLimitExceeded = false,
  webNotConfigured = false,
  bookkeepingNote = '',
} = {}) {
  // ────────────────────────────────────────────────────────────────────────────
  // NO CONTEXT VARIANT: allow general knowledge (relationship-first behavior)
  // ────────────────────────────────────────────────────────────────────────────
  if (!hasContext) {
    return [
      // Identity (business brain context only; tone comes from persona)
      'You are Bizzi — an AI cofounder that assists home-service & construction owners with strategy and operations.',
      // General-knowledge allowance in chat-first model
      'If the user asks about a general topic (outside construction/business), answer helpfully and briefly. When appropriate, you may optionally relate the answer back to the user’s goals or finances — but do not force it.',
      // Data behavior
      'Operate safely without business data when necessary. If data is missing, ask up to two clarifying questions at the end, then propose safe defaults.',
      // Task hints (compact)
      scheduleHint
        ? 'Scheduling: if the user is scheduling, extract **title**, **date/time**, **type**. If explicitly asked to create it, return a fenced JSON block with {action:"schedule_event",title,date,type}.'
        : '',
      affordHint
        ? 'Affordability: provide a **Verdict** (Yes/No/Depends), a brief justification, and 2–3 actions (timing, savings, reminder).'
        : '',
      hasWebContext
        ? [
            'You also have recent web search results relevant to the user’s question. Use them as factual grounding and distinguish web-sourced facts (e.g., “Web results: …”). Mention the date if present.',
            webContext,
          ].join('\n')
        : '',
      webLimitExceeded
        ? 'Web lookups for this user are exhausted this month. Do NOT pretend to have live data. If asked for live scores/news/weather, explain the limit and suggest 1–2 sites where they can check manually. You can still answer from general knowledge.'
        : '',
      (!hasWebContext && (webLimitExceeded || webNotConfigured))
        ? 'Web lookups are currently unavailable. Do NOT pretend to have live data. If asked for live scores/news/weather, explain the limitation (quota exhausted or web not configured) and suggest 1–2 sites where the user can check manually. You can still answer from general knowledge.'
        : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // WITH CONTEXT VARIANT
  // ────────────────────────────────────────────────────────────────────────────
  const cur = monthlyMetrics?.[0] || null;
  const prev = monthlyMetrics?.[1] || null;

  const curRev = cur?.total_revenue;
  const curExp = cur?.total_expenses;
  const curNP = cur?.net_profit;
  const curPM = cur?.profit_margin;
  const topSpend = cur?.top_spending_category;

  let deltaNP = null;
  let deltaPM = null;
  if (cur && prev) {
    deltaNP = Number(curNP ?? 0) - Number(prev.net_profit ?? 0);
    const pmNow = Number(curPM ?? 0);
    const pmPrev = Number(prev.profit_margin ?? 0);
    if (Number.isFinite(pmNow) && Number.isFinite(pmPrev)) deltaPM = pmNow - pmPrev;
  }

  const bp = businessProfile || {};
  const bpLines = [
    bp.name ? `- Business: ${bp.name}` : null,
    bp.industry ? `- Industry: ${bp.industry}` : null,
    bp.location ? `- Location: ${bp.location}` : null,
    (bp.team_size || bp.team_size === 0) ? `- Team Size: ${bp.team_size}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const metricLines = [
    (curRev != null) ? `- Revenue (latest): ${fmtUsd(curRev)}` : null,
    (curExp != null) ? `- Expenses (latest): ${fmtUsd(curExp)}` : null,
    (curNP != null) ? `- Net Profit (latest): ${fmtUsd(curNP)}` : null,
    (curPM != null) ? `- Profit Margin (latest): ${fmtPct(curPM)}` : null,
    (topSpend) ? `- Top spending category: ${topSpend}` : null,
    (deltaNP != null) ? `- Δ Net Profit vs prior: ${fmtUsd(deltaNP)}` : null,
    (deltaPM != null) ? `- Δ Margin vs prior: ${deltaPM >= 0 ? '+' : ''}${fmtPct(deltaPM)}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const accountsLine =
    (Array.isArray(topAccounts) && topAccounts.length)
      ? `- Top Accounts: ${shortList(topAccounts, 3)}`
      : null;

  const movesBlock =
    (Array.isArray(moveSuggestions) && moveSuggestions.length)
      ? moveSuggestions
          .slice(0, 3)
          .map((m) => `- ${safeText(m.title)}: ${safeText(m.rationale)}`)
          .join('\n')
      : null;

  const forecastBlock =
    (Array.isArray(forecastData) && forecastData.length)
      ? forecastData
          .slice(0, 3)
          .map((f) => {
            const m = f.month ?? '';
            const ni = (f.net_cash != null) ? fmtUsd(f.net_cash) : null;
            const ci = (f.cash_in != null) ? fmtUsd(f.cash_in) : null;
            const co = (f.cash_out != null) ? fmtUsd(f.cash_out) : null;
            const parts = [];
            if (ni) parts.push(`Net ${ni}`);
            if (ci && co) parts.push(`In ${ci} / Out ${co}`);
            return `- ${m}: ${parts.join(' • ')}`;
          })
      .join('\n')
      : null;

  const bookkeepingBlock = bookkeepingNote
    ? [
        '### Bookkeeping Health',
        bookkeepingNote,
        'As Bizzi, you are also a friendly bookkeeping coach.',
        '- If the user asks about finances, confusion with their numbers, or why their insights look off, briefly explain that uncategorized transactions can cause inaccurate reports and reassure them this is common.',
        '- Suggest using the "Bookkeeping Cleanup" page under Financials to quickly review and approve categorization suggestions.',
        '- Offer to walk them through what categories mean (fuel, materials, subcontractors, equipment, etc.).',
      ].join('\n')
    : '';

  const recentChatHint =
    (Array.isArray(recentChat) && recentChat.length)
      ? `Avoid repeating what the last assistant message already said.`
      : null;

  // Task hints (conditional, compact)
  const taskHints = [];
  if (scheduleHint) {
    taskHints.push(
      'Scheduling: extract **title**, **date/time**, **type**. If explicitly asked to create an event, output a fenced JSON block:',
      '```json',
      '{ "action": "schedule_event", "title": "<title>", "date": "<ISO or natural>", "type": "<meeting|job|deadline>" }',
      '```'
    );
  }
  if (affordHint) {
    taskHints.push(
      'Affordability: return a **Verdict** (Yes/No/Depends), a short justification, and 2–3 specific actions.'
    );
  }
  if (metricHint || periodHint) {
    const mh = metricHint ? `metric: ${metricHint}` : null;
    const ph = periodHint ? `period: ${periodHint}` : null;
    taskHints.push(
      `KPI explain hints: ${[mh, ph].filter(Boolean).join(' • ')}. Use provided data; if missing, ask ≤2 clarifiers.`
    );
  }

  // Data discipline + safety
  const dataRules = [
    'Use only data provided here; do not invent numbers.',
    'If a key detail is missing, ask up to **two** clarifying questions at the end in one short line.',
    'Prefer concrete numbers ($, %) and specific, actionable recommendations.',
    'Do not claim you lack live data or that your knowledge is out of date; rely on provided context and web info.',
    'Resolve pronouns/typos using recent turns: if the last user/assistant message named a team/person/entity, assume follow-up pronouns or small misspellings refer to that same subject unless contradicted.',
  ].join(' ');

  const demoVoiceBlock = demoSnapshot
    ? [
        '### Demo Voice & Framing',
        '- Assume the supplied demo metrics are authoritative; cite the exact values (e.g., "$48,200 revenue", "62 Google Ads leads").',
        '- Answer like a cofounder in a stand-up: tight headline, metric bullets, then 2–3 decisive moves.',
        '- Tie every recommendation to a number, timeframe, or impact (e.g., "Collecting 50% of the $18.6k AR adds $9.3k cash").',
        '- Call out urgency if a metric implies risk (cash squeeze, overdue invoices) before the action list.',
        '- Close by offering to execute something tangible (draft an email, write ad copy, prep a call script).',
      ].join('\n')
    : '';

  const webBlock = hasWebContext
    ? [
        '### Web Context',
        'You have up-to-date web info for this question. Use it as factual grounding and speak confidently; do NOT mention that it came from a search or claim you lack live data. Mention the date if present (e.g., “as of Nov 18”). Prefer concise statements over meta commentary. Include one relevant authoritative link (e.g., nfl.com, espn.com, official team site) when helpful.',
        webContext,
      ].join('\n')
    : '';

  const webLimitBlock = webLimitExceeded
    ? 'Web lookups are unavailable right now (quota exhausted or not configured). Do NOT pretend to have live data. If they ask for live scores/news/weather, explain the limitation and offer 1–2 sites where they can check manually. Continue to answer from business data and general knowledge.'
    : '';

  return [
    // Identity (context-only)
    'You are Bizzi — business context follows. Use it to produce a precise, task-oriented answer.',
    'Mission: surface insights when they matter, warn early, and propose ranked next steps. Offer to execute simple actions (draft, schedule, checklist).',
    '',
    memoryContext ? `### Conversation Memory\n${memoryContext}` : '',
    '',
    '### Business Snapshot',
    bpLines || '- No profile details available.',
    '',
    metricLines ? '### Latest Metrics\n' + metricLines : '',
    accountsLine ? '\n' + accountsLine : '',
    '',
    movesBlock ? '### Suggested Financial Moves\n' + movesBlock : '',
    '',
    forecastBlock ? '### Forecast Preview\n' + forecastBlock : '',
    '',
    bookkeepingBlock,
    '',
    recentChatHint ? `> ${recentChatHint}` : '',
    '',
    webBlock,
    webLimitBlock,
    '',
    taskHints.length ? '### Task Hints\n' + taskHints.join('\n') : '',
    '',
      '### Data Discipline',
      dataRules,
    '',
    '### Differentiation',
    'Answer the exact question asked. Only restate the base snapshot metrics when the user explicitly requests a snapshot; otherwise, pull new angles, risks, or levers that match their wording. Vary the levers you highlight (cash, revenue, ops, marketing, risk) so consecutive answers don’t recycle the same talking points.',
    '',
    '### Action Variety',
    '- Within a conversation avoid repeating the same prescription (e.g., negotiating payroll vendor terms) unless the user explicitly asks about it. If something has already been recommended, switch to a different lever such as crew scheduling, overtime controls, AR timing, ad tweaks, or risk mitigation.',
    '- When the user asks “what’s urgent?” respond with a concise prioritised list (2–3 bullets) and only the metrics necessary to justify those picks.',
    '- Tie each action to a number, timing, or owner, but do not dump the full snapshot table unless it’s a snapshot request.',
    '',
    '### Snapshot Format (when requested)',
    '- Include a short headline (e.g., “Financial Snapshot — Nov 2025”).',
    '- Present a clean bullet list of the core metrics (Revenue, Expenses, Net Profit, Margin, Top spend).',
    '- Follow with a short interpretation (1–2 bullets or a paragraph) that explains what the numbers mean or how they changed.',
    '- Close with at least two concrete next steps tied to those numbers so the user immediately knows what to do with the snapshot.',
    '- If the user immediately follows up with “anything urgent?” or similar, avoid repeating the full snapshot—just reference the relevant metric briefly and give new actions.',
      demoVoiceBlock,
    ]
    .filter(Boolean)
    .join('\n');
}

// ───────────────────────────────────────────────────────────────────────────────
// NEW: Compose system messages (persona + style + context), with style LAST
// This is the recommended entry point for the main chat and dashboards.
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Compose persona + style (chat by default) + context.
 * - Uses buildPersonaSystems() so we can choose chat vs scaffolded based on intent/prompt/flags.
 *
 * @param {{
 *   intent?: string,
 *   module?: string,
 *   prompt?: string,
 *   surface?: 'chat'|'popover'|'chip'|'doc'|'card',
 *   flags?: { bad_news?: boolean, celebration?: boolean, quick?: boolean, deepDive?: boolean, wantStructure?: boolean },
 *   depth?: 'brief'|'standard'|'deep',
 *   style?: 'chat'|'scaffolded'  // optional explicit override
 * }} opts
 * @param {object} ctxArgs same args as buildBizzySystemPrompt (business data)
 * @returns {{ systemMessages: Array<{role:'system', content:string}>, style: string, depth: string }}
 */
function composeBizzySystemMessages(opts = {}, ctxArgs = {}) {
  const {
    intent = 'general',
    module = 'bizzy',
    prompt = '',
    surface,
    flags = {},
    depth,       // leave undefined to auto-pick
    style,       // leave undefined to auto-pick
  } = opts;

  // 1) Build context-only message
  const contextMsg = buildBizzySystemPrompt({ intent, ...ctxArgs });

  // 2) Compose persona + style (auto-selects chat vs scaffolded when style is undefined)
  const personaFlags = { ...flags };
  if (ctxArgs?.demoSnapshot) {
    personaFlags.demoPunchy = true;
    if (personaFlags.wantStructure == null) {
      personaFlags.wantStructure = true;
    }
  }

  const { systemMessages: personaAndStyle, style: chosenStyle, depth: chosenDepth } =
    buildPersonaSystems({
      intent,
      module,
      prompt,
      surface,
      flags: personaFlags,
      depth,
      // style (optional): if the caller passes style:'scaffolded', we honor it
      ...(style ? { style } : {}),
    });

  // 3) Style must “win last” — append context before persona/style block
  return {
    systemMessages: [
      { role: 'system', content: contextMsg },
      ...personaAndStyle,
    ],
    style: chosenStyle || style || 'chat',
    depth: chosenDepth || depth || 'standard',
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Legacy: if you must assemble style manually (not recommended anymore)
// Keeps backward compatibility for callers still using styleSpec directly.
// ───────────────────────────────────────────────────────────────────────────────
export function buildBizzySystemMessages_legacy(opts = {}, ctxArgs = {}) {
  const { intent = 'general', depth = 'standard', style = 'chat' } = opts;
  const contextMsg = buildBizzySystemPrompt({ intent, ...ctxArgs });
  const styleBlock =
    style === 'chat'
      ? buildChatStyleSystemMessages({ depth })
      : buildStyleSystemMessages({ intent, depth });

  return {
    systemMessages: [
      { role: 'system', content: contextMsg },
      ...(styleBlock?.systemMessages || []),
    ],
    styleVersion: styleBlock?.spec?.version || 'legacy',
  };
}

export const buildBizzySystemMessages = composeBizzySystemMessages;
export default buildBizzySystemPrompt;
