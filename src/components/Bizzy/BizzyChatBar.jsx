// File: /src/components/Bizzy/BizzyChatBar.jsx
import React, { useState, useRef, useEffect, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useBizzyChatContext } from "../../context/BizzyChatContext";
import AskBizzyQuickPrompts from "./AskBizzyQuickPrompts";
import useModuleTheme from "../../hooks/useModuleTheme";
import BizzyVoiceIcon from "./BizzyVoiceIcon";
import BizzySubmitButton from "./BizzySubmitButton";
import ChatGateNotice from "./ChatGateNotice";
import { getQuickPromptsForModule } from "../../services/prompts/quickPromptService";
import { NORMAL_PROMPTS, ONBOARDING_PROMPTS } from "../../config/chatQuickPrompts";
import { identifyOnboardingPrompt } from "../../config/onboardingPromptBank";
import { CHAT_BAR_MAX_W, CHAT_BAR_VW } from "../../config/chatLayout";
import { ACCENT_HEX } from "../../config/accent";

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

  const {
    isCanvasOpen,
    sendMessage,
    isLoading,
    startQuickPrompt,
    openCanvas,
    checkChatAccess,
    chatGateNotice,
    chatReadOnly,
    dismissChatGateNotice,
  } =
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

  /** Submit */
  const handleSubmit = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    if (chatReadOnly) return;
    const text = (input || "").trim();
    if (!text || isLoading) return;
    let access = null;
    try {
      access = await checkChatAccess();
    } catch (err) {
      return;
    }
    if (!access?.allowed) return;
    setInput("");
    inputRef.current?.blur?.();
    const shouldStartNewThread = !isCanvasOpen;
    openCanvas(currentModule);
    window.dispatchEvent(new Event("bizzy:open-chat"));
    await sendMessage(text, {
      openCanvas: true,
      module: currentModule,
      newThread: shouldStartNewThread,
    });
    requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent("bizzy:scrollCanvasBottom"))
    );
  };

  /** Quick prompt */
  const handlePromptClick = async (text) => {
    if (chatReadOnly) return;
    if (!text || isLoading) return;
    let access = null;
    try {
      access = await checkChatAccess();
    } catch (err) {
      return;
    }
    if (!access?.allowed) return;
    if (input) setInput("");
    inputRef.current?.blur?.();
    openCanvas(currentModule);
    const onboardingMatch =
      isOnboardingMode ? identifyOnboardingPrompt(text) : null;
    const context = onboardingMatch ? { onboardingPromptId: onboardingMatch.id } : undefined;
    const shouldStartNewThread = !isCanvasOpen;
    await startQuickPrompt({
      text,
      intent: "general",
      source: "quick-prompt",
      openFullCanvas: true,
      module: currentModule,
      newThread: shouldStartNewThread,
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

  // Prefill chat input (e.g., follow-up suggestions)
  useEffect(() => {
    const handler = (e) => {
      const text = (e?.detail?.text || "").toString();
      const autoSend = !!e?.detail?.autoSend;
      if (!text) return;
      if (chatReadOnly) return;
      setInput(text);
      if (autoSend && !isLoading) {
        setTimeout(async () => {
          let access = null;
          try {
            access = await checkChatAccess();
          } catch (err) {
            return;
          }
          if (!access?.allowed) return;
          const shouldStartNewThread = !isCanvasOpen;
          openCanvas(currentModule);
          window.dispatchEvent(new Event("bizzy:open-chat"));
          setInput("");
          sendMessage(text, {
            openCanvas: true,
            module: currentModule,
            newThread: shouldStartNewThread,
          });
        }, 0);
      }
    };
    window.addEventListener("bizzy:prefill-chat", handler);
    return () => window.removeEventListener("bizzy:prefill-chat", handler);
  }, [chatReadOnly, currentModule, isCanvasOpen, isLoading, sendMessage, openCanvas, checkChatAccess]);

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
              disabled={chatReadOnly}
              disabledReason="Chat is unavailable in read-only Admin View."
            />
          </div>
          {/* Input bar */}
          <div
            style={widthWrapperStyle}
            data-bizzy-chatbar-shell
            data-bizzy-chatbar-measured
          >
            {chatReadOnly ? (
              <div className="mb-2 rounded-full border border-emerald-200/18 bg-emerald-300/[0.08] px-4 py-2 text-xs font-semibold text-emerald-50/82">
                Chat is unavailable in read-only Admin View.
              </div>
            ) : chatGateNotice ? (
              <ChatGateNotice notice={chatGateNotice} onDismiss={dismissChatGateNotice} className="mb-2" />
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
                  id="bizzy-chat-input"
                  name="bizzy-chat-input"
                  value={input}
                  onChange={(e) => {
                    if (chatReadOnly) return;
                    setInput(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (chatReadOnly) {
                      if (e.key === "Enter") e.preventDefault();
                      return;
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmit(e);
                    }
                  }}
                  placeholder={chatReadOnly ? "Chat is unavailable in read-only Admin View." : placeholder || "Talk to Bizzi about your books, cash flow, jobs, or taxes…"}
                  disabled={chatReadOnly}
                  readOnly={chatReadOnly}
                  aria-disabled={chatReadOnly ? "true" : undefined}
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
                  onKeyDown={(e) => {
                    if (chatReadOnly) return;
                    if (e.key === "Enter") setIsRecording((p) => !p);
                  }}
                className={[
                  "ml-3 h-8.5 w-8.5 rounded-full flex items-center justify-center select-none transition-colors",
                  effectiveTone === "neutral"
                    ? "bg-transparent text-white/90 border border-white/20 hover:text-[var(--accent-contrast)] hover:border-[var(--accent-line)]"
                    : "bg-[#0f141b] text-[var(--accent)] border",
                ].join(" ")}
                  style={{ boxShadow: "none" }}
                  aria-label="Toggle voice"
                  title={chatReadOnly ? "Voice input is unavailable in read-only Admin View." : "Toggle voice"}
                  aria-disabled={chatReadOnly ? "true" : undefined}
                >
                  {chatReadOnly ? (
                    <BizzyVoiceIcon isRecording={false} onToggle={() => {}} setInput={() => {}} />
                  ) : (
                    <BizzyVoiceIcon
                      isRecording={isRecording}
                      onToggle={() => setIsRecording((p) => !p)}
                      setInput={setInput}
                    />
                  )}
                </div>

                {/* Submit (force-remove purple halo) */}
<div className="ml-2 no-purple-glow">
  <BizzySubmitButton onClick={chatReadOnly ? undefined : handleSubmit} isLoading={!!isLoading} disabled={chatReadOnly} />
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
