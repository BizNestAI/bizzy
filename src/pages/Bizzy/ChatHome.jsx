// src/pages/Bizzy/ChatHome.jsx
import React, { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useBizzyChatContext } from "../../context/BizzyChatContext";
import BizzyChatBar from "../../components/Bizzy/BizzyChatBar";
import ChatCanvas from "../../components/Bizzy/ChatCanvas";
import useOnboardingStatus from "../../hooks/useOnboardingStatus";
import ChatGreeting from "../../components/Bizzy/ChatGreeting";

export default function ChatHome() {
  return <ChatHomeInner />;
}

function ChatHomeInner() {
  const navigate = useNavigate();
  const { isCanvasOpen = false, closeCanvas } = useBizzyChatContext();
  const { quickPromptMode } = useOnboardingStatus();

  // Ensure IBM Plex Sans is available (once)
  useEffect(() => {
    const id = "ibm-plex-sans-font";
    if (!document.getElementById(id)) {
      const link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href =
        "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap";
      document.head.appendChild(link);
    }
  }, []);

  // Lock page scroll on ChatHome (no vertical scrolling)
  useEffect(() => {
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
    };
  }, []);

  // Subtle contrast shade ONLY for ChatHome’s chat bar shell
  // Use the same neutral shell as dashboard/chat canvas (no override)
  const chatHomeShell = "";

  // Always start with hero visible on /chat
  useEffect(() => {
    const t = setTimeout(() => closeCanvas?.(), 0);
    return () => clearTimeout(t);
  }, [closeCanvas]);

  const showCanvas = isCanvasOpen;
  const showHero = !showCanvas;

  // Measure center column for canvas + bottom dock
  const centerRef = useRef(null);
  const [bounds, setBounds] = useState({ left: 0, width: 0 });
  const measure = useCallback(() => {
    const el = centerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setBounds({ left: Math.round(r.left), width: Math.round(r.width) });
  }, []);
  useEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (centerRef.current) ro.observe(centerRef.current);
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [measure]);

  const lastDash = localStorage.getItem("bizzy:lastDashboard");
  const hasDashHistory = !!(lastDash && !lastDash.startsWith("/dashboard/bizzy/chat"));
  const goToDashboard = () => {
    const target = hasDashHistory ? lastDash : "/dashboard/bizzy";
    navigate(target);
  };

return (
  <div className="h-full min-h-0 overflow-hidden">
    {/* CENTER column wrapper */}
    <section className="relative flex flex-col min-h-[calc(100vh-64px)] bg-app text-primary overflow-hidden">
        {/* Top-right: single Dashboard button for ChatHome */}
        {hasDashHistory && (
          <div className="absolute right-10 top-[0px] z-[9050]">
            <button
              onClick={goToDashboard}
              className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm hover:bg-white/5"
              style={{ borderColor: "rgba(165,167,169,0.22)", color: "var(--text-2)" }}
              title="Back to Dashboard"
            >
              ← Dashboard
            </button>
          </div>
        )}

        {/* Anchor for pinning canvas below header */}
        <div className="absolute left-0 right-0 top-[64px]" data-chat-top-anchor />

        {/* Anchor for measuring center width/left */}
        <div ref={centerRef} className="hidden md:block" style={{ width: "100%", height: 1 }} />

        {/* HERO (bar perfectly centered; greeting + prompts raised above) */}
        {showHero && (
          <div className="hidden md:block absolute inset-0 z-[9000]">
            {/* Centered BAR */}
            <div
              className="absolute left-1/2 w-full max-w-[920px] px-8 pointer-events-none"
              style={{ top: "calc(50% - 145px)", transform: "translateX(-50%)" }}
            >
              <div className="pointer-events-auto">
                <BizzyChatBar
                  variant="inline"
                  forceVisible
                  tone="neutral"
                  className="w-full"
                  shellClassName={chatHomeShell}
                  placeholder="Ask Bizzi anything about cash flow, marketing, or taxes…"
                  centerPlaceholder
                  quickPromptMode={quickPromptMode}
                />
              </div>
            </div>

            {/* Greeting */}
            <div
              className="absolute left-1/2 -translate-x-1/2 w-full max-w-[900px] px-6 text-center"
              style={{ top: "calc(50% - 195px)" }}
            >
              <ChatGreeting />
              <div className="mt-4" />
            </div>
          </div>
        )}

        {/* DESKTOP: ChatCanvas overlays the center when active */}
        {showCanvas && (
          <ChatCanvas
            left={bounds.left}
            width={bounds.width}
            topAnchorSelector="[data-chat-top-anchor]"
          />
        )}

        {/* MOBILE: bottom dock (keyboard-aware) */}
        <MobileDock shellClassName={chatHomeShell} quickPromptMode={quickPromptMode} />

        {/* DESKTOP: bottom dock only when canvas is open */}
        {showCanvas && (
          <div
            className="hidden md:block fixed bottom-8 pointer-events-none"
            style={{ left: `${bounds.left}px`, width: `${bounds.width}px`, zIndex: 10000 }}
            data-bizzy-chatbar
          >
            <div className="pointer-events-auto">
              <BizzyChatBar
                variant="contained"
                shellClassName={chatHomeShell}
                quickPromptMode={quickPromptMode}
              />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function MobileDock({ shellClassName, quickPromptMode = "normal" }) {
  const [bottomInset, setBottom] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onChange = () => {
      const delta = Math.max(0, window.innerHeight - Math.ceil(vv.height));
      setBottom(delta);
    };
    vv.addEventListener("resize", onChange);
    vv.addEventListener("scroll", onChange);
    onChange();
    return () => {
      vv.removeEventListener("resize", onChange);
      vv.removeEventListener("scroll", onChange);
    };
  }, []);
  return (
    <div
      className="md:hidden fixed inset-x-0 bottom-0 z-[10000] px-3"
      style={{ paddingBottom: `max(${bottomInset}px, env(safe-area-inset-bottom))` }}
    >
      <BizzyChatBar
        variant="inline"
        forceVisible
        className="w-full"
        shellClassName={shellClassName}
        placeholder="Ask Bizzi anything…"
        quickPromptMode={quickPromptMode}
      />
    </div>
  );
}
