// /src/components/Bizzy/ChatCanvas.jsx
import React, { useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { Copy, Save, ArrowLeft, Check } from "lucide-react";
import { useBizzyChatContext } from "../../context/BizzyChatContext";
import MarkdownRenderer from "./MarkdownRenderer";
import { useBusiness } from "../../context/BusinessContext";
import { createDoc } from "../../services/bizzyDocs/docsService";
import { generateThreadSummary } from "../../services/bizzyDocs/threadSummary";

const WARM_TEXT = "var(--text)";

/* ----------------------- helpers ----------------------- */
function hashStr(str = "") {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
}
const normSender = (m) => String(m?.sender || "").toLowerCase().trim();
function getMsgTime(m) {
  const t = m?.created_at ?? m?.ts ?? m?.time ?? 0;
  if (typeof t === "number") return t;
  if (typeof t === "string") {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
    const d = Date.parse(t);
    return Number.isFinite(d) ? d : 0;
  }
  return 0;
}

/* ---------------- center measure ---------------- */
function useCenterBounds(fallbackLeft, fallbackWidth, topAnchorSelector = "[data-chat-top-anchor]", topOvershoot = 24) {
  const [rect, setRect] = useState({ left: fallbackLeft ?? 0, width: fallbackWidth ?? 0, top: 0 });

  useEffect(() => {
    const center = document.querySelector("[data-center-col]");
    const topAnchor = document.querySelector(topAnchorSelector);
    if (!center) return;

    const measure = () => {
      const r = center.getBoundingClientRect();
      const anchorTop = topAnchor?.getBoundingClientRect?.().top ?? 0;
      let t = anchorTop - topOvershoot;
      const minTop = 48, maxTop = Math.max(0, window.innerHeight - 160);
      t = Math.min(Math.max(t, minTop), maxTop);
      setRect({ left: Math.round(r.left), width: Math.round(r.width), top: Math.round(t) });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(center);
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [topAnchorSelector, topOvershoot]);

  return rect;
}

function chunkWords(str = "") {
  if (!str) return [""];
  const chunks = [];

  // capture leading whitespace as its own chunk so text alignment stays intact
  let cursor = 0;
  while (cursor < str.length && /\s/.test(str[cursor])) cursor += 1;
  if (cursor > 0) chunks.push(str.slice(0, cursor));

  const wordRegex = /\S+\s*/g;
  wordRegex.lastIndex = cursor;
  let match;
  while ((match = wordRegex.exec(str))) {
    chunks.push(match[0]);
    cursor = wordRegex.lastIndex;
  }

  if (cursor < str.length) {
    chunks.push(str.slice(cursor));
  }

  return chunks.length ? chunks : [""];
}

/* ---------------- typewriter ---------------- */
function Typewriter({ id, text = "", speed = 140, onDone, onProgress }) {
  const [shown, setShown] = useState("");
  const iRef = useRef(0);
  const rafRef = useRef(null);
  const lastTsRef = useRef(0);
  const textRef = useRef(text);
  textRef.current = text;
  const chunkRef = useRef([]);
  const chunkCostsRef = useRef([]);
  const budgetRef = useRef(0);
  const rehypeWordFade = useMemo(
    () =>
      () =>
      (tree) => {
        let wordIndex = 0;
        const SKIP = new Set(["code", "pre"]);
        const walk = (node, blocked = false) => {
          if (!node || typeof node !== "object") return;
          const tag = node.tagName;
          const isBlocked = blocked || (tag && SKIP.has(tag));
          if (!Array.isArray(node.children)) return;

          const next = [];
          node.children.forEach((child) => {
            if (child?.type === "text" && !isBlocked) {
              const parts = String(child.value || "").split(/(\s+)/);
              parts.forEach((part) => {
                if (!part) return;
                const isSpace = /^\s+$/.test(part);
                if (isSpace) {
                  next.push({ type: "text", value: part });
                  return;
                }
                const delay = `${(wordIndex * 0.02).toFixed(3)}s`;
                next.push({
                  type: "element",
                  tagName: "span",
                  properties: {
                    className: ["bizzy-tw-chunk"],
                    style: `animation-delay:${delay}`,
                  },
                  children: [{ type: "text", value: part }],
                });
                wordIndex += 1;
              });
              return;
            }
            walk(child, isBlocked);
            next.push(child);
          });
          node.children = next;
        };
        walk(tree, false);
        return tree;
      },
    []
  );

  useEffect(() => {
    cancelAnimationFrame(rafRef.current || 0);
    iRef.current = 0;
    setShown("");
    lastTsRef.current = 0;
    budgetRef.current = 0;
    const chunks = chunkWords(textRef.current);
    chunkRef.current = chunks;
    chunkCostsRef.current = chunks.map((chunk) => {
      const trimmed = chunk.replace(/\s+/g, "");
      const cost = trimmed.length || chunk.length || 1;
      return Math.max(1, cost);
    });

    const renderPartial = () => {
      const idx = iRef.current;
      const chunks = chunkRef.current;
      const costs = chunkCostsRef.current;
      if (idx >= chunks.length) return;
      const base = chunks.slice(0, idx).join("");
      const cost = costs[idx] || 1;
      const sliceLen = Math.max(0, Math.floor((budgetRef.current / cost) * chunks[idx].length));
      setShown(base + chunks[idx].slice(0, sliceLen));
    };

    const loop = (ts) => {
      if (!lastTsRef.current) lastTsRef.current = ts;
      const dt = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;

      budgetRef.current += speed * dt;
      while (
        iRef.current < chunkRef.current.length &&
        budgetRef.current >= chunkCostsRef.current[iRef.current]
      ) {
        budgetRef.current -= chunkCostsRef.current[iRef.current];
        iRef.current += 1;
        const nextText = chunkRef.current.slice(0, iRef.current).join("");
        setShown(nextText);
        onProgress?.(textRef.current.length ? nextText.length / textRef.current.length : 1);
      }
      if (iRef.current < chunkRef.current.length) {
        renderPartial();
        rafRef.current = requestAnimationFrame(loop);
      } else {
        setShown(textRef.current);
        onDone?.();
      }
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current || 0);
  }, [id, speed, onDone, onProgress]);

  return (
    <div className="bizzy-tw">
      <MarkdownRenderer rehypePlugins={[rehypeWordFade]}>{shown}</MarkdownRenderer>
      <style>{`
        @keyframes bizzyTwFade { from { opacity: 0; transform: translateY(1px); filter: blur(0.25px); } to { opacity: 1; transform: translateY(0); filter: blur(0); } }
        .bizzy-tw .bizzy-tw-chunk { display: inline-block; opacity: 0; animation: bizzyTwFade .22s ease forwards; }
      `}</style>
    </div>
  );
}

/* ---------------- canvas shell ---------------- */
export default function ChatCanvas({
  left: propLeft,
  width: propWidth,
  topAnchorSelector = "[data-chat-top-anchor]",
  topOvershoot = 24,
}) {
  const { isCanvasOpen, closeCanvas } = useBizzyChatContext();
  const geom = useCenterBounds(propLeft, propWidth, topAnchorSelector, topOvershoot);

  const width = typeof propWidth === "number" ? propWidth : geom.width;
  const top = geom.top;

  // Smooth open
  const [appear, setAppear] = useState(false);
  useEffect(() => {
    if (!isCanvasOpen) return;
    const t = setTimeout(() => setAppear(true), 60);
    return () => { clearTimeout(t); setAppear(false); };
  }, [isCanvasOpen]);

  if (!isCanvasOpen) return null;
  if (!width || width <= 0) {
    return (
      <div style={{ position: "fixed", left: 0, right: 0, top: 0, height: 22, background: "rgba(255,0,0,.35)", color: "var(--text)", zIndex: 9600, display: "flex", alignItems: "center", paddingLeft: 8, fontSize: 12 }}>
        Canvas mounted, but width=0 — check [data-center-col] & header anchor
      </div>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        zIndex: 9500,
        left: 0,
        right: 0,
        top: `${top}px`,
        bottom: 0,
        pointerEvents: "auto",
        opacity: appear ? 1 : 0,
        transform: appear ? "translateY(0px)" : "translateY(8px)",
        transition: "opacity .24s cubic-bezier(.22,.1,.25,1), transform .24s cubic-bezier(.22,.1,.25,1)",
      }}
    >
      <div style={{ position: "absolute", inset: 0, background: "var(--bg)", backdropFilter: "none" }} />
      <div style={{ position: "relative", height: "100%", display: "flex", flexDirection: "column", width: "100%", padding: "12px 0" }}>
        <div style={{ display: "flex", justifyContent: "center", padding: "4px 0 6px" }}>
          <div style={{ width: "86vw", maxWidth: 780, display: "flex", justifyContent: "flex-end" }}>
            <button
              onClick={closeCanvas}
              className="bizzy-back-btn inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-white/5"
              style={{ color: "var(--text-2)" }}
              title="Back to Dashboard"
            >
              <ArrowLeft size={14} className="inline -mt-0.5 mr-1" />
              Back to Dashboard
            </button>
          </div>
        </div>
        <MessageStream />
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div style={{ width: "100%", maxWidth: 660 }}>
            <div style={{ height: 140 }} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- typing dots ---------------- */
function TypingIndicator() {
  return (
    <div className="chat-row">
      <div className="bubble-assistant">
        <div className="bizzy-typing"><span /><span /><span /></div>
      </div>
      <style>{`
        @keyframes bizzy-bounce{0%,80%,100%{transform:translateY(0);opacity:.7}40%{transform:translateY(-6px);opacity:1}}
        .bizzy-typing{display:inline-flex;gap:6px;align-items:center;padding:4px 2px}
        .bizzy-typing span{width:7px;height:7px;border-radius:9999px;background:var(--text);box-shadow:0 0 10px rgba(255,255,255,.28);animation:bizzy-bounce 1s infinite ease-in-out}
        .bizzy-typing span:nth-child(2){animation-delay:.15s}.bizzy-typing span:nth-child(3){animation-delay:.30s}
      `}</style>
    </div>
  );
}

/* ---------------- message stream ---------------- */
function MessageStream() {
  const { messages = [], isGenerating, activeThreadId, threadId, isCanvasOpen } = useBizzyChatContext();
  const { currentBusiness } = useBusiness?.() || {};
  const scrollerRef = useRef(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  /* stable id that never depends on text; zero-time assistant reply is keyed off its user */
  const idMapRef = useRef(new WeakMap());
  const keyCacheRef = useRef(new Map());
  const getStableId = (m, idx, list) => {
    if (keyCacheRef.current.has(m)) return keyCacheRef.current.get(m);
    let key = m?.id || m?.uuid || m?._id;
    if (!key) {
      const t = getMsgTime(m);
      if (t) key = hashStr(`${normSender(m)}|t:${t}`);
      else if (normSender(m) === "assistant" && idx > 0 && normSender(list[idx - 1]) === "user") {
        const prevKey = getStableId(list[idx - 1], idx - 1, list);
        key = `rep|${prevKey}`;
      } else {
        key = idMapRef.current.get(m);
        if (!key) { key = hashStr(`${normSender(m)}|z|${Math.random().toString(36).slice(2)}`); idMapRef.current.set(m, key); }
      }
    }
    keyCacheRef.current.set(m, key);
    return key;
  };

  /* Deterministic strictly increasing timeline */
  const sorted = useMemo(() => {
    const raw = messages.map((m, i) => ({ m, i, s: normSender(m), t: getMsgTime(m) }));
    const nonZero = raw.filter(r => r.t > 0).map(r => r.t);
    const base = nonZero.length ? Math.max(...nonZero) : 0;
    let seq = 0;
    const sortable = raw.map(r => ({ ...r, sortT: r.t > 0 ? r.t : base + (++seq) }));
    sortable.sort((a, b) => {
      if (a.sortT !== b.sortT) return a.sortT - b.sortT;
      if (a.s !== b.s) return a.s === "user" ? -1 : 1;
      return a.i - b.i;
    });
    return sortable.map(r => r.m);
  }, [messages]);

  /* Track the most recent user/assistant indices */
  const lastUserIdx = useMemo(() => {
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (normSender(sorted[i]) === "user") return i;
    }
    return -1;
  }, [sorted]);
  const lastAssistantIdx = useMemo(() => {
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (normSender(sorted[i]) === "assistant") return i;
    }
    return -1;
  }, [sorted]);
  const assistantCount = useMemo(() => sorted.filter((m) => normSender(m) === "assistant").length, [sorted]);
  const userCount = useMemo(() => sorted.filter((m) => normSender(m) === "user").length, [sorted]);
  const conversationExcerpt = useMemo(() => {
    const tail = sorted.slice(-12);
    return tail
      .map((m) => `${normSender(m) === "assistant" ? "Bizzi" : "You"}: ${m.text}`)
      .join("\n\n");
  }, [sorted]);
  const showSave = useMemo(() => {
    if (sorted.length < 6) return false;
    if (lastAssistantIdx === -1) return false;
    if (assistantCount < 3 || userCount < 3) return false;
    return true;
  }, [sorted.length, lastAssistantIdx, assistantCount, userCount]);
  const hasAssistantAfterLastUser = lastAssistantIdx > lastUserIdx && lastAssistantIdx !== -1;

  // Track the last assistant tail we've animated so it doesn't replay
  const lastAnimatedTailKeyRef = useRef(null);

  /* Reopen blocker — only trigger when opening a thread that already ends with assistant */
  const reopenBlockRef = useRef(false);
  const prevOpenRef = useRef(isCanvasOpen);
  const prevThreadRef = useRef(activeThreadId);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    const prevThread = prevThreadRef.current;
    prevOpenRef.current = isCanvasOpen;
    prevThreadRef.current = activeThreadId;

    if (!isCanvasOpen) {
      reopenBlockRef.current = false;
      return;
    }

    const justOpened = !wasOpen && isCanvasOpen;
    const threadChanged = prevThread && prevThread !== activeThreadId;
    if ((justOpened || threadChanged) && hasAssistantAfterLastUser) {
      reopenBlockRef.current = true;
      const t = setTimeout(() => { reopenBlockRef.current = false; }, 450);
      return () => clearTimeout(t);
    }

    if (!hasAssistantAfterLastUser) {
      reopenBlockRef.current = false;
    }
  }, [isCanvasOpen, activeThreadId, hasAssistantAfterLastUser]);

  /* Delayed typing dots (unchanged) */
  const [typingVisible, setTypingVisible] = useState(false);
  useEffect(() => {
    let timer;
    if (isGenerating) timer = setTimeout(() => setTypingVisible(true), 450);
    else setTypingVisible(false);
    return () => clearTimeout(timer);
  }, [isGenerating]);

  /* Auto-follow + bottom indicator */
  const scrollToBottom = (behavior = "smooth") => {
    const el = scrollerRef.current; if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  };
  const manualRef = useRef(false);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const THRESH = 64;
    const onScroll = () => {
      const d = el.scrollHeight - el.clientHeight - el.scrollTop;
      manualRef.current = d > THRESH;
      setShowScrollBtn(d > 96);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onScroll, { passive: true });
    el.addEventListener("touchstart", onScroll, { passive: true });
    el.addEventListener("touchmove", onScroll, { passive: true });
    onScroll();
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onScroll);
      el.removeEventListener("touchstart", onScroll);
      el.removeEventListener("touchmove", onScroll);
    };
  }, []);
  useEffect(() => { if (!manualRef.current) scrollToBottom(); }, [sorted, isGenerating]);
  useEffect(() => {
    if (!isCanvasOpen) return;
    manualRef.current = false;
    const t = requestAnimationFrame(() => scrollToBottom("auto"));
    return () => cancelAnimationFrame(t);
  }, [isCanvasOpen, activeThreadId]);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const d = el.scrollHeight - el.clientHeight - el.scrollTop;
    setShowScrollBtn(d > 96);
  }, [sorted.length]);

  /* Pre-mark older assistants: assistants at or before the last user never replay */
  const animatedRef = useRef(new Set());
  useLayoutEffect(() => {
    if (!isCanvasOpen) return;
    keyCacheRef.current.clear();

    const preset = new Set();
    sorted.forEach((m, idx) => {
      if (normSender(m) !== "assistant") return;
      if (lastUserIdx >= 0 && idx <= lastUserIdx) {
        preset.add(getStableId(m, idx, sorted));
      }
    });
    // When opening/selecting a thread, also pre-mark the tail assistant so it doesn't replay
    if (threadJustOpenedRef.current && lastAssistantIdx >= 0) {
      const tailKey = getStableId(sorted[lastAssistantIdx], lastAssistantIdx, sorted);
      preset.add(tailKey);
    }

    animatedRef.current = preset;
  }, [isCanvasOpen, sorted, activeThreadId, lastUserIdx]);

  /* Detect fresh user submissions per thread */
  const userKeyByThreadRef = useRef(new Map());
  const lastThreadSeenRef = useRef(null);
  const threadJustOpenedRef = useRef(false);
  const hadHistoryAtOpenRef = useRef(false);
  const freshQueryRef = useRef(false);
  useEffect(() => {
    const PENDING_THREAD_ID = "__pending__thread__";
    const threadId = activeThreadId || PENDING_THREAD_ID;
    const threadChanged = lastThreadSeenRef.current !== threadId;
    const currentUserKey =
      lastUserIdx >= 0 ? getStableId(sorted[lastUserIdx], lastUserIdx, sorted) : null;

    if (threadChanged) {
      const prevThread = lastThreadSeenRef.current;
      const promotedFromPending = prevThread === PENDING_THREAD_ID && threadId !== PENDING_THREAD_ID;

      if (promotedFromPending) {
        const prevKey = userKeyByThreadRef.current.get(PENDING_THREAD_ID);
        if (prevKey !== undefined) {
          userKeyByThreadRef.current.set(threadId, prevKey);
        } else if (currentUserKey) {
          userKeyByThreadRef.current.set(threadId, currentUserKey);
        }
        userKeyByThreadRef.current.delete(PENDING_THREAD_ID);
        lastThreadSeenRef.current = threadId;
        // Preserve whatever fresh-query state we already have; this is the same live chat.
        return;
      }

      lastThreadSeenRef.current = threadId;
      threadJustOpenedRef.current = true;
      hadHistoryAtOpenRef.current = sorted.some((m) => normSender(m) === "assistant");
      freshQueryRef.current = false;
      lastAnimatedTailKeyRef.current = null;
      reopenBlockRef.current = false;
      return;
    }

    if (!threadId || currentUserKey === null) return;

    const prevKey = userKeyByThreadRef.current.get(threadId);
    if (prevKey === currentUserKey) return;

    userKeyByThreadRef.current.set(threadId, currentUserKey);
    const suppress = threadJustOpenedRef.current && hadHistoryAtOpenRef.current;
    threadJustOpenedRef.current = false;
    if (suppress) return;
    freshQueryRef.current = true;
  }, [sorted, lastUserIdx, activeThreadId]);

  /* Render */
  const [doneBump, setDoneBump] = useState(0);

  return (
    <div ref={scrollerRef} className="bizzy-canvas-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingTop: 6, paddingBottom: 0 }}>
      <div style={{ display: "flex", justifyContent: "center" }}>
        <div style={{ width: "86vw", maxWidth: 660 }}>
          <style>{`
            .bizzy-canvas-scroll { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.24) transparent; }
            .bizzy-canvas-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
            .bizzy-canvas-scroll::-webkit-scrollbar-track { background: transparent; }
            .bizzy-canvas-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.24); border-radius: 9999px; border: 2px solid transparent; background-clip: padding-box; }
            .bizzy-canvas-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.32); }
            .chat-row  { margin: 18px 6px; }
            .row-wrap  { width: 100%; max-width: 100%; gap: 8px; display:flex; flex-direction:column; align-items:flex-start; }
            .row-wrap--user { align-items: flex-end; }
            .bubble-user { background: rgba(255,255,255,0.055); padding: 12px 14px; border-radius: 14px;
                           color:${WARM_TEXT}; display:inline-block; max-width:100%; border:1px solid rgba(255,255,255,0.08);
                           word-break: break-word; white-space: normal; text-align:right; }
            .bubble-assistant { color:${WARM_TEXT}; max-width:100%; margin-top:10px; padding: 4px 0; }
            .actions { opacity:0; transition:opacity .18s ease; display:flex; gap:8px; margin-top:6px; }
            .actions--visible { opacity:.9; }
            .tipwrap{ position:relative; display:inline-flex; align-items:center; }
            .btn-ico{ border:none; outline:none; background:transparent; color:var(--text-2);
                      width:32px; height:32px; border-radius:999px; display:inline-flex; align-items:center; justify-content:center;
                      transition: background .15s ease, color .15s ease, transform .12s ease; }
            .btn-ico:hover{ background: rgba(255,255,255,0.10); color:#fff; transform: translateY(-1px); }
            .tooltip{ position:absolute; top:calc(100% + 8px); left:50%; transform: translate(-50%, 0);
                      z-index:10100; background:rgba(28,28,30,0.92); color:#fff; font-size:12px; line-height:1;
                      padding:8px 10px; border-radius:10px; box-shadow:0 10px 30px rgba(0,0,0,0.35);
                      white-space:nowrap; pointer-events:none; opacity:0; transition:opacity .15s ease, transform .15s ease; }
            .tipwrap:hover .tooltip{ opacity:1; transform: translate(-50%, 0); }
          `}</style>
          <style>{`
            .bizzy-back-btn { background: transparent; }
            .bizzy-back-btn:hover { background: rgba(255,255,255,0.05); }
          `}</style>

          <div style={{ display: "none" }}>{doneBump}</div>

          {sorted.map((m, idx) => {
            const s  = normSender(m);
            const key = getStableId(m, idx, sorted);

            if (s === "user") {
              return (
                <div className="chat-row" key={key}>
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <div className="row-wrap row-wrap--user">
                      <div className="bubble-user">{m.text}</div>
                    </div>
                  </div>
                </div>
              );
            }

            // Animate tail assistant exactly once (no replay on reopen)
            const isTailAssistant = idx === lastAssistantIdx;
            const alreadyAnimated = animatedRef.current.has(key);

            // Animate only if:
            //  - this row is the current tail assistant
            //  - that assistant follows a fresh user message
            //  - we didn't animate this particular tail before
            //  - and we aren't in "reopen suppress" mode
            const shouldAnimate =
              isTailAssistant &&
              hasAssistantAfterLastUser &&
              lastAnimatedTailKeyRef.current !== key &&
              !alreadyAnimated &&
              !reopenBlockRef.current &&
              freshQueryRef.current &&
              !threadJustOpenedRef.current;

            if (shouldAnimate) {
              return (
                <div className="chat-row" key={key}>
                  <AssistantRow
                    id={key}
                    text={m.text}
                    onProgress={() => {
                      const el = scrollerRef.current;
                      if (el) el.scrollTop = el.scrollHeight;
                    }}
                    onDone={() => {
                      animatedRef.current.add(key);
                      lastAnimatedTailKeyRef.current = key;
                      freshQueryRef.current = false;
                      setDoneBump(n => n + 1);
                    }}
                    showActions={false}
                  />
                </div>
              );
            }

            const showActions = idx === lastAssistantIdx;
            const allowSave = showSave && idx === lastAssistantIdx;
            return (
              <div className="chat-row" key={key}>
                <div className="row-wrap">
                  <div className="bubble-assistant"><MarkdownRenderer>{m.text}</MarkdownRenderer></div>
                  <ActionRow
                    text={m.text}
                    show={showActions}
                    allowSave={allowSave}
                    conversationExcerpt={conversationExcerpt}
                    businessName={currentBusiness?.business_name}
                    threadId={threadId}
                    activeThreadId={activeThreadId}
                  />
                </div>
              </div>
            );
          })}

          {/* delayed typing dots only when the last message is NOT assistant */}
          {(() => {
            const last = sorted[sorted.length - 1];
            return isGenerating && normSender(last) !== "assistant" ? <TypingIndicator /> : null;
          })()}

          {showScrollBtn && !isGenerating && (
            <div className="sticky bottom-0 flex justify-center pointer-events-none z-[9805]">
              <button
                onClick={() => scrollToBottom("smooth")}
                className="pointer-events-auto inline-flex items-center gap-1 rounded-full px-3 py-2 text-[12px] text-white bg-[#1f1f20] border border-white/15 shadow-sm hover:bg-[#242526] hover:border-white/25 transition"
                aria-label="Jump to latest"
              >
                ↓
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- rows & actions ---------------- */
function AssistantRow({ id, text, onProgress, onDone, showActions, allowSave }) {
  return (
    <div className="row-wrap">
      <div className="bubble-assistant">
        <Typewriter id={id} text={text} speed={140} onProgress={onProgress} onDone={onDone} />
      </div>
      <ActionRow text={text} show={!!showActions} allowSave={allowSave} />
    </div>
  );
}
function ActionRow({ text, show = false, allowSave = false, conversationExcerpt, businessName, threadId, activeThreadId }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const doCopy = async () => { try { await navigator.clipboard.writeText(text || ""); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {} };
  const doSave = async () => {
    if (!text || saving || !allowSave) return;
    try {
      setSaving(true);
      let title = `Bizzi response — ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
      let summarySections = [{ heading: '', body: text }];
      if (threadId && threadId === activeThreadId) {
        try {
          const summary = await generateThreadSummary({ threadId, businessName, text: conversationExcerpt || text });
          if (summary?.title) title = summary.title;
          if (Array.isArray(summary?.sections) && summary.sections.length) {
            summarySections = summary.sections
              .map((section, idx) => ({
                heading: section.heading || (idx === 0 ? 'Summary' : ''),
                body: section.body || '',
              }))
              .filter((section) => section.body);
          }
        } catch (e) {
          console.warn('Summary generation failed, fallback to raw text', e);
        }
      }
      if (!summarySections.length) {
        summarySections = [{ heading: 'Conversation recap', body: conversationExcerpt || text }];
      }
      await createDoc({
        title,
        category: 'general',
        content: {
          format: 'sections',
          sections: summarySections,
          plain_excerpt: summarySections.map((s) => s.body).join('\n').slice(0, 600),
        },
        tags: ['bizzy', 'chat'],
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('Save to Bizzi Docs failed', e);
      alert('Could not save this conversation to Bizzi Docs.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className={`actions ${show ? "actions--visible" : ""}`}>
      <span className="tipwrap">
        <button className="btn-ico" onClick={doCopy} aria-label="Copy">
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
        <span className="tooltip">{copied ? "Copied!" : "Copy"}</span>
      </span>
      {allowSave ? (
        <span className="tipwrap">
          <button className="btn-ico" onClick={doSave} aria-label="Save to Bizzi Docs" disabled={saving}>
            {saved ? <Check size={16} /> : <Save size={16} />}
          </button>
          <span className="tooltip">{saved ? "Saved!" : "Save to Bizzi Docs"}</span>
        </span>
      ) : null}
    </div>
  );
}
