// File: /src/context/BizzyChatContext.jsx
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
} from 'react';

import { useAuth } from './AuthContext';
import { useBizzyChat } from '../hooks/useBizzyChat';
import { useBusiness } from './BusinessContext';
import { apiUrl, safeFetch } from '../utils/safeFetch';

const BizzyChatContext = createContext(null);
export const useBizzyChatContext = () => useContext(BizzyChatContext);

export const BizzyChatProvider = ({ children }) => {
  const { user } = useAuth();
  const { currentBusiness } = useBusiness();

  // ---------------- Core chat hook (your existing data flow) ----------------
  const {
    messages,
    isLoading,
    isGenerating,
    sendMessage: hookSendMessage,
    chooseIntent: hookChooseIntent,
    suggestedActions,
    followUpPrompt,
    clarify,
    usageCount,
    error,
    hydrate,
  } = useBizzyChat(user?.id);

  // ---------------- Biz / thread state ----------------
  const [businessId, setBusinessId] = useState(null);
  const [threadId, setThreadId] = useState(null);

  useEffect(() => {
    if (currentBusiness?.id) setBusinessId(currentBusiness.id);
    else setBusinessId(localStorage.getItem('currentBusinessId') || null);
  }, [currentBusiness?.id]);

  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isChatMinimized, setIsChatMinimized] = useState(false);
  const [suppressNextUserBubble, setSuppressNextUserBubble] = useState(false);
  const [threadsRefreshKey, setThreadsRefreshKey] = useState(0);
  const [isFetchingThread, setIsFetchingThread] = useState(false);
  const suppressedUserTextRef = useRef(null);

  const refreshThreads = () => setThreadsRefreshKey((k) => k + 1);

  // If there are messages, keep the legacy history considered "open"
  useEffect(() => {
    if (messages?.length > 0) setIsChatOpen(true);
  }, [messages]);

  // ---------------- NEW: Canvas state for conversational view ----------------
  const [isCanvasOpen, setCanvasOpen] = useState(false);
  const [canvasModule, setCanvasModule] = useState(null); // 'accounting' | 'marketing' | 'tax' | 'investments' | null

  const openCanvas = useCallback((mod) => {
    if (mod) setCanvasModule(mod);
    setCanvasOpen(true);
    console.log('[Canvas] openCanvas() called; module =', mod);
    try { document.body.style.overflow = 'hidden'; } catch {}
  }, []);

  const closeCanvas = useCallback(() => {
    setCanvasOpen(false);
    console.log('[Canvas] closeCanvas() called');
    try { document.body.style.overflow = ''; } catch {}
  }, []);

  // lifecycle log when the flag flips
   useEffect(() => {
     console.log('[Canvas] isCanvasOpen =', isCanvasOpen, 'canvasModule =', canvasModule);
   }, [isCanvasOpen, canvasModule]);

   // simple debug shim
   useEffect(() => {
     // attach only once
     if (window.__bizzy) return;
     window.__bizzy = {
       openCanvas: (m) => openCanvas(m ?? 'accounting'),
       closeCanvas,
       get state() { return { isCanvasOpen, canvasModule, messages, threadId }; },
       sendText: async (text, module='accounting') => {
         openCanvas(module);
         await hookSendMessage(text, { openCanvas: true, module });
       }
     };
     console.log('[Canvas] debug shim: window.__bizzy ready:', window.__bizzy);
   }, []); // eslint-disable-line

  // ---------------- Auto title helper (unchanged) ----------------
  const autoTitleThread = async (id) => {
    if (!id) return;
    const headers = {
      'Content-Type': 'application/json',
      'x-business-id': businessId || '',
      'x-user-id': user?.id || '',
    };

    try {
      const t = await safeFetch(apiUrl(`/api/chats/${id}`), { headers });
      const curTitle = (t?.thread?.title || '').trim();
      const looksPlaceholder =
        !curTitle ||
        /^untitled$/i.test(curTitle) ||
        /^user inquiry/i.test(curTitle) ||
        /^weekly priorities/i.test(curTitle);
      if (!looksPlaceholder) return;
    } catch {
      // ignore and retry below
    }

    for (const delay of [400, 900, 1500]) {
      try {
        await new Promise((r) => setTimeout(r, delay));
        await safeFetch(apiUrl(`/api/chats/${id}/auto-title`), { method: 'POST', headers });
        refreshThreads();
        break;
      } catch {/* ignore and continue */}
    }
  };

  // ---------------- Send message / intent ----------------
  const sendMessage = async (text, options = {}) => {
    if (!text || (typeof text === 'string' && !text.trim())) return;

    // keep legacy overlay wallet open-ish (not minimized) for consistency
    setIsChatOpen(true);
    setIsChatMinimized(false);

    // If callers ask to open the canvas, do it immediately
    if (options.openCanvas) {
      openCanvas(options.module);
    }

    return await hookSendMessage(text, {
      ...options,
      business_id: options.business_id ?? businessId,
      threadId,
      onThreadCreated: async (id) => {
        setThreadId(id);
        refreshThreads();
        autoTitleThread(id);
      },
    });
  };

  const chooseIntent = async (forcedIntent, depth = 'standard') => {
    setIsChatOpen(true);
    setIsChatMinimized(false);
    return await hookChooseIntent(forcedIntent, depth, threadId);
  };

  // ---------------- Load a thread ----------------
  const latestOpenRef = useRef({ ctr: 0, abort: null });

  const openThread = async (id) => {
    if (!id) return;
    setThreadId(id);
    setIsChatOpen(true);
    setIsChatMinimized(false);
    setIsFetchingThread(true);

    // cancel previous load if still in flight
    if (latestOpenRef.current.abort) {
      try { latestOpenRef.current.abort.abort(); } catch {}
    }
    const ctr = (latestOpenRef.current.ctr || 0) + 1;
    const ac = new AbortController();
    latestOpenRef.current = { ctr, abort: ac };

    hydrate([]); // clear existing messages while loading

    try {
      const url = new URL(apiUrl(`/api/chats/${id}`));
      url.searchParams.set('limit', '200');
      const data = await safeFetch(url.toString(), {
        signal: ac.signal,
        headers: { 'x-business-id': businessId || '', 'x-user-id': user?.id || '' },
      });

      if (latestOpenRef.current.ctr !== ctr) return;
      const msgs = Array.isArray(data?.messages)
        ? data.messages.map((m) => ({
            id: m.id,
            sender: m.role === 'assistant' ? 'assistant' : 'user',
            text: m.content,
            created_at: m.created_at,
          }))
        : [];
      hydrate(msgs);
    } catch (e) {
      if (e?.name !== 'AbortError') {
        console.warn('[BizzyChat] failed to load thread', e);
      }
    } finally {
      if (latestOpenRef.current.ctr === ctr) setIsFetchingThread(false);
    }
  };

  // ---------------- Open/close controls (legacy overlay) ----------------
  const openHistory   = () => setIsChatOpen(true);
  const closeHistory  = () => setIsChatOpen(false);
  const toggleHistory = () => setIsChatOpen((p) => !p);
  const minimizeChat  = () => setIsChatMinimized(true);
  const expandChat    = () => setIsChatMinimized(false);
  const closeChat     = () => setIsChatOpen(false);

  const resetThread = () => {
    setIsChatOpen(false);
    setIsChatMinimized(false);
    setThreadId(null);
    hydrate([]);
  };

  // Un-hide user bubble after temporary suppression
  const clearUserBubbleSuppression = () => setSuppressNextUserBubble(false);

  // ---------------- Quick Prompt API ----------------
  const startQuickPrompt = async ({
    text,
    intent,
    source = 'quick',
    meta = {},
    openFullCanvas = false,
    module,
  }) => {
    if (!text) return;

    setIsChatOpen(true);
    setIsChatMinimized(false);
    setSuppressNextUserBubble(true);
    suppressedUserTextRef.current = (text || '').trim();

    // Ensure a clean thread if we don't have one yet
    if (!threadId) hydrate([]);

    if (openFullCanvas) {
      openCanvas(module);
    }

    try {
      await sendMessage(text, {
        intent,
        source,
        ...meta,
      });
    } catch (e) {
      console.warn('[BizzyChat] startQuickPrompt failed:', e);
    }
  };

  // ---------------- Context value ----------------
  const value = useMemo(
    () => ({
      // chat data & state
      messages,
      isLoading,
      isGenerating,
      isFetchingThread,
      usageCount,
      error,
      followUpPrompt,
      suggestedActions,
      clarify,

      // thread
      threadId,
      threadsRefreshKey,
      refreshThreads,

      // actions
      sendMessage,
      chooseIntent,
      openThread,

      // overlay history controls
      openHistory,
      closeHistory,
      toggleHistory,

      isChatOpen,
      setIsChatOpen,
      isChatMinimized,
      setIsChatMinimized,

      minimizeChat,
      expandChat,
      closeChat,
      resetThread,

      // canvas controls
      isCanvasOpen,
      canvasModule,
      openCanvas,
      closeCanvas,

      // quick prompts
      startQuickPrompt,

      // suppression controls
      suppressNextUserBubble,
      clearUserBubbleSuppression,
      suppressedUserTextRef,
    }),
    [
      messages, isLoading, isGenerating, isFetchingThread, usageCount, error,
      followUpPrompt, suggestedActions, clarify,
      threadId, threadsRefreshKey,
      isChatOpen, isChatMinimized,
      isCanvasOpen, canvasModule,
    ]
  );

  return (
    <BizzyChatContext.Provider value={value}>
      {children}
    </BizzyChatContext.Provider>
  );
};
