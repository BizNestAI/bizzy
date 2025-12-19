// File: /src/components/Bizzy/BizzyChatHistory.jsx
import React, { useEffect, useRef, useMemo, useState, useLayoutEffect } from 'react';
import { useBizzyChatContext } from '../../context/BizzyChatContext';
import { motion, AnimatePresence } from 'framer-motion';
import useModuleTheme from '../../hooks/useModuleTheme';
import { useLocation } from 'react-router-dom';
import { Minimize2, Maximize2, X, MoreHorizontal } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { createDoc } from '../../services/bizzyDocs/docsService';
import MarkdownRenderer from './MarkdownRenderer';
import ChatMessage from './ChatMessage';

/* ---------- constants / helpers ---------- */
const USER_MAX_W = 'max-w-[80%] sm:max-w-[65%] md:max-w-[55%]';
const BIZZY_MAX_W = 'max-w-[98%] sm:max-w-[96%] md:max-w-[95%]';

const accentHexMap = {
  bizzy: '#FF4EEB',
  accounting: '#00FFB2',
  marketing: '#3B82F6',
  tax: '#FFD700',
  investments: '#B388FF',
};
function hexToRgba(hex, alpha = 1) {
  let c = hex.replace('#', '');
  if (c.length === 3) c = c.split('').map(s => s + s).join('');
  const n = parseInt(c, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
const bgFromAccent = (hex) => ({ fill: hexToRgba(hex, 0.10), border: hexToRgba(hex, 0.45) });

function getModuleFromPath(path = '') {
  if (path.includes('/dashboard/accounting') || path.includes('/dashboard/financials')) return 'accounting';
  if (path.includes('/dashboard/marketing')) return 'marketing';
  if (path.includes('/dashboard/tax')) return 'tax';
  if (path.includes('/dashboard/investments')) return 'investments';
  if (path.includes('/dashboard/bizzy')) return 'bizzy';
  return 'bizzy';
}

function stripHtml(html = '') {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el.textContent || el.innerText || '';
}
function shouldSuggestDoc(msg) {
  if (!msg) return false;
  const isAssistant = msg.sender === 'assistant' || msg.sender === 'bizzy';
  if (!isAssistant) return false;
  const plain = stripHtml(msg.text || '');
  const len = plain.length;
  const hasHeadings = /<h\d|^#{1,3}\s/m.test(msg.text || '');
  const bulletCount = (msg.text || '').match(/<li>|^- |\* /gm)?.length || 0;
  const keywords = ['overview','summary','plan','strategy','next steps','recommendation','analysis','drivers','actions'];
  const keywordScore = keywords.reduce((acc, k) => acc + (plain.toLowerCase().includes(k) ? 1 : 0), 0);
  if (len > 800 && (hasHeadings || bulletCount >= 3 || keywordScore >= 2)) return true;
  if (len > 1400) return true;
  return false;
}

/* ---------- Typing dots (restored) ---------- */
const TypingDots = ({ accentHex }) => (
  <div className="flex items-center gap-1">
    <style>{`
      @keyframes bizzy-bounce {
        0%, 80%, 100% { transform: scale(0); opacity: .4; }
        40% { transform: scale(1); opacity: 1; }
      }
    `}</style>
    {[0,1,2].map(i => (
      <span
        key={i}
        className="inline-block w-2 h-2 rounded-full"
        style={{
          background: accentHex,
          boxShadow: `0 0 10px ${accentHex}66`,
          animation: 'bizzy-bounce 1.4s infinite ease-in-out',
          animationDelay: `${i * 0.15}s`
        }}
      />
    ))}
  </div>
);

/* ---------- Inline typewriter (unchanged) ---------- */
const TypewriterText = ({ text = '', onDone, containerRef, autoScroll }) => {
  const [shown, setShown] = useState('');
  const lastScrollTsRef = useRef(0);
  const autoRef = useRef(autoScroll);
  const onDoneRef = useRef(onDone);
  useEffect(() => { autoRef.current = autoScroll; }, [autoScroll]);
  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);

  useEffect(() => {
    if (!text) { setShown(''); return; }
    let i = 0;
    let raf;
    const step = () => {
      const chunk = Math.max(1, Math.ceil(text.length / 800));
      i = Math.min(text.length, i + chunk);
      setShown(text.slice(0, i));
      if (autoRef.current && containerRef?.current) {
        const now = performance.now();
        if (now - lastScrollTsRef.current > 50) {
          lastScrollTsRef.current = now;
          const el = containerRef.current;
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        }
      }
      if (i < text.length) raf = requestAnimationFrame(step);
      else onDoneRef.current?.();
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, containerRef]);

  return <MarkdownRenderer>{shown}</MarkdownRenderer>;
};

/* ---------- stable key map (does NOT depend on text length) ---------- */
const useStableKeys = () => {
  const registryRef = useRef(new Map());
  return (msg, index, threadId) => {
    const id = msg?.id ?? `${msg?.sender || 'msg'}-${msg?.created_at || 't'}-${index}`;
    if (!registryRef.current.has(id)) registryRef.current.set(id, `${threadId || 'thread'}-${id}`);
    return registryRef.current.get(id);
  };
};

/* ======================================================== */
const BizzyChatHistory = ({ inline = false }) => {
  const {
     messages,
     isChatOpen,
     setIsChatOpen,
     isChatMinimized,
     setIsChatMinimized,
     isGenerating,
     isFetchingThread,
     suppressNextUserBubble,
     clearUserBubbleSuppression,
     suppressedUserTextRef,
     threadId,
     isCanvasOpen,
   } = useBizzyChatContext();

  // If the new chat canvas is active, never render the overlay
   if (isCanvasOpen && !inline) return null;

  /* ---------- seed suppression (persist + hide) ---------- */
  const norm = (s = '') => s.replace(/\s+/g, ' ').trim().toLowerCase();

  const storedSeed = useMemo(() => {
    if (!threadId) return '';
    try { return localStorage.getItem(`bizzy:seed:${threadId}`) || ''; } catch { return ''; }
  }, [threadId]);

  const hiddenSeedFlag = useMemo(() => {
    if (!threadId) return false;
    try { return localStorage.getItem(`bizzy:hiddenSeed:${threadId}`) === '1'; } catch { return false; }
  }, [threadId]);

  const seededTextGlobal = useMemo(() => {
    const inlineSeed = (suppressedUserTextRef?.current || '');
    const persisted =
      (threadId && localStorage.getItem(`bizzy:seed:${threadId}`)) ||
      localStorage.getItem('bizzy:lastSeedPrompt') || '';
    const seed = inlineSeed || persisted || '';
    return norm(seed);
  }, [suppressedUserTextRef, threadId]);

  useEffect(() => {
    if (!threadId) return;
    const anySeed = messages.some(m => m?.sender === 'user' && seededTextGlobal && norm(m.text || '') === seededTextGlobal);
    if (anySeed) {
      try {
        const seedRaw = suppressedUserTextRef?.current || storedSeed || '';
        if (seedRaw) {
          localStorage.setItem(`bizzy:seed:${threadId}`, seedRaw);
          localStorage.setItem('bizzy:lastSeedPrompt', seedRaw);
        }
        localStorage.setItem(`bizzy:hiddenSeed:${threadId}`, '1');
      } catch {}
    }
  }, [messages, seededTextGlobal, threadId, suppressedUserTextRef, storedSeed]);

  const filteredMessages = useMemo(() => {
    const seedNorm = seededTextGlobal;
    const storedNorm = norm(storedSeed || '');
    return messages.filter((m) => {
      if (m?.sender === 'user') {
        const txt = norm(m.text || '');
        if (seedNorm && txt === seedNorm) return false;
        if (hiddenSeedFlag && storedNorm && txt === storedNorm) return false;
      }
      return true;
    });
  }, [messages, seededTextGlobal, hiddenSeedFlag, storedSeed]);

  const lastAssistantIdx = useMemo(() => {
    for (let i = filteredMessages.length - 1; i >= 0; i--) {
      if (filteredMessages[i]?.sender === 'assistant') return i;
    }
    return -1;
  }, [filteredMessages]);

  /* ---------- scrolling (latched unpin) ---------- */
  const { user } = useAuth();
  const containerRef = useRef(null);

  const isAtBottom = () => {
    const el = containerRef.current;
    if (!el) return true;
    const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
    return distance <= 4;
  };

  const manualUnpinnedRef = useRef(false);
  const [pinnedBottomVisual, setPinnedBottomVisual] = useState(true);
  const [unpinVersion, setUnpinVersion] = useState(0);

  const [typedSet, setTypedSet] = useState(() => new Set());
  const isTypingNow = useMemo(() => {
    if (lastAssistantIdx < 0) return false;
    return !typedSet.has(lastAssistantIdx) && !!filteredMessages[lastAssistantIdx]?.text;
  }, [lastAssistantIdx, typedSet, filteredMessages]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = isAtBottom();
      if (manualUnpinnedRef.current) {
        setPinnedBottomVisual(atBottom);
        if (atBottom && !isTypingNow) manualUnpinnedRef.current = false;
        return;
      }
      setPinnedBottomVisual(atBottom);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [isTypingNow]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const takeControl = () => {
      if (!manualUnpinnedRef.current) {
        manualUnpinnedRef.current = true;
        setUnpinVersion(v => v + 1);
      }
      el.scrollTo({ top: el.scrollTop, behavior: 'auto' });
    };
    el.addEventListener('wheel', takeControl, { passive: true });
    el.addEventListener('touchstart', takeControl, { passive: true });
    el.addEventListener('touchmove', takeControl, { passive: true });
    return () => {
      el.removeEventListener('wheel', takeControl);
      el.removeEventListener('touchstart', takeControl);
      el.removeEventListener('touchmove', takeControl);
    };
  }, []);

  const allowAutoScroll = useMemo(
    () => !manualUnpinnedRef.current && pinnedBottomVisual,
    [pinnedBottomVisual, unpinVersion]
  );

  /* ---------- only newest assistant animates ---------- */
  useEffect(() => {
    if (!filteredMessages.length) return;
    let latest = -1;
    for (let i = filteredMessages.length - 1; i >= 0; i--) {
      if (filteredMessages[i]?.sender === 'assistant') { latest = i; break; }
    }
    if (latest === -1) return;
    setTypedSet(prev => {
      const next = new Set(prev);
      for (let i = 0; i < latest; i++) {
        if (filteredMessages[i]?.sender === 'assistant') next.add(i);
      }
      return next;
    });
  }, [filteredMessages]);

  /* ---------- layout positioning ---------- */
  const [panelTop, setPanelTop] = useState(80);
  const [panelBottom, setPanelBottom] = useState(180);
  const [panelLeft, setPanelLeft] = useState(null);
  const [panelWidth, setPanelWidth] = useState(null);

  const recompute = () => {
    if (inline) return;
    const topAnchor =
      document.querySelector('[data-chat-top-anchor]') ||
      document.querySelector('[data-bizzy-sidebar-top]');
    setPanelTop(Math.max(8, Math.round(topAnchor?.getBoundingClientRect().top ?? 80)));

    const chatBar = document.querySelector('[data-bizzy-chatbar]');
    if (chatBar) {
      const chatRect = chatBar.getBoundingClientRect();
      setPanelBottom(Math.max(12, Math.round(window.innerHeight - chatRect.top) + 12));
      setPanelLeft(Math.round(chatRect.left));
      setPanelWidth(Math.round(chatRect.width));
    } else {
      setPanelBottom(160);
      setPanelLeft(null);
      setPanelWidth(null);
    }
  };

  const location = useLocation();
  const currentModule = getModuleFromPath(location.pathname);
  useModuleTheme(currentModule);
  const accentHex = useMemo(() => accentHexMap[currentModule] || '#FF4EEB', [currentModule]);
  const { fill, border } = bgFromAccent(accentHex);

  useEffect(() => {
    recompute();
    if (inline) return;
    const onResize = () => recompute();
    const onScroll = () => recompute();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(recompute);
    const chatBar = document.querySelector('[data-bizzy-chatbar]'); if (chatBar) ro.observe(chatBar);
    const topAnchor =
      document.querySelector('[data-chat-top-anchor]') || document.querySelector('[data-bizzy-sidebar-top]');
    if (topAnchor) ro.observe(topAnchor);
    return () => { window.removeEventListener('resize', onResize); window.removeEventListener('scroll', onScroll); ro.disconnect(); };
  }, [isChatOpen, isChatMinimized, location.pathname, inline]);

  /* ---------- auto-scroll for new messages only if allowed ---------- */
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !allowAutoScroll) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [filteredMessages, isChatMinimized, isChatOpen, allowAutoScroll]);

  /* ---------- stop temp suppression when assistant replies ---------- */
  useEffect(() => {
    if (!suppressNextUserBubble) return;
    const last = filteredMessages[filteredMessages.length - 1];
    if (last && last.sender !== 'user') clearUserBubbleSuppression?.();
  }, [filteredMessages, suppressNextUserBubble, clearUserBubbleSuppression]);

  /* ---------- hydration typing gate ---------- */
  const prevFetchingRef = useRef(isFetchingThread);
  useEffect(() => {
    const prev = prevFetchingRef.current;
    prevFetchingRef.current = isFetchingThread;
    if (prev && !isFetchingThread) {
      setTypedSet(() => {
        const set = new Set();
        filteredMessages.forEach((m, i) => { if (m?.sender === 'assistant') set.add(i); });
        return set;
      });
    }
  }, [isFetchingThread, filteredMessages]);

  /* ---------- force bottom on open/hydrate (pre & post paint) ---------- */
  const forceBottom = () => {
    const el = containerRef.current; if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
  };
  useLayoutEffect(() => {
    if (!isChatOpen) return;
    forceBottom();
    requestAnimationFrame(() => setTimeout(forceBottom, 120));
  }, [isChatOpen, isFetchingThread]);

  /* ---------- panel shell ---------- */
  const showOverlay = isChatOpen;
  const panelBaseClass = `rounded-2xl border bg-neutral-850/85 backdrop-blur-sm backdrop-saturate-150`;
  const panelPosClass = inline ? '' : 'fixed z-50';
  const panelStyle = inline ? {} : {
    left: panelLeft ?? '50%',
    transform: panelLeft != null ? 'none' : 'translateX(-50%)',
    width: panelWidth != null ? `${panelWidth}px` : undefined,
    top: `${panelTop}px`,
    bottom: `${panelBottom}px`,
  };

  const [menuOpen, setMenuOpen] = useState(null);
  const stableKey = useStableKeys();

  return (
    <AnimatePresence>
      {showOverlay && (
        <motion.div
          key="bizzy-panel"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ type: 'spring', stiffness: 260, damping: 28 }}
          className={`${panelPosClass} ${panelBaseClass}`}
          style={{
            ...panelStyle,
            borderColor: `${hexToRgba(accentHex, 0.5)}`,
            boxShadow: `0 0 24px ${hexToRgba(accentHex, 0.20)}`,
            maxWidth: inline ? 'min(1200px, 98vw)' : undefined
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-white/10">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-2.5 w-2.5 rounded-full bg-white/60" />
              <span className="font-semibold tracking-wide">Bizzy</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsChatMinimized((v) => !v)}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs border border-white/10 hover:bg-white/5"
              >
                {isChatMinimized ? (<><Maximize2 className="h-3.5 w-3.5" /> Expand</>) : (<><Minimize2 className="h-3.5 w-3.5" /> Minimize</>)}
              </button>
              <button
                onClick={() => setIsChatOpen(false)}
                className="inline-flex rounded-md p-1.5 border border-white/10 hover:bg-white/5"
                title="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Hide WebKit scrollbars just for chat history */}
          <style>{`
            .bizzy-chat-scroll::-webkit-scrollbar { display: none; width: 0; height: 0; }
          `}</style>

          {/* Messages */}
          <div
            ref={containerRef}
            className="px-4 sm:px-6 py-3 space-y-4 overflow-y-auto h-[calc(100%-44px)] bizzy-chat-scroll"
            style={{
              overscrollBehavior: 'contain',
              scrollbarWidth: 'none',   /* Firefox */
              msOverflowStyle: 'none',  /* IE/Edge legacy */
            }}
            aria-live="polite"
            aria-busy={isFetchingThread || !!isGenerating ? 'true' : 'false'}
          >
            {filteredMessages.length === 0 && isFetchingThread && (
              <div className="text-white/70 text-sm py-6 text-center">
                Loading conversation…
              </div>
            )}

            {filteredMessages.map((msg, index) => {
              const isUser = msg.sender === 'user';
              const suggest = shouldSuggestDoc(msg);
              const key = stableKey(msg, index, threadId);

              if (isUser) {
                const isLast = index === filteredMessages.length - 1;
                if (suppressNextUserBubble && isLast) return null;
                return (
                  <ChatMessage key={key} side="user">
                    {msg.text}
                  </ChatMessage>
                );
              }

              const shouldType = index === lastAssistantIdx && !!msg?.text && !typedSet.has(index);

              return (
                <ChatMessage key={key} side="assistant" accentFill={fill} accentBorder={border}>
                  <div className="relative">
                    {shouldType ? (
                      <TypewriterText
                        text={msg.text}
                        containerRef={containerRef}
                        autoScroll={allowAutoScroll}
                        onDone={() => {
                          setTypedSet(prev => {
                            const next = new Set(prev);
                            next.add(index);
                            return next;
                          });
                        }}
                      />
                    ) : (
                      <MarkdownRenderer>{msg.text}</MarkdownRenderer>
                    )}

                    {suggest && (
                      <div className="absolute top-2 right-2">
                        <div className="relative">
                          <button
                            className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-black/30 border border-white/10 hover:bg-black/50"
                            onClick={() => setMenuOpen(menuOpen === index ? null : index)}
                            title="More"
                          >
                            <MoreHorizontal size={14} />
                          </button>
                          {menuOpen === index && (
                            <div className="absolute right-0 mt-1 w-44 rounded-md bg-black/90 border border-white/10 shadow-xl z-10">
                              <button
                                onClick={async () => {
                                  const m = filteredMessages[index];
                                  if (!m?.text) return;
                                  try {
                                    const title = prompt('Title for Bizzy Doc?', 'Bizzy Summary');
                                    if (!title) return;
                                    await createDoc({
                                      business_id: localStorage.getItem('currentBusinessId'),
                                      user_id: user?.id,
                                      title,
                                      category:
                                        getModuleFromPath(location.pathname) === 'accounting'
                                          ? 'financials'
                                          : getModuleFromPath(location.pathname),
                                      content: { title, sections: [{ heading: 'Summary', body: stripHtml(m.text) }] },
                                      tags: ['chat','summary'],
                                    });
                                    alert('Saved to Bizzy Docs ✅');
                                    setMenuOpen(null);
                                  } catch (e) {
                                    console.warn('[save as doc] failed:', e?.message || e);
                                  }
                                }}
                                className="w-full text-left px-3 py-2 text-xs hover:bg-white/5"
                              >
                                Save as Bizzy Doc
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </ChatMessage>
              );
            })}

            {/* Loader bubble at the end (only when actually generating) */}
            {isChatOpen && isGenerating && (
              <div className="flex">
                <div
                  className="w-fit max-w-[92%] sm:max-w-[85%] md:max-w-[80%] mr-auto rounded-2xl px-4 py-3 text-sm"
                  style={{
                    background: fill,
                    border: `1px solid ${border}`,
                    boxShadow: `0 0 18px ${hexToRgba(accentHex, 0.20)}`
                  }}
                >
                  <TypingDots accentHex={accentHex} />
                </div>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default BizzyChatHistory; 
