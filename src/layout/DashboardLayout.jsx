// DashboardLayout.jsx
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import BizzyChatBar from "../components/Bizzy/BizzyChatBar";
import { useBizzyChatContext } from "../context/BizzyChatContext";
import ChatCanvas from "../components/Bizzy/ChatCanvas";
import useModuleTheme from "../hooks/useModuleTheme";
import ExpandableInsightButton from "../layout/ExpandableInsightButton";
import InsightsRail from "../insights/InsightsRail";
import { InsightsUnreadProvider } from "../insights/InsightsUnreadContext";
import { RightExtrasProvider } from "../insights/RightExtrasContext";
import { ChevronLeft, ChevronRight, MessageSquare } from "lucide-react";
import ChatSwitchToggle from "../components/Bizzy/ChatSwitchToggle";
import { AnimatePresence, motion } from "framer-motion";
import { useRightExtras } from "../insights/RightExtrasContext";
import { useBusiness } from "../context/BusinessContext"
import useOnboardingStatus from "../hooks/useOnboardingStatus";
import NavRail from "./NavRail";
import { CHAT_BAR_MAX_W, CHAT_BAR_VW, CHAT_CONTENT_MAX_W, CHAT_CONTENT_VW } from "../config/chatLayout";
import { useInsightsUnread } from "../insights/InsightsUnreadContext";
import { useMemo } from "react";
import { ACCENT_HEX } from "../config/accent";

const BAR_GAP_PX = 32;
const SPACER_EXTRA = 84;
const DEFAULT_BAR_HEIGHT = 110;
const MAX_BAR_HEIGHT = 220;
const MIN_SPACER_PX = 280; // hard floor so dashboards never sit too high after canvas
// Max width of the chat thread + bar (desktop)
const CHAT_MAX_W = CHAT_CONTENT_MAX_W;

// Grid
const RIGHT_RAIL_W = 320;
const HANDLE_W = 46;
const GRID_GAP = 6;

// Curtain sizing (tuned for “just covers chips”)
const CURTAIN_MIN_H = 75;
const CURTAIN_TRIM_TOP = 16; // shave a bit so we stop at top of chips
const UNDERLAP = 8;          // tuck slightly under the bar so no seam

// This must match the wrapper class "bottom-12"
const WRAPPER_BOTTOM_OFFSET_PX = 50;
// Small nudge to align the dashboard bar perfectly with content
const DASH_BAR_ALIGN_NUDGE_PX = -12;

// Layer stack (ordered low → high)
const LAYERS = {
  CANVAS: 9400,   // ChatCanvas root
  BAR: 9500,      // Chat bar wrapper (curtain renders inside this wrapper)
  HANDLE: 9600,   // Insights toggle handle always clickable
};

const isChromeRoute = (path) => {
  // Pages that previously used Bizzi pink → now use Chrome/Silver
  return (
    path.startsWith("/dashboard/bizzy") ||        // Pulse
    path.startsWith("/dashboard/bizzy-docs") ||   // Docs
    path.startsWith("/dashboard/companion") ||    // Meet Bizzi
    path.startsWith("/dashboard/settings") ||     // Settings/Sync
    path === "/chat"                              // Chat home
  );
};

function moduleFromPath(pathname = "") {
    const seg = pathname.split("/")[2] || "bizzy";
    if (seg === "financials") return "accounting";
    if (seg === "sch")        return "calendar";
    return seg.toLowerCase();
  }

const accentHexMap = {
  bizzy: ACCENT_HEX,
  accounting: ACCENT_HEX,
  marketing: ACCENT_HEX,
  tax: ACCENT_HEX,
  investments: ACCENT_HEX,
  email: ACCENT_HEX,
  calendar: ACCENT_HEX,
  activity: ACCENT_HEX,
  ops: ACCENT_HEX,
  jobs: ACCENT_HEX,
  leads: ACCENT_HEX,
  "lead-jobs": ACCENT_HEX,
  "leads-jobs": ACCENT_HEX,
};

// Normalize unread counts to canonical module keys
// Mirrors Sidebar normalization (inbox->email, sch->calendar, jobs->ops)
// Honors business suffix (module:businessId) so we don't aggregate across businesses.
function normalizeUnreadMap(raw = {}, bizId = "") {
  const ALIAS = { inbox: "email", sch: "calendar", jobs: "ops" };
  const totals = {};
  Object.entries(raw || {}).forEach(([key, val]) => {
    const [base, suffix] = key.split(":");
    if (suffix && bizId && suffix !== bizId) return; // skip other businesses
    const canonical = ALIAS[base] || base;
    totals[canonical] = (totals[canonical] || 0) + Number(val || 0);
  });
  return totals;
}

const DashboardContent = ({ children }) => {
  const location = useLocation();
  const { currentBusiness } = useBusiness?.() || {};
  const { quickPromptMode } = useOnboardingStatus();
  const { setExtras } = useRightExtras();   // <-- publish descriptor from here
  const bizId =
    currentBusiness?.id ||
    localStorage.getItem("currentBusinessId") ||
    localStorage.getItem("business_id") ||
    "";
  const { unreadByModule: rawUnread = {}, markModuleAsRead } = useInsightsUnread?.() || {};
  const normalizedUnread = useMemo(() => normalizeUnreadMap(rawUnread, bizId), [rawUnread, bizId]);
  const storageKey = useMemo(
    () => `bizzy:insights:cleared:${bizId || "anon"}`,
    [bizId]
  );
  const [clearedModules, setClearedModules] = useState(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? new Set(arr) : new Set();
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    const inChatHome = location.pathname.startsWith("/dashboard/bizzy/chat");
    if (location.pathname.startsWith("/dashboard/") && !inChatHome) {
      localStorage.setItem("bizzy:lastDashboard", location.pathname);
      try { sessionStorage.setItem("bizzy:visitedDash", "1"); } catch {}
    }
  }, [location.pathname]);

  // Always publish a default Agenda descriptor.
   // Any page can override this by calling setExtras(...) itself.
   useEffect(() => {
     const businessId =
       currentBusiness?.id ||
       localStorage.getItem("currentBusinessId") ||
       localStorage.getItem("business_id") ||
       "";
     const module = moduleFromPath(location.pathname);
     if (!businessId) return;
     setExtras({ type: "agenda", props: { businessId, module } });
   }, [location.pathname, currentBusiness?.id, setExtras]);

  const theme = useModuleTheme(location.pathname);
  const { isCanvasOpen = false, activeThreadId, openCanvas, closeCanvas } = useBizzyChatContext();

  const [railOpen, setRailOpen] = useState(false);
  const toggleRail = () => setRailOpen((v) => !v);
  const moduleKey = moduleFromPath(location.pathname);
  const unreadCount = normalizedUnread[moduleKey] || 0;
  const isCleared = clearedModules.has(moduleKey);
  const lastUnreadRef = useRef(new Map());
  const effectiveUnread = unreadCount > 0 ? unreadCount : (lastUnreadRef.current.get(moduleKey) || 0);
  const showUnreadBadge = effectiveUnread > 0 && !isCleared;
  const badgeAccent = useMemo(() => accentHexMap[moduleKey] || ACCENT_HEX, [moduleKey]);

  // Persist cleared modules in session
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(Array.from(clearedModules)));
    } catch {}
  }, [clearedModules, storageKey]);

  // Cache unread while rail is open so badge stays visible
  useEffect(() => {
    if (!railOpen) return;
    if (unreadCount > 0) {
      lastUnreadRef.current.set(moduleKey, unreadCount);
    }
  }, [railOpen, unreadCount, moduleKey]);

  // Mark as read only when the rail closes (badge stays visible while open)
  const prevRailOpenRef = useRef(railOpen);
  useEffect(() => {
    const prev = prevRailOpenRef.current;
    prevRailOpenRef.current = railOpen;
    const justClosed = prev && !railOpen;
    if (!justClosed) return;
    if (typeof markModuleAsRead !== "function") return;
    const pending = lastUnreadRef.current.get(moduleKey) || unreadCount;
    if (pending > 0) {
      markModuleAsRead(moduleKey);
      setClearedModules((prevSet) => {
        const next = new Set(prevSet);
        next.add(moduleKey);
        return next;
      });
      lastUnreadRef.current.delete(moduleKey);
    }
  }, [railOpen, markModuleAsRead, moduleKey, unreadCount]);
  const useChrome = isChromeRoute(location.pathname);
  const centerRef = useRef(null);
  const contentRef = useRef(null);
  const rightAsideRef = useRef(null);
  const prevPathRef = useRef(location.pathname);
  const canvasScrollLockRef = useRef({ top: 0, overflowY: null });
  // Graphite base color for the curtain
  const [curtainBg, setCurtainBg] = useState(getComputedStyle(document.documentElement)?.getPropertyValue("--bg")?.trim() || "#12100F");
  useEffect(() => {
    const host =
      centerRef.current?.closest("section") ||
      document.querySelector("section.bg-app") ||
      document.body;
    const bg = getComputedStyle(host).backgroundColor || getComputedStyle(document.documentElement).getPropertyValue("--bg") || "#12100F";
    setCurtainBg(bg);
  }, [location.pathname, theme]);

  const bgColor = theme?.bgClass || "";
  const textColor = theme?.textClass || "text-primary";

  const onDashboard = location.pathname.startsWith("/dashboard/");
  const isChatHome  = location.pathname.startsWith("/dashboard/bizzy/chat") || location.pathname.startsWith("/chat");
  const hideCenter  = isCanvasOpen;
  const inSettings  = location.pathname.includes("settings");
  const inMeetBizzi = location.pathname.includes("companion");
  const inDocs      = location.pathname.includes("bizzy-docs");
  const showPortalBar =
    !isCanvasOpen && !isChatHome && (onDashboard || inSettings || inMeetBizzi || inDocs);

  const disableRails = inSettings || inMeetBizzi || inDocs;
  const showRail = onDashboard && !disableRails && !isChatHome;
  const showChat = onDashboard || isChatHome || inSettings || inMeetBizzi || inDocs;

  const railStateRef = useRef(railOpen);
  const prevCanvasOpen = useRef(isCanvasOpen);
  const preCanvasBarHeightRef = useRef(null);
  const ignoreBarMeasureUntilRef = useRef(0);

  useEffect(() => {
    const becameOpen = !prevCanvasOpen.current && isCanvasOpen;
    if (becameOpen && showRail && !isChatHome) {
      setRailOpen(false);
    }
    if (becameOpen) {
      preCanvasBarHeightRef.current = lastBarHeightRef.current || barHeight || DEFAULT_BAR_HEIGHT;
    } else if (prevCanvasOpen.current && !isCanvasOpen) {
      ignoreBarMeasureUntilRef.current = Date.now() + 500;
      if (preCanvasBarHeightRef.current) {
        lastBarHeightRef.current = Math.max(lastBarHeightRef.current || 0, preCanvasBarHeightRef.current);
        setBarHeight(lastBarHeightRef.current);
      }
    }
    prevCanvasOpen.current = isCanvasOpen;
  }, [isCanvasOpen, showRail, isChatHome]);

  // Ensure canvas closes (and body overflow resets) when navigating away from ChatHome
  // Allow canvas on dashboards/chat; close only when leaving both
  useEffect(() => {
    if (!onDashboard && !isChatHome && isCanvasOpen) {
      closeCanvas?.();
    }
  }, [onDashboard, isChatHome, isCanvasOpen, closeCanvas]);

  useEffect(() => {
    const fire = () => window.dispatchEvent(new Event("bizzy:layout-shift"));
    fire();
    const t = setTimeout(fire, 200);
    return () => clearTimeout(t);
  }, [railOpen]);

  useLayoutEffect(() => {
    railStateRef.current = railOpen;
    const pad = railOpen && showRail ? "1.25rem" : "0.75rem";
    // Header should stop just before the rail; use a small gutter instead of the full rail width
    const railOffset = railOpen && showRail ? `${GRID_GAP + 8}px` : "0px";
    // Reserve space for the header + content when the rail is open
    document.documentElement.style.setProperty("--header-pad-right", pad);
    document.documentElement.style.setProperty("--header-rail-offset", railOffset);
    document.documentElement.style.setProperty(
      "--content-rail-offset",
      railOpen && showRail ? `${RIGHT_RAIL_W + GRID_GAP}px` : "0px"
    );
    document.documentElement.style.setProperty("--insights-w", `${RIGHT_RAIL_W}px`);
    return () => {
      // Reset on unmount if this layout unmounts
      if (railStateRef.current === railOpen) {
        document.documentElement.style.setProperty("--header-pad-right", "0.75rem");
        document.documentElement.style.setProperty("--header-rail-offset", "0px");
        document.documentElement.style.setProperty("--content-rail-offset", "0px");
      }
    };
  }, [railOpen, showRail]);

  const userId     = localStorage.getItem("user_id");
  const businessId = localStorage.getItem("currentBusinessId");

  const chatWrapperRef = useRef(null);
  const lastBarHeightRef = useRef(DEFAULT_BAR_HEIGHT);
  const [barHeight, setBarHeight] = useState(DEFAULT_BAR_HEIGHT);
  const chatClearance = Math.max(72, (barHeight || DEFAULT_BAR_HEIGHT) + BAR_GAP_PX);
  const clampBarHeight = (h = 0) =>
    Math.min(MAX_BAR_HEIGHT, Math.max(DEFAULT_BAR_HEIGHT, Math.round(h) || 0));

  // If we are on ChatHome with a selected thread but the canvas isn't open yet,
  // open it automatically so the overlay shows.
   useEffect(() => {
     if (isChatHome && activeThreadId && !isCanvasOpen) {
       openCanvas(activeThreadId);
     }
   }, [isChatHome, activeThreadId, isCanvasOpen, openCanvas]);

  useEffect(() => {
    // Only measure the desktop chat bar when it is rendered (canvas closed); ignore ChatCanvas-only height.
    if (!showPortalBar) return;
    if (!chatWrapperRef.current) return;
    const el = chatWrapperRef.current;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      const h = Math.round(rect?.height || 0);
      if (h > 0) {
        if (Date.now() < ignoreBarMeasureUntilRef.current) return;
        const next = clampBarHeight(h);
        const stable = Math.max(lastBarHeightRef.current || DEFAULT_BAR_HEIGHT, next);
        lastBarHeightRef.current = stable;
        setBarHeight(stable);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [showPortalBar]);

  // On first paint after closing the canvas (or showing the portal bar), measure immediately
  useEffect(() => {
    if (!showPortalBar) return;
    const el = chatWrapperRef.current;
    if (!el) return;
    const h = Math.round(el.getBoundingClientRect()?.height || 0);
    if (h > 0) {
      if (Date.now() < ignoreBarMeasureUntilRef.current) return;
      const next = clampBarHeight(h);
      const stable = Math.max(lastBarHeightRef.current || DEFAULT_BAR_HEIGHT, next);
      lastBarHeightRef.current = stable;
      setBarHeight(stable);
    } else if (lastBarHeightRef.current) {
      setBarHeight(lastBarHeightRef.current);
    }
  }, [showPortalBar, isCanvasOpen]);

  // When canvas closes, immediately restore the last measured bar height to avoid a temporary shrink
  useEffect(() => {
    if (isCanvasOpen) return;
    const cached = lastBarHeightRef.current;
    if (cached && cached !== barHeight) {
      setBarHeight(cached);
    }
  }, [isCanvasOpen, barHeight]);

  // Robust measurement of center column (left/width)
  const [chatBounds, setChatBounds] = useState({ left: 0, width: 0 });
  const measureCenter = () => {
    const rectSource = contentRef.current || centerRef.current;
    if (rectSource) {
      const rect = rectSource.getBoundingClientRect();
      const left = Math.round(rect.left);
      const width = Math.round(rect.width);
      if (width > 0) {
        setChatBounds({ left, width });
        return;
      }
    }

    const vwWidth = Math.round(window.innerWidth * CHAT_CONTENT_VW);
    const width = Math.min(CHAT_MAX_W, vwWidth);
    const left = (window.innerWidth - width) / 2;
    setChatBounds({ left: Math.round(left), width: Math.round(width) });
  };

  useLayoutEffect(() => {
    measureCenter();
    if (chatBounds.width === 0) {
      requestAnimationFrame(measureCenter);
      setTimeout(measureCenter, 0);
    }
    const ro = new ResizeObserver(measureCenter);
    if (centerRef.current) ro.observe(centerRef.current);
    const onResize = () => measureCenter();
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railOpen, showRail, location.pathname]);

  // Reset scroll when landing on ChatHome so it never inherits a scrolled dashboard position.
  useEffect(() => {
    if (location.pathname.startsWith("/dashboard/bizzy/chat") || location.pathname.startsWith("/chat")) {
      window.scrollTo({ top: 0, behavior: "auto" });
      if (contentRef.current) contentRef.current.scrollTo({ top: 0, behavior: "auto" });
    }
  }, [location.pathname]);

  useEffect(() => {
    const prev = prevPathRef.current;
    const leavingChat =
      prev &&
      (prev.startsWith("/dashboard/bizzy/chat") || prev.startsWith("/chat"));
    const nowOnDashboard =
      location.pathname.startsWith("/dashboard/") &&
      !location.pathname.startsWith("/dashboard/bizzy/chat");
    const nowOnChat =
      location.pathname.startsWith("/dashboard/bizzy/chat") || location.pathname.startsWith("/chat");

    if (leavingChat && nowOnDashboard) {
      window.scrollTo({ top: 0, behavior: "auto" });
      if (contentRef.current) contentRef.current.scrollTo({ top: 0, behavior: "auto" });
      setBarHeight(DEFAULT_BAR_HEIGHT);
    } else if (!nowOnChat) {
      // Any non-chat route should reset to default spacer
      setBarHeight(DEFAULT_BAR_HEIGHT);
    }
    prevPathRef.current = location.pathname;
  }, [location.pathname]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    if (isCanvasOpen) {
      canvasScrollLockRef.current = {
        top: el.scrollTop,
        overflowY: el.style.overflowY || "",
      };
      el.style.overflowY = "hidden";
      return;
    }
    const { top, overflowY } = canvasScrollLockRef.current;
    el.style.overflowY = overflowY || "";
    if (Number.isFinite(top)) {
      el.scrollTop = top;
    }
  }, [isCanvasOpen]);

  // Freeze spacer to the last known bar height while ChatCanvas is open so ChatCanvas-only
  // content (e.g., follow-up prompts) cannot inflate dashboard/chat-home spacing.
  const stableBarHeight = isCanvasOpen
    ? Math.max(DEFAULT_BAR_HEIGHT, lastBarHeightRef.current || barHeight)
    : Math.max(DEFAULT_BAR_HEIGHT, barHeight);
  const spacerHeight = Math.max(MIN_SPACER_PX, stableBarHeight + BAR_GAP_PX + SPACER_EXTRA);
  // Position the back-to-chat toggle:
  // Anchor Chat toggle just above the hero card; keep it in view regardless of rail state
  // Keep chat toggle anchored consistently; ignore rail width changes
  const backToChatStyle = {
    position: "fixed",
    top: "16px",
    left: "calc(var(--nav-w, 0px) - 20px)",
    zIndex: 20050,
    backdropFilter: "none",
    pointerEvents: "auto",
  };

  return (
    <div className={`h-screen min-h-0 w-full font-sans ${textColor}`}>
      {/* 3-col grid: [Nav space] [Center] [Insights or Handle] */}
      <div
        className="h-screen min-h-0 grid pl-0"
        style={{
          gridTemplateColumns: "1fr",
          columnGap: `${GRID_GAP}px`,
        }}
      >
        {/* CENTER COLUMN */}
        <section className="relative flex flex-col overflow-hidden bg-transparent">
          <div style={{ position: "relative", zIndex: 1, height: "100%" }} className="flex flex-col min-h-0">
            {/* Desktop Chat toggle lives in the chrome instead of the scrollable column */}
            {!isChatHome &&
              createPortal(
                <ChatSwitchToggle
                  context="dashboard"
                  style={backToChatStyle}
                  className="hidden md:inline-flex"
                />,
                document.body
              )}

            {/* Anchor & measurer / your existing scroll region */}
            <div
              className="hidden md:flex flex-1 min-h-0 pt-7 overflow-hidden"
              data-chat-top-anchor
              style={{ position: "relative", zIndex: 1 }}
            >
              <div
                ref={centerRef}
                className="flex w-full h-full"
                data-center-col
                style={{
                  width: `min(${CHAT_CONTENT_VW * 100}vw, ${CHAT_MAX_W}px)`,
                  maxWidth: `${CHAT_MAX_W}px`,
                  margin: "0 auto",
                }}
              >
                <div
                  ref={contentRef}
                  className={`flex-1 min-h-0 px-0 ${isChatHome ? "overflow-hidden" : "overflow-y-auto no-scrollbar touch-scroll"}`}
                  style={{
                    width: chatBounds.width ? `${chatBounds.width}px` : `min(${CHAT_CONTENT_VW * 100}vw, ${CHAT_MAX_W}px)`,
                    maxWidth: chatBounds.width ? `${chatBounds.width}px` : `${CHAT_MAX_W}px`,
                    margin: "0 auto",
                    // hide page content under the overlay on ChatHome
                    visibility: hideCenter ? "hidden" : "visible",
                    pointerEvents: hideCenter ? "none" : "auto",
                  }}
                >
                  {/* Keep page content visually aligned with the chat width */}
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={location.pathname}
                      initial={{ opacity: 0, y: 30 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 20 }}
                      transition={{ duration: 0.22, ease: [0.22, 0.1, 0.25, 1] }}
                      className="will-change-transform"
                    >
                      <div className="flex flex-col gap-4">
                        {children}
                        <div style={{ height: `${spacerHeight}px` }} />
                      </div>
                    </motion.div>
                  </AnimatePresence>
                </div>
              </div>
            </div>

            {/* ChatCanvas … (unchanged) */}
            {showChat && (
              <div style={{ zIndex: LAYERS.CANVAS, position: "relative" }}>
                <ChatCanvas
                  left={chatBounds.left}
                  width={chatBounds.width}
                  barNudge={DASH_BAR_ALIGN_NUDGE_PX}
                  topAnchorSelector="[data-chat-top-anchor]"
                  quickPromptMode={quickPromptMode}
                />
              </div>
            )}

            {/* MOBILE */}
            <div className="md:hidden flex-1 flex flex-col" style={{ position: "relative", zIndex: 1 }}>
              {showChat && (
                <>
                  <div className="md:hidden">
                    <ExpandableInsightButton variant="mobile" />
                  </div>
                  <BizzyChatBar quickPromptMode={quickPromptMode} />
                </>
              )}
            </div>
          </div>
        </section>

        {/* RIGHT COLUMN / Insights rail (host is transparent; rail draws its own glass) */}
        {showRail && (
          <>
            {/* Top-right floating toggle rendered to body to avoid clipping under headers */}
            {!isChatHome &&
              createPortal(
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); toggleRail(); }}
                  className="hidden lg:inline-flex items-center justify-center h-8 w-8 rounded-full border border-white/16 bg-black/80 text-white hover:bg-black/90 transition shadow-[0_10px_30px_rgba(0,0,0,0.35)]"
                  style={{ position: "fixed", top: 12, right: 12, zIndex: 20000, pointerEvents: "auto" }}
                  title={railOpen ? "Close insights" : "Open insights"}
                  aria-label={railOpen ? "Close insights" : (showUnreadBadge ? `${unreadCount} unread insights` : "Open insights")}
                >
                  <div className="relative">
                    <MessageSquare size={14} />
                    {showUnreadBadge && (
                      <span
                        className="absolute -top-2 -right-2 min-w-[16px] h-[16px] px-[4px] rounded-full text-[10px] leading-[16px] text-black font-semibold flex items-center justify-center border border-black/30 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
                        aria-label={`${unreadCount} unread insights`}
                        style={{ backgroundColor: badgeAccent }}
                      >
                        {unreadCount > 9 ? "9+" : unreadCount}
                      </span>
                    )}
                  </div>
                </button>,
                document.body
              )
            }

            <aside
              ref={rightAsideRef}
              className="hidden lg:flex"
              style={{
                position: "fixed",
                top: 0,
                right: 0,
                height: "100vh",
                width: railOpen ? `${RIGHT_RAIL_W}px` : "0px",
                overscrollBehavior: "contain",
                "--chat-clearance": `${chatClearance}px`,
                zIndex: LAYERS.HANDLE + 10,
                background: "transparent",
                overflow: "visible",
                transition: "width 560ms cubic-bezier(0.22,1,0.36,1), transform 560ms cubic-bezier(0.22,1,0.36,1)",
                transform: railOpen ? "translateX(0)" : "translateX(10px)",
                pointerEvents: railOpen ? "auto" : "none",
                visibility: railOpen ? "visible" : "hidden",
              }}
            >
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 z-0 bizzy-bg-textured"
                style={{ backgroundColor: "var(--bg)" }}
              />

              <div
                className="h-full w-full will-change-transform transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
                style={{
                  paddingRight: 0,
                  transform: railOpen ? "translateX(0)" : "translateX(12px)",
                  pointerEvents: railOpen ? "auto" : "none",
                  visibility: railOpen ? "visible" : "hidden",
                  height: "100%",
                  position: "relative",
                }}
              >
                <InsightsRail
                  userId={userId}
                  businessId={businessId}
                  accountId={undefined}
                  isOpen={railOpen}
                />
              </div>
            </aside>
          </>
        )}
      </div>

      {/* CHAT BAR + INTERNAL CURTAIN (single stacking context via portal) */}
  {showChat &&
    showPortalBar &&               // ← dashboards always; ChatHome only when Canvas open
    chatBounds.width > 0 &&
        createPortal(
          (() => {
            const measured = chatWrapperRef.current?.getBoundingClientRect()?.height || 0;
            const barH = Math.max(DEFAULT_BAR_HEIGHT, measured || barHeight || DEFAULT_BAR_HEIGHT);
            const barLeft = chatBounds.left + DASH_BAR_ALIGN_NUDGE_PX;
            const barWidth = Math.max(0, chatBounds.width - DASH_BAR_ALIGN_NUDGE_PX);

            // Exactly cover chips + bar, no higher
            // Use a shorter curtain on ChatCanvas so it stops at the top of quick prompts;
            // keep the taller version on dashboards.
            const trimTop = isChatHome ? CURTAIN_TRIM_TOP + 0 : CURTAIN_TRIM_TOP;
            const curtainH = Math.max(barH - trimTop + UNDERLAP, CURTAIN_MIN_H);

            return (
              <motion.div
                ref={chatWrapperRef}
                className="hidden md:block fixed bottom-8 pointer-events-none"
                data-bizzy-chatbar
                data-bizzy-chatbar-shell
                style={{
                  left: `${barLeft}px`,
                  transform: "none",
                  width: `${barWidth}px`,
                  maxWidth: `${CHAT_MAX_W}px`,
                  zIndex: LAYERS.BAR,
                  overflow: "visible",
                  isolation: "isolate",
                }}
                initial={{ opacity: 0, y: 40 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 40 }}
                transition={{ duration: 0.25, ease: [0.22, 0.1, 0.25, 1] }}
              >
                {/* CURTAIN: behind the bar (upwards) */}
                <div
                  data-bizzy-chatbar-measure
                  data-bizzy-curtain
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: `${curtainH}px`,
                    pointerEvents: "none",
                    zIndex: 0,
                  }}
                >
                  <div
                    className="bizzy-bg-textured"
                    style={{
                      position: "absolute",
                      inset: 0,
                      backgroundColor: "var(--bg)",
                      pointerEvents: "none",
                    }}
                  />
                </div>

                {/* CURTAIN FOOTER: fill the gap below the bar to the viewport edge */}
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: 4,
                    right: 0,
                    bottom: `-${WRAPPER_BOTTOM_OFFSET_PX}px`,
                    height: `${WRAPPER_BOTTOM_OFFSET_PX}px`,
                    pointerEvents: "none",
                    zIndex: 0,
                  }}
                >
                  <div
                    className="bizzy-bg-textured"
                    style={{
                      position: "absolute",
                      inset: 0,
                      backgroundColor: "var(--bg)",
                      pointerEvents: "none",
                    }}
                  />
                </div>

                {/* Bar above curtain */}
                <div style={{ position: "relative", zIndex: 1 }} className="pointer-events-auto">
                  <BizzyChatBar variant="contained" quickPromptMode={quickPromptMode} />
                </div>
              </motion.div>
            );
          })(),
          document.body
        )}
    </div>
  );
};

const DashboardLayout = ({ children }) => {
  const userId = localStorage.getItem("user_id");
  const businessId = localStorage.getItem("currentBusinessId");

  return (
    <>
      <NavRail businessId={businessId} open />
      <InsightsUnreadProvider userId={userId} businessId={businessId}>
        <RightExtrasProvider>
          <DashboardContent>{children}</DashboardContent>
        </RightExtrasProvider>
      </InsightsUnreadProvider>
    </>
  );
};

export default DashboardLayout;
