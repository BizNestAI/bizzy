// File: /src/components/Bizzy/BizzyChatBar.jsx
import React, { useState, useRef, useEffect, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useBizzyChatContext } from "../../context/BizzyChatContext";
import AskBizzyQuickPrompts from "./AskBizzyQuickPrompts";
import useModuleTheme from "../../hooks/useModuleTheme";
import BizzyVoiceIcon from "./BizzyVoiceIcon";
import BizzySubmitButton from "./BizzySubmitButton";
import { getQuickPromptsForModule } from "../../services/prompts/quickPromptService";
import { NORMAL_PROMPTS, ONBOARDING_PROMPTS } from "../../config/chatQuickPrompts";
import { identifyOnboardingPrompt } from "../../config/onboardingPromptBank";

/* -------------------------------------------------- */
const accentHexMap = {
  bizzy: "#FF4EEB",
  accounting: "#00FFB2",
  marketing: "#3B82F6",
  tax: "#FFD700",
  investments: "#B388FF",
  email: "#3CF2FF",
};

const CHROME_HEX  = "#BFBFBF";
const CHROME_SOFT = "rgba(191,191,191,0.50)";
const CHROME_TOP  = "#D9D9D9";
const DEFAULT_BORDER   = hexToRgba(CHROME_HEX, 0.25);
const DEFAULT_QP_FRAME = hexToRgba(CHROME_HEX, 0.22);
const DEFAULT_GLOW     = hexToRgba(CHROME_HEX, 0.24);

function hexToRgba(hex, alpha = 1) {
  let c = (hex || "").replace("#", "");
  if (c.length === 3) c = c.split("").map(s => s + s).join("");
  const n = parseInt(c, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function routeAllowsBar(pathname) {
  if (!pathname) return false;
  return pathname.startsWith("/dashboard/") || pathname.startsWith("/chat");
}

function getModuleFromPath(path) {
  const seg = (path.split("/")[2] || "").toLowerCase();
  if (seg === "financials" || seg === "accounting") return "accounting";
  if (seg === "marketing") return "marketing";
  if (seg === "tax") return "tax";
  if (seg === "investments") return "investments";
  if (seg === "email") return "email";
  if (seg === "calendar") return "calendar";
  if (seg === "activity") return "activity";
  if (seg === "leads-jobs") return "jobs";
  if (seg === "bizzy-docs") return "docs";
  if (seg === "companion") return "companion";
  if (seg === "settings") return "settings";
  return "bizzy";
}

const CHROME_MODULES = new Set(["bizzy", "jobs", "calendar", "activity", "docs", "companion", "settings"]);
/* -------------------------------------------------- */

export default function BizzyChatBar({
  variant = "contained",
  placeholder,
  className = "",
  forceVisible = false,
  tone = "auto",
  shellClassName = "",
  quickPromptMode = "normal",
}) {
  const location = useLocation();
  const pathname = location?.pathname || "";
  const currentModule = getModuleFromPath(pathname);
  const isChatHome = pathname.startsWith("/dashboard/bizzy") || pathname.startsWith("/chat");

  const { isCanvasOpen, sendMessage, isLoading, startQuickPrompt, openCanvas } =
    useBizzyChatContext();

  const [input, setInput] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [quickPrompts, setQuickPrompts] = useState([]);
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef(null);

  const allowedByRoute = routeAllowsBar(pathname);
  const shouldRender = forceVisible || allowedByRoute;

  // Theme hook (kept)
  useModuleTheme(currentModule);

  const useChromeAccent = CHROME_MODULES.has(currentModule) || isChatHome;
  const brandAccent = useMemo(() => {
    if (useChromeAccent) return CHROME_HEX;
    return accentHexMap[currentModule] || "#A855F7";
  }, [useChromeAccent, currentModule]);

  const neutralFrame = DEFAULT_QP_FRAME;
  const effectiveTone = useMemo(() => {
    if (tone === "neutral" || tone === "brand") return tone;
    // Use the neutral chat-home shell color on dashboards too.
    if (isChatHome || pathname.startsWith("/dashboard/")) return "neutral";
    return "brand";
  }, [tone, isChatHome, pathname]);

  const accentHex  = effectiveTone === "neutral" ? neutralFrame : brandAccent;
  // Always use the ChatHome default chrome border, even on dashboards.
  const borderCol  = DEFAULT_BORDER;
  const glowCol    = isChatHome ? "transparent" : (useChromeAccent ? CHROME_SOFT : DEFAULT_GLOW);

  /** Submit */
  const handleSubmit = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    const text = (input || "").trim();
    if (!text || isLoading) return;
    setInput("");
    inputRef.current?.blur?.();
    openCanvas(currentModule);
    window.dispatchEvent(new Event("bizzy:open-chat"));
    await sendMessage(text, { openCanvas: true, module: currentModule });
    requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent("bizzy:scrollCanvasBottom"))
    );
  };

  /** Quick prompt */
  const handlePromptClick = async (text) => {
    if (!text || isLoading) return;
    if (input) setInput("");
    inputRef.current?.blur?.();
    openCanvas(currentModule);
    const onboardingMatch =
      isOnboardingMode ? identifyOnboardingPrompt(text) : null;
    const context = onboardingMatch ? { onboardingPromptId: onboardingMatch.id } : undefined;
    await startQuickPrompt({
      text,
      intent: "general",
      source: "quick-prompt",
      openFullCanvas: true,
      module: currentModule,
      meta: context ? { context } : {},
    });
  };

  /** Auto-resize */
  useEffect(() => {
    if (!inputRef.current) return;
    const el = inputRef.current;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const isOnboardingMode = quickPromptMode === "onboarding";

  /** Load quick prompts */
  useEffect(() => {
    let alive = true;
    const userId = localStorage.getItem("user_id");
    async function load() {
      try {
        const prompts = await getQuickPromptsForModule(userId, currentModule, { max: 4, ttlHours: 6 });
        if (alive) setQuickPrompts(prompts);
      } catch {
        if (alive) setQuickPrompts([]);
      }
    }
    if (!isOnboardingMode && (allowedByRoute || forceVisible) && userId) load();
    else setTimeout(() => alive && setQuickPrompts([]), 0);
    return () => { alive = false; };
  }, [currentModule, allowedByRoute, forceVisible, isOnboardingMode]);

  if (!shouldRender) return null;

  // Container positioning
  let containerClass = "w-full";
  if (variant === "contained") containerClass = "sticky bottom-3 z-20 w-full";
  else if (variant === "fixed") containerClass = "fixed bottom-0 left-0 w-full z-50";

  // Focus glow removed (keep neutral)
  const focusGlow = "none";
  const focusBg = "none";

  // Unified neutral shell (slightly lighter for contrast, subtle border like Grok)
  const neutralShellBg = "rgba(46,42,40,0.92)";
  const neutralShellBorder = "1px solid rgba(255,255,255,0.08)";

  // Chrome static pages should stay centered/narrow; dashboards with Canvas open should not.
  const isChromeStaticPage =
    currentModule === "docs" || currentModule === "companion" || currentModule === "settings";

  // Keep chat-home wide, but cap the bar on dashboards for better balance.
  const widthWrapperStyle = (() => {
    // When the canvas is open (ChatHome or dashboard), match the capped dashboard width.
    if (isCanvasOpen) return { maxWidth: "780px", width: "86vw", margin: "0 auto" };
    if (isChromeStaticPage) return { maxWidth: "900px", width: "88vw", margin: "0 auto" };
    if (!isChatHome) return { maxWidth: "780px", width: "86vw", margin: "0 auto" };
    return undefined;
  })();

  const quickPromptAccent = null; // keep quick prompts on the neutral chrome scheme everywhere
  const quickPromptFrame = DEFAULT_QP_FRAME;

  return (
    <div className={[containerClass, className].join(" ")}>
      <div className="w-full">
        <div className="w-full px-3 py-0 transition-all bg-transparent shadow-none border-0">
          {/* Quick Prompts */}
          <div
            className="pt-2 pb-0 bizzy-qprompts"
            style={{
              ...widthWrapperStyle,
              "--qp-accent": accentHex,
              "--qp-frame": quickPromptFrame,
            }}
          >
            <AskBizzyGuidedPrompts
              module={currentModule}
              prompts={
                isOnboardingMode
                  ? ONBOARDING_PROMPTS
                  : quickPrompts?.length
                    ? quickPrompts
                    : NORMAL_PROMPTS
              }
              onPromptClick={handlePromptClick}
              max={isOnboardingMode ? ONBOARDING_PROMPTS.length : undefined}
              accentColor={quickPromptAccent}
            />
          </div>

          {/* Input bar */}
          <div style={widthWrapperStyle}>
            <form onSubmit={handleSubmit} className="mt-1">
              <div
                className={[
                  "flex items-center w-full transition rounded-2xl px-4 py-2",
                  effectiveTone === "neutral" ? "rounded-full" : "rounded-2xl",
                  shellClassName,
                ].join(" ")}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                style={{
                  border: effectiveTone === "neutral" ? neutralShellBorder : `1px solid ${borderCol}`,
                  boxShadow: focusGlow,
                  backgroundImage: focusBg,
                  backgroundColor:
                    effectiveTone === "neutral"
                      ? neutralShellBg
                      : "rgba(18,16,15,0.88)",
                }}
              >
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmit(e);
                    }
                  }}
                  placeholder={placeholder || "Ask Bizzi anything about cash flow, marketing, or taxes..."}
                  rows={1}
                  className={[
                    "flex-1 resize-none px-0 py-2.5 bg-transparent text-white focus:outline-none",
                    "scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-transparent",
                    effectiveTone === "neutral" ? "py-1.5" : "",
                  ].join(" ")}
                  style={{
                    minHeight: effectiveTone === "neutral" ? "40px" : "44px",
                    maxHeight: "160px",
                  }}
                />

                {/* Mic toggle */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setIsRecording((p) => !p)}
                  onKeyDown={(e) => e.key === "Enter" && setIsRecording((p) => !p)}
                  className={[
                    "ml-3 h-9 w-9 rounded-full flex items-center justify-center select-none",
                    effectiveTone === "neutral"
                      ? "bg-transparent text-white/90 border border-white/20"
                      : "bg-zinc-900/95 text-[var(--accent)] border",
                  ].join(" ")}
                  style={{ borderColor: borderCol }}
                  aria-label="Toggle voice"
                  title="Toggle voice"
                >
                  <BizzyVoiceIcon
                    isRecording={isRecording}
                    onToggle={() => setIsRecording((p) => !p)}
                    setInput={setInput}
                  />
                </div>

                {/* Submit (force-remove purple halo) */}
<div className="ml-2 no-purple-glow">
  <BizzySubmitButton onClick={handleSubmit} isLoading={!!isLoading} />
</div>
              </div>
            </form>
          </div>
        </div>
      </div>

      {/* Hard override: kill any ring/glow the submit button might add */}
      <style>{`
  /* Nuke any ring/shadow/after glow the submit button might add */
  .no-purple-glow button,
  .no-purple-glow button:focus,
  .no-purple-glow button:focus-visible,
  .no-purple-glow button:hover,
  .no-purple-glow button:active {
    outline: none !important;
    box-shadow: none !important;
    filter: none !important;
    background-image: none !important;
    /* Tailwind ring variables */
    --tw-ring-offset-shadow: 0 0 #0000 !important;
    --tw-ring-shadow: 0 0 #0000 !important;
    --tw-shadow: 0 0 #0000 !important;
  }
  .no-purple-glow button::before,
  .no-purple-glow button::after {
    content: none !important;
    box-shadow: none !important;
    filter: none !important;
    background-image: none !important;
  }
  /* If the icon itself has a drop-shadow */
  .no-purple-glow button svg {
    filter: none !important;
  }
`}</style>

    </div>
  );
}

/* ------------ small utils ------------- */
function AskBizzyGuidedPrompts(props) {
  return <AskBizzyQuickPrompts {...props} />;
}
