// File: /src/api/gpt/generateBizzyResponse.js
import { supabase } from '../../../services/supabaseAdmin.js';
import OpenAI from 'openai';
import { retrieveRelevantMemories, storeMemory } from './bizzyMemoryService.js';
import { buildBizzySystemPrompt, buildBizzySystemMessages } from './bizzySystemPrompt.js';
import { getEmbedding } from '../../../utils/openaiEmbedding.js';
import { detectAffordabilityIntent, extractExpenseDetails } from '../affordabilityParser.js';
import { saveCalendarEvent } from '../../../services/calendar/saveCalendarEvent.js';
import { buildPersonaSystems } from './persona.helpers.js';
import { intentToModule } from '../utils/intentToModule.js';
import { generateThreadTitle } from '../../chats/title.util.js';
import { webLookup } from '../webLookup.js';
import { getBookkeepingHealth } from '../../accounting/bookkeepingHealth.js';
import {
  identifyOnboardingPrompt,
  buildOnboardingGuide,
  buildOnboardingToneBlock,
} from '../../../config/onboardingPromptBank.js';

// 👉 NEW: demo-mode helpers
import { isDemoMode, loadDemoData } from '../../../services/demo/loadDemoData.js';

const openaiKey = process.env.OPENAI_API_KEY || '';
const openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null;
const BIZZY_CHAT_MODEL = process.env.BIZZY_GPT_MODEL || 'gpt-5.1';
const isGpt5Model = /^gpt-5/i.test(BIZZY_CHAT_MODEL || '');

function flattenMessageContent(content) {
  const chunks = Array.isArray(content) ? content : [content];
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk;
      if (typeof chunk?.text === 'string') return chunk.text;
      if (chunk?.text?.value) return chunk.text.value;
      if (typeof chunk?.content === 'string') return chunk.content;
      if (Array.isArray(chunk?.content)) return flattenMessageContent(chunk.content);
      try {
        return JSON.stringify(chunk ?? '');
      } catch {
        return String(chunk ?? '');
      }
    })
    .join('\n');
}

function prepareResponsesInput(messages = []) {
  const instructions = [];
  const conversation = [];

  messages.forEach((msg) => {
    const role = sanitizeRole(msg.role);
    const textBody = flattenMessageContent(msg.content);

    if (!textBody) return;

    if (role === 'system' || role === 'developer') {
      instructions.push(textBody);
      return;
    }

    conversation.push({
      role,
      content: [{ type: 'input_text', text: textBody }],
    });
  });

  return {
    instructions: instructions.join('\n\n'),
    conversation,
  };
}

function extractResponseText(resp) {
  if (!resp) return '';

  if (Array.isArray(resp.output_text) && resp.output_text.length) {
    return resp.output_text.join('\n').trim();
  }

  const messageBlock = resp.output?.find((p) => p.type === 'message');
  if (messageBlock?.content?.length) {
    return messageBlock.content
      .map((chunk) => {
        if (!chunk) return '';
        if (typeof chunk === 'string') return chunk;
        if (chunk?.text && typeof chunk.text === 'string') return chunk.text;
        if (chunk?.text?.value) return chunk.text.value;
        return '';
      })
      .join('')
      .trim();
  }

  const reasoning = resp.output?.find((p) => p.type === 'reasoning');
  if (reasoning?.content?.length) {
    const text = reasoning.content
      .map((chunk) => chunk?.text || chunk?.text?.value || '')
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) return text;
  }

  const choice = resp.choices?.[0]?.message?.content;
  if (typeof choice === 'string') return choice.trim();
  if (Array.isArray(choice)) {
    return choice
      .map((c) => (typeof c === 'string' ? c : c?.text || ''))
      .join('')
      .trim();
  }
  return '';
}

function detectSchedulingIntent(text) {
  const triggers = ['schedule', 'set a reminder', 'book a meeting', 'add to calendar'];
  return triggers.some((t) => String(text || '').toLowerCase().includes(t));
}

const sanitizeRole = (r) => {
  const v = String(r || '').toLowerCase();
  if (v === 'bizzy') return 'assistant';
  if (v === 'assistant' || v === 'user' || v === 'system' || v === 'developer') return v;
  return 'assistant';
};

const BASE_SYSTEM =
  'You are Bizzi, a helpful AI cofounder for home service businesses. Be concise, pragmatic, and specific.';

const preview = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 140);

const WEB_LOOKUP_LIMIT = 20;

const CHECKLIST_TEMPLATE = [
  { key: 'business_profile', label: 'Business profile' },
  { key: 'quickbooks', label: 'QuickBooks' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'email', label: 'Email' },
  { key: 'job_tool', label: 'Job tool' },
];

function buildOnboardingChecklist({ businessProfileComplete, qbConnected }) {
  return CHECKLIST_TEMPLATE.map((item) => {
    if (item.key === 'business_profile') {
      return { ...item, status: businessProfileComplete ? 'done' : 'pending' };
    }
    if (item.key === 'quickbooks') {
      return { ...item, status: qbConnected ? 'done' : 'pending' };
    }
    return { ...item, status: 'pending' };
  });
}

function formatChecklistText(items = []) {
  return items
    .map((item) => {
      const icon = item.status === 'done' ? '✅' : '⏳';
      return `${icon} ${item.label}`;
    })
    .join('\n');
}

function needsWebLookup(message, intent) {
  const text = String(message || '').toLowerCase();
  const businessGuard = /\b(cash flow|quickbooks|invoice|invoices|ar|accounts receivable|ap|payables|job|crew|marketing|ad spend|tax|forecast|kpi|profit|revenue|expenses|payroll|vendor|invoice)\b/;
  if (businessGuard.test(text)) return false;

  const liveSignals = [
    /\b(nba|nfl|mlb|nhl|soccer|premier league|record|score|scores|standings|schedule|playoffs|bracket|game today|games today)\b/,
    /\b(beat|win|won|lost|loss|score|who did (they|the) beat)\b/,
    /\b(stock|share price|ticker|price today|market close|market open)\b/,
    /\b(latest news|breaking news|what.?s happening|what happened today|this week|today|this morning|this evening)\b/,
    /\b(weather|forecast today|temperature|rain|snow)\b/,
  ];

  return liveSignals.some((re) => re.test(text));
}

// Coerce the settled embedding result to a non-empty float array or null
const normalizeVec = (settled) => {
  if (!settled || settled.status !== 'fulfilled') return null;

  const v = settled.value;
  const arr =
    Array.isArray(v) ? v :
    Array.isArray(v?.embedding) ? v.embedding :
    Array.isArray(v?.data) ? v.data :
    null;

  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.map(Number);
};

export async function generateBizzyResponse({
  user_id,
  message,
  type = null,
  parsedInput = null,
  styleMessages = [],
  personaMessage = null,
  threadId = null,
  business_id: businessIdFromHandler = null,
}) {
  const started = Date.now();
  console.log('[gpt] start', { user_id, threadId, business_id: businessIdFromHandler });
  const llmInvocation = {
    requested_model: BIZZY_CHAT_MODEL,
    method: isGpt5Model ? 'responses' : 'chat.completions',
  };
  // Shared holders for optional web context
  let webContext = '';
  let webLookupUsed = false;
  let webNotConfigured = false;
  const hasWebKey = !!process.env.SERPAPI_API_KEY;

  try {
    if (!user_id || !message) {
      return { responseText: 'Missing user_id or message.', suggestedActions: [], followUpPrompt: '' };
    }

    // Intent routing (unchanged)
    console.log('[gpt] intent', { type, intent: type || 'general' });
    if (!type) {
      if (detectAffordabilityIntent(message)) {
        const parsed = extractExpenseDetails(message);
        return await generateBizzyResponse({
          user_id, message, type: 'affordability_check',
          parsedInput: { ...parsedInput, affordHint: parsed }, styleMessages, personaMessage,
          threadId, business_id: businessIdFromHandler,
        });
      }
      if (detectSchedulingIntent(message)) {
        return await generateBizzyResponse({
          user_id, message, type: 'calendar_schedule',
          parsedInput: { ...parsedInput, scheduleHint: message }, styleMessages, personaMessage,
          threadId, business_id: businessIdFromHandler,
        });
      }
    }
    const intent = type || 'general';

    // Usage soft cap (unchanged)
    console.log('[gpt] usage-check ok');
    const now = new Date();
    const currentMonth = now.toISOString().slice(0, 7);
    let usageRow = null;
    let webLookupsThisMonth = 0;
    let webLimitReached = false;
    try {
      const { data: usageData } = await supabase
        .from('gpt_usage')
        .select('query_count, web_lookups')
        .eq('user_id', user_id)
        .eq('month', currentMonth)
        .maybeSingle();
      usageRow = usageData || null;
      const currentCount = usageData?.query_count || 0;
      webLookupsThisMonth = usageData?.web_lookups || 0;
      if (currentCount >= 300) {
        return {
          responseText:
            "You've reached the current 300-query monthly limit. Try again next month or contact support to raise the cap.",
          suggestedActions: [],
          followUpPrompt: '',
        };
      }
      webLimitReached = webLookupsThisMonth >= WEB_LOOKUP_LIMIT;
    } catch {}

    // Resolve business id (unchanged)
    console.log('[gpt] business resolved', { businessId: businessIdFromHandler });
    let businessId = businessIdFromHandler;
    let businessProfile = null;
    let bookkeepingHealth = null;
    let businessProfileComplete = false;
    let hasViewedIntegrationsPage = false;
    let onboardingCompletedOnce = false;
    let qbConnected = false;
    try {
      const profileColumns = 'id,business_name,name,business_type,industry,location,team_size,has_viewed_integrations_page,onboarding_completed_once';
      if (businessId) {
        const { data: bp } = await supabase
          .from('business_profiles')
          .select(profileColumns)
          .eq('id', businessId)
          .maybeSingle();
        businessProfile = bp || null;
      } else {
        const { data: bp } = await supabase
          .from('business_profiles')
          .select(profileColumns)
          .eq('user_id', user_id)
          .maybeSingle();
        businessProfile = bp || null;
        businessId = bp?.id || null;
      }
    } catch {}

    const profileName = businessProfile?.business_name || businessProfile?.name || '';
    businessProfileComplete = Boolean(
      profileName &&
      businessProfile?.industry &&
      (businessProfile?.business_type || businessProfile?.businessType)
    );
    hasViewedIntegrationsPage = Boolean(businessProfile?.has_viewed_integrations_page);
    onboardingCompletedOnce = Boolean(businessProfile?.onboarding_completed_once);

    if (businessId) {
      try {
        const { data: qbRow } = await supabase
          .from('quickbooks_tokens')
          .select('business_id')
          .eq('business_id', businessId)
          .maybeSingle();
        qbConnected = !!qbRow;
      } catch {}
    }

    // Fetch bookkeeping health snapshot to inform coaching behaviors
    try {
      if (businessId) {
        bookkeepingHealth = await getBookkeepingHealth(businessId);
        if (bookkeepingHealth) {
          bundle.bookkeepingHealth = bookkeepingHealth;
        }
      }
    } catch (e) {
      console.warn('[bizzy] bookkeeping health fetch failed', e?.message || e);
    }

    // Build input bundle (existing)
    const bundle = parsedInput || {};

    const onboardingComplete = businessProfileComplete && qbConnected && hasViewedIntegrationsPage;
    const onboardingModeActive = onboardingCompletedOnce ? false : !onboardingComplete;
    const onboardingChecklist = buildOnboardingChecklist({ businessProfileComplete, qbConnected });
    const onboardingHintId = parsedInput?.onboardingPromptId;
    const onboardingMatch = identifyOnboardingPrompt(message, onboardingHintId);
    const showOnboardingTone = onboardingModeActive || !!onboardingMatch;
    const checklistText = formatChecklistText(onboardingChecklist);
    const onboardingToneBlock = showOnboardingTone ? buildOnboardingToneBlock(onboardingMatch?.title || null) : null;
    const onboardingGuide = onboardingMatch ? buildOnboardingGuide(onboardingMatch, { checklist: checklistText }) : null;
    const onboardingSuggestedActions = onboardingMatch?.suggestedActions || [];
    const onboardingFollowUp = onboardingMatch?.followUpPrompt || '';
    const onboardingMeta = {
      active: showOnboardingTone,
      promptId: onboardingMatch?.id || null,
      completedOnce: onboardingCompletedOnce,
      checklist: onboardingChecklist,
      profileComplete: businessProfileComplete,
      qbConnected,
      hasViewedIntegrationsPage,
    };
    bundle.onboardingPromptId = onboardingMatch?.id || onboardingHintId || null;
    bundle.onboardingChecklist = onboardingChecklist;

    // ───────────────────────────────────────────────
    // DEMO MODE: hydrate bundle with demo data
    // ───────────────────────────────────────────────
    let demoData = null;
    if (isDemoMode()) {
      try {
        demoData = await loadDemoData();
        if (demoData) {
          // Derive KPI row to match your schema (month, totals, margin, top_spending_category)
          const monthTag = new Date().toISOString().slice(0, 7);
          const fin = demoData?.financials || {};
          const demoKpi = {
            month: monthTag,
            total_revenue: fin.mtdRevenue ?? 0,
            total_expenses: fin.mtdExpenses ?? 0,
            net_profit: fin.mtdProfit ?? 0,
            profit_margin: fin.profitMarginPct ?? 0,
            top_spending_category: Array.isArray(fin.topCostDrivers) && fin.topCostDrivers[0]?.name
              ? fin.topCostDrivers[0].name
              : null
          };

          // Prime the bundle so the rest of your pipeline treats it as first-class context
          if (!Array.isArray(bundle.kpis) || bundle.kpis.length === 0) {
            bundle.kpis = [demoKpi];
          }
          if (!Array.isArray(bundle.forecast) || bundle.forecast.length === 0) {
            if (fin?.forecastNext30d) {
              bundle.forecast = [{
                month: monthTag,
                cash_in: Number(fin.forecastNext30d?.cashIn ?? 0),
                cash_out: Number(fin.forecastNext30d?.cashOut ?? 0),
                net_cash: Number(fin.forecastNext30d?.net ?? 0),
              }];
            }
          }
          // You can also attach lightweight “moves” if you want them:
          if (!Array.isArray(bundle.moves) || bundle.moves.length === 0) {
            bundle.moves = [
              ...(fin?.topCostDrivers ? [{
                title: `Negotiate ${fin.topCostDrivers[0]?.name || 'top cost'} vendor terms`,
                rationale: 'Largest contributor to spend; 5–10% reduction yields material impact.'
              }] : [])
            ];
          }

          if (!bundle.unpaidCustomers && Array.isArray(fin?.unpaidCustomers)) {
            const jobLookup = new Map(
              (demoData?.jobs?.topUnpaid || []).map((job) => [job.external_id || job.id, job.title || job.name || ""])
            );
            bundle.unpaidCustomers = fin.unpaidCustomers.map((row) => ({
              ...row,
              project: jobLookup.get(row.invoiceId) || null,
            }));
          }

          // Attach raw demo snapshot for prompt context
          bundle.demoSnapshot = demoData;
        }
      } catch (e) {
        console.warn('[demo] loadDemoData failed:', e?.message || e);
      }
    }
    // ───────────────────────────────────────────────

    // Support data fetches (unchanged)
    const needKPIs     = !Array.isArray(bundle.kpis)     || bundle.kpis.length === 0;
    const needForecast = !Array.isArray(bundle.forecast) || bundle.forecast.length === 0;
    const needMoves    = !Array.isArray(bundle.moves)    || bundle.moves.length === 0;

    const supportPromises = [];
    if (businessId && (needKPIs || needForecast || needMoves)) {
      if (needKPIs) {
        supportPromises.push(
          supabase
            .from('financial_metrics')
            .select('month,total_revenue,total_expenses,net_profit,profit_margin,top_spending_category')
            .eq('business_id', businessId)
            .order('month', { ascending: false })
            .limit(3)
            .then(({ data }) => ({ kpis: data || [] }))
        );
      }
      if (needForecast) {
        supportPromises.push(
          supabase
            .from('cashflow_forecast')
            .select('month,cash_in,cash_out,net_cash')
           .eq('business_id', businessId)
           .order('month', { ascending: true })
           .limit(6)
            .then(({ data }) => ({ forecast: data || [] }))
        );
      }
      if (needMoves) {
        supportPromises.push(
          supabase
            .from('financial_moves')
            .select('*')
            .eq('business_id', businessId)
            .order('month', { ascending: false })
            .limit(3)
            .then(({ data }) => ({ moves: data || [] }))
        );
      }
    }

    const mergedSupport = {};
    if (supportPromises.length) {
      const settled = await Promise.allSettled(supportPromises);
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) Object.assign(mergedSupport, r.value);
      }
    }

    const kpis       = Array.isArray(bundle.kpis) && bundle.kpis.length ? bundle.kpis : (mergedSupport.kpis || []);
    const forecast   = Array.isArray(bundle.forecast) && bundle.forecast.length ? bundle.forecast : (mergedSupport.forecast || []);
    const moves      = Array.isArray(bundle.moves) && bundle.moves.length ? bundle.moves : (mergedSupport.moves || []);
    let recentChat = Array.isArray(bundle.recentChat) ? bundle.recentChat : [];
    let recentChatSummary = '';

    // Fallback: load recent thread turns if not already present
    if ((!recentChat || recentChat.length === 0) && threadId) {
      try {
        const { data: recentMsgs } = await supabase
          .from('gpt_messages')
          .select('role, content')
          .eq('thread_id', threadId)
          .order('created_at', { ascending: false })
          .limit(12); // fetch a bit more so we can summarize older turns
        if (Array.isArray(recentMsgs) && recentMsgs.length) {
          recentChat = recentMsgs.slice(0, 6);
          const older = recentMsgs.slice(6);
          if (older.length) {
            // Compact summary of older turns (prevents token blow-up)
            const cleaned = older
              .map((m) => {
                const role = sanitizeRole(m.role) || 'user';
                const text = String(m.content || '').replace(/\s+/g, ' ').trim();
                return text ? `${role}: ${text}` : '';
              })
              .filter(Boolean);
            const flat = cleaned.join(' • ');
            recentChatSummary = flat.slice(0, 600);
          }
        }
      } catch (e) {
        console.warn('[recentChat fallback] load failed:', e?.message || e);
      }
    }

    // Memory fetch (unchanged; we’ll also append a demo snapshot if present)
    let memoryContext = '';
    try {
      const memorySnippets = await retrieveRelevantMemories(user_id, message);
      memoryContext = memorySnippets?.length
        ? `Context from past Bizzi conversations:\n${memorySnippets.map((m) => m.summary).join('\n')}`
        : '';
    } catch {}

    if (recentChatSummary) {
      memoryContext += `\n\nRecent conversation summary (older turns): ${recentChatSummary}`;
    }

    if (kpis?.length) {
      const r = kpis[0];
      memoryContext += `\n\nRecent financial summary:\nRevenue $${r.total_revenue} • Expenses $${r.total_expenses} • Net Profit $${r.net_profit} • Margin ${r.profit_margin}% • Top spend: ${r.top_spending_category}.`;
    }
    if (moves?.length) {
      const previewList = moves.map((m) => `- ${m.title}: ${m.rationale}`).join('\n');
      memoryContext += `\n\nSuggested Financial Moves:\n${previewList}`;
    }

    // Heuristic: capture latest subject from recent turns to help disambiguate pronouns/typos
    const resolveSubjectFromText = (txt = '') => {
      const lower = txt.toLowerCase();
      const knownTeams = ['panthers', 'carolina panthers', 'hornets', 'charlotte hornets'];
      for (const t of knownTeams) {
        if (lower.includes(t)) return t;
      }
      return null;
    };
    const latestTurnText = [
      ...(Array.isArray(recentChat) ? recentChat : []),
    ]
      .map((m) => String(m?.content || ''))
      .filter(Boolean);
    const combinedTurns = latestTurnText.join(' • ');
    const latestSubject = resolveSubjectFromText(combinedTurns) || resolveSubjectFromText(webContext);
    if (latestSubject) {
      memoryContext += `\n\nRecent subject (for pronouns/typos): ${latestSubject}. If the user says "they/the/them" or misspells it, assume they mean ${latestSubject} unless the user clearly switches topics.`;
    }

    // If we see a sports subject and a sports-ish query, force web lookup even if detector missed it
    const forceSportsLookup = latestSubject && /panthers|hornets|nfl|nba|score|record|beat|won|lost/i.test(message || '');
    const wantsWebLookup = needsWebLookup(message, intent) || forceSportsLookup;

    // Web lookup (time-sensitive questions)
    webNotConfigured = wantsWebLookup && !hasWebKey;
    if (wantsWebLookup) {
      console.log('[webLookup] intent', { wantsWebLookup, hasWebKey, webLimitReached, webNotConfigured });
    }
    if (wantsWebLookup && hasWebKey && !webLimitReached) {
      try {
        const webText = await webLookup(message);
        if (webText) {
          webContext = webText;
          webLookupUsed = true;
          console.log('[webLookup] hydrated context preview', webText.slice(0, 200));
          // increment web_lookups in gpt_usage
          try {
            if (usageRow) {
              await supabase
                .from('gpt_usage')
                .update({ web_lookups: (usageRow.web_lookups || 0) + 1 })
                .eq('user_id', user_id)
                .eq('month', currentMonth);
            } else {
              await supabase
                .from('gpt_usage')
                .insert({
                  user_id,
                  month: currentMonth,
                  query_count: usageRow?.query_count || 0,
                  web_lookups: 1,
                });
            }
          } catch (e) {
            console.error('[webLookup usage increment]', e?.message || e);
          }
        }
        if (!webText) {
          console.warn('[webLookup] no results returned');
        }
      } catch (e) {
        console.error('[webLookup]', e?.message || e);
      }
    }

    // Sports-specific helpful links when we are likely answering sports queries
    if (wantsWebLookup && /panthers|nfl|football|score|standing|record/i.test(`${message} ${webContext} ${memoryContext}`)) {
      const links = [
        'https://www.nfl.com/scoreboard',
        'https://www.panthers.com/schedule',
        'https://www.espn.com/nfl/team/_/name/car/carolina-panthers',
      ];
      memoryContext += `\n\nReference links: ${links.join(' | ')}`;
    }

    // 👉 DEMO: add snapshot bullets to memory context (does not affect prod)
    if (demoData) {
      const fin = demoData?.financials || {};
      const mkt = demoData?.marketing || {};
      const job = demoData?.jobs || {};
      const tax = demoData?.tax || {};
      memoryContext += `

[Demo Business Snapshot]
- Business: ${demoData?.meta?.businessName || 'Demo Co.'} (${demoData?.meta?.period || ''})
- Cash on hand: $${fin?.cashOnHand ?? '—'} • AR outstanding: $${fin?.arOutstanding ?? 0}
- MTD Revenue: $${fin?.mtdRevenue ?? 0} • Expenses: $${fin?.mtdExpenses ?? 0} • Profit: $${fin?.mtdProfit ?? 0} • Margin: ${fin?.profitMarginPct ?? 0}%
- Leads MTD: ${mkt?.leadsMTD ?? 0} (Best channel: ${(mkt?.channels?.[0]?.name || 'Google Ads')})
- Upcoming: ${(demoData?.calendar?.upcoming || []).map(e => e.title).join(', ') || 'No major events'}
${Array.isArray(fin?.unpaidCustomers) && fin.unpaidCustomers.length
  ? '- Customers with unpaid invoices:\n' + fin.unpaidCustomers.map((row) => {
      const jobMatch = (demoData?.jobs?.topUnpaid || []).find(
        (j) => (j.external_id || j.id) === row.invoiceId
      );
      const project = jobMatch?.title ? ` — ${jobMatch.title}` : '';
      const contact = row.contact ? ` (contact: ${row.contact})` : '';
      return `  • Invoice ${row.invoiceId}${project} for ${row.name}: $${row.amount} due ${row.dueDate || 'N/A'} (${row.daysLate || 0} days late)${contact}`;
    }).join('\n')
  : ''}
`;
      if (Array.isArray(fin?.unpaidCustomers) && fin.unpaidCustomers.length) {
        const jobLookup = new Map(
          (demoData?.jobs?.topUnpaid || []).map((j) => [j.external_id || j.id, j.title || j.name || ""])
        );
        memoryContext += `\n### Demo AR Details\n${fin.unpaidCustomers
          .map((row) => {
            const project = jobLookup.get(row.invoiceId);
            const contact = row.contact ? `Contact: ${row.contact}.` : "";
            return `- Invoice ${row.invoiceId} ${project ? `(${project}) ` : ""}for ${row.name}: $${row.amount} due ${
              row.dueDate || "N/A"
            } (${row.daysLate || 0} days late). ${contact}`;
          })
          .join("\n")}\n`;
      }
    }

    const hasContext = !!(businessProfile || kpis?.length || forecast?.length || moves?.length || demoData);

    const bookkeepingNote =
      bookkeepingHealth?.uncategorized_count > 0
        ? `This business has ${bookkeepingHealth.uncategorized_count} uncategorized transactions in QuickBooks. You can help them understand why this matters, and direct them to the "Bookkeeping Cleanup" page in Financials to fix it.`
        : '';

    console.log('[gpt] building prompt', { webLookupUsed: webLookupUsed ? true : false, webLimitReached, webNotConfigured });
    const systemPrompt = buildBizzySystemPrompt({
      hasContext,
      memoryContext,
      businessProfile,
      financials: null,
      goals: null,
      timeline: null,
      monthlyMetrics: kpis,
      topAccounts: bundle.accounts || [],
      moveSuggestions: moves,
      forecastData: forecast,
      recentChat,
      scheduleHint: bundle.scheduleHint,
      affordHint: bundle.affordHint,
      bookkeepingNote,
      metricHint: bundle.metricHint,
      periodHint: bundle.periodHint,
      demoSnapshot: demoData,
      webContext,
      hasWebContext: !!webContext,
      webLimitExceeded: wantsWebLookup && (webLimitReached || webNotConfigured),
      webNotConfigured,
    });

    const chatHistoryFormatted =
      Array.isArray(recentChat) && recentChat.length
        ? [...recentChat]
            .reverse()
            .map((msg) => ({
              role: sanitizeRole(msg.role),
              content: String(msg.content || '').slice(0, 4000),
            }))
            .filter((m) => m.content)
        : [];

    const { systemMessages: personaAndStyle } = buildBizzySystemMessages(
      {
        intent,
        module: intentToModule(intent),
        prompt: message,
        surface: 'chat',
      },
      {
        hasContext,
        memoryContext,
        businessProfile,
        monthlyMetrics: kpis,
        topAccounts: bundle.accounts || [],
        moveSuggestions: moves,
        forecastData: forecast,
        recentChat,
        scheduleHint: bundle.scheduleHint,
        affordHint: bundle.affordHint,
        bookkeepingNote,
        metricHint: bundle.metricHint,
        periodHint: bundle.periodHint,
        demoSnapshot: demoData,
        webContext,
        hasWebContext: !!webContext,
        webLimitExceeded: wantsWebLookup && (webLimitReached || webNotConfigured),
        webNotConfigured,
      }
    );

    const messages = [
      ...(onboardingToneBlock ? [{ role: 'system', content: onboardingToneBlock }] : []),
      ...personaAndStyle,
      ...(onboardingGuide ? [{ role: 'system', content: onboardingGuide }] : []),
      ...chatHistoryFormatted,
      { role: 'user', content: message },
    ];

    // 👉 Ensure a thread id exists here too (covers legacy callers)
    let localThreadId = threadId || null;
    if (!localThreadId && businessId) {
      try {
        const fallbackTitle = (message || 'New conversation').slice(0, 60);
        const module = intentToModule(intent || 'general');
        const { data: created, error: tErr } = await supabase
          .from('gpt_threads')
          .insert({
            user_id,
            business_id: businessId,
            title: fallbackTitle,
            first_intent: intent || 'general',
            module,
          })
          .select('id')
          .single();
        if (tErr) {
          console.error('[thread create in core] failed:', tErr);
        } else if (created?.id) {
          localThreadId = created.id;
        }
      } catch (e) {
        console.error('[thread create in core] hard fail:', e?.message || e);
      }
    }

    console.log('[gpt] calling LLM');
    // LLM call — use chat completions for stability
    let bizzyReply = null;
    let lastResponseDebug = null;
    try {
      if (openai) {
        const completion = await openai.chat.completions.create({
          model: BIZZY_CHAT_MODEL,
          messages,
          temperature: 0.7,
          max_completion_tokens: 1400,
        });
        llmInvocation.actual_model = completion?.model || null;
        llmInvocation.api = 'chat.completions';
        bizzyReply = completion?.choices?.[0]?.message?.content?.trim() || null;
      }
    } catch (e) {
      console.error('[OpenAI] completion failed:', e?.message || e);
    }
    if (!bizzyReply) {
      if (isGpt5Model && lastResponseDebug) {
        const snippet = JSON.stringify(lastResponseDebug, null, 2).slice(0, 1800);
        bizzyReply = [
          'GPT-5 Responses returned an empty message. Share this payload snippet with OpenAI support:',
          '```json',
          snippet,
          '```',
        ].join('\n');
      } else {
        bizzyReply = `Dev stub: I received “${message}”. I’ll respond with deeper insights once full context and keys are connected.`;
      }
    }

    console.log('[gpt] persisting messages');
    // ---- Calendar action + persistence (unchanged)
    if (intent === 'calendar_schedule') {
      const nowIso = new Date().toISOString();
      const userEmbeddingText  = `User said: ${message}`;
      const bizzyEmbeddingText = `Bizzy replied: ${bizzyReply}`;
      try {
        const [uVec, aVec] = await Promise.allSettled([
          getEmbedding(userEmbeddingText),
          getEmbedding(bizzyEmbeddingText),
        ]);

        const userEmb = normalizeVec(uVec);
        const asstEmb = normalizeVec(aVec);

        const { error: msgErr } = await supabase
          .from('gpt_messages')
          .insert([
            {
              thread_id     : localThreadId,
              business_id   : businessId,
              user_id,
              role          : 'user',
              content       : message,
              created_at    : nowIso,
              embedding_text: userEmb ? userEmbeddingText : null,
              embedding     : userEmb,
            },
            {
              thread_id     : localThreadId,
              business_id   : businessId,
              user_id,
              role          : 'assistant',
              content       : bizzyReply,
              created_at    : nowIso,
              embedding_text: asstEmb ? bizzyEmbeddingText : null,
              embedding     : asstEmb,
            },
          ]);

        if (msgErr) console.error('[gpt_messages insert calendar] failed:', msgErr);

        if (localThreadId) {
          const { error: touchErr } = await supabase
            .from('gpt_threads')
            .update({
              last_message_excerpt: preview(bizzyReply),
              last_message_at     : nowIso,
              updated_at          : nowIso,
            })
            .eq('id', localThreadId);
          if (touchErr) console.error('[gpt_threads touch calendar] failed:', touchErr);
        }
      } catch (e) {
        console.error('[persist calendar turn] failed:', e?.message || e);
      }
    }

    // ---- Persist turn (unchanged)
    try {
      const userEmbeddingText  = `User said: ${message}`;
      const bizzyEmbeddingText = `Bizzy replied: ${bizzyReply}`;

      const [uVec, aVec] = await Promise.allSettled([
        getEmbedding(userEmbeddingText),
        getEmbedding(bizzyEmbeddingText),
      ]);

      const userEmb = normalizeVec(uVec);
      const asstEmb = normalizeVec(aVec);

      const nowIso = new Date().toISOString();

      const { error: msgErr } = await supabase
        .from('gpt_messages')
        .insert([
          {
            thread_id     : localThreadId,
            business_id   : businessId,
            user_id,
            role          : 'user',
            content       : message,
            created_at    : nowIso,
            embedding_text: userEmb ? userEmbeddingText : null,
            embedding     : userEmb,
          },
          {
            thread_id     : localThreadId,
            business_id   : businessId,
            user_id,
            role          : 'assistant',
            content       : bizzyReply,
            created_at    : nowIso,
            embedding_text: asstEmb ? bizzyEmbeddingText : null,
            embedding     : asstEmb,
          },
        ])
        .select('id,thread_id,role');

      if (msgErr) {
        console.error('[gpt_messages insert] failed:', msgErr);
      }

      if (localThreadId) {
        const { error: touchErr } = await supabase
          .from('gpt_threads')
          .update({
            last_message_excerpt: preview(bizzyReply),
            last_message_at     : nowIso,
            updated_at          : nowIso,
          })
          .eq('id', localThreadId);
        if (touchErr) console.error('[gpt_threads touch] failed:', touchErr);
      }
    } catch (e) {
      console.error('[persist turn] failed:', e?.message || e);
    }

    console.log('[gpt] storing memory');
    // Memory (unchanged)
    try {
      const memoryTags = [intent || 'general'];
      if (onboardingMatch) {
        memoryTags.unshift('onboarding_help');
      }
      await storeMemory({
        user_id,
        input_text: message,
        bizzy_response: bizzyReply,
        tags: memoryTags,
        kpis: kpis?.length ? {
          revenue_ytd: kpis[0]?.total_revenue || 0,
          margin_pct : kpis[0]?.profit_margin || 0,
          top_expense_categories: kpis[0]?.top_spending_category ? [kpis[0].month ? `${kpis[0].top_spending_category}` : kpis[0].top_spending_category] : [],
        } : null,
      });
    } catch {}

    return {
      responseText: bizzyReply,
      suggestedActions: onboardingSuggestedActions,
      followUpPrompt: onboardingFollowUp || '',
      meta: {
        intent,
        thread_id: localThreadId || null,
        took_ms: Date.now() - started,
        context_keys: Object.keys(bundle || {}),
        demoMode: isDemoMode() ? true : false,
        llm: llmInvocation,
        web_lookup_used: webLookupUsed,
        web_limit_reached: webLimitReached,
        web_not_configured: hasWebKey ? false : wantsWebLookup,
        onboarding: onboardingMeta,
        onboarding_actions: onboardingSuggestedActions,
        onboarding_mode_active: showOnboardingTone,
        ...(webContext ? { web_context_preview: webContext.slice(0, 200) } : {}),
      },
    };
  } catch (error) {
    console.error('❌ Unhandled error in Bizzy GPT core:', error);
    return {
      responseText: 'Something went wrong, but I’m still here. Try again in a moment.',
      suggestedActions: [],
      followUpPrompt: '',
      meta: { error: 'gpt_core_failed' },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export async function generateBizzyResponseHandler(req, res) {
  try {
    const { user_id, message, type } = req.body ?? {};
    const styleMessages  = Array.isArray(req.bizzy?.systemMessages) ? req.bizzy.systemMessages : [];
    const normalizedType = type || req.body?.intent || req.bizzy?.intent || null;
    const personaMessage = typeof req.bizzy?.personaMessage === 'string' ? req.bizzy.personaMessage : null;

    const bundle    = req.bizzy?.contextBundle || {};
    const clientCtx = req.body?.context || req.body?.parsedInput || {};
    const parsedInput = { ...bundle, ...clientCtx };

    const incomingThreadId = req.body?.thread_id || null;
    const business_id = req.body?.business_id || req.header('x-business-id') || null;

    let threadIdToUse = incomingThreadId;
    let fallbackTitleUsed = null;

    if (!threadIdToUse && business_id) {
      try {
        const fallbackTitle = (req.body?.message || '').slice(0, 60) || 'New conversation';
        const module = intentToModule(normalizedType || 'general');
        const { data: created } = await supabase
          .from('gpt_threads')
          .insert({
            user_id,
            business_id: business_id,
            title: fallbackTitle,
            first_intent: normalizedType || 'general',
            module,
          })
          .select('id,title')
          .single();
        if (created?.id) {
          threadIdToUse     = created.id;
          fallbackTitleUsed = created.title || fallbackTitle;
        }
      } catch {}
    }

    const result = await generateBizzyResponse({
      user_id,
      message,
      type: normalizedType,
      parsedInput,
      styleMessages,
      personaMessage,
      threadId: threadIdToUse || null,
      business_id,
    });

    result.meta = {
      ...(result.meta || {}),
      intent: normalizedType || result.meta?.intent || 'general',
      thread_id: threadIdToUse || result.meta?.thread_id || null,
    };

    // (unchanged) auto-title…
    try {
      if (!incomingThreadId && threadIdToUse) {
        const title = await generateThreadTitle({
          userText: req.body?.message || '',
          assistantText: result?.responseText || '',
        });
        if (title) {
          const { data: latest } = await supabase
            .from('gpt_threads')
            .select('id,title')
            .eq('id', threadIdToUse)
            .single();
          const unchanged = !latest?.title || !fallbackTitleUsed
            ? true
            : (latest.title === fallbackTitleUsed);
          if (unchanged) {
            await supabase
              .from('gpt_threads')
              .update({ title, updated_at: new Date().toISOString() })
              .eq('id', threadIdToUse);
          }
        }
      }
    } catch {}

    return res.json({ ...result });
  } catch (e) {
    const debug = req.headers['x-debug'] === '1' || req.query.debug === '1';
    console.error('[gpt handler] hard error:', e);
    return res
      .status(500)
      .json({
        responseText: 'Something went wrong, but I’m still here. Try again.',
        suggestedActions: [],
        followUpPrompt: '',
        error: 'gpt_handler_failed',
        ...(debug ? { debug: { message: String(e?.message || e), stack: e?.stack } } : {}),
      });
  }
}

export default generateBizzyResponse;
