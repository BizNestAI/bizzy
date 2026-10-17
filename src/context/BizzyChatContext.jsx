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
import { useAdminView } from './AdminViewContext.jsx';
import { apiUrl, safeFetch } from '../utils/safeFetch';
import { normalizeChatPromptInput } from '../utils/chatPromptInput';

const BizzyChatContext = createContext(null);
export const useBizzyChatContext = () => useContext(BizzyChatContext);

export const BizzyChatProvider = ({ children }) => {
  const { user } = useAuth();
  const { currentBusiness } = useBusiness();
  const adminView = useAdminView();

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
    quota,
    updateQuota,
    error,
    hydrate,
  } = useBizzyChat(adminView.active ? null : user?.id);

  // ---------------- Biz / thread state ----------------
  const [businessId, setBusinessId] = useState(null);
  const [threadId, setThreadId] = useState(null);
  const [chatGateNotice, setChatGateNotice] = useState(null);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaError, setQuotaError] = useState(null);
  const quotaRequestRef = useRef(0);

  useEffect(() => {
    if (adminView.active && adminView.businessId) setBusinessId(adminView.businessId);
    else if (currentBusiness?.id) setBusinessId(currentBusiness.id);
    else setBusinessId(localStorage.getItem('currentBusinessId') || null);
  }, [adminView.active, adminView.businessId, currentBusiness?.id]);

  const refreshQuota = useCallback(async ({ businessId: requestedBusinessId } = {}) => {
    if (adminView.active) return null;
    const resolvedBusinessId =
      requestedBusinessId ||
      businessId ||
      currentBusiness?.id ||
      localStorage.getItem('currentBusinessId') ||
      localStorage.getItem('business_id') ||
      '';
    if (!resolvedBusinessId) {
      updateQuota(null);
      setQuotaError('business_required');
      return null;
    }

    const requestNumber = quotaRequestRef.current + 1;
    quotaRequestRef.current = requestNumber;
    setQuotaLoading(true);
    setQuotaError(null);
    const url = new URL(apiUrl('/api/gpt/chat-access'));
    url.searchParams.set('business_id', resolvedBusinessId);
    try {
      const access = await safeFetch(url.toString(), {
        headers: { 'x-business-id': resolvedBusinessId },
      });
      if (quotaRequestRef.current === requestNumber) updateQuota(access);
      return access;
    } catch (err) {
      if (quotaRequestRef.current === requestNumber) {
        updateQuota(null);
        setQuotaError(err?.body?.error || err?.message || 'chat_access_failed');
      }
      throw err;
    } finally {
      if (quotaRequestRef.current === requestNumber) setQuotaLoading(false);
    }
  }, [adminView.active, businessId, currentBusiness?.id, updateQuota]);

  useEffect(() => {
    updateQuota(null);
    setQuotaError(null);
    if (!businessId || adminView.active) {
      setQuotaLoading(false);
      return;
    }
    refreshQuota({ businessId }).catch(() => {});
  }, [adminView.active, businessId, refreshQuota, updateQuota]);

  const checkChatAccess = useCallback(async () => {
    if (adminView.active) {
      const notice = {
        blocked: true,
        title: 'Chat disabled in Admin View',
        message: 'Customer chat is disabled while viewing as an administrator.',
      };
      setChatGateNotice(notice);
      return { allowed: false, error: 'admin_view_read_only', ...notice };
    }
    const resolvedBusinessId =
      businessId ||
      currentBusiness?.id ||
      localStorage.getItem('currentBusinessId') ||
      localStorage.getItem('business_id') ||
      '';

    if (!resolvedBusinessId) {
      const notice = {
        blocked: true,
        title: 'Business required',
        message: 'Select a business before asking Bizzi a question.',
      };
      setChatGateNotice(notice);
      return { allowed: false, ...notice };
    }

    let access = null;
    try {
      access = await refreshQuota({ businessId: resolvedBusinessId });
    } catch (err) {
      const notice = {
        blocked: true,
        title: 'Could not verify access',
        message: 'Bizzi could not verify your subscription status. Try again in a moment.',
      };
      setChatGateNotice(notice);
      return { allowed: false, error: err?.message, ...notice };
    }

    if (!access?.subscription_active) {
      setChatGateNotice({
        blocked: true,
        title: 'Subscription required',
        message: 'An active or trialing subscription is required to ask Bizzi questions.',
      });
    } else if (Number(access?.remaining || 0) <= 0) {
      setChatGateNotice({ blocked: true, title: 'Monthly limit reached', message: 'You have used all 300 questions. Your credits reset next month.' });
    } else {
      setChatGateNotice(null);
    }

    return access;
  }, [adminView.active, businessId, currentBusiness?.id, refreshQuota]);

  const dismissChatGateNotice = useCallback(() => {
    setChatGateNotice(null);
  }, []);

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
  }, []);

  const clearActiveThread = useCallback(() => {
    setThreadId(null);
    hydrate([]);
    setSuppressNextUserBubble(false);
    suppressedUserTextRef.current = null;
  }, [hydrate]);

  const closeCanvas = useCallback(() => {
    setCanvasOpen(false);
  }, []);

  const leaveCanvas = useCallback(() => {
    setCanvasOpen(false);
    clearActiveThread();
  }, [clearActiveThread]);

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
  const sendMessage = async (promptInput, options = {}) => {
    const normalizedInput = normalizeChatPromptInput(promptInput);
    if (!normalizedInput.text) return;
    if (adminView.active) {
      setChatGateNotice({
        blocked: true,
        title: 'Chat disabled in Admin View',
        message: 'Customer chat is disabled while viewing as an administrator.',
      });
      return;
    }
    const { newThread = false, ...messageOptions } = options || {};
    const resolvedMessageOptions = {
      ...messageOptions,
      intent: messageOptions.intent || normalizedInput.intent || undefined,
    };

    // keep legacy overlay wallet open-ish (not minimized) for consistency
    setIsChatOpen(true);
    setIsChatMinimized(false);

    if (newThread) {
      clearActiveThread();
    }

    // If callers ask to open the canvas, do it immediately
    if (resolvedMessageOptions.openCanvas) {
      openCanvas(resolvedMessageOptions.module);
    }

    return await hookSendMessage(normalizedInput.text, {
      ...resolvedMessageOptions,
      business_id: resolvedMessageOptions.business_id ?? businessId,
      threadId: newThread ? null : threadId,
      onThreadCreated: async (id) => {
        setThreadId(id);
        refreshThreads();
        autoTitleThread(id);
      },
    });
  };

  const chooseIntent = async (forcedIntent, depth = 'standard') => {
    if (adminView.active) return;
    setIsChatOpen(true);
    setIsChatMinimized(false);
    return await hookChooseIntent(forcedIntent, depth, threadId);
  };

  // ---------------- Load a thread ----------------
  const latestOpenRef = useRef({ ctr: 0, abort: null });

  useEffect(() => {
    if (latestOpenRef.current.abort) {
      try { latestOpenRef.current.abort.abort(); } catch { /* already closed */ }
    }
    latestOpenRef.current = { ctr: (latestOpenRef.current.ctr || 0) + 1, abort: null };
    setThreadId(null);
    hydrate([]);
    updateQuota(null);
    setChatGateNotice(null);
    setSuppressNextUserBubble(false);
    suppressedUserTextRef.current = null;
    setIsFetchingThread(false);
  }, [user?.id, businessId, hydrate, updateQuota]);

  const openThread = async (id) => {
    if (!id) return;
    setThreadId(id);
    setIsChatOpen(true);
    setIsChatMinimized(false);
    setIsFetchingThread(true);

    // cancel previous load if still in flight
    if (latestOpenRef.current.abort) {
      try { latestOpenRef.current.abort.abort(); } catch { /* already closed */ }
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
    newThread = false,
  }) => {
    const normalizedInput = normalizeChatPromptInput({ text, intent });
    if (!normalizedInput.text) return;
    if (adminView.active) {
      setChatGateNotice({
        blocked: true,
        title: 'Chat disabled in Admin View',
        message: 'Customer chat is disabled while viewing as an administrator.',
      });
      return;
    }

    setIsChatOpen(true);
    setIsChatMinimized(false);
    setSuppressNextUserBubble(true);
    suppressedUserTextRef.current = normalizedInput.text;

    // Ensure a clean thread when starting from outside the active conversation.
    if (newThread || !threadId) hydrate([]);

    if (openFullCanvas) {
      openCanvas(module);
    }

    try {
      await sendMessage(normalizedInput, {
        intent: normalizedInput.intent,
        source,
        ...meta,
        newThread,
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
      quota,
      quotaLoading,
      quotaError,
      error,
      followUpPrompt,
      suggestedActions,
      clarify,
      chatGateNotice,
      chatReadOnly: adminView.active && adminView.readOnly,

      // thread
      threadId,
      businessId,
      userId: user?.id || null,
      threadsRefreshKey,
      refreshThreads,

      // actions
      sendMessage,
      chooseIntent,
      openThread,
      checkChatAccess,
      refreshQuota,
      updateQuota,
      dismissChatGateNotice,

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
      leaveCanvas,

      // quick prompts
      startQuickPrompt,

      // suppression controls
      suppressNextUserBubble,
      clearUserBubbleSuppression,
      suppressedUserTextRef,
    }),
    [
      adminView.active,
      adminView.readOnly,
      messages, isLoading, isGenerating, isFetchingThread, usageCount, quota, quotaLoading, quotaError, error,
      followUpPrompt, suggestedActions, clarify, chatGateNotice,
      threadId, businessId, user?.id, threadsRefreshKey,
      isChatOpen, isChatMinimized,
      isCanvasOpen, canvasModule,
      checkChatAccess, refreshQuota, updateQuota, dismissChatGateNotice,
    ]
  );

  return (
    <BizzyChatContext.Provider value={value}>
      {children}
    </BizzyChatContext.Provider>
  );
};
