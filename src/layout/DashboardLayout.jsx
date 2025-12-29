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
import { ChevronLeft, ChevronRight } from "lucide-react";
import ChatSwitchToggle from "../components/Bizzy/ChatSwitchToggle";
import { AnimatePresence, motion } from "framer-motion";
import { useRightExtras } from "../insights/RightExtrasContext";
import { useBusiness } from "../context/BusinessContext"
import useOnboardingStatus from "../hooks/useOnboardingStatus";

const BAR_GAP_PX = 32;
const SPACER_EXTRA = 84;
const DEFAULT_BAR_HEIGHT = 110;
// Max width of the chat thread + bar (desktop)
const CHAT_MAX_W = 980; // tweak to 920/960/etc to taste

// Grid
const RIGHT_RAIL_W = 320;
const HANDLE_W = 46;
const GRID_GAP = 6;

// Curtain sizing (tuned for “just covers chips”)
const CURTAIN_MIN_H = 75;
const CURTAIN_TRIM_TOP = 9; // shave a bit so we stop at top of chips
const UNDERLAP = 8;          // tuck slightly under the bar so no seam

// This must match the wrapper class "bottom-12"
const WRAPPER_BOTTOM_OFFSET_PX = 50;

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

const DashboardContent = ({ children }) => {
  const location = useLocation();
  const { currentBusiness } = useBusiness?.() || {};
  const { quickPromptMode } = useOnboardingStatus();
  const { setExtras } = useRightExtras();   // <-- publish descriptor from here
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
  const { isCanvasOpen = false, activeThreadId, openCanvas } = useBizzyChatContext();

  const [railOpen, setRailOpen] = useState(true);
  const useChrome = isChromeRoute(location.pathname);
  const centerRef = useRef(null);
  const contentRef = useRef(null);
  const rightAsideRef = useRef(null);
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

  const bgColor = theme?.bgClass || "bg-app";
  const textColor = theme?.textClass || "text-primary";

  const onDashboard = location.pathname.startsWith("/dashboard/");
  const isChatHome  = location.pathname.startsWith("/dashboard/bizzy/chat") || location.pathname.startsWith("/chat");
  const hideCenter  = isChatHome && isCanvasOpen;
  const showPortalBar =
    (!isChatHome && (onDashboard || inSettings || inMeetBizzi || inDocs)) ||
    (isChatHome && isCanvasOpen);

  const inSettings  = location.pathname.includes("settings");
  const inMeetBizzi = location.pathname.includes("companion");
  const inDocs      = location.pathname.includes("bizzy-docs");

  const disableRails = inSettings || inMeetBizzi || inDocs;
  const showRail = onDashboard && !disableRails && !isChatHome;
  const showChat = onDashboard || isChatHome || inSettings || inMeetBizzi || inDocs;

  const railStateRef = useRef(railOpen);

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
  const [barHeight, setBarHeight] = useState(DEFAULT_BAR_HEIGHT);
  const chatClearance = Math.max(72, (barHeight || DEFAULT_BAR_HEIGHT) + BAR_GAP_PX);

  // If we are on ChatHome with a selected thread but the canvas isn't open yet,
  // open it automatically so the overlay shows.
   useEffect(() => {
     if (isChatHome && activeThreadId && !isCanvasOpen) {
       openCanvas(activeThreadId);
     }
   }, [isChatHome, activeThreadId, isCanvasOpen, openCanvas]);

  useEffect(() => {
    if (!chatWrapperRef.current) return;
    const el = chatWrapperRef.current;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect?.height) setBarHeight(Math.round(rect.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Robust measurement of center column (left/width)
  const [chatBounds, setChatBounds] = useState({ left: 0, width: 0 });
  const measureCenter = () => {
    const host = centerRef.current;
     const content = contentRef.current;
     if (!host) return;
     const hostRect = host.getBoundingClientRect();
     // Prefer the exact centered content; fall back to a centered box inside the host
     const rect = (content?.getBoundingClientRect?.() || hostRect);
     const width = Math.min(rect.width, CHAT_MAX_W);
     const left = rect.left + (rect.width - width) / 2;
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

  const spacerHeight = barHeight + BAR_GAP_PX + SPACER_EXTRA;
  // Position the back-to-chat toggle:
  // - keep vertical aligned to the "Today" label
  // - horizontally align over the Tax Readiness shield (roughly 78% across the content row)
  const chatButtonLeft = chatBounds.width
    ? Math.round(chatBounds.left + chatBounds.width * 0.78)
    : null;
  const backToChatStyle = {
    top: "clamp(35px, 1vh, 240px)",
    left: chatButtonLeft ? `${chatButtonLeft}px` : undefined,
    right: chatButtonLeft ? "auto" : (railOpen && showRail
      ? "calc(var(--content-rail-offset, 0px) - 12px)"
      : "12px"),
  };

  return (
    <div className={`h-screen min-h-0 w-full font-sans ${bgColor} ${textColor}`}>
      {/* 3-col grid: [Nav space] [Center] [Insights or Handle] */}
      <div
        className="h-screen min-h-0 grid pl-0"
        style={{
          gridTemplateColumns: "1fr",
          columnGap: `${GRID_GAP}px`,
        }}
      >
        {/* CENTER COLUMN */}
        <section className="relative flex flex-col overflow-hidden bg-app">

          {/* <-- Add this sticky row (desktop only) */}
  {!isChatHome && (
             <div className="hidden md:block">
               <div
                 className="sticky top-3 z-[46] flex justify-end pr-2 pointer-events-none relative"
               >
                 <div className="pointer-events-auto">
                   <ChatSwitchToggle
                     context="dashboard"
                     className="md:top-2 md:right-4"
                     style={backToChatStyle}
                   />
                 </div>
               </div>
             </div>
           )}

  {/* Anchor & measurer / your existing scroll region */}
<div className="hidden md:flex flex-1 min-h-0 pt-7 overflow-hidden" data-chat-top-anchor>
  <div ref={centerRef} className="flex w-full h-full" data-center-col>
    <div
      ref={contentRef}
      className="flex-1 min-h-0 overflow-y-auto no-scrollbar touch-scroll px-0"
      style={{
    maxWidth: `${CHAT_MAX_W}px`,
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
        topAnchorSelector="[data-chat-top-anchor]"
      />
    </div>
  )}

          {/* MOBILE */}
          <div className="md:hidden flex-1 flex flex-col">
            {showChat && (
              <>
                <div className="md:hidden">
                  <ExpandableInsightButton variant="mobile" />
                </div>
                <BizzyChatBar quickPromptMode={quickPromptMode} />
              </>
            )}
          </div>
        </section>

        {/* RIGHT COLUMN / Insights rail (host is transparent; rail draws its own glass) */}
        {showRail && (
          <aside
            ref={rightAsideRef}
            className="hidden lg:flex"
            style={{
              position: "fixed",
              top: 0,
              right: 0,
              height: "100vh",
              width: railOpen ? `${RIGHT_RAIL_W}px` : `${HANDLE_W}px`,
              overscrollBehavior: "contain",
              "--chat-clearance": `${chatClearance}px`,
              zIndex: LAYERS.HANDLE + 10, // ensure rail sits above header
              background: "transparent",
              overflow: "visible",
              transition: "width 560ms cubic-bezier(0.22,1,0.36,1), transform 560ms cubic-bezier(0.22,1,0.36,1)",
              transform: railOpen ? "translateX(0)" : "translateX(10px)",
            }}
          >
            {/* Base fill to eliminate any uncovered gap above the rail */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 z-0"
              style={{ backgroundColor: "var(--bg)" }}
            />

            {/* Toggle handle — always clickable except on ChatHome */}
            {!isChatHome && (
              <button
                 className="absolute left-0 top-1/2 -translate-y-1/2 w-[16px] h-[56px]
                            rounded-l-sm border text-secondary pointer-events-auto"
    title={railOpen ? "Hide insights" : "Show insights"}
    onClick={() => setRailOpen(!railOpen)}
    style={{
      zIndex: LAYERS.HANDLE,
      // neutral, semi-transparent tab that works with the glass behind it
      background: "rgba(18,19,20,0.48)",
                   borderColor: useChrome ? "var(--accent-line)" : "rgba(255,255,255,0.10)",
                   borderWidth: "1px",
                   boxShadow: useChrome ? "0 0 1px var(--accent-soft)" : "none"
    }}
  >

                {railOpen ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
              </button>
            )}

            <div
              className="h-full w-full will-change-transform transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={{
                paddingRight: 0,
                transform: railOpen ? "translateX(0)" : "translateX(12px)",
                pointerEvents: railOpen ? "auto" : "none",
                visibility: railOpen ? "visible" : "hidden", // hides clicks, keeps paint stable
                height: "100%",
                position: "relative",
              }}
            >
              {/* keep mounted – no remount on expand/collapse */}
              <InsightsRail
                userId={userId}
                businessId={businessId}
                accountId={undefined}
                isOpen={railOpen}
              />
            </div>
          </aside>
        )}
      </div>

      {/* CHAT BAR + INTERNAL CURTAIN (single stacking context via portal) */}
  {showChat &&
    showPortalBar &&               // ← dashboards always; ChatHome only when Canvas open
    chatBounds.width > 0 &&
        createPortal(
          (() => {
            const measured = chatWrapperRef.current?.getBoundingClientRect()?.height || 0;
            const barH = measured || barHeight || DEFAULT_BAR_HEIGHT;

            // Exactly cover chips + bar, no higher
            // Use a shorter curtain on ChatCanvas so it stops at the top of quick prompts;
            // keep the taller version on dashboards.
            const trimTop = isChatHome ? CURTAIN_TRIM_TOP + 16 : CURTAIN_TRIM_TOP;
            const curtainH = Math.max(barH - trimTop + UNDERLAP, CURTAIN_MIN_H);

            return (
              <motion.div
                ref={chatWrapperRef}
                className="hidden md:block fixed bottom-8 pointer-events-none"
                data-bizzy-chatbar
                style={{
                  left: `${chatBounds.left}px`,
                  width: `${chatBounds.width}px`,
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
                  data-bizzy-curtain
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: `${curtainH}px`,
                    backgroundColor: "var(--bg)",
                    backgroundImage: "none",
                    mixBlendMode: "normal",
                    opacity: 1,
                    pointerEvents: "none",
                    zIndex: 0,
                  }}
                />

                {/* CURTAIN FOOTER: fill the gap below the bar to the viewport edge */}
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: 4,
                    right: 0,
                    bottom: `-${WRAPPER_BOTTOM_OFFSET_PX}px`,
                    height: `${WRAPPER_BOTTOM_OFFSET_PX}px`,
                    backgroundColor: "var(--bg)",
                    opacity: 1,
                    pointerEvents: "none",
                    zIndex: 0,
                  }}
                />

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
    <InsightsUnreadProvider userId={userId} businessId={businessId}>
      <RightExtrasProvider>
        <DashboardContent>{children}</DashboardContent>
      </RightExtrasProvider>
    </InsightsUnreadProvider>
  );
};

export default DashboardLayout;
