// File: /src/components/Bizzy/BizzyChatBar.jsx
import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { useBizzyChatContext } from "../../context/BizzyChatContext";
import AskBizzyQuickPrompts from "./AskBizzyQuickPrompts";
import useModuleTheme from "../../hooks/useModuleTheme";
import BizzyVoiceIcon from "./BizzyVoiceIcon";
import BizzySubmitButton from "./BizzySubmitButton";
import { getQuickPromptsForModule } from "../../services/prompts/quickPromptService";
import { NORMAL_PROMPTS, ONBOARDING_PROMPTS } from "../../config/chatQuickPrompts";
import { identifyOnboardingPrompt } from "../../config/onboardingPromptBank";
import { CHAT_BAR_MAX_W, CHAT_BAR_VW } from "../../config/chatLayout";
import { ACCENT_HEX } from "../../config/accent";
import { apiUrl, safeFetch } from "../../utils/safeFetch";

/* -------------------------------------------------- */
const accentHexMap = {
  bizzy: ACCENT_HEX,
  accounting: ACCENT_HEX,
  marketing: ACCENT_HEX,
  tax: ACCENT_HEX,
  investments: ACCENT_HEX,
  email: ACCENT_HEX,
};

const CHROME_HEX  = ACCENT_HEX;
const DEFAULT_BORDER   = hexToRgba(CHROME_HEX, 0.18);
const DEFAULT_QP_FRAME = hexToRgba(CHROME_HEX, 0.16);

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
  if (seg === "bizzi-docs") return "docs";
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
  flushColumnPadding = false,
}) {
  const location = useLocation();
  const pathname = location?.pathname || "";
  const currentModule = getModuleFromPath(pathname);
  const isChatHome = pathname.startsWith("/dashboard/bizzi/chat") || pathname.startsWith("/chat");

  const { isCanvasOpen, sendMessage, isLoading, startQuickPrompt, openCanvas } =
    useBizzyChatContext();

  const [input, setInput] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [quickPrompts, setQuickPrompts] = useState([]);
  const [isFocused, setIsFocused] = useState(false);
  const [chatGateNotice, setChatGateNotice] = useState(null);
  const inputRef = useRef(null);

  const allowedByRoute = routeAllowsBar(pathname);
  const shouldRender = forceVisible || allowedByRoute;

  // Theme hook (kept)
  useModuleTheme(currentModule);

  const useChromeAccent = CHROME_MODULES.has(currentModule) || isChatHome;
  const brandAccent = useMemo(() => {
    if (useChromeAccent) return CHROME_HEX;
    return accentHexMap[currentModule] || ACCENT_HEX;
  }, [useChromeAccent, currentModule]);

  const neutralFrame = DEFAULT_QP_FRAME;
  const effectiveTone = useMemo(() => {
    if (tone === "neutral" || tone === "brand") return tone;
    // Use the neutral chat-home shell color on dashboards too.
    if (isChatHome || pathname.startsWith("/dashboard/")) return "neutral";
    return "brand";
  }, [tone, isChatHome, pathname]);

  const accentHex  = effectiveTone === "neutral" ? neutralFrame : brandAccent;

  const getBusinessId = useCallback(() => {
    try {
      return localStorage.getItem("currentBusinessId") || localStorage.getItem("business_id") || "";
    } catch {
      return "";
    }
  }, []);

  const checkChatAccess = useCallback(async () => {
    const businessId = getBusinessId();
    if (!businessId) return { allowed: false, message: "Select a business before asking Bizzi a question." };
    const url = new URL(apiUrl("/api/gpt/chat-access"));
    url.searchParams.set("business_id", businessId);
    const access = await safeFetch(url.toString(), {
      headers: { "x-business-id": businessId },
    });
    if (!access?.subscription_active) {
      const used = Number(access?.usage_count || 0);
      const limit = Number(access?.trial_limit || access?.limit || 2);
      const remaining = Math.max(0, Number(access?.remaining ?? (limit - used)));
      setChatGateNotice({
        blocked: !access?.allowed,
        title: access?.allowed ? "Bizzi test questions" : "Subscription required",
        message: access?.allowed
          ? `You have ${remaining} of ${limit} test questions left before a monthly subscription is required.`
          : "You have used both test questions. Start a monthly subscription to keep asking Bizzi questions.",
      });
    } else if (chatGateNotice) {
      setChatGateNotice(null);
    }
    return access;
  }, [chatGateNotice, getBusinessId]);

  /** Submit */
  const handleSubmit = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    const text = (input || "").trim();
    if (!text || isLoading) return;
    let access = null;
    try {
      access = await checkChatAccess();
    } catch (err) {
      setChatGateNotice({
        blocked: true,
        title: "Could not verify access",
        message: err?.message || "Bizzi could not verify your subscription status. Try again in a moment.",
      });
      return;
    }
    if (!access?.allowed) return;
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
    let access = null;
    try {
      access = await checkChatAccess();
    } catch (err) {
      setChatGateNotice({
        blocked: true,
        title: "Could not verify access",
        message: err?.message || "Bizzi could not verify your subscription status. Try again in a moment.",
      });
      return;
    }
    if (!access?.allowed) return;
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

  useEffect(() => {
    if (!isChatHome || !shouldRender || isCanvasOpen) return;
    const el = inputRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => el.focus());
    return () => cancelAnimationFrame(raf);
  }, [isChatHome, shouldRender, isCanvasOpen]);

  // Container positioning
  let containerClass = "w-full";
  if (variant === "contained") containerClass = "sticky bottom-3 z-20 w-full";
  else if (variant === "fixed") containerClass = "fixed bottom-0 left-0 w-full z-50";

  // Unified neutral shell (graphite glass, no blue) shared across ChatHome, dashboards, and Canvas
  const neutralShellBg = "linear-gradient(180deg, var(--chatbar-bg), var(--chatbar-bg-2))";
  const neutralShellBorder = "1px solid var(--chatbar-border)";
  const barShadow = "var(--chatbar-shadow)";

  // Shared chat column width (aligns with conversation width)
  const widthWrapperStyle = {
    maxWidth: "var(--chat-col-max)",
    width: "100%",
    paddingLeft: flushColumnPadding ? 0 : "var(--chat-col-pad)",
    paddingRight: flushColumnPadding ? 0 : "var(--chat-col-pad)",
    margin: "0 auto",
    boxSizing: "border-box",
  };

  const quickPromptAccent = null; // keep quick prompts on the neutral chrome scheme everywhere
  const quickPromptFrame = DEFAULT_QP_FRAME;
  const promptContainerClass = isChatHome ? "bizzy-chathome-prompts bizzy-chathome-chips" : "";
  const promptChipClass = isChatHome ? "bizzy-chathome-chip bizzy-chip" : "";
  const lastLogRef = useRef({ mode: null, module: null });

  useEffect(() => {
    if (!import.meta.env?.DEV) return;
    const prev = lastLogRef.current;
    if (prev.mode !== quickPromptMode || prev.module !== currentModule) {
      console.log("[BizzyChatBar] mode:", quickPromptMode, "module:", currentModule);
      lastLogRef.current = { mode: quickPromptMode, module: currentModule };
    }
  }, [quickPromptMode, currentModule]);

  // Prefill chat input (e.g., follow-up suggestions)
  useEffect(() => {
    const handler = (e) => {
      const text = (e?.detail?.text || "").toString();
      const autoSend = !!e?.detail?.autoSend;
      if (!text) return;
      setInput(text);
      if (autoSend && !isLoading) {
        setTimeout(async () => {
          let access = null;
          try {
            access = await checkChatAccess();
          } catch (err) {
            setChatGateNotice({
              blocked: true,
              title: "Could not verify access",
              message: err?.message || "Bizzi could not verify your subscription status. Try again in a moment.",
            });
            return;
          }
          if (!access?.allowed) return;
          openCanvas(currentModule);
          window.dispatchEvent(new Event("bizzy:open-chat"));
          setInput("");
          sendMessage(text, { openCanvas: true, module: currentModule });
        }, 0);
      }
    };
    window.addEventListener("bizzy:prefill-chat", handler);
    return () => window.removeEventListener("bizzy:prefill-chat", handler);
  }, [currentModule, isLoading, sendMessage, openCanvas, checkChatAccess]);

  if (!shouldRender) return null;

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
            data-bizzy-chatbar-measured
          >
            <AskBizzyGuidedPrompts
              module={currentModule}
              prompts={
                isOnboardingMode
                  ? ONBOARDING_PROMPTS
                  : quickPrompts?.length
                    ? quickPrompts
                    : undefined
              }
              onPromptClick={handlePromptClick}
              max={isOnboardingMode ? ONBOARDING_PROMPTS.length : undefined}
              accentColor={quickPromptAccent}
              className={promptContainerClass}
              chipClassName={promptChipClass}
            />
          </div>
          {/* Input bar */}
          <div
            style={widthWrapperStyle}
            data-bizzy-chatbar-shell
            data-bizzy-chatbar-measured
          >
            {chatGateNotice ? (
              <div
                className="mb-2 flex items-start justify-between gap-3 rounded-lg border border-amber-300/24 bg-[#14120b]/95 px-3 py-2 text-sm text-amber-50 shadow-[0_12px_30px_rgba(0,0,0,0.28)]"
                role="status"
              >
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-amber-100/80">
                    {chatGateNotice.title}
                  </div>
                  <div className="mt-0.5 text-[13px] leading-snug text-amber-50/86">
                    {chatGateNotice.message}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="Close subscription notice"
                  onClick={() => setChatGateNotice(null)}
                  className="shrink-0 rounded-full border border-amber-100/18 bg-white/[0.04] px-2 py-0.5 text-sm font-semibold text-amber-50/80 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-amber-200/35"
                >
                  X
                </button>
              </div>
            ) : null}
            <form onSubmit={handleSubmit} className="mt-1">
              <div
                data-bizzy-chatbar-form
            className={[
              "bizzy-chatbar",
              "flex items-center w-full transition rounded-2xl px-4 py-2",
              effectiveTone === "neutral" ? "rounded-full" : "rounded-2xl",
              shellClassName,
            ].join(" ")}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                style={{
                  border: neutralShellBorder,
                  // Keep focus state flat—no outer glow when the bar is active
                  boxShadow: isFocused ? barShadow : barShadow,
                  backgroundImage: neutralShellBg,
                  backgroundColor: "var(--chatbar-bg)",
                }}
              >
                <div className="bizzy-chatbar-sheen" aria-hidden="true" />
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
                  placeholder={placeholder || "Talk to Bizzi about your books, cash flow, jobs, or taxes…"}
                  rows={1}
                  className={[
                  "flex-1 resize-none px-0 py-2 bg-transparent text-white focus:outline-none placeholder:text-white/50",
                  "scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-transparent",
                  effectiveTone === "neutral" ? "py-1.25" : "",
                ].join(" ")}
                style={{
                  minHeight: effectiveTone === "neutral" ? "36px" : "40px",
                  maxHeight: "150px",
                  color: "var(--text)",
                  caretColor: "var(--text)",
                  fontFamily: "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial",
                  fontSize: "15px",
                }}
                />

                {/* Mic toggle */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setIsRecording((p) => !p)}
                  onKeyDown={(e) => e.key === "Enter" && setIsRecording((p) => !p)}
                className={[
                  "ml-3 h-8.5 w-8.5 rounded-full flex items-center justify-center select-none transition-colors",
                  effectiveTone === "neutral"
                    ? "bg-transparent text-white/90 border border-white/20 hover:text-[var(--accent-contrast)] hover:border-[var(--accent-line)]"
                    : "bg-[#0f141b] text-[var(--accent)] border",
                ].join(" ")}
                  style={{ boxShadow: "none" }}
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
