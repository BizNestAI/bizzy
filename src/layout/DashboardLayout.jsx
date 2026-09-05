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
import { CHAT_CONTENT_MAX_W, CHAT_CONTENT_VW } from "../config/chatLayout";
import { useInsightsUnread } from "../insights/InsightsUnreadContext";
import { useMemo } from "react";
import { ACCENT_HEX } from "../config/accent";
import { shouldSuppressTabRestoreMotion } from "../utils/tabVisibilityMotionGuard";

const MotionDiv = motion.div;

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

// Curtain sizing (tuned to start just above the prompt row)
const CURTAIN_MIN_H = 75;
const UNDERLAP = 8;          // tuck slightly above the chips so no content peeks through

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

const GLOBAL_INSIGHTS_MODULE = "contractor_cfo";

class DashboardRouteErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    console.error("[DashboardRouteErrorBoundary]", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen w-full bg-app px-6 py-10 text-primary">
          <div className="mx-auto max-w-[520px] rounded-2xl border border-white/12 bg-white/[0.045] p-5 shadow-[0_20px_70px_rgba(0,0,0,0.45)]">
            <h1 className="text-lg font-semibold text-white">Something went wrong.</h1>
            <p className="mt-2 text-sm leading-6 text-white/65">
              Refresh this page to reload your workspace. Your data was not changed.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 rounded-full border border-white/16 bg-white/[0.06] px-4 py-2 text-sm font-semibold text-white/86 transition hover:bg-white/[0.1]"
            >
              Refresh page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// Normalize unread counts while honoring business suffix (module:businessId)
// so we don't aggregate across businesses.
function normalizeUnreadMap(raw = {}, bizId = "") {
  const totals = {};
  Object.entries(raw || {}).forEach(([key, val]) => {
    const [base, suffix] = key.split(":");
    if (suffix && bizId && suffix !== bizId) return; // skip other businesses
    totals[base] = (totals[base] || 0) + Number(val || 0);
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
    const inChatHome = location.pathname.startsWith("/dashboard/bizzi/chat");
    if (location.pathname.startsWith("/dashboard/") && !inChatHome) {
      localStorage.setItem("bizzy:lastDashboard", location.pathname);
      try { sessionStorage.setItem("bizzy:visitedDash", "1"); } catch {
        // Session storage can be unavailable in restricted contexts.
      }
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
     if (!businessId) return;
     setExtras({ type: "agenda", props: { businessId, module: GLOBAL_INSIGHTS_MODULE } });
   }, [location.pathname, currentBusiness?.id, setExtras]);

  const theme = useModuleTheme(location.pathname);
  const { isCanvasOpen = false, closeCanvas } = useBizzyChatContext();

  const [railOpen, setRailOpen] = useState(false);
  const toggleRail = () => setRailOpen((v) => !v);
  const moduleKey = GLOBAL_INSIGHTS_MODULE;
  const unreadCount = normalizedUnread[moduleKey] || 0;
  const isCleared = clearedModules.has(moduleKey);
  const lastUnreadRef = useRef(new Map());
  const effectiveUnread = unreadCount > 0 ? unreadCount : (lastUnreadRef.current.get(moduleKey) || 0);
  const showUnreadBadge = effectiveUnread > 0 && !isCleared;
  const badgeAccent = ACCENT_HEX;

  // Persist cleared modules in session
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(Array.from(clearedModules)));
    } catch {
      // Session storage can be unavailable in restricted contexts.
    }
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
  const centerRef = useRef(null);
  const chatMeasureRef = useRef(null);
  const contentRef = useRef(null);
  const rightAsideRef = useRef(null);
  const prevPathRef = useRef(location.pathname);
  const canvasScrollLockRef = useRef({ top: 0, overflowY: null });

  const textColor = theme?.textClass || "text-primary";

  const onDashboard = location.pathname.startsWith("/dashboard/");
  const isChatHome  = location.pathname.startsWith("/dashboard/bizzi/chat") || location.pathname.startsWith("/chat");
  const isMonthlyReviewAdmin = location.pathname.startsWith("/dashboard/admin/monthly-review");
  const hideCenter  = isCanvasOpen;
  const inSettings  = location.pathname.includes("settings");
  const inMeetBizzi = location.pathname.includes("companion");
  const inDocs      = location.pathname.includes("bizzi-docs");
  const showPortalBar =
    !isMonthlyReviewAdmin && !isCanvasOpen && !isChatHome && (onDashboard || inSettings || inMeetBizzi || inDocs);

  const disableRails = inSettings || inMeetBizzi || inDocs || isMonthlyReviewAdmin;
  const showRail = onDashboard && !disableRails && !isChatHome;
  const showChat = !isMonthlyReviewAdmin && (onDashboard || isChatHome || inSettings || inMeetBizzi || inDocs);
  const suppressRouteMotion = shouldSuppressTabRestoreMotion();

  const railStateRef = useRef(railOpen);
  const prevCanvasOpen = useRef(isCanvasOpen);
  const preCanvasBarHeightRef = useRef(null);
  const ignoreBarMeasureUntilRef = useRef(0);
  const chatWrapperRef = useRef(null);
  const lastBarHeightRef = useRef(DEFAULT_BAR_HEIGHT);
  const [barHeight, setBarHeight] = useState(DEFAULT_BAR_HEIGHT);
  const clampBarHeight = (h = 0) => {
    const numericHeight = Number(h);
    if (!Number.isFinite(numericHeight) || numericHeight <= 0) return DEFAULT_BAR_HEIGHT;
    return Math.min(MAX_BAR_HEIGHT, Math.max(DEFAULT_BAR_HEIGHT, Math.round(numericHeight)));
  };

  useEffect(() => {
    const becameOpen = !prevCanvasOpen.current && isCanvasOpen;
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
  }, [isCanvasOpen, barHeight]);

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

  const chatClearance = Math.max(72, (barHeight || DEFAULT_BAR_HEIGHT) + BAR_GAP_PX);

  useEffect(() => {
    // Only measure the desktop chat bar when it is rendered (canvas closed); ignore ChatCanvas-only height.
    if (!showPortalBar) return;
    if (!chatWrapperRef.current) return;
    if (typeof ResizeObserver === "undefined") return;
    const el = chatWrapperRef.current;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      const next = clampBarHeight(rect?.height);
      if (Date.now() < ignoreBarMeasureUntilRef.current) return;
      if (next === lastBarHeightRef.current && next === barHeight) return;
      const stable = Math.max(lastBarHeightRef.current || DEFAULT_BAR_HEIGHT, next);
      lastBarHeightRef.current = stable;
      setBarHeight((current) => (Math.abs(current - stable) >= 1 ? stable : current));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [showPortalBar, barHeight]);

  // On first paint after closing the canvas (or showing the portal bar), measure immediately
  useEffect(() => {
    if (!showPortalBar) return;
    const el = chatWrapperRef.current;
    if (!el) return;
    if (Date.now() < ignoreBarMeasureUntilRef.current) return;
    const next = clampBarHeight(el.getBoundingClientRect()?.height);
    const stable = Math.max(lastBarHeightRef.current || DEFAULT_BAR_HEIGHT, next);
    lastBarHeightRef.current = stable;
    setBarHeight((current) => (Math.abs(current - stable) >= 1 ? stable : current));
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
    // Measure the outer center column, not contentRef. contentRef is sized from
    // chatBounds, so measuring it can permanently lock in a narrower width after
    // DevTools changes the viewport until a full refresh.
    const rectSource = chatMeasureRef.current || centerRef.current || contentRef.current;
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
    if (typeof ResizeObserver === "undefined") {
      const onResize = () => measureCenter();
      window.addEventListener("resize", onResize);
      window.visualViewport?.addEventListener("resize", onResize);
      return () => {
        window.removeEventListener("resize", onResize);
        window.visualViewport?.removeEventListener("resize", onResize);
      };
    }
    const ro = new ResizeObserver(measureCenter);
    if (chatMeasureRef.current) ro.observe(chatMeasureRef.current);
    const onResize = () => measureCenter();
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railOpen, showRail, location.pathname]);

  // Reset scroll when landing on ChatHome so it never inherits a scrolled dashboard position.
  useEffect(() => {
    if (location.pathname.startsWith("/dashboard/bizzi/chat") || location.pathname.startsWith("/chat")) {
      window.scrollTo({ top: 0, behavior: "auto" });
      if (contentRef.current) contentRef.current.scrollTo({ top: 0, behavior: "auto" });
    }
  }, [location.pathname]);

  useEffect(() => {
    const prev = prevPathRef.current;
    const leavingChat =
      prev &&
      (prev.startsWith("/dashboard/bizzi/chat") || prev.startsWith("/chat"));
    const nowOnDashboard =
      location.pathname.startsWith("/dashboard/") &&
      !location.pathname.startsWith("/dashboard/bizzi/chat");
    const nowOnChat =
      location.pathname.startsWith("/dashboard/bizzi/chat") || location.pathname.startsWith("/chat");

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

    // ChatHome should never inherit a preserved scroll position from the canvas.
    // Restoring a stale top here can nudge the hero/bar stack upward after closing
    // a long thread, which also makes the next canvas open feel like a shake.
    if (isChatHome) {
      if (isCanvasOpen) {
        el.style.overflowY = "hidden";
        return;
      }
      el.style.overflowY = "";
      el.scrollTop = 0;
      canvasScrollLockRef.current = { top: 0, overflowY: "" };
      return;
    }

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
  }, [isCanvasOpen, isChatHome]);

  useEffect(() => {
    if (!isChatHome || isCanvasOpen) return;
    lastBarHeightRef.current = DEFAULT_BAR_HEIGHT;
    setBarHeight(DEFAULT_BAR_HEIGHT);
  }, [isChatHome, isCanvasOpen]);

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
            {!isChatHome && !isMonthlyReviewAdmin &&
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
                ref={chatMeasureRef}
                aria-hidden
                className="pointer-events-none absolute left-1/2 top-0 hidden h-px -translate-x-1/2 md:block"
                data-chat-center-col
                style={{
                  width: `min(${CHAT_CONTENT_VW * 100}vw, ${CHAT_MAX_W}px)`,
                  maxWidth: `${CHAT_MAX_W}px`,
                }}
              />
              <div
                ref={centerRef}
                className={[
                  "flex h-full",
                  isMonthlyReviewAdmin
                    ? "w-full"
                    : isChatHome
                      ? "bizzy-page-width bizzy-page-width--conversation"
                      : "bizzy-page-width bizzy-page-width--workspace",
                ].join(" ")}
                data-center-col
                style={{
                  width: isMonthlyReviewAdmin
                    ? "calc(100vw - var(--nav-w, 0px) - 48px)"
                    : undefined,
                  maxWidth: isMonthlyReviewAdmin ? "none" : undefined,
                  margin: "0 auto",
                }}
              >
                <div
                  ref={contentRef}
                  className={`flex-1 min-h-0 ${isChatHome ? "overflow-hidden" : "overflow-y-auto no-scrollbar touch-scroll"}`}
                  style={{
                    width: isMonthlyReviewAdmin
                      ? "100%"
                      : "100%",
                    maxWidth: isMonthlyReviewAdmin ? "none" : "100%",
                    margin: "0 auto",
                    // hide page content under the overlay on ChatHome
                    visibility: hideCenter ? "hidden" : "visible",
                    pointerEvents: hideCenter ? "none" : "auto",
                  }}
                >
                  {/* Keep page content visually aligned with the chat width */}
                  <AnimatePresence mode="wait">
                    <MotionDiv
                      key={location.pathname}
                      initial={suppressRouteMotion ? false : { opacity: 0, y: 30 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 20 }}
                      transition={
                        suppressRouteMotion
                          ? { duration: 0 }
                          : { duration: 0.22, ease: [0.22, 0.1, 0.25, 1] }
                      }
                      className="will-change-transform"
                    >
                      <div className="flex flex-col gap-4">
                        {children}
                        {!isMonthlyReviewAdmin ? <div style={{ height: `${spacerHeight}px` }} /> : null}
                      </div>
                    </MotionDiv>
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
                  rightInset={railOpen && showRail ? RIGHT_RAIL_W + GRID_GAP : 0}
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
              aria-hidden={!railOpen}
              style={{
                position: "fixed",
                top: 0,
                right: 0,
                height: "100vh",
                width: `${RIGHT_RAIL_W}px`,
                overscrollBehavior: "contain",
                "--chat-clearance": `${chatClearance}px`,
                zIndex: LAYERS.HANDLE + 10,
                background: "transparent",
                overflow: "visible",
                opacity: railOpen ? 1 : 0,
                transition: "transform 260ms cubic-bezier(0.2,0.85,0.25,1), opacity 180ms ease",
                transform: railOpen ? "translateX(0)" : "translateX(calc(100% + 10px))",
                pointerEvents: railOpen ? "auto" : "none",
                willChange: "transform, opacity",
              }}
            >
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 z-0 bizzy-bg-textured"
                style={{ backgroundColor: "var(--bg)" }}
              />

              <div
                className="h-full w-full"
                style={{
                  paddingRight: 0,
                  pointerEvents: railOpen ? "auto" : "none",
                  height: "100%",
                  position: "relative",
                }}
              >
                <InsightsRail
                  userId={userId}
                  businessId={businessId}
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
            const navWidthPx =
              showRail && typeof window !== "undefined"
                ? Number.parseFloat(
                    window
                      .getComputedStyle(document.documentElement)
                      .getPropertyValue("--nav-w")
                  ) || 0
                : 0;
            const bandLeft = navWidthPx;
            const barLeft = Math.max(0, chatBounds.left + DASH_BAR_ALIGN_NUDGE_PX - bandLeft);
            const barWidth = Math.max(0, chatBounds.width - DASH_BAR_ALIGN_NUDGE_PX);

            // Cover only the fixed prompt/composer stack and the small gap above it.
            const curtainH = Math.max(barH + UNDERLAP, CURTAIN_MIN_H);

            return (
              <MotionDiv
                ref={chatWrapperRef}
                className="hidden md:block fixed bottom-0 right-0 pointer-events-none"
                data-bizzy-chatbar
                data-bizzy-chatbar-shell
                style={{
                  left: `${bandLeft}px`,
                  transform: "none",
                  width: "auto",
                  maxWidth: "none",
                  zIndex: LAYERS.BAR,
                  overflow: "visible",
                  isolation: "isolate",
                }}
                initial={{ opacity: 0, y: 40 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 40 }}
                transition={{ duration: 0.25, ease: [0.22, 0.1, 0.25, 1] }}
              >
                {/* Main-area bottom backdrop; prompts/composer stay constrained inside it. */}
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
                    style={{
                      position: "absolute",
                      inset: 0,
                      background:
                        "linear-gradient(180deg, rgba(5,6,6,0), rgba(5,6,6,0.96) 12px, var(--bg) 34px, var(--bg) 100%)",
                      pointerEvents: "none",
                    }}
                  />
                </div>

                {/* Bar above curtain */}
                <div
                  style={{
                    position: "relative",
                    zIndex: 1,
                    width: `${barWidth}px`,
                    maxWidth: `${CHAT_MAX_W}px`,
                    marginLeft: `${barLeft}px`,
                    marginBottom: "32px",
                  }}
                  className="pointer-events-auto"
                >
                  <BizzyChatBar
                    variant="contained"
                    quickPromptMode={quickPromptMode}
                    flushColumnPadding
                  />
                </div>
              </MotionDiv>
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
          <DashboardRouteErrorBoundary>
            <DashboardContent>{children}</DashboardContent>
          </DashboardRouteErrorBoundary>
        </RightExtrasProvider>
      </InsightsUnreadProvider>
    </>
  );
};

export default DashboardLayout;
