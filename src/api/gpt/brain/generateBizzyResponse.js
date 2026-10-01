// File: /src/api/gpt/generateBizzyResponse.js
/* global process */
import { supabase } from '../../../services/supabaseAdmin.js';
import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { isOperationalMemory, retrieveRelevantMemories, storeMemory } from './bizzyMemoryService.js';
import { buildDurableMemoryCandidate } from './durableMemoryPolicy.js';
import { buildBizzySystemMessages } from './bizzySystemPrompt.js';
import { getEmbedding } from '../../../utils/openaiEmbedding.js';
import { detectAffordabilityIntent, extractExpenseDetails } from '../affordabilityParser.js';
import { intentToModule } from '../utils/intentToModule.js';
import { generateThreadTitle } from '../../chats/title.util.js';
import { webLookup } from '../webLookup.js';
import { getBookkeepingHealth } from '../../accounting/bookkeepingHealth.js';
import { formatBizzyMarkdown } from './formatBizzyMarkdown.js';
import { parseStructuredResponse } from './structuredResponse.js';
import {
  identifyOnboardingPrompt,
  buildOnboardingGuide,
  buildOnboardingToneBlock,
} from '../../../config/onboardingPromptBank.js';
import {
  applyMainChatContextBudget,
  buildMainChatUsageTelemetry,
  maybeLogMainChatCostWarning,
  recordMainChatUsage,
} from './chatCostControls.js';
import { buildChatContext } from '../orchestration/chatContextService.js';
import { loadRecentStructuredReferences, shouldPersistStructuredReferences } from '../orchestration/recentStructuredReferences.js';
import { invokeBizzyChatCompletion } from './openaiInvocation.js';
import { HISTORY_AUTHORITY_INSTRUCTION, labelOlderConversationDigest, sortConversationMessages } from '../../../utils/conversationMessageOrder.js';

// 👉 NEW: demo-mode helpers
import { isDemoMode, loadDemoData } from '../../../services/demo/loadDemoData.js';

const openaiKey = process.env.OPENAI_API_KEY || '';
const openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null;
const BIZZY_CHAT_MODEL = process.env.BIZZY_GPT_MODEL || 'gpt-5.6-terra';
console.info('[bizzy-openai] configuration', {
  configured: Boolean(openaiKey),
  model: BIZZY_CHAT_MODEL,
  invocation_method: /^gpt-5\.6(?:-|$)/i.test(BIZZY_CHAT_MODEL) ? 'responses' : 'chat.completions',
  timeout_ms: 45_000,
  max_retries: 1,
});
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
    const { data: membership, error: membershipError } = await supabase
      .from('user_business_link')
      .select('user_id,business_id')
      .eq('user_id', userId)
      .eq('business_id', businessId)
      .limit(1)
      .maybeSingle();
    if (membershipError || !membership) {
      return { ok: false, status: 403, error: 'forbidden', message: 'You do not have access to this business.' };
    }
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

const sanitizeRole = (r) => {
  const v = String(r || '').toLowerCase();
  if (v === 'bizzy') return 'assistant';
  if (v === 'assistant' || v === 'user' || v === 'system' || v === 'developer') return v;
  return 'assistant';
};

// Compact logging helper; identity is defined only by the canonical prompt compiler.
const preview = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 140);

const WEB_LOOKUP_LIMIT = 20;

const CHECKLIST_TEMPLATE = [
  { key: 'business_profile', label: 'Business profile' },
  { key: 'quickbooks', label: 'QuickBooks' },
  { key: 'plaid', label: 'Plaid' },
];

function buildOnboardingChecklist({ businessProfileComplete, qbConnected, plaidConnected }) {
  return CHECKLIST_TEMPLATE.map((item) => {
    if (item.key === 'business_profile') {
      return { ...item, status: businessProfileComplete ? 'done' : 'pending' };
    }
    if (item.key === 'quickbooks') {
      return { ...item, status: qbConnected ? 'done' : 'pending' };
    }
    if (item.key === 'plaid') {
      return { ...item, status: plaidConnected ? 'done' : 'pending' };
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

function needsWebLookup(message) {
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
  };
}

function resetLiveFinancialContext(bundle) {
  [
    'kpis',
    'forecast',
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
  threadId = null,
  business_id: businessIdFromHandler = null,
  dataMode = 'auto',
}) {
  const started = Date.now();
  const requestedDataMode = normalizeDataMode(dataMode);
  const effectiveDemoMode = requestedDataMode === 'demo' || (requestedDataMode !== 'live' && isDemoMode());
  console.log('[gpt] start', { user_id, threadId, business_id: businessIdFromHandler, dataMode: requestedDataMode, demoMode: effectiveDemoMode });
  const requestId = randomUUID();
  const llmInvocation = {
    requested_model: BIZZY_CHAT_MODEL,
    method: /^gpt-5\.6(?:-|$)/i.test(BIZZY_CHAT_MODEL) ? 'responses' : 'chat.completions',
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
          parsedInput: { ...parsedInput, affordHint: parsed },
          threadId, business_id: businessIdFromHandler, dataMode: requestedDataMode,
        });
      }
    }
    const intent = type || 'general';

    // Usage soft cap (unchanged)
    console.log('[gpt] usage-check ok');
    const currentMonth = getCurrentUsageMonth();
    try {
      const { data: usageData } = await supabase
        .from('gpt_usage')
        .select('query_count, last_used')
        .eq('user_id', user_id)
        .eq('month', currentMonth)
        .maybeSingle();
      const currentCount = usageData?.query_count || 0;
      if (currentCount >= 300) {
        return {
          responseText:
            "You've reached the current 300-query monthly limit. Try again next month or contact support to raise the cap.",
          suggestedActions: [],
          followUpPrompt: '',
        };
      }
    } catch {
      // Usage lookup is best-effort; the handler-level billing gate remains authoritative.
    }

    // Resolve business id (unchanged)
    console.log('[gpt] business resolved', { businessId: businessIdFromHandler });
    let businessId = businessIdFromHandler;
    let businessProfile = null;
    let bookkeepingHealth = null;
    let businessProfileComplete = false;
    let qbConnected = false;
    let plaidConnected = false;

    // Build input bundle EARLY (fixes bundle usage before definition)
    const bundle = parsedInput || {};
    const structuredReferences = bundle.chatContext?.structured_references || null;
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
    } catch {
      // The canonical context normally supplies this profile; preserve graceful degradation.
    }

    const profileName = businessProfile?.business_name || businessProfile?.name || '';
    businessProfileComplete = Boolean(profileName && businessProfile?.industry && businessProfile?.state);
    const canonicalAccountStatus = bundle.chatContext?.account_status || null;
    if (effectiveDemoMode) {
      businessProfileComplete = true;
      qbConnected = true;
      plaidConnected = true;
    } else if (canonicalAccountStatus) {
      businessProfileComplete = canonicalAccountStatus.business_profile_complete;
      qbConnected = canonicalAccountStatus.quickbooks_connected;
      plaidConnected = canonicalAccountStatus.plaid_connected;
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
    const onboardingComplete = effectiveDemoMode ? true : canonicalAccountStatus?.onboarded;
    const onboardingModeActive = onboardingComplete === false;
    const onboardingChecklist = buildOnboardingChecklist({ businessProfileComplete, qbConnected, plaidConnected });
    const onboardingHintId =
      parsedInput?.onboardingPromptId ||
      parsedInput?.context?.onboardingPromptId ||
      parsedInput?.meta?.onboardingPromptId ||
      parsedInput?.meta?.context?.onboardingPromptId ||
      null;
    const onboardingMatch = onboardingModeActive ? identifyOnboardingPrompt(message, onboardingHintId) : null;
    // Onboarding guidance is scoped to an approved onboarding prompt. Ordinary
    // questions always retain the normal chat contract, even before onboarding.
    const showOnboardingTone = onboardingModeActive && !!onboardingMatch;
    const checklistText = formatChecklistText(onboardingChecklist);
    const onboardingToneBlock = showOnboardingTone ? buildOnboardingToneBlock(onboardingMatch?.title || null) : null;
    const onboardingGuide = onboardingMatch ? buildOnboardingGuide(onboardingMatch, { checklist: checklistText }) : null;
    // Retained response fields stay structurally compatible, but onboarding no longer emits
    // actions or forced follow-up questions.
    const onboardingSuggestedActions = [];
    const onboardingFollowUp = '';
    const onboardingMeta = {
      active: showOnboardingTone,
      promptId: onboardingMatch?.id || null,
      checklist: onboardingChecklist,
      profileComplete: businessProfileComplete,
      qbConnected,
      plaidConnected,
      status: canonicalAccountStatus?.status || (effectiveDemoMode ? 'known' : 'unknown'),
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
    const summaryRows = [
      ...(bundle.chatContext?.financial_summary?.previous_12_completed_months || []),
      ...(bundle.chatContext?.financial_summary?.current_month ? [bundle.chatContext.financial_summary.current_month] : []),
    ];
    if (!Array.isArray(bundle.kpis) || bundle.kpis.length === 0) {
      bundle.kpis = summaryRows.map((row) => ({
        month: row.month,
        total_revenue: row.revenue,
        total_expenses: row.expenses,
        net_profit: row.net_income,
        profit_margin: row.profit_margin,
      })).reverse();
    }
    const needKPIs = !Array.isArray(bundle.kpis) || bundle.kpis.length === 0;

    const supportPromises = [];
    if (!effectiveDemoMode && businessId && needKPIs) {
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
    }

    const mergedSupport = {};
    if (supportPromises.length) {
      const settled = await Promise.allSettled(supportPromises);
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) Object.assign(mergedSupport, r.value);
      }
    }

    const kpis     = Array.isArray(bundle.kpis) && bundle.kpis.length ? bundle.kpis : (mergedSupport.kpis || []);
    const forecast = intent === 'forecast_generate' ? (bundle.chatContext?.intent_context?.data || []) : [];
    let recentChat = Array.isArray(bundle.recentChat) ? bundle.recentChat : [];
    let recentChatSummary = '';

    // Fallback: load recent thread turns if not already present
    if (!effectiveDemoMode && (!recentChat || recentChat.length === 0) && threadId) {
      try {
        const { data: recentMsgs } = await supabase
          .from('gpt_messages')
          .select('role, content, message_kind, created_at, message_role_position, message_sequence')
          .eq('thread_id', threadId)
          .eq('message_kind', 'conversation')
          .order('created_at', { ascending: false })
          .order('message_role_position', { ascending: false })
          .order('message_sequence', { ascending: false })
          .limit(24);
        if (Array.isArray(recentMsgs) && recentMsgs.length) {
          const safeRecentMessages = sortConversationMessages(
            recentMsgs.filter((row) => !isOperationalMemory({ bizzy_response: row.content })),
            { descending: true }
          );
          recentChat = safeRecentMessages.slice(0, 12);
          const older = safeRecentMessages.slice(12, 24);
          if (older.length) {
            const cleaned = older.slice().reverse()
              .map((m) => {
                const role = sanitizeRole(m.role) || 'user';
                const text = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 140);
                return text ? `${role}: ${text}` : '';
              })
              .filter(Boolean);
            recentChatSummary = cleaned.join('\n').slice(0, 1600);
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
        const memorySnippets = await retrieveRelevantMemories(user_id, businessId, message);
        memoryContext = memorySnippets?.length
          ? `Non-authoritative durable user context from past Bizzi conversations. Never use it as evidence for current financial, bookkeeping, job, invoice, transaction, integration, or freshness claims:\n${memorySnippets.map((m) => m.summary).join('\n')}`
          : '';
      }
    } catch {
      // Conversation memory is optional context.
    }

    if (recentChatSummary) {
      memoryContext += `\n\n${labelOlderConversationDigest(recentChatSummary)}`;
    }

    if (kpis?.length && !bundle.chatContext?.financial_summary) {
      const r = kpis[0];
      memoryContext += `\n\nRecent financial summary:\nRevenue $${r.total_revenue} • Expenses $${r.total_expenses} • Net Profit $${r.net_profit} • Margin ${r.profit_margin}% • Top spend: ${r.top_spending_category}.`;
    }

    // Web lookup (unchanged)
    const forceSportsLookup = false; // keep existing heuristics if you need
    const wantsWebLookup = needsWebLookup(message) || forceSportsLookup;
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

    const hasContext = !!(businessProfile || kpis?.length || forecast?.length || bundle.chatContext || demoData);

    const bookkeepingNote =
      bookkeepingHealth?.uncategorized_count > 0
        ? `This business has ${bookkeepingHealth.uncategorized_count} uncategorized transactions in QuickBooks. You can help them understand why this matters and direct them to Financials → Books at /dashboard/accounting/bookkeeping to review them in Books Review.`
        : '';

    // Build the canonical advisory chat system messages.
    let personaAndStyle;
    try {
      ({ systemMessages: personaAndStyle } = buildBizzySystemMessages({
        intent,
        module: intentToModule(intent),
        prompt: message,
        surface: 'chat',
      }, {
        hasContext,
        memoryContext,
        businessProfile,
        monthlyMetrics: bundle.chatContext?.financial_summary ? [] : kpis,
        topAccounts: bundle.accounts || [],
        forecastData: forecast,
        recentChat,
        affordHint: bundle.affordHint,
        bookkeepingNote,
        financialSource: bundle.financialSource || bundle.financial_source || bundle.source || '',
        accountingBasis: bundle.accountingBasis || bundle.accounting_basis || bundle.basis || '',
        reportingPeriod: bundle.reportingPeriod || bundle.reporting_period || bundle.period || bundle.periodHint || '',
        dataThroughDate: bundle.dataThroughDate || bundle.data_through_date || bundle.dataThrough || '',
        refreshedAt: bundle.refreshedAt || bundle.refreshed_at || bundle.refreshTime || '',
        metricHint: bundle.metricHint,
        periodHint: bundle.periodHint,
        demoSnapshot: demoData,
        webContext,
        hasWebContext: !!webContext,
        webLimitExceeded: wantsWebLookup && (webLimitReached || webNotConfigured),
        webNotConfigured,
        userRequestedNavigation: allowNavigationActions,
        userRequestedSave: !!bundle.userRequestedSave,
        accountStatus: bundle.chatContext?.account_status || null,
        financialSummary: bundle.chatContext?.financial_summary || null,
        plaidSummary: bundle.chatContext?.plaid_summary || null,
        detailedContext: bundle.chatContext?.intent_context || null,
        normalizedPeriod: bundle.chatContext?.period || null,
        loaderStatus: bundle.chatContext?.loader_status || null,
      }));
    } catch (compilationError) {
      console.error('[gpt] prompt compilation failed', {
        request_id: requestId,
        business_id: businessId,
        intent,
        period: bundle.chatContext?.period || null,
        error_class: 'prompt_compilation_failure',
        message: compilationError?.message || String(compilationError),
      });
      return {
        responseText: 'I’m having trouble generating a response right now. Your QuickBooks and Plaid connections may still be working.',
        artifacts: [],
        actions: [],
        doc_suggestion: null,
        suggestedActions: [],
        followUpPrompt: '',
        meta: {
          error: 'prompt_compilation_failed',
          operational_error: true,
          request_id: requestId,
          intent,
          thread_id: threadId || null,
        },
      };
    }

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

    const rawMessages = [
      ...(onboardingToneBlock ? [{ role: 'system', content: onboardingToneBlock }] : []),
      ...(onboardingGuide ? [{ role: 'system', content: onboardingGuide }] : []),
      ...personaAndStyle,
      ...(chatHistoryFormatted.length ? [{
        role: 'system',
        content: HISTORY_AUTHORITY_INSTRUCTION,
      }] : []),
      ...chatHistoryFormatted,
      { role: 'user', content: message },
    ];
    const contextBudget = applyMainChatContextBudget(rawMessages);
    const messages = contextBudget.messages;
    llmInvocation.context_budget = {
      trimmed: contextBudget.trimmed,
      input_chars: contextBudget.input_chars,
      max_chars: contextBudget.max_chars,
    };

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
    let openaiUsageTelemetry = null;
    let operationalError = false;
    const scriptedOnboardingReply = onboardingMatch?.response?.trim() || null;

    if (scriptedOnboardingReply) {
      bizzyReply = scriptedOnboardingReply;
      llmInvocation.skipped = true;
      llmInvocation.reason = 'scripted_onboarding_prompt';
    } else {
      console.log('[gpt] calling LLM');
      const invocation = await invokeBizzyChatCompletion({ client: openai, model: BIZZY_CHAT_MODEL, messages });
      llmInvocation.actual_model = invocation.response?.model || null;
      llmInvocation.api = invocation.apiMethod;
      llmInvocation.diagnostic = invocation.diagnostic;
      openaiUsageTelemetry = invocation.response ? buildMainChatUsageTelemetry(invocation.response, BIZZY_CHAT_MODEL) : null;
      bizzyReply = invocation.content;
      if (!invocation.ok) {
        operationalError = true;
        console.error('[OpenAI] chat unavailable', {
          request_id: requestId,
          business_id: businessId,
          intent,
          period: bundle.chatContext?.period || null,
          model: BIZZY_CHAT_MODEL,
          invocation_method: invocation.apiMethod,
          context_loader_availability: bundle.chatContext?.loader_status || null,
          ...invocation.diagnostic,
        });
      }
    }

    if (!bizzyReply) {
      operationalError = true;
      bizzyReply = 'I’m having trouble generating a response right now. Your QuickBooks and Plaid connections may still be working.';
    }

    const structured = parseStructuredResponse(bizzyReply, { allowNavigation: allowNavigationActions });
    const rawBizzyReply = structured.content || bizzyReply;
    bizzyReply = formatBizzyMarkdown(rawBizzyReply);
    responseArtifacts = structured.artifacts || [];
    responseActions = structured.actions || [];
    responseDocSuggestion = structured.doc_suggestion || null;

    console.log('[gpt] persisting messages');

    let persistedUserMessageId = null;
    // Persist turn (unchanged)
    try {
      const userEmbeddingText  = `User said: ${message}`;
      const bizzyEmbeddingText = `Bizzy replied: ${bizzyReply}`;

      const [uVec, aVec] = await Promise.allSettled([
        getEmbedding(userEmbeddingText),
        operationalError ? Promise.resolve(null) : getEmbedding(bizzyEmbeddingText),
      ]);

      const userEmb = normalizeVec(uVec);
      const asstEmb = normalizeVec(aVec);

      const nowIso = new Date().toISOString();

      const persistedStructuredReferences = operationalError || !shouldPersistStructuredReferences(bundle.chatContext)
        ? null
        : structuredReferences;
      const { data: persistedMessages, error: msgErr } = await supabase
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
            message_kind  : 'conversation',
            message_role_position: 0,
          },
          {
            thread_id     : localThreadId,
            business_id   : businessId,
            user_id,
            role          : 'assistant',
            content       : bizzyReply,
            created_at    : nowIso,
            embedding_text: operationalError ? null : (asstEmb ? bizzyEmbeddingText : null),
            embedding     : asstEmb,
            message_kind  : operationalError ? 'operational_error' : 'conversation',
            message_role_position: 1,
            structured_references: persistedStructuredReferences,
          },
        ])
        .select('id,thread_id,role');

      if (msgErr) {
        console.error('[gpt_messages insert] failed:', msgErr);
      } else {
        persistedUserMessageId = persistedMessages?.find((row) => row.role === 'user')?.id || null;
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
      const durableMemory = buildDurableMemoryCandidate({ input_text: message, operationalError });
      if (durableMemory && !(structuredReferences?.transactions?.length)) {
        const memoryTags = [durableMemory.memory_kind, 'user_confirmed'];
        await storeMemory({
          user_id,
          business_id: businessId,
          input_text: durableMemory.durable_fact,
          bizzy_response: '',
          tags: memoryTags,
          kpis: {},
          memory_kind: durableMemory.memory_kind,
          memory_key: durableMemory.memory_key,
          policy_version: durableMemory.policy_version,
          source_thread_id: localThreadId,
          source_message_id: persistedUserMessageId,
        });
      }
    } catch {
      // Memory persistence must not fail the user-facing response.
    }

    return {
      responseText: bizzyReply,
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
        operational_error: operationalError,
        request_id: requestId,
        ...(webContext ? { web_context_preview: webContext.slice(0, 200) } : {}),
      },
      internalTelemetry: {
        request_id: requestId,
        openai_usage: openaiUsageTelemetry || {
          model: scriptedOnboardingReply ? 'scripted_onboarding_prompt' : BIZZY_CHAT_MODEL,
          input_tokens: 0,
          cached_input_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0,
          total_tokens: 0,
          estimated_openai_cost_usd: 0,
        },
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
    const user_id = req.auth?.userId || req.user?.id || null;
    const normalizedType = type || req.body?.intent || req.bizzy?.intent || null;

    const bundle    = req.bizzy?.contextBundle || {};
    const clientCtx = req.body?.context || req.body?.parsedInput || {};
    let parsedInput = { ...bundle, ...clientCtx };

    const incomingThreadId = req.body?.thread_id || null;
    const business_id = req.business?.id || req.auth?.businessId || null;
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

    if (threadIdToUse && business_id) {
      const { data: thread, error: threadError } = await supabase
        .from('gpt_threads')
        .select('id,business_id')
        .eq('id', threadIdToUse)
        .eq('business_id', business_id)
        .maybeSingle();
      if (threadError || !thread) {
        return res.status(404).json({
          ok: false,
          error: 'thread_not_found',
          responseText: 'That conversation was not found.',
          suggestedActions: [],
          followUpPrompt: '',
          meta: { thread_id: incomingThreadId || null },
        });
      }
    }

    let orchestration;
    const contextRequestId = randomUUID();
    try {
      const recentReferences = await loadRecentStructuredReferences({
        db: supabase,
        businessId: business_id,
        threadId: threadIdToUse,
      });
      orchestration = await buildChatContext({
        businessId: business_id,
        message,
        forcedIntent: normalizedType,
        db: supabase,
        requestId: contextRequestId,
        recentReferences,
      });
    } catch (contextError) {
      const requestId = contextRequestId;
      console.error('[gpt handler] context compilation failed', {
        request_id: requestId,
        business_id,
        error_class: 'context_compilation_failure',
        message: contextError?.message || String(contextError),
      });
      return res.status(503).json({
        responseText: 'I’m having trouble generating a response right now. Your QuickBooks and Plaid connections may still be working.',
        artifacts: [],
        actions: [],
        doc_suggestion: null,
        suggestedActions: [],
        followUpPrompt: '',
        error: 'context_compilation_failed',
        meta: { operational_error: true, request_id: requestId, thread_id: incomingThreadId || null },
      });
    }
    parsedInput = { ...parsedInput, chatContext: orchestration };
    const resolvedType = orchestration.intent;

    if (!threadIdToUse && business_id) {
      try {
        const fallbackTitle = (req.body?.message || '').slice(0, 60) || 'New conversation';
        const module = intentToModule(resolvedType || 'general');
        const { data: created } = await supabase
          .from('gpt_threads')
          .insert({
            user_id,
            business_id: business_id,
            title: fallbackTitle,
            first_intent: resolvedType || 'general',
            module,
          })
          .select('id,title')
          .single();
        if (created?.id) {
          threadIdToUse     = created.id;
          fallbackTitleUsed = created.title || fallbackTitle;
        }
      } catch {
        // Core response generation can create the thread if this best-effort step fails.
      }
    }

    const result = await generateBizzyResponse({
      user_id,
      message,
      type: resolvedType,
      parsedInput,
      threadId: threadIdToUse || null,
      business_id,
      dataMode,
    });
    const { internalTelemetry, ...publicResult } = result || {};

    publicResult.meta = {
      ...(publicResult.meta || {}),
      intent: resolvedType || publicResult.meta?.intent || 'general',
      thread_id: threadIdToUse || publicResult.meta?.thread_id || null,
    };

    // Auto-title (unchanged)
    try {
      if (!incomingThreadId && threadIdToUse) {
        const title = await generateThreadTitle({
          userText: req.body?.message || '',
          assistantText: publicResult?.responseText || '',
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
    } catch {
      // Auto-title is optional and must not fail the completed chat turn.
    }

    try {
      if (!publicResult?.meta?.error && user_id) {
        const usageRecord = await recordMainChatUsage({
          supabaseClient: supabase,
          userId: user_id,
          businessId: business_id,
          month: getCurrentUsageMonth(),
          telemetry: internalTelemetry?.openai_usage || {},
          requestId: internalTelemetry?.request_id || null,
        });
        maybeLogMainChatCostWarning({
          userId: user_id,
          businessId: business_id,
          month: getCurrentUsageMonth(),
          model: internalTelemetry?.openai_usage?.model || BIZZY_CHAT_MODEL,
          queryCount: usageRecord?.query_count,
          estimatedMonthlyCostUsd: usageRecord?.estimated_openai_cost_usd,
        });
      }
    } catch (usageError) {
      console.warn('[gpt handler] usage increment failed:', usageError?.message || usageError);
    }

    return res.json({ ...publicResult });
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
    const user_id = req.auth?.userId || req.user?.id || null;
    const business_id = req.business?.id || req.auth?.businessId || null;
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
