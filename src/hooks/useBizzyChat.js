// File: /src/hooks/useBizzyChat.js
import { useCallback, useEffect, useState, useRef } from 'react';
import { supabase } from '../services/supabaseClient.js';

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

  // Clarifier support
  const [clarify, setClarify] = useState(null); // { question, options, note }
  const lastInputRef = useRef('');              // same text for clarifier resend
  const defaultDepthRef = useRef('standard');

  const API_BASE = import.meta.env?.VITE_API_BASE || '';

  /* ────────────────────────────── Usage tracking ───────────────────────────── */
  const fetchUsage = async () => {
    try {
      const currentMonth = new Date().toISOString().slice(0, 7);
      const { data, error } = await supabase
        .from('gpt_usage')
        .select('query_count')
        .eq('user_id', user_id)
        .eq('month', currentMonth)
        .maybeSingle();
      if (error && error.code !== 'PGRST116') throw error;
      setUsageCount(data?.query_count || 0);
    } catch (err) {
      console.warn('[useBizzyChat] Failed to fetch usage:', err.message);
    }
  };

  useEffect(() => {
    if (user_id) fetchUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user_id]);

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
    setMessages(Array.isArray(msgs) ? msgs : []);
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

    const newUserMessage = {
      id: Date.now(),
      sender: 'user',
      text: userInput.trim(),
    };

    // Optimistic UI: show user message immediately
    setMessages((prev) => [...prev, newUserMessage]);
    lastInputRef.current = userInput;
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
        message: userInput.trim(),
        intent,
        context,
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

      const newBizzyMessage = {
        id: Date.now() + 1,
        sender: 'assistant',
        text: data.responseText || 'No response generated.',
      };

      // Append assistant message
      setMessages((prev) => [...prev, newBizzyMessage]);

      // Normal CTAs (non-clarifier)
      if (!data?.meta?.clarify) {
        setSuggestedActions(data.suggestedActions || []);
        triggerSuggestedActions(data.suggestedActions || []);
        setFollowUpPrompt(data.followUpPrompt || null);
      }

      fetchUsage();
    } catch (err) {
      console.error('🔥 Bizzy chat error:', err);
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
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
