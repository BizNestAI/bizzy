// File: /src/hooks/useBizzyChat.js
import { useCallback, useState, useRef } from 'react';
import { getDemoMode, shouldUseDemoData } from '../services/demo/demoClient.js';
import { apiUrl, safeFetch } from '../utils/safeFetch.js';

// Lightweight intent/trigger detectors (frontend safeguards)
const SAVE_INTENT_RE = /\b(save (this|it)?|save to docs|add to docs|put this in docs|remember this decision|keep this decision|document this)\b/i;
const NAV_INTENT_RE = /\b(open|go to|navigate|take me to|show me)\b.*\b(forecast|forecasts|report|reports|jobs|tax|taxes|invoices?|unpaid|receivables|accounts receivable)\b/i;
const WHERE_TO_SEE_RE = /\bwhere (can|do) i (see|view)\b/i;
const PNL_RE = /\b(p&l|pnl|profit and loss|profit & loss|income statement|financial report|report pdf|p and l)\b/i;

const detectSaveIntent = (text = '') => SAVE_INTENT_RE.test(text);
const detectNavigationIntent = (text = '') => NAV_INTENT_RE.test(text) || WHERE_TO_SEE_RE.test(text);
const detectPnlContext = (text = '') => PNL_RE.test(text);
const createRequestId = () => globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
  const value = Math.floor(Math.random() * 16);
  return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16);
});

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
  const [quota, setQuota] = useState(null);
  const usageCount = Number(quota?.consumed_count || 0);

  // Clarifier support
  const [clarify, setClarify] = useState(null); // { question, options, note }
  const lastInputRef = useRef('');              // same text for clarifier resend
  const defaultDepthRef = useRef('standard');
  const assistantCountRef = useRef(0);          // track assistant turns for rate-limiting
  const lastDocSuggestionAssistantIdxRef = useRef(-Infinity);
  const userRequestedSaveRef = useRef(false);
  const userRequestedNavigationRef = useRef(false);
  const lastUserMessageRef = useRef('');

  /* ────────────────────────────── Usage tracking ───────────────────────────── */
  const updateQuota = useCallback((next) => {
    if (next && typeof next === 'object') setQuota(next);
  }, []);

  const getActiveDataMode = () => {
    try {
      if (getDemoMode?.() === 'demo' || shouldUseDemoData?.()) return 'demo';
      if (getDemoMode?.() === 'live') return 'live';
      if (localStorage.getItem('bizzy:dataMode') === 'demo' || localStorage.getItem('bizzy:demo') === '1') return 'demo';
      if (localStorage.getItem('bizzy:dataMode') === 'live' || localStorage.getItem('bizzy:demo') === '0') return 'live';
    } catch {
      // Ignore storage failures and let the server default.
    }
    return 'auto';
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
    });
  }, []);

  // ────────────────────────────── Client-side guards ─────────────────────────────
  const normalizeArtifacts = useCallback((raw = [], assistantText = '') => {
    const allowed = Array.isArray(raw) ? raw : [];
    if (!allowed.length) return [];

    const lastUserText = lastUserMessageRef.current || '';
    const textForHeuristics = `${assistantText} ${lastUserText}`.toLowerCase();
    const maybePnl = detectPnlContext(textForHeuristics);

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
        // Runtime-only signal: every newly received reply should animate, even
        // when a scripted response returns before thread-open effects settle.
        animateOnArrival: true,
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
      intent,
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

    const bizId = business_id || localStorage.getItem('currentBusinessId') || null;
    const pendingStorageKey = `bizzy:pending-chat:${bizId || 'unknown'}:${threadId || 'new'}`;
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(pendingStorageKey) || 'null'); } catch { pending = null; }
    const requestId = pending?.text === trimmedInput && pending?.request_id
      ? pending.request_id
      : createRequestId();
    try { sessionStorage.setItem(pendingStorageKey, JSON.stringify({ request_id: requestId, text: trimmedInput })); } catch { /* storage is best-effort */ }
    const newUserMessage = {
      id: requestId,
      request_id: requestId,
      sender: 'user',
      text: trimmedInput,
      deliveryStatus: 'sending',
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
      const dataMode = getActiveDataMode();

      const payload = {
        user_id: user_id ?? localStorage.getItem('user_id') ?? undefined,
        business_id: bizId,
        data_mode: dataMode,
        message: trimmedInput,
        ...(intent ? { intent } : {}),
        context: {
          ...(context || {}),
          userRequestedNavigation,
          userRequestedSave,
        },
        opts: { depth },
        thread_id: threadId || null,
        request_id: requestId,
      };

      const headers = {
        'Content-Type': 'application/json',
        'x-current-route': (typeof window !== 'undefined' && window.location?.pathname) || '',
        'x-bizzy-data-mode': dataMode,
        'x-bizzy-depth': depth,
        'x-idempotency-key': requestId,
      };

      // Prefer primary route; alias for backward compatibility
      const primary = apiUrl('/api/gpt/generate');
      const alias = apiUrl('/api/gpt/generate-response');

      const callChat = async () => {
        try {
          return await safeFetch(primary, { method: 'POST', headers, body: payload });
        } catch (primaryErr) {
          if (primaryErr?.status !== 404) throw primaryErr;
          return safeFetch(alias, { method: 'POST', headers, body: payload });
        }
      };
      let data;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          data = await callChat();
          break;
        } catch (requestError) {
          if (requestError?.status || attempt === 1) throw requestError;
        }
      }

      updateQuota(data?.quota || data?.meta?.quota);
      setMessages((prev) => prev.map((item) => item.request_id === requestId ? { ...item, deliveryStatus: 'sent' } : item));
      try { sessionStorage.removeItem(pendingStorageKey); } catch { /* storage is best-effort */ }

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

    } catch (err) {
      console.error('🔥 Bizzy chat error:', err);
      updateQuota(err?.body?.quota || err?.body?.meta?.quota);
      if (err?.status) {
        try { sessionStorage.removeItem(pendingStorageKey); } catch { /* storage is best-effort */ }
      }
      setMessages((prev) => prev.map((item) => item.request_id === requestId
        ? { ...item, deliveryStatus: 'failed', retryable: err?.body?.meta?.retryable !== false }
        : item));
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
    quota,
    updateQuota,
    error,
    clarify,
  };
};
