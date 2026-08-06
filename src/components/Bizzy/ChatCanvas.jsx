// /src/components/Bizzy/ChatCanvas.jsx
import React, { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback, useId } from "react";
import { createPortal } from "react-dom";
import { Copy, Save, ArrowLeft, Check, FileText, Receipt, ArrowUpRight, ChevronRight, ChevronDown } from "lucide-react";
import { useBizzyChatContext } from "../../context/BizzyChatContext";
import MarkdownRenderer from "./MarkdownRenderer";
import { useBusiness } from "../../context/BusinessContext";
import { createDoc } from "../../services/bizzyDocs/docsService";
import { generateThreadSummary } from "../../services/bizzyDocs/threadSummary";
import { CHAT_ALIGN_NUDGE_PX } from "../../config/chatLayout";
import { CANVAS_BAR_HEIGHT } from "../../config/chatCanvasLayout";
import { apiUrl, safeFetch } from "../../utils/safeFetch";
import ChatCanvasBar from "./ChatCanvasBar";

const WARM_TEXT = "var(--text)";
const FOLLOWUPS_ENABLED = false; // temporarily hide follow-up prompts from the canvas
const FOLLOWUP_MIN_LENGTH = 240; // chars threshold for showing follow-ups
const FOLLOWUP_USER_MAX = 600;
const FOLLOWUP_ASSISTANT_MAX = 900;
const UNRESOLVED_PATTERNS = [
  "next step",
  "one clear next action",
  "please confirm",
  "do you want me to",
  "approve",
  "needs review",
  "connect",
  "set up",
  "follow up",
];

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

function chunkWords(str = "") {
  if (!str) return [{ text: "", atomic: true }];

  const splitWordsPreserveWhitespace = (line = "") => {
    const parts = [];
    let cursor = 0;
    while (cursor < line.length && /\s/.test(line[cursor])) cursor += 1;
    if (cursor > 0) parts.push({ text: line.slice(0, cursor), atomic: false });
    const wordRegex = /\S+\s*/g;
    wordRegex.lastIndex = cursor;
    let match;
    while ((match = wordRegex.exec(line))) {
      parts.push({ text: match[0], atomic: false });
      cursor = wordRegex.lastIndex;
    }
    if (cursor < line.length) parts.push({ text: line.slice(cursor), atomic: false });
    return parts;
  };

  const chunks = [];
  const lines = str.split("\n");
  lines.forEach((line, idx) => {
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const [, indent, marker, rest] = listMatch;
      chunks.push({ text: `${indent}${marker} `, atomic: true });
      if (rest) chunks.push(...splitWordsPreserveWhitespace(rest));
    } else if (line.length === 0) {
      chunks.push({ text: "", atomic: true });
    } else {
      chunks.push(...splitWordsPreserveWhitespace(line));
    }
    if (idx < lines.length - 1) chunks.push({ text: "\n", atomic: true });
  });

  return chunks.length ? chunks : [{ text: "", atomic: true }];
}

function hideDanglingMarkdownMarkers(str = "") {
  if (!str) return "";

  const hideLastUnpairedDoubleMarker = (input, marker) => {
    const positions = [];
    for (let i = 0; i < input.length - 1; i += 1) {
      if (input[i] === "\\" || input.slice(i, i + marker.length) !== marker) continue;
      positions.push(i);
      i += marker.length - 1;
    }
    if (positions.length % 2 === 0) return input;
    const last = positions[positions.length - 1];
    return input.slice(0, last) + input.slice(last + marker.length);
  };

  let safe = str;
  safe = hideLastUnpairedDoubleMarker(safe, "**");
  safe = hideLastUnpairedDoubleMarker(safe, "__");
  return safe;
}

function measureTopOffsetForSelector(selector) {
  if (!selector || typeof document === "undefined") return 0;
  const el = document.querySelector(selector);
  if (!el) return 0;
  const rect = el.getBoundingClientRect();
  return Math.max(0, Math.round(rect.top));
}

// Singleton portal target for the scroll-to-bottom button
function getScrollPortalRoot() {
  if (typeof document === "undefined") return null;
  const existing = document.getElementById("bizzy-scrollbottom-root");
  if (existing) return existing;
  const el = document.createElement("div");
  el.id = "bizzy-scrollbottom-root";
  document.body.appendChild(el);
  return el;
}

function hasUnresolvedAction(text = "") {
  const lower = (text || "").toLowerCase();
  return UNRESOLVED_PATTERNS.some((p) => lower.includes(p));
}

function truncateForFollowups(text = "", max = 600, mode = "tail") {
  if (!text) return "";
  const squished = text.replace(/\s+/g, " ").trim();
  if (!squished) return "";
  if (squished.length <= max) return squished;
  if (mode === "tail") {
    return squished.slice(-max);
  }
  if (mode === "head_tail") {
    const headLen = Math.min(200, Math.floor(max * 0.3));
    const tailLen = max - headLen - 5; // leave room for spacer
    const head = squished.slice(0, headLen);
    const tail = squished.slice(-Math.max(0, tailLen));
    return `${head} ... ${tail}`.slice(-max);
  }
  return squished.slice(0, max);
}

/* ---------------- typewriter ---------------- */
const REVEAL_LEAD_IN_CHARS = 180;
const REVEAL_MAX_DURATION_MS = 2600;
const REVEAL_TARGET_CHUNK_FRAMES = 48;

function getBurstSize(totalLength = 0) {
  if (totalLength <= REVEAL_LEAD_IN_CHARS) return 1;
  const remaining = Math.max(0, totalLength - REVEAL_LEAD_IN_CHARS);
  return Math.max(2, Math.ceil(remaining / REVEAL_TARGET_CHUNK_FRAMES));
}

function Typewriter({ id, text = "", speed = 200, onDone, onProgress }) {
  const [typingDone, setTypingDone] = useState(false);
  const [shown, setShown] = useState("");
  const iRef = useRef(0);
  const rafRef = useRef(null);
  const lastTsRef = useRef(0);
  const textRef = useRef(text);
  textRef.current = text;
  const onDoneRef = useRef(onDone);
  const onProgressRef = useRef(onProgress);
  const finishedRef = useRef(false);
  useEffect(() => {
    onDoneRef.current = onDone;
    onProgressRef.current = onProgress;
  }, [onDone, onProgress]);
  const chunkRef = useRef([]);
  const chunkCostsRef = useRef([]);
  const budgetRef = useRef(0);
  const visibleCharCountRef = useRef(0);
  useEffect(() => {
    setTypingDone(false);
  }, [id, text]);

  useEffect(() => {
    cancelAnimationFrame(rafRef.current || 0);
    iRef.current = 0;
    setShown("");
    lastTsRef.current = 0;
    budgetRef.current = 0;
    visibleCharCountRef.current = 0;
    finishedRef.current = false;
    const chunks = chunkWords(textRef.current);
    chunkRef.current = chunks;
    chunkCostsRef.current = chunks.map(({ text }) => {
      const trimmed = text.replace(/\s+/g, "");
      const cost = trimmed.length || text.length || 1;
      return Math.max(1, cost);
    });

    const renderPartial = () => {
      const idx = iRef.current;
      const chunks = chunkRef.current;
      const costs = chunkCostsRef.current;
      if (idx >= chunks.length) return;
      const base = chunks.slice(0, idx).map((c) => c.text).join("");
      visibleCharCountRef.current = base.length;
      setShown(base);
    };

    const loop = (ts) => {
      if (!lastTsRef.current) lastTsRef.current = ts;
      const dt = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;

      const totalLength = textRef.current.length;
      const burstSize = getBurstSize(totalLength);
      const leadInComplete = visibleCharCountRef.current >= Math.min(REVEAL_LEAD_IN_CHARS, totalLength);
      const revealSpeed = leadInComplete
        ? Math.max(speed * burstSize, totalLength / (REVEAL_MAX_DURATION_MS / 1000))
        : speed;
      budgetRef.current += revealSpeed * dt;
      while (
        iRef.current < chunkRef.current.length &&
        budgetRef.current >= chunkCostsRef.current[iRef.current]
      ) {
        budgetRef.current -= chunkCostsRef.current[iRef.current];
        iRef.current += 1;
        const nextText = chunkRef.current.slice(0, iRef.current).map((c) => c.text).join("");
        visibleCharCountRef.current = nextText.length;
        setShown(nextText);
        onProgressRef.current?.(
          textRef.current.length ? nextText.length / textRef.current.length : 1
        );
      }
      if (iRef.current < chunkRef.current.length) {
        renderPartial();
        rafRef.current = requestAnimationFrame(loop);
      } else {
        setShown(textRef.current);
        if (!finishedRef.current) {
          finishedRef.current = true;
          onProgressRef.current?.(1);
          onDoneRef.current?.();
          setTypingDone(true);
        }
      }
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current || 0);
  }, [id, text, speed]);

  return (
    <div className="bizzy-tw" data-typing={typingDone ? "false" : "true"}>
      <MarkdownRenderer>{typingDone ? text : hideDanglingMarkdownMarkers(shown)}</MarkdownRenderer>
    </div>
  );
}

/* ---------------- canvas shell ---------------- */
export default function ChatCanvas({
  left: propLeft,
  width: propWidth,
  rightInset = 0,
  barNudge = 0,
  topAnchorSelector,
  quickPromptMode = "normal",
}) {
  const { isCanvasOpen, leaveCanvas } = useBizzyChatContext();
  const canvasRightInset = Math.max(0, Math.round(Number(rightInset) || 0));
  const prevOverflowRef = useRef({ body: "", html: "" });
  const navWidth = useMemo(() => {
    if (typeof window === "undefined") return 0;
    const fromVar = getComputedStyle(document.documentElement).getPropertyValue("--nav-w") || "0";
    const parsed = parseInt(fromVar, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }, [isCanvasOpen]);

  // Smooth open
  const [appear, setAppear] = useState(false);
  useEffect(() => {
    if (!isCanvasOpen) return;
    const t = setTimeout(() => setAppear(true), 60);
    return () => { clearTimeout(t); setAppear(false); };
  }, [isCanvasOpen]);

  useEffect(() => {
    if (!isCanvasOpen) return;
    try {
      prevOverflowRef.current = {
        body: document.body.style.overflow || "",
        html: document.documentElement.style.overflow || "",
      };
      document.body.style.overflow = "hidden";
      document.documentElement.style.overflow = "hidden";
    } catch {}
    return () => {
      try {
        document.body.style.overflow = prevOverflowRef.current.body || "";
        document.documentElement.style.overflow = prevOverflowRef.current.html || "";
      } catch {}
    };
  }, [isCanvasOpen]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    document.documentElement.style.setProperty("--bizzy-canvas-right-inset", `${canvasRightInset}px`);
    return () => {
      document.documentElement.style.setProperty("--bizzy-canvas-right-inset", "0px");
    };
  }, [canvasRightInset]);

  const handleCanvasWheel = useCallback((event) => {
    const el = event.currentTarget;
    if (!el) return;
    const delta = event.deltaY || 0;
    const atTop = el.scrollTop <= 0;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    if ((delta < 0 && atTop) || (delta > 0 && atBottom)) {
      event.preventDefault();
    }
    event.stopPropagation();
  }, []);

  // Respect the caller's top anchor (e.g., keep dashboard header visible)
  const [topOffset, setTopOffset] = useState(() => measureTopOffsetForSelector(topAnchorSelector));
  useLayoutEffect(() => {
    if (!topAnchorSelector || typeof window === "undefined") return;
    const measure = () => {
      setTopOffset(measureTopOffsetForSelector(topAnchorSelector));
    };
    measure();
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [topAnchorSelector, isCanvasOpen]);

  // Keep conversation width in sync with the visible chat bar width
  const barMeasureRef = useRef(null);
  const [contentWidth, setContentWidth] = useState(null);
  const [contentGutter, setContentGutter] = useState(0);
  const canvasScrollRef = useRef(null);
  const [scrollShellStyle, setScrollShellStyle] = useState(null);

  useEffect(() => {
    if (!isCanvasOpen) return;
    const updateShell = () => {
      const bar = barMeasureRef.current;
      if (!bar) return;
      const quickRow = bar.querySelector?.(".bizzy-qprompts");
      const rect = (quickRow || bar).getBoundingClientRect();
      setScrollShellStyle({ left: rect.left, width: rect.width });
    };
    const raf = requestAnimationFrame(updateShell);
    window.addEventListener("resize", updateShell);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateShell) : null;
    ro?.observe(barMeasureRef.current);
    const quickRow = barMeasureRef.current?.querySelector?.(".bizzy-qprompts");
    if (quickRow) ro?.observe(quickRow);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", updateShell);
      ro?.disconnect();
    };
  }, [isCanvasOpen]);
  useLayoutEffect(() => {
    if (!isCanvasOpen) return;
    const pillEl = barMeasureRef.current?.querySelector?.("[data-bizzy-chatbar-pill]");
    if (!pillEl || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const rect = pillEl.getBoundingClientRect();
      const w = Math.round(rect?.width || 0);
      const cs = window.getComputedStyle(pillEl);
      const padL = Math.round(parseFloat(cs.paddingLeft || "0"));
      const padR = Math.round(parseFloat(cs.paddingRight || "0"));
      const maxCol = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue("--chat-col-max") || "900",
        10
      );
      const clamped = maxCol && Number.isFinite(maxCol) ? Math.min(w, maxCol) : w;
      setContentWidth(clamped || null);
      setContentGutter(Math.max(padL, padR) || 0);
      const barRect = barMeasureRef.current?.getBoundingClientRect?.();
      if (barRect) {
        const quickRow = barMeasureRef.current?.querySelector?.(".bizzy-qprompts");
        const rect = (quickRow || barMeasureRef.current).getBoundingClientRect();
        setScrollShellStyle({ left: rect.left, width: rect.width });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(pillEl);
    return () => ro.disconnect();
  }, [isCanvasOpen]);

  const columnStyle = {
    margin: "0 auto",
    width: contentWidth ? `${contentWidth}px` : "var(--chat-col-max)",
    maxWidth: contentWidth ? `${contentWidth}px` : "var(--chat-col-max)",
    boxSizing: "border-box",
  };

  if (!isCanvasOpen) return null;

  const effectiveTop = Math.min(Math.max(0, topOffset), 16);

  const handleBackToDashboard = () => {
    // Only close the canvas; let the current route remain (e.g., stay on ChatHome).
    try {
      leaveCanvas?.();
    } catch {}
  };

  return (
    <div
      style={{
        position: "fixed",
        zIndex: 9500,
        top: `${effectiveTop}px`,
        bottom: 0,
        left: `${navWidth}px`,
        right: `${canvasRightInset}px`,
        pointerEvents: "auto",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--bg)",
        overscrollBehavior: "contain",
        isolation: "isolate",
        transition: "right 560ms cubic-bezier(0.22,1,0.36,1)",
      }}
      onWheelCapture={(event) => event.stopPropagation()}
      onTouchMoveCapture={(event) => event.stopPropagation()}
    >
      <div
        aria-hidden
        className="bizzy-bg-textured"
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 0,
          backgroundColor: "var(--bg)",
          pointerEvents: "none",
        }}
      />

      <button
        type="button"
        onClick={handleBackToDashboard}
        className="hidden md:inline-flex items-center gap-2 rounded-md border border-transparent bg-transparent text-white/80 hover:bg-white/6 transition-colors px-2.5 py-1.5"
        style={{
          position: "fixed",
          top: `${effectiveTop + 12}px`,
          left: `${navWidth}px`,
          zIndex: 9800,
          pointerEvents: "auto",
          backdropFilter: "none",
          boxShadow: "none",
        }}
        aria-label="Back to dashboard"
      >
        <ArrowLeft size={16} />
        <span className="text-sm font-medium">Dashboard</span>
      </button>

      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minHeight: 0,
          opacity: appear ? 1 : 0,
          transform: appear ? "translateY(0px)" : "translateY(8px)",
          transition: "opacity .24s cubic-bezier(.22,.1,.25,1), transform .24s cubic-bezier(.22,.1,.25,1)",
        }}
      >
        {/* Scroll layer fills available vertical space */}
        <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
          <div
            ref={canvasScrollRef}
            className="bizzy-canvas-scroll"
            style={{
              position: "absolute",
              inset: 0,
              overflowY: "auto",
              overflowX: "hidden",
              paddingTop: 104,
              overscrollBehavior: "contain",
              pointerEvents: "auto",
            }}
            onWheel={handleCanvasWheel}
          >
            <div style={columnStyle}>
              <MessageStream
                contentGutter={contentGutter}
                scrollerRef={canvasScrollRef}
                scrollShellStyle={scrollShellStyle}
              />
            </div>
          </div>
        </div>

        {/* Canvas-specific bar inside the shared column */}
        <div style={{ position: "relative", flexShrink: 0, marginBottom: "16px" }}>
          <div style={columnStyle} ref={barMeasureRef}>
            <ChatCanvasBar
              quickPromptMode={quickPromptMode}
              placeholder="Talk to Bizzi about your books, cash flow, jobs, or taxes…"
            />
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
        @keyframes bizzy-bounce{0%,80%,100%{transform:translateY(0);opacity:.58}40%{transform:translateY(-3px);opacity:.82}}
        @keyframes bizzy-glow{
          0%{background:rgba(247,241,232,.64);box-shadow:0 0 4px rgba(247,241,232,.1);}
          50%{background:rgba(220,214,206,.78);box-shadow:0 0 6px rgba(220,214,206,.14);}
          100%{background:rgba(247,241,232,.64);box-shadow:0 0 4px rgba(247,241,232,.1);}
        }
        .bizzy-typing{display:inline-flex;gap:5px;align-items:center;padding:6px 4px}
        .bizzy-typing span{
          width:5px;height:5px;border-radius:9999px;
          animation:bizzy-bounce 1s infinite ease-in-out,bizzy-glow 1.6s infinite ease-in-out;
        }
        .bizzy-typing span:nth-child(2){animation-delay:.12s,.12s}
        .bizzy-typing span:nth-child(3){animation-delay:.24s,.24s}
      `}</style>
    </div>
  );
}

/* ---------------- message stream ---------------- */
function MessageStream({ contentGutter = 0, scrollerRef: providedScrollerRef, scrollShellStyle }) {
  const {
    messages = [],
    isGenerating,
    activeThreadId,
    threadId,
    isCanvasOpen,
    sendMessage,
  } = useBizzyChatContext();
  const { currentBusiness } = useBusiness?.() || {};
  const localScrollerRef = useRef(null);
  const scrollerRef = providedScrollerRef || localScrollerRef;
  const bottomRef = useRef(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [historyRevealVisible, setHistoryRevealVisible] = useState(true);
  const [followups, setFollowups] = useState([]);
  const [followupsLoading, setFollowupsLoading] = useState(false);
  const [followupSending, setFollowupSending] = useState(false);
  const followupAnchorRef = useRef(null);
  const [followupDockStyle, setFollowupDockStyle] = useState(null);
  const followupKeyRef = useRef(null);
  const followupAbortRef = useRef(null);
  const followupTimerRef = useRef(null);
  const followupAttemptedRef = useRef(new Set());
  const followupSendRef = useRef(false);
  const followupCacheRef = useRef(new Map()); // cache by assistantKey to avoid refetch on reopen
  const followupsFromCacheRef = useRef(false);
  const followupsStatic = followupsFromCacheRef.current;
  const typewriterDoneRef = useRef(new Map()); // track when the tail assistant finished typing
  const [typewriterTick, setTypewriterTick] = useState(0);
  const markTypewriterPending = useCallback((key) => {
    if (!key) return;
    if (typewriterDoneRef.current.get(key) === false) return;
    typewriterDoneRef.current.set(key, false);
    setFollowups([]);
    setFollowupsLoading(false);
    setFollowupDockStyle(null);
    setTypewriterTick((n) => n + 1);
  }, []);
  const markTypewriterDone = useCallback((key) => {
    if (!key) return;
    if (typewriterDoneRef.current.get(key) === true) return;
    typewriterDoneRef.current.set(key, true);
    setTypewriterTick((n) => n + 1);
  }, []);
  const uniqFollowups = useCallback((arr = []) => {
    return Array.from(new Set((arr || []).filter(Boolean))).slice(0, 3);
  }, []);
  useEffect(() => {
    if (!isCanvasOpen) {
      // Hard reset follow-up UI/state when the canvas closes so dashboards/ChatHome never inherit it
      if (followupTimerRef.current) {
        clearTimeout(followupTimerRef.current);
        followupTimerRef.current = null;
      }
      if (followupAbortRef.current) {
        followupAbortRef.current.abort();
        followupAbortRef.current = null;
      }
      followupAttemptedRef.current.clear();
      followupCacheRef.current.clear();
      followupKeyRef.current = null;
      setFollowups([]);
      setFollowupDockStyle(null);
    }
  }, [isCanvasOpen]);

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
  const lastAssistantMsg = lastAssistantIdx >= 0 ? sorted[lastAssistantIdx] : null;
  const lastUserMsg = lastUserIdx >= 0 ? sorted[lastUserIdx] : null;
  const conversationExcerpt = useMemo(() => {
    const tail = sorted.slice(-12);
    return tail
      .map((m) => `${normSender(m) === "assistant" ? "Bizzi" : "You"}: ${m.text}`)
      .join("\n\n");
  }, [sorted]);
  const hasAssistantAfterLastUser = lastAssistantIdx > lastUserIdx && lastAssistantIdx !== -1;

  // Track the last assistant tail we've animated so it doesn't replay
  const lastAnimatedTailKeyRef = useRef(null);
  const handleFollowupClick = useCallback(
    async (text) => {
      const prompt = (text || "").trim();
      if (!prompt || followupSendRef.current) return;
      followupSendRef.current = true;
      setFollowupSending(true);
      try {
        await sendMessage(prompt, { openCanvas: true });
      } catch (e) {
        console.warn("[BizzyChat] follow-up send failed", e);
      } finally {
        followupSendRef.current = false;
        setFollowupSending(false);
        requestAnimationFrame(() =>
          window.dispatchEvent(new CustomEvent("bizzy:scrollCanvasBottom"))
        );
      }
    },
    [sendMessage]
  );

  /* Fetch follow-up suggestions for the latest assistant reply */
  useEffect(() => {
    if (!FOLLOWUPS_ENABLED) {
      setFollowups([]);
      setFollowupsLoading(false);
      setFollowupDockStyle(null);
      followupKeyRef.current = null;
      followupsFromCacheRef.current = false;
      return;
    }

    const latestAssistantText = lastAssistantMsg?.text || "";
    const latestUserText = lastUserMsg?.text || "";
    const assistantKey =
      lastAssistantMsg && lastAssistantIdx >= 0
        ? getStableId(lastAssistantMsg, lastAssistantIdx, sorted)
        : null;

    const showFollowups =
      !!latestAssistantText &&
      (latestAssistantText.length >= FOLLOWUP_MIN_LENGTH || hasUnresolvedAction(latestAssistantText));

    const cancelPending = () => {
      if (followupTimerRef.current) {
        clearTimeout(followupTimerRef.current);
        followupTimerRef.current = null;
      }
      if (followupAbortRef.current) {
        followupAbortRef.current.abort();
        followupAbortRef.current = null;
      }
    };

    const trimmedUser = truncateForFollowups(latestUserText, FOLLOWUP_USER_MAX, "head_tail");
    const trimmedAssistant = truncateForFollowups(latestAssistantText, FOLLOWUP_ASSISTANT_MAX, "head_tail");

    // Wait until the tail assistant has fully finished typing before showing follow-ups
    if (assistantKey && typewriterDoneRef.current.get(assistantKey) === false) {
      cancelPending();
      return;
    }

    if (!assistantKey || !showFollowups || !trimmedUser || !trimmedAssistant) {
      cancelPending();
      setFollowups([]);
      setFollowupsLoading(false);
      followupKeyRef.current = assistantKey;
      followupsFromCacheRef.current = false;
      return;
    }

    // If we already have cached follow-ups for this assistant message, reuse them and skip fetch
    if (followupCacheRef.current.has(assistantKey)) {
      const cached = uniqFollowups(followupCacheRef.current.get(assistantKey) || []);
      followupCacheRef.current.set(assistantKey, cached);
      setFollowups(cached);
      setFollowupsLoading(false);
      followupKeyRef.current = assistantKey;
      followupsFromCacheRef.current = true;
      return;
    }

    followupsFromCacheRef.current = false;
    if (followupAttemptedRef.current.has(assistantKey)) {
      return;
    }

    if (followupKeyRef.current === assistantKey && (followups.length > 0 || followupsLoading)) {
      return;
    }

    followupKeyRef.current = assistantKey;
    cancelPending();

    const controller = new AbortController();
    followupAbortRef.current = controller;
    followupAttemptedRef.current.add(assistantKey);
    followupTimerRef.current = setTimeout(async () => {
      setFollowupsLoading(true);
      try {
        if (import.meta?.env?.DEV) {
          // Lightweight debug, lengths only
          console.debug("[BizzyChat] followups payload lens", {
            user: trimmedUser.length,
            assistant: trimmedAssistant.length,
          });
        }
        const data = await safeFetch(apiUrl("/api/bizzy/followups"), {
          method: "POST",
          body: {
            lastUserMessage: trimmedUser,
            lastAssistantMessage: trimmedAssistant,
          },
          signal: controller.signal,
        });
        const qs = uniqFollowups(Array.isArray(data?.questions) ? data.questions : []);
        const next = qs.length === 3 ? qs : [];
        followupCacheRef.current.set(assistantKey, next);
        setFollowups(next);
        followupsFromCacheRef.current = false;
      } catch (e) {
        const isAbort =
          e?.name === "AbortError" ||
          e?.cause?.name === "AbortError" ||
          /aborted/i.test(String(e?.message || ""));
        if (!isAbort) {
          console.warn("[BizzyChat] follow-ups fetch failed", e);
        }
        setFollowups([]);
      } finally {
        if (!controller.signal.aborted) setFollowupsLoading(false);
      }
    }, 300);

    return () => {
      cancelPending();
      if (controller && !controller.signal.aborted) controller.abort();
    };
  }, [sorted, lastAssistantIdx, lastAssistantMsg, lastUserMsg, typewriterTick]);

  // Keep follow-ups anchored under the latest assistant response without shifting layout
  useEffect(() => {
    if (!FOLLOWUPS_ENABLED) {
      setFollowupDockStyle(null);
      return;
    }

    let raf;
    const updateDock = () => {
      if (!isCanvasOpen || !followups.length) {
        setFollowupDockStyle(null);
        return;
      }
      const anchor = followupAnchorRef.current;
      const scroller = scrollerRef.current;
      if (!anchor || !scroller) {
        setFollowupDockStyle(null);
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(rect.width || 520, 520);
      // Pin follow-ups to viewport (fixed) so they never affect layout/spacer calculations elsewhere
      const left = Math.max(8, rect.left);
      const top = rect.bottom - 6;

      setFollowupDockStyle({
        top,
        left,
        width,
        maxWidth: "min(520px, var(--chat-col-max))",
        position: "fixed",
        transform: "none",
      });
    };

    raf = requestAnimationFrame(updateDock);
    const el = scrollerRef.current;
    el?.addEventListener("scroll", updateDock, { passive: true });
    window.addEventListener("resize", updateDock);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el?.removeEventListener("scroll", updateDock);
      window.removeEventListener("resize", updateDock);
    };
  }, [followups.length, followupsLoading, isCanvasOpen]);

  // Keep latest assistant + follow-ups in view once loaded
  useEffect(() => {
    if (!followups.length || followupsLoading) return;
    const el = scrollerRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    });
  }, [followups, followupsLoading, sorted.length, lastAssistantIdx]);

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
  const scrollToBottomSoon = (behavior = "auto", delay = 30) => {
    const el = scrollerRef.current; if (!el) return;
    setTimeout(() => scrollToBottom(behavior), delay);
  };
  const forceScrollToBottom = (behavior = "auto") => {
    const el = scrollerRef.current; if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  };
  const keepPinnedIfNearBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
    if (distance < 16) {
      requestAnimationFrame(() => scrollToBottom("auto"));
    }
  }, []);
  const handleScrollButtonClick = useCallback(() => {
    manualRef.current = false;
    hasScrolledUpRef.current = false;
    threadScrollPendingRef.current = false;
    stickToBottomRef.current = true;
    setShowScrollBtn(false);
    scrollToBottom("smooth");
  }, []);
  const manualRef = useRef(false);
  const hasScrolledUpRef = useRef(false);
  const openSettledRef = useRef(false);
  const threadScrollPendingRef = useRef(false);
  const initialAutoScrollPendingRef = useRef(false);
  const historyRevealPendingRef = useRef(false);
  const historyRevealRafRef = useRef(0);
  const settleTimerRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const lastThreadIdRef = useRef(activeThreadId);
  const openPinUntilRef = useRef(0);
  const pinnedOffsetRef = useRef(0);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    initialAutoScrollPendingRef.current = true;
    lastScrollTopRef.current = el.scrollTop;
    hasScrolledUpRef.current = false;
    setShowScrollBtn(false);
    const onScroll = () => {
      const d = el.scrollHeight - el.clientHeight - el.scrollTop;
      const delta = el.scrollTop - lastScrollTopRef.current;
      const nearBottom = d < 12;
      const awayFromBottom = d > 24;
      lastScrollTopRef.current = el.scrollTop;

      if (!openSettledRef.current || initialAutoScrollPendingRef.current || threadScrollPendingRef.current) {
        setShowScrollBtn(false);
        return;
      }

      if (Math.abs(delta) > 1) {
        manualRef.current = true;
        pinnedOffsetRef.current = d;
      }

      if (nearBottom) {
        manualRef.current = false;
        hasScrolledUpRef.current = false;
        setShowScrollBtn(false);
        return;
      }

      if (delta < -2 && awayFromBottom) {
        hasScrolledUpRef.current = true;
      }

      setShowScrollBtn(hasScrolledUpRef.current && awayFromBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // allow scroll detection after initial auto-scroll settles
    const unlock = setTimeout(() => {
      initialAutoScrollPendingRef.current = false;
    }, 80);
    return () => {
      el.removeEventListener("scroll", onScroll);
      clearTimeout(unlock);
    };
  }, []);
  useEffect(() => {
    if (!isCanvasOpen) return;
    pinnedOffsetRef.current = 0;
  }, [isCanvasOpen, activeThreadId]);
  useEffect(() => {
    return () => {
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
      }
    };
  }, []);
  useEffect(() => {
    if (!isCanvasOpen) return;
    historyRevealPendingRef.current = true;
    setHistoryRevealVisible(false);
    return () => {
      if (historyRevealRafRef.current) {
        cancelAnimationFrame(historyRevealRafRef.current);
        historyRevealRafRef.current = 0;
      }
    };
  }, [isCanvasOpen, activeThreadId]);
  useEffect(() => {
    if (!isCanvasOpen) return;
    if (!historyRevealPendingRef.current) return;
    if (sorted.length === 0) return;

    const hasExistingHistory = sorted.some((m) => normSender(m) === "assistant");
    if (!hasExistingHistory) {
      historyRevealPendingRef.current = false;
      setHistoryRevealVisible(true);
      return;
    }

    historyRevealRafRef.current = requestAnimationFrame(() => {
      historyRevealRafRef.current = requestAnimationFrame(() => {
        setHistoryRevealVisible(true);
        historyRevealPendingRef.current = false;
      });
    });

    return () => {
      if (historyRevealRafRef.current) {
        cancelAnimationFrame(historyRevealRafRef.current);
        historyRevealRafRef.current = 0;
      }
    };
  }, [sorted.length, isCanvasOpen]);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!isCanvasOpen) return;
      if (threadScrollPendingRef.current) return;
      if (manualRef.current) return;
      const target = Math.max(0, el.scrollHeight - el.clientHeight - pinnedOffsetRef.current);
      el.scrollTop = target;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isCanvasOpen]);
  useEffect(() => {
    if (!isCanvasOpen) return;
    const el = scrollerRef.current;
    if (!el) return;
    const pinUntil = Date.now() + 220;
    openPinUntilRef.current = pinUntil;
    let rafId = 0;
    const tick = () => {
      if (!isCanvasOpen) return;
      if (
        Date.now() < openPinUntilRef.current &&
        !manualRef.current &&
        threadScrollPendingRef.current
      ) {
        el.scrollTop = el.scrollHeight;
        rafId = requestAnimationFrame(tick);
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isCanvasOpen, activeThreadId]);
  useEffect(() => {
    if (threadScrollPendingRef.current) return;
    if (!manualRef.current) scrollToBottom();
  }, [sorted, isGenerating]);
  useEffect(() => {
    if (!isCanvasOpen) return;
    manualRef.current = false;
    hasScrolledUpRef.current = false;
    openSettledRef.current = false;
    threadScrollPendingRef.current = true;
    initialAutoScrollPendingRef.current = true;
    lastScrollTopRef.current = scrollerRef.current?.scrollTop || 0;
    setShowScrollBtn(false);
    const t = requestAnimationFrame(() => scrollToBottom("auto"));
    return () => cancelAnimationFrame(t);
  }, [isCanvasOpen, activeThreadId]);

  // When firing a follow-up send, force the viewport to stay pinned so the streamed response renders smoothly
  useEffect(() => {
    if (!followupSending) return;
    manualRef.current = false;
    hasScrolledUpRef.current = false;
    openSettledRef.current = true;
    stickToBottomRef.current = true;
    setShowScrollBtn(false);
    scrollToBottom("auto");
    scrollToBottomSoon("auto", 40);
  }, [followupSending]);

  // When opening a thread, force the view to the bottom (latest content + follow-ups)
  useEffect(() => {
    if (!isCanvasOpen) return;
    threadScrollPendingRef.current = true;
    manualRef.current = false;
    hasScrolledUpRef.current = false;
    openSettledRef.current = false;
    initialAutoScrollPendingRef.current = true;
    setShowScrollBtn(false);
  }, [activeThreadId, isCanvasOpen]);

  // After messages hydrate for a thread open, ensure we land at the bottom
  useEffect(() => {
    if (!isCanvasOpen) return;
    if (!threadScrollPendingRef.current) return;
    if (sorted.length === 0) return;
    const currentThread = activeThreadId;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (currentThread !== activeThreadId) return;
        forceScrollToBottom("auto");
        threadScrollPendingRef.current = false;
        initialAutoScrollPendingRef.current = false;
        manualRef.current = false;
        hasScrolledUpRef.current = false;
        if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
        settleTimerRef.current = setTimeout(() => {
          openSettledRef.current = true;
        }, 180);
      });
    });
  }, [sorted.length, isCanvasOpen]);

  /* Pre-mark older assistants: assistants at or before the last user never replay */
  const animatedRef = useRef(new Set());
  const stickToBottomRef = useRef(false);
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
  const horizontalPad = Math.max(0, contentGutter || 0);
  const insetPx = 12; // small inset to keep conversation slightly narrower while staying centered
  const padLeft = horizontalPad + insetPx;
  const padRight = horizontalPad + insetPx;
  const innerWidth = "100%";
  const innerMargin = 0;
  const innerPaddingBottom = 48; // small bottom buffer so content doesn't sit flush, without allowing deep overscroll
  const innerPadding = `0 ${padRight}px ${innerPaddingBottom}px ${padLeft}px`;
  const scrollPortal = React.useMemo(() => getScrollPortalRoot(), []);

  return (
    <>
      <div style={{ width: "100%" }}>
        {/* Inner wrapper: constrain actual message text to chat column width */}
        <div
          style={{
            position: "relative",
            width: innerWidth,
            maxWidth: innerWidth,
            margin: innerMargin,
            padding: innerPadding,
            boxSizing: "border-box",
          }}
        >
        <style>{`
            .bizzy-canvas-scroll { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.18) transparent; }
            .bizzy-canvas-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
            .bizzy-canvas-scroll::-webkit-scrollbar-track { background: transparent; }
            .bizzy-canvas-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.14); border-radius: 9999px; border: 2px solid transparent; background-clip: padding-box; }
            .bizzy-canvas-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }
            /* Align assistant text with the chat input width (no horizontal gutters) */
            .chat-row  { margin: 18px 0; position: relative; z-index: 15000; }
            .row-wrap  { width: 100%; max-width: 100%; gap: 8px; display:flex; flex-direction:column; align-items:stretch; }
            .row-wrap--user { align-items: flex-end; padding-right: 6px; }
            .bubble-user { background: linear-gradient(135deg, rgba(255,255,255,0.05), rgba(255,255,255,0.025));
                           padding: 8px 12px; border-radius: 14px; font-size: 15px;
                           color:${WARM_TEXT}; display:inline-flex; border:1px solid rgba(255,255,255,0.10);
                           max-width:100%; align-self:flex-end; word-break: break-word; white-space: normal; text-align:left;
                           box-shadow: 0 10px 20px rgba(0,0,0,0.20); }
            .bubble-assistant { color:${WARM_TEXT}; width:100%; margin-top:10px; padding: 4px 0; font-size: 15px; }
            .actions { opacity:0; transition:opacity .18s ease; display:flex; gap:8px; margin-top:-10px; width:100%; }
            .actions { transform: translateY(4px); transition: opacity .18s ease, transform .18s ease; }
            .actions--visible { opacity:.95; }
            .actions--ready { transform: translateY(0); }
            .actions-grid { display:flex; flex-direction:column; gap:8px; width:100%; }
            .tipwrap{ position:relative; display:inline-flex; align-items:center; isolation:isolate; z-index:40000; }
            .btn-ico{ border:none; outline:none; background:transparent; color:var(--text-2);
                      width:32px; height:32px; border-radius:999px; display:inline-flex; align-items:center; justify-content:center;
                      transition: background .15s ease, color .15s ease, transform .12s ease; }
            .btn-ico:hover{ background: rgba(255,255,255,0.10); color:#fff; transform: translateY(-1px); }
            .tooltip{ position:absolute; top:calc(100% + 8px); left:50%; transform: translate(-50%, 0);
                      z-index:40000; background:rgba(28,28,30,1); color:#fff; font-size:12px; line-height:1;
                      padding:8px 10px; border-radius:10px; box-shadow:0 10px 30px rgba(0,0,0,0.35);
                      white-space:nowrap; pointer-events:none; opacity:0; transition:opacity .15s ease, transform .15s ease; }
            .tipwrap:hover .tooltip{ opacity:1; transform: translate(-50%, 0); }
            .artifact-row { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:8px; width:100%; }
            .artifact-card { display:flex; gap:10px; align-items:center; padding:10px 12px; border-radius:12px;
                             background: linear-gradient(135deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));
                             border:1px solid rgba(255,255,255,0.08); color:${WARM_TEXT}; text-decoration:none; }
            .artifact-card:hover { border-color: rgba(255,255,255,0.16); background: linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.04)); }
            .artifact-title { font-weight:600; font-size:13px; }
            .artifact-sub { font-size:12px; color:var(--text-2); }
            .action-btn-row { display:flex; gap:8px; flex-wrap:wrap; }
            .action-pill { border:1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.03); color:${WARM_TEXT};
                           padding:7px 12px; border-radius:10px; font-size:12px; display:inline-flex; align-items:center; gap:6px; }
            .action-pill:hover { border-color: rgba(255,255,255,0.2); background: rgba(255,255,255,0.07); }
            .followup-row { display:flex; flex-direction:column; gap:4px; align-items:flex-start; padding-left:2px; }
            .followup-pill { border:1px solid var(--surface-border); background: rgba(255,255,255,0.085); color:${WARM_TEXT};
                              padding:6px 12px; border-radius:999px; font-size:12px; line-height:1.22; text-align:left;
                              transition: background .12s ease, transform .12s ease, border-color .12s ease, box-shadow .12s ease; width:auto; max-width:520px;
                              opacity:0; transform: translateY(6px);
                              display: inline-flex; align-items: center; justify-content: flex-start; gap: 10px;
                              box-shadow: 0 10px 22px rgba(0,0,0,0.22);
                            }
            .followup-pill.appear { animation: followupFade .22s ease forwards; }
            .followup-pill:hover { background: rgba(255,255,255,0.14); border-color: var(--surface-border-strong); transform: translateY(-1px); box-shadow: 0 12px 26px rgba(0,0,0,0.26); }
            .followup-text { flex: 1; min-width: 0; }
            .followup-arrow { opacity: 0.65; transform: translateX(-2px); transition: opacity .12s ease, transform .12s ease; display: inline-flex; align-items: center; }
            .followup-pill:hover .followup-arrow { opacity: 1; transform: translateX(0px); }
            @keyframes followupFade { to { opacity: 1; transform: translateY(0); } }
            .scrollbottom-shell { position:fixed; left:var(--nav-w, 0px); right:var(--bizzy-canvas-right-inset, 0px); bottom:${CANVAS_BAR_HEIGHT + 18}px; display:flex; justify-content:center; pointer-events:none; opacity:0; transform: translateY(12px); transition: opacity .2s ease, transform .2s ease, right 560ms cubic-bezier(0.22,1,0.36,1); z-index:20000; }
            .scrollbottom-shell.visible { opacity:1; transform: translateY(0); }
            .scrollbottom-btn { pointer-events:auto; background:#0f1214; color:rgba(255,255,255,0.95); border:1px solid rgba(255,255,255,0.32); border-radius:999px; padding:6px; font-size:12px; box-shadow:0 16px 38px rgba(0,0,0,0.42); display:inline-flex; align-items:center; justify-content:center; width:32px; height:32px; }
            .scrollbottom-btn:hover { background:#15191c; border-color:rgba(255,255,255,0.4); transform: translateY(-1px); transition: all .15s ease; color: rgba(255,255,255,1); }
            .scrollbottom-icon { line-height:1; display:inline-flex; align-items:center; justify-content:center; width:100%; height:100%; color:inherit; opacity:1; }
          `}</style>
        <style>{`
            .bizzy-back-btn { background: transparent; }
            .bizzy-back-btn:hover { background: rgba(255,255,255,0.05); }
          `}</style>

        <div style={{ display: "none" }}>{doneBump}</div>

        <div
          style={{
            opacity: historyRevealVisible ? 1 : 0,
            transform: historyRevealVisible ? "translateY(0px)" : "translateY(8px)",
            transition: "opacity .18s ease-out, transform .22s cubic-bezier(.22,1,.36,1)",
            willChange: "opacity, transform",
          }}
        >
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
          const followupBusy = followupsLoading || followupSending;

          // Animate any newly arrived tail assistant after the latest user.
          // Reopened historical threads are pre-marked above so they do not replay.
          const shouldAnimate =
            isTailAssistant &&
            hasAssistantAfterLastUser &&
            lastAnimatedTailKeyRef.current !== key &&
            !alreadyAnimated &&
            !reopenBlockRef.current &&
            !threadJustOpenedRef.current;

          if (shouldAnimate) {
            stickToBottomRef.current = false;
            manualRef.current = false;
            const allowSave = Boolean(m.doc_suggestion?.should_show);
            markTypewriterPending(key);
            return (
              <div className="chat-row" key={key}>
                <AssistantRow
                  id={key}
                  text={m.text}
                  artifacts={m.artifacts}
                  actions={m.actions}
                  docSuggestion={m.doc_suggestion}
                  onControlsReady={keepPinnedIfNearBottom}
                  onProgress={(ratio) => {
                    const el = scrollerRef.current;
                    if (!el) return;
                    const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
                    const nearBottom = distance < el.clientHeight * 0.6; // start nudging when content is in lower half
                    if (ratio >= 0.6 && nearBottom) {
                      stickToBottomRef.current = true;
                    }
                    if (stickToBottomRef.current) {
                      requestAnimationFrame(() => {
                        el.scrollTop = el.scrollHeight;
                      });
                    }
                  }}
                  onDone={() => {
                    const el = scrollerRef.current;
                    if (el) el.scrollTop = el.scrollHeight;
                    stickToBottomRef.current = false;
                    animatedRef.current.add(key);
                    lastAnimatedTailKeyRef.current = key;
                    freshQueryRef.current = false;
                    markTypewriterDone(key);
                    setDoneBump(n => n + 1);
                  }}
                  showActions={true}
                  allowSave={allowSave}
                  conversationExcerpt={conversationExcerpt}
                  businessName={currentBusiness?.business_name}
                  threadId={threadId}
                  activeThreadId={activeThreadId}
                  isLatestAssistant={isTailAssistant}
                  followups={isTailAssistant ? followups : []}
                  followupsLoading={isTailAssistant && followupBusy}
                  followupsStatic={isTailAssistant ? followupsFromCacheRef.current : false}
                  followupAnchorRef={isTailAssistant ? followupAnchorRef : null}
                  onFollowupClick={handleFollowupClick}
                />
              </div>
            );
          }

          const allowSave = Boolean(m.doc_suggestion?.should_show);
          const showActions = true;
          if (isTailAssistant) {
            markTypewriterDone(key);
          }
          return (
            <div className="chat-row" key={key}>
              <div className="row-wrap">
                <div className="bubble-assistant"><MarkdownRenderer>{m.text}</MarkdownRenderer></div>
                <ActionRow
                  text={m.text}
                  artifacts={m.artifacts}
                  actions={m.actions}
                  docSuggestion={m.doc_suggestion}
                  show={showActions}
                  allowSave={allowSave}
                  conversationExcerpt={conversationExcerpt}
                  businessName={currentBusiness?.business_name}
                  threadId={threadId}
                  activeThreadId={activeThreadId}
                  isLatestAssistant={isTailAssistant}
                  onControlsReady={keepPinnedIfNearBottom}
                  followups={isTailAssistant ? followups : []}
                  followupsLoading={isTailAssistant && followupBusy}
                  followupsStatic={isTailAssistant ? followupsFromCacheRef.current : false}
                  followupAnchorRef={isTailAssistant ? followupAnchorRef : null}
                  onFollowupClick={handleFollowupClick}
                  ready={true}
                />
              </div>
            </div>
          );
        })}

        <div ref={bottomRef} />

        {/* delayed typing dots only when the last message is NOT assistant */}
        {(() => {
          const last = sorted[sorted.length - 1];
          return isGenerating && normSender(last) !== "assistant" ? <TypingIndicator /> : null;
        })()}
        </div>

        {scrollPortal && isCanvasOpen
          ? createPortal(
              <div className={`scrollbottom-shell ${showScrollBtn && !isGenerating ? "visible" : ""}`}>
                <button
                  onClick={handleScrollButtonClick}
                  className="scrollbottom-btn"
                  aria-label="Jump to latest"
                >
                  <span className="scrollbottom-icon">
                    <ChevronDown size={18} strokeWidth={2.25} />
                  </span>
                </button>
              </div>,
              scrollPortal
            )
          : null}
        </div>
      </div>
      {isCanvasOpen && followups.length && followupDockStyle ? (
        <FollowupDock
          followups={followups}
          followupsStatic={followupsStatic}
          followupsLoading={followupsLoading}
          followupDockStyle={followupDockStyle}
          scrollerRef={scrollerRef}
          onFollowupClick={handleFollowupClick}
        />
      ) : null}
    </>
  );
}

/* ---------------- rows & actions ---------------- */
function AssistantRow({
  id,
  text,
  artifacts,
  actions,
  docSuggestion,
  onProgress,
  onDone,
  onControlsReady,
  showActions,
  allowSave,
  conversationExcerpt,
  businessName,
  threadId,
  activeThreadId,
  isLatestAssistant = false,
  followups = [],
  followupsLoading = false,
  followupsStatic = false,
  followupAnchorRef = null,
  onFollowupClick,
}) {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (!text) setIsReady(true);
  }, [text]);

  return (
    <div className="row-wrap">
      <div className="bubble-assistant">
        <Typewriter
          id={id}
          text={text}
          speed={95}
          onProgress={onProgress}
          onDone={() => {
            setIsReady(true);
            onDone?.();
          }}
        />
      </div>
      <ActionRow
        text={text}
        artifacts={artifacts}
        actions={actions}
        docSuggestion={docSuggestion}
        show={!!showActions}
        allowSave={allowSave}
        conversationExcerpt={conversationExcerpt}
        businessName={businessName}
        threadId={threadId}
        activeThreadId={activeThreadId}
        isLatestAssistant={isLatestAssistant}
        onControlsReady={onControlsReady}
        followups={followups}
        followupsLoading={followupsLoading}
        followupsStatic={followupsStatic}
        followupAnchorRef={followupAnchorRef}
        onFollowupClick={onFollowupClick}
        ready={isReady}
      />
    </div>
  );
}
function ActionRow({
  text,
  artifacts = [],
  actions = [],
  docSuggestion = null,
  show = false,
  allowSave = false,
  conversationExcerpt,
  businessName,
  threadId,
  activeThreadId,
  isLatestAssistant = false,
  onControlsReady,
  followups = [],
  followupsLoading = false,
  followupsStatic = false,
  followupAnchorRef = null,
  onFollowupClick,
  ready = true,
}) {
  const [controlsReady, setControlsReady] = useState(false);
  useEffect(() => {
    if (!ready) {
      setControlsReady(false);
      return;
    }
    if (!isLatestAssistant) {
      setControlsReady(true);
      return;
    }
    const t = setTimeout(() => setControlsReady(true), 120);
    return () => clearTimeout(t);
  }, [ready, isLatestAssistant]);

  const safeArtifacts = Array.isArray(artifacts) ? artifacts.slice(0, 2) : [];
  const safeActions = Array.isArray(actions)
    ? actions.filter((a) => a?.type === "navigate" && a?.payload?.to && a?.label)
    : [];
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveTitleHint = docSuggestion?.suggested_title;
  const doCopy = async () => { try { await navigator.clipboard.writeText(text || ""); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {} };
  const doSave = async () => {
    if (!text || saving || !allowSave) return;
    try {
      setSaving(true);
      let title =
        saveTitleHint ||
        `Bizzi response — ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
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
  const handleNavigate = (target) => {
    if (!target) return;
    try {
      window.dispatchEvent(new CustomEvent('bizzy:navigate', { detail: { type: 'navigate', target } }));
    } catch {}
    try {
      window.location.assign(target);
    } catch {}
  };

  const showRow = controlsReady && (show || safeArtifacts.length > 0 || safeActions.length > 0 || allowSave || (isLatestAssistant && followups.length > 0));
  useEffect(() => {
    if (!showRow || !isLatestAssistant) return;
    if (typeof onControlsReady !== "function") return;
    const raf = requestAnimationFrame(() => onControlsReady());
    return () => cancelAnimationFrame(raf);
  }, [showRow, isLatestAssistant, onControlsReady]);
  return (
    <div
      className={`actions ${showRow ? "actions--visible actions--ready" : ""}`}
      style={{ minHeight: isLatestAssistant ? 56 : 0, position: "relative" }}
      ref={isLatestAssistant ? followupAnchorRef : null}
    >
      <div className="actions-grid">
        {safeArtifacts.length ? (
          <div className="artifact-row">
            {safeArtifacts.map((artifact, idx) => (
              <ArtifactCard key={`${artifact.type}-${idx}-${artifact.url}`} artifact={artifact} />
            ))}
          </div>
        ) : null}

        {safeActions.length ? (
          <div className="action-btn-row">
            {safeActions.map((action, idx) => (
              <button
                key={`${action.label}-${idx}`}
                className="action-pill"
                onClick={() => handleNavigate(action.payload?.to)}
              >
                {action.label} <ArrowUpRight size={14} />
              </button>
            ))}
          </div>
        ) : null}

        <div className="action-btn-row">
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

        {/* Follow-ups now rendered in floating dock to avoid shifting layout */}
      </div>
    </div>
  );
}

function FollowupDock({
  followups = [],
  followupsStatic = false,
  followupsLoading = false,
  followupDockStyle = null,
  scrollerRef = null,
  onFollowupClick,
}) {
  if (!followups.length) return null;
  const uniqueFollowups = Array.from(new Set(followups)).slice(0, 3);
  if (!uniqueFollowups.length) return null;
  const anchoredStyle =
    followupDockStyle && Number.isFinite(followupDockStyle.top)
      ? {
          position: followupDockStyle.position || "fixed",
          zIndex: 9000,
          pointerEvents: "none",
          ...followupDockStyle,
          transform: "none",
        }
      : null;
  const dockBaseStyle =
    anchoredStyle ||
    {
      position: "absolute",
      left: 16,
      bottom: CANVAS_BAR_HEIGHT + 12,
      zIndex: 9000,
      pointerEvents: "none",
      width: "min(520px, 92vw)",
      maxWidth: "min(520px, var(--chat-col-max))",
    };
  const widthStyle = anchoredStyle
    ? { width: followupDockStyle?.width || "100%", maxWidth: "min(520px, var(--chat-col-max))" }
    : {
        width: "100%",
        maxWidth: "min(520px, var(--chat-col-max))",
        margin: "0",
      };
  const dock = (
    <div style={dockBaseStyle} aria-live="polite">
      <div
        className="followup-dock"
        style={{
          ...widthStyle,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          pointerEvents: "auto",
          padding: "2px",
          alignItems: "flex-start",
        }}
      >
        {uniqueFollowups.map((q, idx) => (
          <button
            key={`${q}-${idx}`}
            className={`followup-pill ${followupsStatic ? "" : "appear"}`.trim()}
            style={{
              padding: "8px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(0,0,0,0.35)",
              backdropFilter: "blur(8px)",
              animationDelay: followupsStatic ? undefined : `${80 * idx}ms`,
              width: "auto",
              maxWidth: "100%",
              minHeight: 36,
              display: "inline-flex",
              transition: "background .12s ease, border-color .12s ease",
            }}
            onClick={() => onFollowupClick?.(q)}
            disabled={followupsLoading}
          >
            <span className="followup-arrow">
              <ChevronRight size={12} />
            </span>
            <span className="followup-text">{q}</span>
          </button>
        ))}
      </div>
      <style>{`
        .followup-dock .followup-pill:hover {
          background: rgba(255,255,255,0.08);
          border-color: rgba(255,255,255,0.22);
        }
      `}</style>
    </div>
  );
  const target = scrollerRef?.current;
  return target ? createPortal(dock, target) : dock;
}

function ArtifactCard({ artifact }) {
  const isExternal = /^https?:\/\//i.test(artifact?.url || '');
  const Icon = artifact?.type === 'invoice' ? Receipt : FileText;
  return (
    <a
      className="artifact-card"
      href={artifact?.url || '#'}
      target={isExternal ? '_blank' : undefined}
      rel={isExternal ? 'noreferrer' : undefined}
    >
      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-white/6 border border-white/10 text-white/90">
        <Icon size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="artifact-title truncate">{artifact?.title || ''}</div>
        {artifact?.subtitle ? <div className="artifact-sub truncate">{artifact.subtitle}</div> : null}
      </div>
      <ArrowUpRight size={16} />
    </a>
  );
}
