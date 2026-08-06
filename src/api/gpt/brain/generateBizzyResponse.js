// File: /src/api/gpt/generateBizzyResponse.js
import { supabase } from '../../../services/supabaseAdmin.js';
import { qboEnvName } from '../../../utils/qboEnv.js';
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
import { formatBizzyMarkdown } from './formatBizzyMarkdown.js';
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
const FREE_CHAT_LIMIT = 2;
const PAID_CHAT_LIMIT = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getCurrentUsageMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function readModeScopedBillingValue(row, key, fallbackValue = null) {
  if (!row) return fallbackValue;
  const requestedStripeMode = String(process.env.STRIPE_MODE || '').trim().toLowerCase();
  const stripeMode = requestedStripeMode === 'test' || requestedStripeMode === 'live'
    ? requestedStripeMode
    : process.env.NODE_ENV === 'production' ? 'live' : 'test';
  const scopedKey = `${key}_${stripeMode}`;
  if (row?.[scopedKey] !== undefined && row?.[scopedKey] !== null) return row[scopedKey];
  if (stripeMode === 'live' && row?.[key] !== undefined && row?.[key] !== null) return row[key];
  return fallbackValue;
}

function projectChatBilling(row) {
  return {
    subscription_status: readModeScopedBillingValue(row, 'subscription_status', 'free') || 'free',
    plan_type: readModeScopedBillingValue(row, 'plan_type', null),
    stripe_subscription_id: readModeScopedBillingValue(row, 'stripe_subscription_id', null),
    current_period_end: readModeScopedBillingValue(row, 'current_period_end', null),
    cancel_at_period_end: Boolean(readModeScopedBillingValue(row, 'cancel_at_period_end', false)),
  };
}

function hasActiveMonthlySubscription(billing) {
  if (!billing) return false;
  if (billing.subscription_status !== 'active') return false;
  if (!billing.stripe_subscription_id && !billing.plan_type) return false;
  if (billing.cancel_at_period_end && billing.current_period_end) {
    const end = new Date(billing.current_period_end);
    if (!Number.isNaN(end.getTime()) && end.getTime() <= Date.now()) return false;
  }
  return true;
}

async function getMonthlyUsageCount(userId, month = getCurrentUsageMonth()) {
  if (!userId) return 0;
  const { data, error } = await supabase
    .from('gpt_usage')
    .select('query_count')
    .eq('user_id', userId)
    .eq('month', month)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return Number(data?.query_count || 0);
}

async function getBusinessBillingForUser(userId, businessId) {
  if (!userId || !businessId || !UUID_RE.test(String(userId)) || !UUID_RE.test(String(businessId))) {
    return { ok: false, status: 400, error: 'invalid_ids', message: 'Valid user id and business id are required.' };
  }

  const { data: business, error: businessError } = await supabase
    .from('business_profiles')
    .select('id,user_id')
    .eq('id', businessId)
    .maybeSingle();
  if (businessError || !business) {
    return { ok: false, status: 404, error: 'business_not_found', message: 'Business not found.' };
  }
  if (business.user_id !== userId) {
    return { ok: false, status: 403, error: 'forbidden', message: 'You do not own this business.' };
  }

  const { data: billingRow, error: billingError } = await supabase
    .from('business_billing')
    .select('*')
    .eq('business_id', businessId)
    .maybeSingle();
  if (billingError) {
    return { ok: false, status: 500, error: 'billing_lookup_failed', message: 'Failed to load billing status.' };
  }

  return { ok: true, billing: projectChatBilling(billingRow) };
}

export async function getBizzyChatAccess({ user_id, business_id } = {}) {
  const month = getCurrentUsageMonth();
  const billingResult = await getBusinessBillingForUser(user_id, business_id);
  if (!billingResult.ok) {
    return {
      ok: false,
      allowed: false,
      status: billingResult.status,
      error: billingResult.error,
      message: billingResult.message,
      month,
      usage_count: 0,
      limit: FREE_CHAT_LIMIT,
      remaining: 0,
      subscription_active: false,
    };
  }

  const usageCount = await getMonthlyUsageCount(user_id, month);
  const subscriptionActive = hasActiveMonthlySubscription(billingResult.billing);
  const limit = subscriptionActive ? PAID_CHAT_LIMIT : FREE_CHAT_LIMIT;
  const remaining = Math.max(0, limit - usageCount);
  const allowed = usageCount < limit;
  return {
    ok: true,
    allowed,
    month,
    usage_count: usageCount,
    limit,
    remaining,
    subscription_active: subscriptionActive,
    subscription_status: billingResult.billing.subscription_status,
    trial_limit: FREE_CHAT_LIMIT,
    paid_limit: PAID_CHAT_LIMIT,
    message: allowed
      ? null
      : subscriptionActive
        ? "You've reached the current 300-query monthly limit."
        : 'Your two test questions are used. Subscribe to keep asking Bizzi questions.',
  };
}

async function incrementMonthlyUsage(userId) {
  if (!userId) return null;
  const month = getCurrentUsageMonth();
  const nowIso = new Date().toISOString();
  const { data: usageData, error: fetchError } = await supabase
    .from('gpt_usage')
    .select('query_count')
    .eq('user_id', userId)
    .eq('month', month)
    .maybeSingle();
  if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;
  const nextCount = (usageData?.query_count || 0) + 1;
  const { error: upsertError } = await supabase
    .from('gpt_usage')
    .upsert(
      {
        user_id: userId,
        month,
        query_count: nextCount,
        last_used: nowIso,
      },
      { onConflict: 'user_id,month' }
    );
  if (upsertError) throw upsertError;
  return nextCount;
}

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

// Updated: autonomous financial operator framing
const BASE_SYSTEM =
  'You are Bizzi, an Autonomous Financial Operator for contractors and home-service businesses. Be calm, pragmatic, specific, and low-noise.';

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

const MAX_ARTIFACTS = 2;

function normalizeDataMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'demo' || mode === 'mock') return 'demo';
  if (mode === 'live') return 'live';
  return 'auto';
}

function demoBusinessProfileFromSnapshot(demoData) {
  const name = demoData?.meta?.businessName || "Mike's Remodeling";
  return {
    id: 'demo-business',
    business_name: name,
    name,
    industry: 'Remodeling and home services',
    team_size: null,
    has_viewed_integrations_page: true,
    onboarding_completed_once: true,
  };
}

function resetLiveFinancialContext(bundle) {
  [
    'kpis',
    'forecast',
    'moves',
    'accounts',
    'bookkeepingHealth',
    'metricHint',
    'periodHint',
    'unpaidCustomers',
  ].forEach((key) => {
    delete bundle[key];
  });
}

function applyDemoContext(bundle, demoData) {
  if (!demoData) return;
  resetLiveFinancialContext(bundle);
  const monthTag = demoData?.meta?.period || new Date().toISOString().slice(0, 7);
  const fin = demoData?.financials || {};
  const prev = fin?.prevMonth || {};
  const topDriver = Array.isArray(fin.topCostDrivers) && fin.topCostDrivers[0]?.name
    ? fin.topCostDrivers[0].name
    : prev?.topSpendingCategory || null;

  bundle.kpis = [
    {
      month: monthTag,
      total_revenue: Number(fin.mtdRevenue ?? 0),
      total_expenses: Number(fin.mtdExpenses ?? 0),
      net_profit: Number(fin.mtdProfit ?? 0),
      profit_margin: Number(fin.profitMarginPct ?? 0),
      top_spending_category: topDriver,
    },
  ];

  if (prev && Object.keys(prev).length) {
    bundle.kpis.push({
      month: 'Prior period',
      total_revenue: Number(prev.revenue ?? 0),
      total_expenses: Number(prev.expenses ?? 0),
      net_profit: Number(prev.profit ?? 0),
      profit_margin: Number(prev.profitMarginPct ?? 0),
      top_spending_category: prev.topSpendingCategory || null,
    });
  }

  bundle.forecast = fin?.forecastNext30d
    ? [{
        month: 'Next 30 days',
        cash_in: Number(fin.forecastNext30d?.cashIn ?? 0),
        cash_out: Number(fin.forecastNext30d?.cashOut ?? 0),
        net_cash: Number(fin.forecastNext30d?.net ?? 0),
      }]
    : [];

  bundle.moves = Array.isArray(fin?.suggestedMoves)
    ? fin.suggestedMoves.map((move) => ({
        title: move?.title || '',
        rationale: [move?.rationale, move?.timeframe].filter(Boolean).join(' '),
        month: move?.month || monthTag,
      })).filter((move) => move.title)
    : [];

  if (Array.isArray(fin?.unpaidCustomers)) {
    const jobLookup = new Map(
      (demoData?.jobs?.topUnpaid || []).map((job) => [job.external_id || job.id, job.title || job.name || ''])
    );
    bundle.unpaidCustomers = fin.unpaidCustomers.map((row) => ({
      ...row,
      project: jobLookup.get(row.invoiceId) || null,
    }));
  }

  bundle.demoSnapshot = demoData;
  bundle.dataMode = 'demo';
}

const extractJsonCandidate = (raw = '') => {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === 'object') return direct;
  } catch {}

  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try {
      const parsed = JSON.parse(fenced[1]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return null;
};

const sanitizeArtifacts = (raw = []) => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) => ({
      type: a?.type,
      title: a?.title || '',
      subtitle: a?.subtitle || '',
      url: a?.url || '',
      meta: a?.meta,
    }))
    .filter((a) => a.type && a.title && a.url && (a.type === 'pnl_pdf' || a.type === 'invoice'))
    .slice(0, MAX_ARTIFACTS);
};

const sanitizeActions = (raw = [], allowNavigation = false) => {
  if (!allowNavigation || !Array.isArray(raw)) return [];
  return raw
    .filter((a) => a?.type === 'navigate' && a?.payload?.to && a?.label)
    .map((a) => ({ type: 'navigate', label: a.label, payload: { to: a.payload.to } }));
};

const normalizeDocSuggestion = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const { should_show, shouldShow, reason, suggested_title, suggestedTitle } = raw;
  const show = should_show ?? shouldShow ?? false;
  const title = suggested_title || suggestedTitle || undefined;
  return {
    should_show: !!show,
    reason: reason || undefined,
    ...(title ? { suggested_title: title } : {}),
  };
};

const parseStructuredResponse = (rawText, { allowNavigation = false } = {}) => {
  const parsed = extractJsonCandidate(rawText);
  if (!parsed || typeof parsed !== 'object') {
    return { content: rawText, artifacts: [], actions: [], doc_suggestion: null };
  }
  const content = typeof parsed.content === 'string' ? parsed.content : rawText;
  return {
    content,
    artifacts: sanitizeArtifacts(parsed.artifacts),
    actions: sanitizeActions(parsed.actions, allowNavigation),
    doc_suggestion: normalizeDocSuggestion(parsed.doc_suggestion || parsed.docSuggestion),
  };
};

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
  dataMode = 'auto',
}) {
  const started = Date.now();
  const requestedDataMode = normalizeDataMode(dataMode);
  const effectiveDemoMode = requestedDataMode === 'demo' || (requestedDataMode !== 'live' && isDemoMode());
  console.log('[gpt] start', { user_id, threadId, business_id: businessIdFromHandler, dataMode: requestedDataMode, demoMode: effectiveDemoMode });
  const llmInvocation = {
    requested_model: BIZZY_CHAT_MODEL,
    method: isGpt5Model ? 'responses' : 'chat.completions',
  };
  let responseArtifacts = [];
  let responseActions = [];
  let responseDocSuggestion = null;
  // Shared holders for optional web context
  let webContext = '';
  let webLookupUsed = false;
  let webNotConfigured = false;
  let webLimitReached = false;
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
          threadId, business_id: businessIdFromHandler, dataMode: requestedDataMode,
        });
      }
      if (detectSchedulingIntent(message)) {
        return await generateBizzyResponse({
          user_id, message, type: 'calendar_schedule',
          parsedInput: { ...parsedInput, scheduleHint: message }, styleMessages, personaMessage,
          threadId, business_id: businessIdFromHandler, dataMode: requestedDataMode,
        });
      }
    }
    const intent = type || 'general';

    // Usage soft cap (unchanged)
    console.log('[gpt] usage-check ok');
    const currentMonth = getCurrentUsageMonth();
    let usageRow = null;
    try {
      const { data: usageData } = await supabase
        .from('gpt_usage')
        .select('query_count, last_used')
        .eq('user_id', user_id)
        .eq('month', currentMonth)
        .maybeSingle();
      usageRow = usageData || null;
      const currentCount = usageData?.query_count || 0;
      if (currentCount >= 300) {
        return {
          responseText:
            "You've reached the current 300-query monthly limit. Try again next month or contact support to raise the cap.",
          suggestedActions: [],
          followUpPrompt: '',
        };
      }
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
    let plaidConnected = false;

    // Build input bundle EARLY (fixes bundle usage before definition)
    const bundle = parsedInput || {};
    const allowNavigationActions = !!bundle.userRequestedNavigation;

    try {
      const profileColumns = 'id,business_name,industry,state,team_size,annual_revenue,founded_year,services_offered,billing_model,top_challenge';
      if (effectiveDemoMode) {
        businessProfile = demoBusinessProfileFromSnapshot(null);
      } else if (businessId) {
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
    businessProfileComplete = Boolean(profileName && businessProfile?.industry);
    hasViewedIntegrationsPage = false;
    onboardingCompletedOnce = false;
    if (effectiveDemoMode) {
      businessProfileComplete = true;
      hasViewedIntegrationsPage = true;
      onboardingCompletedOnce = true;
      qbConnected = true;
      plaidConnected = true;
    }

    if (!effectiveDemoMode && businessId) {
      try {
        const { data: qbRow } = await supabase
          .from('quickbooks_tokens')
          .select('business_id')
          .eq('business_id', businessId)
          .eq('qbo_env', qboEnvName)
          .eq('is_active', true)
          .eq('status', 'active')
          .maybeSingle();
        qbConnected = !!qbRow;
      } catch {}

      try {
        const { count } = await supabase
          .from('plaid_items')
          .select('plaid_item_id', { count: 'exact', head: true })
          .eq('business_id', businessId)
          .eq('is_active', true);
        plaidConnected = (count || 0) > 0;
      } catch {}
    }

    // Fetch bookkeeping health snapshot to inform coaching behaviors
    try {
      if (!effectiveDemoMode && businessId) {
        bookkeepingHealth = await getBookkeepingHealth(businessId);
        if (bookkeepingHealth) {
          bundle.bookkeepingHealth = bookkeepingHealth;
        }
      }
    } catch (e) {
      console.warn('[bizzy] bookkeeping health fetch failed', e?.message || e);
    }

    // Onboarding controls (unchanged)
    const onboardingComplete =
      businessProfileComplete &&
      qbConnected &&
      plaidConnected &&
      hasViewedIntegrationsPage;
    const onboardingModeActive = onboardingCompletedOnce ? false : !onboardingComplete;
    const onboardingChecklist = buildOnboardingChecklist({ businessProfileComplete, qbConnected });
    const onboardingHintId =
      parsedInput?.onboardingPromptId ||
      parsedInput?.context?.onboardingPromptId ||
      parsedInput?.meta?.onboardingPromptId ||
      parsedInput?.meta?.context?.onboardingPromptId ||
      null;
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
      plaidConnected,
      hasViewedIntegrationsPage,
    };
    bundle.onboardingPromptId = onboardingMatch?.id || onboardingHintId || null;
    bundle.onboardingChecklist = onboardingChecklist;

    // ───────────────────────────────────────────────
    // DEMO MODE: hydrate bundle with demo data
    // ───────────────────────────────────────────────
    let demoData = null;
    if (effectiveDemoMode) {
      try {
        demoData = await loadDemoData();
        if (demoData) {
          businessProfile = demoBusinessProfileFromSnapshot(demoData);
          applyDemoContext(bundle, demoData);
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
    if (!effectiveDemoMode && businessId && (needKPIs || needForecast || needMoves)) {
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

    const kpis     = Array.isArray(bundle.kpis) && bundle.kpis.length ? bundle.kpis : (mergedSupport.kpis || []);
    const forecast = Array.isArray(bundle.forecast) && bundle.forecast.length ? bundle.forecast : (mergedSupport.forecast || []);
    const moves    = Array.isArray(bundle.moves) && bundle.moves.length ? bundle.moves : (mergedSupport.moves || []);
    let recentChat = Array.isArray(bundle.recentChat) ? bundle.recentChat : [];
    let recentChatSummary = '';

    // Fallback: load recent thread turns if not already present
    if (!effectiveDemoMode && (!recentChat || recentChat.length === 0) && threadId) {
      try {
        const { data: recentMsgs } = await supabase
          .from('gpt_messages')
          .select('role, content')
          .eq('thread_id', threadId)
          .order('created_at', { ascending: false })
          .limit(12);
        if (Array.isArray(recentMsgs) && recentMsgs.length) {
          recentChat = recentMsgs.slice(0, 6);
          const older = recentMsgs.slice(6);
          if (older.length) {
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

    // Memory fetch (unchanged)
    let memoryContext = '';
    try {
      if (!effectiveDemoMode) {
        const memorySnippets = await retrieveRelevantMemories(user_id, message);
        memoryContext = memorySnippets?.length
          ? `Context from past Bizzi conversations:\n${memorySnippets.map((m) => m.summary).join('\n')}`
          : '';
      }
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

    // Web lookup (unchanged)
    const forceSportsLookup = false; // keep existing heuristics if you need
    const wantsWebLookup = needsWebLookup(message, intent) || forceSportsLookup;
    webNotConfigured = wantsWebLookup && !hasWebKey;
    if (wantsWebLookup) {
      console.log('[webLookup] intent', { wantsWebLookup, hasWebKey, webNotConfigured });
    }
    if (wantsWebLookup && hasWebKey) {
      try {
        const webText = await webLookup(message);
        if (webText) {
          webContext = webText;
          webLookupUsed = true;
          console.log('[webLookup] hydrated context preview', webText.slice(0, 200));
        }
        if (!webText) {
          console.warn('[webLookup] no results returned');
        }
      } catch (e) {
        console.error('[webLookup]', e?.message || e);
      }
    }

    // Demo snapshot enrichment (unchanged)
    if (demoData) {
      const fin = demoData?.financials || {};
      const mkt = demoData?.marketing || {};
      memoryContext += `

[Demo Business Snapshot]
- Data mode: Mock Mode. Treat this demo snapshot as the only authoritative business data. Do not use or mention live QuickBooks/sandbox figures.
- Business: ${demoData?.meta?.businessName || 'Demo Co.'} (${demoData?.meta?.period || ''})
- Cash on hand: $${fin?.cashOnHand ?? '—'} • AR outstanding: $${fin?.arOutstanding ?? 0}
- MTD Revenue: $${fin?.mtdRevenue ?? 0} • Expenses: $${fin?.mtdExpenses ?? 0} • Profit: $${fin?.mtdProfit ?? 0} • Margin: ${fin?.profitMarginPct ?? 0}%
- Leads MTD: ${mkt?.leadsMTD ?? 0} (Best channel: ${(mkt?.channels?.[0]?.name || 'Google Ads')})
`;
    }

    const hasContext = !!(businessProfile || kpis?.length || forecast?.length || moves?.length || demoData);

    const bookkeepingNote =
      bookkeepingHealth?.uncategorized_count > 0
        ? `This business has ${bookkeepingHealth.uncategorized_count} uncategorized transactions in QuickBooks. You can help them understand why this matters, and direct them to the "Bookkeeping Cleanup" page in Financials to fix it.`
        : '';

    // Build system messages (unchanged; but system prompt now reflects Autonomous Financial Operator)
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
        userRequestedNavigation: allowNavigationActions,
        userRequestedSave: !!bundle.userRequestedSave,
      }
    );

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

    const messages = [
      ...(onboardingToneBlock ? [{ role: 'system', content: onboardingToneBlock }] : []),
      ...personaAndStyle,
      ...(onboardingGuide ? [{ role: 'system', content: onboardingGuide }] : []),
      ...chatHistoryFormatted,
      { role: 'user', content: message },
    ];

    // Ensure a thread id exists (unchanged)
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

    let bizzyReply = null;
    let lastResponseDebug = null;
    const scriptedOnboardingReply = onboardingMatch?.response
      ? [
          onboardingMatch.response.trim(),
          onboardingFollowUp ? onboardingFollowUp.trim() : '',
        ].filter(Boolean).join('\n\n')
      : null;

    if (scriptedOnboardingReply) {
      bizzyReply = scriptedOnboardingReply;
      llmInvocation.skipped = true;
      llmInvocation.reason = 'scripted_onboarding_prompt';
    } else {
      console.log('[gpt] calling LLM');
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
        bizzyReply = `I received your message — but I’m missing some context to operate properly. If you connect QuickBooks and your business profile, I can take over the financial workflow more reliably.`;
      }
    }

    const structured = parseStructuredResponse(bizzyReply, { allowNavigation: allowNavigationActions });
    const rawBizzyReply = structured.content || bizzyReply;
    bizzyReply = rawBizzyReply;
    responseArtifacts = structured.artifacts || [];
    responseActions = structured.actions || [];
    responseDocSuggestion = structured.doc_suggestion || null;

    console.log('[gpt] persisting messages');

    // Persist turn (unchanged)
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

    const formattedReply = formatBizzyMarkdown(bizzyReply);

    return {
      responseText: formattedReply,
      artifacts: responseArtifacts,
      actions: responseActions,
      doc_suggestion: responseDocSuggestion,
      suggestedActions: onboardingSuggestedActions,
      followUpPrompt: onboardingFollowUp || '',
      meta: {
        intent,
        thread_id: localThreadId || null,
        took_ms: Date.now() - started,
        context_keys: Object.keys(bundle || {}),
        demoMode: effectiveDemoMode,
        dataMode: effectiveDemoMode ? 'demo' : requestedDataMode,
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
      artifacts: [],
      actions: [],
      doc_suggestion: null,
      suggestedActions: [],
      followUpPrompt: '',
      meta: { error: 'gpt_core_failed' },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export async function generateBizzyResponseHandler(req, res) {
  try {
    const { message, type } = req.body ?? {};
    const user_id = req.user?.id || req.body?.user_id || null;
    const styleMessages  = Array.isArray(req.bizzy?.systemMessages) ? req.bizzy.systemMessages : [];
    const normalizedType = type || req.body?.intent || req.bizzy?.intent || null;
    const personaMessage = typeof req.bizzy?.personaMessage === 'string' ? req.bizzy.personaMessage : null;

    const bundle    = req.bizzy?.contextBundle || {};
    const clientCtx = req.body?.context || req.body?.parsedInput || {};
    const parsedInput = { ...bundle, ...clientCtx };

    const incomingThreadId = req.body?.thread_id || null;
    const business_id = req.body?.business_id || req.header('x-business-id') || null;
    const dataMode = normalizeDataMode(
      req.body?.data_mode ||
      req.body?.dataMode ||
      req.header('x-bizzy-data-mode') ||
      parsedInput?.data_mode ||
      parsedInput?.dataMode
    );

    const access = await getBizzyChatAccess({ user_id, business_id });
    if (!access.allowed) {
      const blockedStatus = access.ok
        ? access.subscription_active ? 429 : 402
        : (access.status || 403);
      return res.status(blockedStatus).json({
        ok: false,
        error: access.ok
          ? access.subscription_active ? 'monthly_chat_limit_reached' : 'chat_subscription_required'
          : access.error,
        responseText: access.message || 'Subscribe to keep asking Bizzi questions.',
        suggestedActions: [],
        followUpPrompt: '',
        meta: {
          billing_gate: access,
          thread_id: incomingThreadId || null,
          intent: normalizedType || 'general',
        },
      });
    }

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
      dataMode,
    });

    result.meta = {
      ...(result.meta || {}),
      intent: normalizedType || result.meta?.intent || 'general',
      thread_id: threadIdToUse || result.meta?.thread_id || null,
    };

    // Auto-title (unchanged)
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

    try {
      if (!result?.meta?.error && user_id) {
        await incrementMonthlyUsage(user_id);
      }
    } catch (usageError) {
      console.warn('[gpt handler] usage increment failed:', usageError?.message || usageError);
    }

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

export async function getBizzyChatAccessHandler(req, res) {
  try {
    const user_id = req.user?.id || req.query?.user_id || req.header('x-user-id') || null;
    const business_id = req.query?.business_id || req.query?.businessId || req.header('x-business-id') || null;
    const access = await getBizzyChatAccess({ user_id, business_id });
    return res.status(access.ok ? 200 : (access.status || 400)).json(access);
  } catch (e) {
    console.warn('[gpt chat-access] failed:', e?.message || e);
    return res.status(500).json({
      ok: false,
      allowed: false,
      error: 'chat_access_failed',
      message: 'Failed to load chat access.',
      limit: FREE_CHAT_LIMIT,
      remaining: 0,
      subscription_active: false,
    });
  }
}

export default generateBizzyResponse;
