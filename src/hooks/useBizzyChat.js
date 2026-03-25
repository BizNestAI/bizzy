// File: /src/hooks/useBizzyChat.js
import { useCallback, useEffect, useState, useRef } from 'react';
import { supabase } from '../services/supabaseClient.js';
import apiBaseUrl from '../utils/apiBase.js';

// Lightweight intent/trigger detectors (frontend safeguards)
const SAVE_INTENT_RE = /\b(save (this|it)?|save to docs|add to docs|put this in docs|remember this decision|keep this decision|document this)\b/i;
const NAV_INTENT_RE = /\b(open|go to|navigate|take me to|show me)\b.*\b(forecast|forecasts|report|reports|jobs|tax|taxes|invoices?|unpaid|receivables|accounts receivable)\b/i;
const WHERE_TO_SEE_RE = /\bwhere (can|do) i (see|view)\b/i;
const PNL_RE = /\b(p&l|pnl|profit and loss|profit & loss|income statement|financial report|report pdf|p and l)\b/i;
const INVOICE_RE = /\b(invoice|invoices|ar|accounts receivable|unpaid|overdue|who owes|payment due)\b/i;

const detectSaveIntent = (text = '') => SAVE_INTENT_RE.test(text);
const detectNavigationIntent = (text = '') => NAV_INTENT_RE.test(text) || WHERE_TO_SEE_RE.test(text);
const detectPnlContext = (text = '') => PNL_RE.test(text);
const detectInvoiceContext = (text = '') => INVOICE_RE.test(text);

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

/**
 * useBizzyChat
 * Handles client-side message flow, hydration, clarifiers, and usage tracking.
 * Ensures all chat traffic hits /api/gpt/generate → server-side persistence in gpt_messages.
 */
export const useBizzyChat = (user_id) => {
  const [messages, setMessages] = useState([]);             // chat history in memory
  const [isLoading, setIsLoading] = useState(false);        // network in-flight
  const [isGenerating, setIsGenerating] = useState(false);  // waiting for AI response
  const [suggestedActions, setSuggestedActions] = useState([]);
  const [followUpPrompt, setFollowUpPrompt] = useState(null);
  const [error, setError] = useState(null);
  const [usageCount, setUsageCount] = useState(0);
  const getCurrentMonth = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  };
  const hasValidUser = user_id && user_id !== 'undefined';

  // Clarifier support
  const [clarify, setClarify] = useState(null); // { question, options, note }
  const lastInputRef = useRef('');              // same text for clarifier resend
  const defaultDepthRef = useRef('standard');
  const assistantCountRef = useRef(0);          // track assistant turns for rate-limiting
  const lastDocSuggestionAssistantIdxRef = useRef(-Infinity);
  const userRequestedSaveRef = useRef(false);
  const userRequestedNavigationRef = useRef(false);
  const lastUserMessageRef = useRef('');

  const API_BASE = apiBaseUrl || '';

  /* ────────────────────────────── Usage tracking ───────────────────────────── */
  const ensureUsageRow = async () => {
    if (!hasValidUser) return null;
    const currentMonth = getCurrentMonth();
    return supabase
      .from('gpt_usage')
      .upsert(
        {
          user_id,
          month: currentMonth,
          query_count: 0,
          last_used: new Date().toISOString(),
        },
        { onConflict: 'user_id,month', ignoreDuplicates: true }
      );
  };

  const fetchUsage = async () => {
    if (!hasValidUser) return;
    const currentMonth = getCurrentMonth();
    try {
      await ensureUsageRow();
      const { data, error } = await supabase
        .from('gpt_usage')
        .select('query_count')
        .eq('user_id', user_id)
        .eq('month', currentMonth)
        .maybeSingle();
      if (error && error.code !== 'PGRST116') throw error;
      setUsageCount(data?.query_count || 0);
    } catch (err) {
      if (import.meta?.env?.DEV) {
        console.warn('[useBizzyChat] Failed to fetch usage:', err.message);
      }
    }
  };

  const incrementUsage = async () => {
    if (!hasValidUser) return;
    try {
      await fetchUsage();
    } catch (err) {
      if (import.meta?.env?.DEV) {
        console.warn('[useBizzyChat] Failed to increment usage:', err.message);
      }
    }
  };

  useEffect(() => {
    if (hasValidUser) fetchUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasValidUser, user_id]);

  /* ────────────────────────────── Utilities ───────────────────────────── */
  const parseJsonOrThrow = async (res) => {
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    if (!ct.includes('application/json')) {
      throw new Error(`Non-JSON response (${ct}): ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Unexpected server response. Please try again.');
    }
  };

  /* ────────────────────────────── Hydration ───────────────────────────── */
  /**
   * Hydrate the chat with a given set of messages (e.g., when opening a thread).
   * @param {Array<{id:string|number, sender:'user'|'assistant', text:string, created_at?:string}>} msgs
   */
  const hydrate = (msgs) => {
    const next = Array.isArray(msgs) ? msgs : [];
    setMessages(next);
    assistantCountRef.current = next.filter((m) => m?.sender === 'assistant').length;
    lastDocSuggestionAssistantIdxRef.current = -Infinity;
    userRequestedSaveRef.current = false;
    userRequestedNavigationRef.current = false;
    lastUserMessageRef.current = '';
    setClarify(null);
    setSuggestedActions([]);
    setFollowUpPrompt(null);
    setError(null);
    lastInputRef.current = '';
  };

  const triggerSuggestedActions = useCallback((actions = []) => {
    if (typeof window === 'undefined' || !Array.isArray(actions)) return;
    actions.forEach((action) => {
      if (!action || typeof action !== 'object') return;
      if (action.type === 'navigate' && action.target) {
        window.dispatchEvent(
          new CustomEvent('bizzy:navigate', { detail: { ...action } })
        );
      }
      if (action.type === 'show_checklist' && action.checklistId) {
        window.dispatchEvent(
          new CustomEvent('bizzy:show-checklist', { detail: { ...action } })
        );
      }
    });
  }, []);

  // ────────────────────────────── Client-side guards ─────────────────────────────
  const normalizeArtifacts = useCallback((raw = [], assistantText = '') => {
    const allowed = Array.isArray(raw) ? raw : [];
    if (!allowed.length) return [];

    const lastUserText = lastUserMessageRef.current || '';
    const textForHeuristics = `${assistantText} ${lastUserText}`.toLowerCase();
    const maybePnl = detectPnlContext(textForHeuristics);
    const maybeInvoice = detectInvoiceContext(textForHeuristics);

    const mapped = allowed
      .map((a) => ({
        type: a?.type,
        title: a?.title || '',
        subtitle: a?.subtitle || '',
        url: a?.url || '',
        meta: a?.meta,
      }))
      .filter((a) => a.type && a.title && a.url);

    const filtered = mapped.filter((a) => {
      if (a.type === 'pnl_pdf') return maybePnl || detectPnlContext(lastUserText);
      if (a.type === 'invoice') return maybeInvoice || detectInvoiceContext(lastUserText);
      return false;
    });

    return filtered.slice(0, 2);
  }, []);

  const normalizeActions = useCallback((raw = []) => {
    const allowNav = userRequestedNavigationRef.current || detectNavigationIntent(lastUserMessageRef.current || '');
    if (!allowNav) return [];
    const allowed = Array.isArray(raw) ? raw : [];
    return allowed
      .filter((a) => a?.type === 'navigate' && a?.payload?.to && a?.label)
      .map((a) => ({
        type: 'navigate',
        label: a.label,
        payload: { to: a.payload.to },
      }));
  }, []);

  const normalizeAssistantMessage = useCallback(
    (data = {}) => {
      const incomingText =
        typeof data.responseText === 'string'
          ? data.responseText
          : typeof data.content === 'string'
            ? data.content
            : '';

      const assistantIdx = (assistantCountRef.current || 0) + 1;
      const userAskedToSave = userRequestedSaveRef.current;
      const docSuggestionRaw = normalizeDocSuggestion(data?.doc_suggestion || data?.docSuggestion);
      let docSuggestion = docSuggestionRaw || null;
      let shouldShow = docSuggestion?.should_show || false;
      let reason = docSuggestion?.reason;

      if (userAskedToSave) {
        shouldShow = true;
        reason = 'user_requested';
      }

      const strategic = reason === 'strategic_decision';
      const lastIdx = Number.isFinite(lastDocSuggestionAssistantIdxRef.current)
        ? lastDocSuggestionAssistantIdxRef.current
        : -Infinity;
      const withinCooldown = assistantIdx - lastIdx < 10;
      if (strategic && !userAskedToSave && withinCooldown) {
        shouldShow = false;
      }

      if (shouldShow) {
        lastDocSuggestionAssistantIdxRef.current = assistantIdx;
      }

      if (shouldShow || reason) {
        docSuggestion = { ...(docSuggestion || {}), should_show: shouldShow };
        if (reason) docSuggestion.reason = reason;
      } else {
        docSuggestion = null;
      }

      const artifacts = normalizeArtifacts(data?.artifacts, incomingText);
      const actions = normalizeActions(data?.actions);

      assistantCountRef.current = assistantIdx;
      userRequestedSaveRef.current = false;
      userRequestedNavigationRef.current = false;

      return {
        id: Date.now() + 1,
        sender: 'assistant',
        text: incomingText || 'No response generated.',
        artifacts,
        actions,
        doc_suggestion: docSuggestion,
      };
    },
    [normalizeActions, normalizeArtifacts]
  );

  /* ────────────────────────────── Message sending ───────────────────────────── */
  /**
   * Send a user message to Bizzy (handles new + existing threads)
   */
  const sendMessage = async (
    userInput,
    {
      intent = 'general',
      depth = defaultDepthRef.current,
      context = null,
      business_id,
      threadId = null,
      onThreadCreated,
    } = {}
  ) => {
    if (!userInput?.trim() || isLoading) return;

    const trimmedInput = userInput.trim();
    lastUserMessageRef.current = trimmedInput;
    const userRequestedSave = detectSaveIntent(trimmedInput);
    const userRequestedNavigation = detectNavigationIntent(trimmedInput);
    userRequestedSaveRef.current = userRequestedSave;
    userRequestedNavigationRef.current = userRequestedNavigation;

    const newUserMessage = {
      id: Date.now(),
      sender: 'user',
      text: trimmedInput,
    };

    // Optimistic UI: show user message immediately
    setMessages((prev) => [...prev, newUserMessage]);
    lastInputRef.current = trimmedInput;
    setIsLoading(true);
    setIsGenerating(true);
    setError(null);
    setClarify(null);
    setSuggestedActions([]);
    setFollowUpPrompt(null);

    try {
      const bizId = business_id || localStorage.getItem('currentBusinessId') || null;

      const payload = {
        user_id: user_id ?? localStorage.getItem('user_id') ?? undefined,
        business_id: bizId,
        message: trimmedInput,
        intent,
        context: {
          ...(context || {}),
          userRequestedNavigation,
          userRequestedSave,
        },
        opts: { depth },
        thread_id: threadId || null,
      };

      const headers = {
        'Content-Type': 'application/json',
        'x-current-route': (typeof window !== 'undefined' && window.location?.pathname) || '',
        'x-bizzy-depth': depth,
        'x-debug': '1',  // TEMP only
      };

      // Prefer primary route; alias for backward compatibility
      const primary = `${API_BASE}/api/gpt/generate`;
      const alias   = `${API_BASE}/api/gpt/generate-response`;

      let res = await fetch(primary, { method: 'POST', headers, body: JSON.stringify(payload) });
      if (res.status === 404) {
        res = await fetch(alias, { method: 'POST', headers, body: JSON.stringify(payload) });
      }

      const data = await parseJsonOrThrow(res);

      // If the server created a thread on the first turn, inform parent
      if (!threadId && data?.meta?.thread_id && typeof onThreadCreated === 'function') {
        onThreadCreated(data.meta.thread_id);
      }

      // Clarifier flow
      if (data?.meta?.clarify && Array.isArray(data?.suggestedActions)) {
        setClarify(data.meta.clarify);
        setSuggestedActions(data.suggestedActions);
        triggerSuggestedActions(data.suggestedActions);
      }

      const newBizzyMessage = normalizeAssistantMessage(data);

      // Append assistant message
      setMessages((prev) => [...prev, newBizzyMessage]);

      // Normal CTAs (non-clarifier)
      if (!data?.meta?.clarify) {
        setSuggestedActions(data.suggestedActions || []);
        triggerSuggestedActions(data.suggestedActions || []);
        setFollowUpPrompt(data.followUpPrompt || null);
      }

      incrementUsage();
    } catch (err) {
      console.error('🔥 Bizzy chat error:', err);
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      userRequestedSaveRef.current = false;
      userRequestedNavigationRef.current = false;
      setIsLoading(false);
      setIsGenerating(false);
    }
  };

  /* ────────────────────────────── Clarifier handling ───────────────────────────── */
  /**
   * Choose a clarifier option. Re-sends the same user input with a forced intent.
   * @param {string} forcedIntent
   * @param {'brief'|'standard'|'deep'} depth
   * @param {string|null} threadId
   */
  const chooseIntent = async (forcedIntent, depth = defaultDepthRef.current, threadId = null) => {
    if (!forcedIntent || !lastInputRef.current) return;
    setClarify(null);
    return sendMessage(lastInputRef.current, { intent: forcedIntent, depth, threadId });
  };

  /* ────────────────────────────── Return API ───────────────────────────── */
  return {
    messages,
    isLoading,
    isGenerating,
    sendMessage,
    chooseIntent,
    hydrate,                 // <-- exposed for BizzyChatContext/openThread
    suggestedActions,
    followUpPrompt,
    usageCount,
    error,
    clarify,
  };
};
