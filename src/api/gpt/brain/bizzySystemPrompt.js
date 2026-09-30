// File: /src/api/gpt/bizzySystemPrompt.js
//
// Purpose:
//  - Provide the *business/context* system message only (no tone/voice here).
//  - Persona (voice) + formatting (style) are composed via persona/helpers.
//  - Summarize context compactly and include task-specific advisory hints.
//  - Do NOT force output structure; styleSpec owns presentation rules.
//

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
  hasContext,
  memoryContext = '',
  businessProfile = null,
  monthlyMetrics = [],
  topAccounts = [],
  forecastData = [],
  recentChat = [],
  affordHint,
  metricHint,
  periodHint,
  demoSnapshot = null,
  webContext = '',
  hasWebContext = false,
  webLimitExceeded = false,
  webNotConfigured = false,
  bookkeepingNote = '',
  financialSource = '',
  accountingBasis = '',
  reportingPeriod = '',
  dataThroughDate = '',
  refreshedAt = '',
  userRequestedNavigation = false,
  userRequestedSave = false,
  accountStatus = null,
  financialSummary = null,
  plaidSummary = null,
  detailedContext = null,
  normalizedPeriod = null,
  loaderStatus = null,
} = {}) {
  // ────────────────────────────────────────────────────────────────────────────
  // NO CONTEXT VARIANT: allow general knowledge (operator-first behavior)
  // ────────────────────────────────────────────────────────────────────────────
  if (!hasContext) {
    return [
      // Identity (business brain context only; tone comes from persona)
      'Business context is not available for this turn. Continue as Bizzi’s conversational financial intelligence and advisory interface.',
      // General-knowledge allowance in chat-first model
      'You may answer useful general-business and stable general-knowledge questions, but your primary specialty remains financial operations. Do not force unrelated questions back into finance, and do not present yourself as a general-purpose lifestyle assistant.',
      // Data behavior
      'Operate safely without business data. Give the safe portion first, then ask the minimum questions needed; normally no more than two.',
      // Task hints (compact)
      affordHint
        ? 'Affordability: provide a **Verdict** (Yes/No/Depends), a brief justification, cash impact and timing when supported, and the safest meaningful action if one exists.'
        : '',
      hasWebContext
        ? [
            'Verified current external context is supplied below. Use it for time-sensitive facts, mention the relevant date when freshness matters, and include an authoritative link only when useful. Do not narrate the lookup process unless it helps evaluate uncertainty.',
            webContext,
          ].join('\n')
        : '',
      webLimitExceeded
        ? 'Current external lookup is unavailable. Say so briefly when the question requires live information, never fabricate it, and continue with available context or stable general knowledge.'
        : '',
      (!hasWebContext && (webLimitExceeded || webNotConfigured))
        ? 'Current external lookup is unavailable. Say so briefly only when freshness is required, never fabricate live information, and continue with what can be answered safely.'
        : '',
      'Supported outputs are advisory text, drafts, checklists, verified navigation suggestions when explicitly requested, and implemented P&L-report or document-save UI suggestions. None executes bookkeeping or an external action.',
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
    (bp.name || bp.business_name) ? `- Business: ${bp.name || bp.business_name}` : null,
    bp.industry ? `- Industry: ${bp.industry}` : null,
    (bp.location || bp.state) ? `- Location: ${bp.location || bp.state}` : null,
    (bp.team_size || bp.team_size === 0) ? `- Team Size: ${bp.team_size}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const metricLines = [
    financialSource ? `- Source: ${safeText(financialSource)}` : null,
    accountingBasis ? `- Accounting basis: ${safeText(accountingBasis)}` : null,
    (reportingPeriod || cur?.month) ? `- Reporting period: ${safeText(reportingPeriod || cur.month)}` : null,
    dataThroughDate ? `- Data through: ${safeText(dataThroughDate)}` : null,
    refreshedAt ? `- Refreshed at: ${safeText(refreshedAt)}` : null,
    (curRev != null) ? `- Revenue (available snapshot): ${fmtUsd(curRev)}` : null,
    (curExp != null) ? `- Expenses (available snapshot): ${fmtUsd(curExp)}` : null,
    (curNP != null) ? `- Net Profit (available snapshot): ${fmtUsd(curNP)}` : null,
    (curPM != null) ? `- Profit Margin (available snapshot): ${fmtPct(curPM)}` : null,
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
        'Clean bookkeeping is foundational to accurate financial decisions. Interpret the supplied status of Bizzi’s bookkeeping workflows without implying that chat maintains or changes the books.',
        '- If the user asks why numbers look off, explain (briefly) that uncategorized/misclassified transactions can distort reports.',
        '- Suggest Financials → Books at /dashboard/accounting/bookkeeping to review suggestions in Books Review.',
        '- Offer quick category translation (fuel, materials, subs, equipment, owner draw, transfers) without lecturing.',
      ].join('\n')
    : '';

  const recentChatHint =
    (Array.isArray(recentChat) && recentChat.length)
      ? `Avoid repeating what the last assistant message already said.`
      : null;

  // Task hints (conditional, compact)
  const taskHints = [];
  if (affordHint) {
    taskHints.push(
      'Affordability: return a **Verdict** (Yes/No/Depends), a short justification, supported cash impact and timing, and the safest meaningful action if one exists.'
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
    'Never invent user-specific business facts or financial figures. Use financial context supplied to this request for company-specific claims, verified current external context for time-sensitive external facts, and stable general knowledge for general explanations.',
    'Do not claim to have checked QuickBooks, a bank, or another live source unless the supplied context establishes the source and adequate freshness. Attribute claims precisely, such as “Based on the QuickBooks data available here” or “As of the latest refresh shown.”',
    'Preserve transaction state, reporting period, cash/accrual basis, and data-through or refresh date when supplied. Pending is not ready for bookkeeping action; Needs Review requires a decision; Handled is staged in the grace period, not posted; posting-failed did not reach QuickBooks; Posted reached QuickBooks; Matched links existing QuickBooks activity rather than creating a new posting; and a report snapshot is dated evidence, not a live check.',
    'If unresolved bookkeeping materially affects the conclusion, say which conclusion may be distorted; otherwise omit generic data-quality caveats.',
    'Give the safe portion first, then ask the minimum clarifying questions needed; normally no more than two.',
    'Use concrete numbers and specific recommendations only when supported and useful.',
    'Preserve metric semantics: revenue is not cash collected, revenue is not net income, bank balance is not profit, a Plaid balance is not a QuickBooks book balance, and an invoice amount is not collected cash.',
    'When the user asks how much money they made, interpret it as revenue unless recent conversation clearly establishes another measure; identify that interpretation and include net income only when supplied.',
    'Treat canonical account-status true, false, and unknown distinctly. Never call an integration disconnected when its status or status loader is unknown/error.',
    'For a company-specific financial request: if the named integration is confirmed disconnected, name it; if it is connected but the relevant loader failed, say it is connected but the requested figures could not be retrieved right now; if the loader succeeded with no qualifying rows, say no qualifying data was found for the requested period; if data is stale, answer from it and state the cutoff.',
    'Resolve pronouns/typos using recent turns: if the last user/assistant message named a team/person/entity, assume follow-up pronouns or small misspellings refer to that same subject unless contradicted.',
  ].join(' ');

  const demoVoiceBlock = demoSnapshot
    ? [
        '### Demo Voice & Framing',
        '- Assume the supplied demo metrics are authoritative; cite exact values (e.g., "$48,200 revenue", "62 Google Ads leads").',
        '- Answer like an operator update: lead with the material finding and use metric bullets only when they improve scanning.',
        '- Tie recommendations to supplied numbers, timeframes, or impact when supported (e.g., "Collecting 50% of the $18.6k AR adds $9.3k cash").',
        '- Call out urgency when a supplied metric indicates material risk. Add actions or an offer only when useful.',
      ].join('\n')
    : '';

  const webBlock = hasWebContext
    ? [
        '### Web Context',
        'Verified current external context is available for this question. Use it as factual grounding, mention the relevant date when freshness matters, and include an authoritative link only when genuinely useful. Do not narrate the lookup process unless it helps the user evaluate uncertainty.',
        webContext,
      ].join('\n')
    : '';

  const webLimitBlock = webLimitExceeded
    ? 'Current external lookup is unavailable. Say so briefly when the answer requires fresh information, never fabricate live facts, and continue with available business context or stable general knowledge.'
    : '';

  return [
    // Identity (context-only)
    'Business context follows. Use it to produce a precise, task-oriented answer under the stable chat identity and capability contract above.',
    'Core chat job: answer the exact question, use the most relevant financial evidence, explain the implication plainly, and recommend an action only when a meaningful one exists.',
    'You are not a generic “AI cofounder.” Think like the owner’s finance operator/controller while remaining an advisory conversational interface.',
    '',
    memoryContext ? `### Conversation Memory\n${memoryContext}` : '',
    '',
    '### Business Snapshot',
    bpLines || '- No profile details available.',
    '',
    metricLines ? '### Available Financial Snapshot\n' + metricLines : '',
    accountsLine ? '\n' + accountsLine : '',
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
    accountStatus ? `### Account Status (canonical persisted facts)\n${JSON.stringify(accountStatus)}` : '',
    financialSummary ? `### Financial Summary (bounded)\n${JSON.stringify(financialSummary)}` : '',
    plaidSummary ? `### Plaid Balance Summary (cached; not QuickBooks book balance)\n${JSON.stringify(plaidSummary)}` : '',
    normalizedPeriod ? `### Requested Period\n${JSON.stringify(normalizedPeriod)}` : '',
    detailedContext ? `### Intent-Specific Context\n${JSON.stringify(detailedContext)}` : '',
    loaderStatus ? `### Context Availability\n${JSON.stringify(loaderStatus)}` : '',
    '',
    '### Chat Artifacts & Save Suggestions',
    'Supported output contracts: ordinary advisory text; drafted text and checklists; P&L artifacts under the conditions below; navigation suggestions only when explicitly requested; and rare document-save suggestions. These outputs do not execute bookkeeping or external actions.',
    '- Default: do not include artifacts, navigation actions, or doc suggestions unless conditions apply.',
    '- Do NOT add alert/flag artifacts here; Insights owns alerts.',
    '- P&L artifact: add only when discussing P&L values for a specific month or when the user explicitly asks for a P&L/report/PDF. Use /dashboard/accounting/reports?month=YYYY-MM&open=pnl.',
    `- Navigation action (type "navigate"): only include when the user explicitly asked to open or find a page. userRequestedNavigation=${userRequestedNavigation ? 'true' : 'false'}.`,
    '- Doc suggestion: set doc_suggestion.should_show=true only when the user asked to save OR when this is a recurring/strategic decision; keep this rare. reason ∈ {"user_requested","strategic_decision"}. Include suggested_title when clear.',
    '- Structured response envelope: normally return ordinary text. Only when a supported UI output is needed, return one JSON object with exactly this shape: {"content":"answer text","artifacts":[{"type":"pnl_pdf","title":"...","subtitle":"...","url":"/dashboard/accounting/reports?month=YYYY-MM&open=pnl"}],"actions":[{"type":"navigate","label":"...","payload":{"to":"verified route"}}],"doc_suggestion":{"should_show":false,"reason":"user_requested|strategic_decision","suggested_title":"..."}}. Omit unused array items, use null for an unused doc_suggestion, and never add other action or artifact types.',
    userRequestedSave ? '- The user just asked to save; if you surface doc_suggestion, mark reason="user_requested".' : '',
    '',
    '### Data Discipline',
    dataRules,
    '',
    '### Differentiation',
    'Answer the exact question asked. Only restate the base snapshot metrics when explicitly requested; otherwise, use the most relevant evidence and explain its implication. Do not force unrelated questions back into finance or bookkeeping.',
    '',
    '### Action Variety',
    '- Avoid repeating a prescription across consecutive replies unless it remains materially relevant or the user asks.',
    '- When the user asks “what’s urgent?”, respond with a concise prioritized list (2–3 bullets) and only the metrics needed to justify those picks.',
    '- When recommending action, tie it to supported money, timing, impact, responsibility, job, vendor, customer, invoice, or account details where useful. Never invent specificity.',
    '',
    '### Snapshot Format (when requested)',
    '- Include a short headline (e.g., “Financial Snapshot — Nov 2025”).',
    '- Present a clean bullet list of core metrics (Revenue, Expenses, Net Profit, Margin, Top spend).',
    '- Follow with a short interpretation (1–2 bullets or a paragraph) that explains what the numbers mean or how they changed.',
    '- Add a concrete next step only when the snapshot supports a meaningful action.',
    '- If the user follows with “anything urgent?”, avoid repeating the full snapshot — just reference the relevant metric briefly and give new actions.',
    demoVoiceBlock,
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ───────────────────────────────────────────────────────────────────────────────
// Compose system messages in authority order: stable persona/capabilities,
// presentation guidance, then dynamic context and constrained output contracts.
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

  // Stable policy and style precede dynamic context/output contracts. No later
  // prompt layer may broaden the capability contract compiled by personaSpec.
  return {
    systemMessages: [
      ...personaAndStyle,
      { role: 'system', content: contextMsg },
    ],
    style: chosenStyle || style || 'chat',
    depth: chosenDepth || depth || 'standard',
  };
}

export const buildBizzySystemMessages = composeBizzySystemMessages;
export default buildBizzySystemPrompt;
