// File: /src/components/Bizzy/BizzyChatBar.jsx
import React, { useState, useEffect, useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useBizzyChatContext } from "../../context/BizzyChatContext";
import AskBizzyQuickPrompts from "./AskBizzyQuickPrompts";
import useModuleTheme from "../../hooks/useModuleTheme";
import BizzyChatComposer from "./BizzyChatComposer";
import ChatGateNotice from "./ChatGateNotice";
import { getQuickPromptsForModule } from "../../services/prompts/quickPromptService";
import { ONBOARDING_PROMPTS } from "../../config/chatQuickPrompts";
import { identifyOnboardingPrompt } from "../../config/onboardingPromptBank";
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
  const [quickPrompts, setQuickPrompts] = useState([]);

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
    } catch {
      return;
    }
    if (!access?.allowed) return;
    setInput("");
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
    } catch {
      return;
    }
    if (!access?.allowed) return;
    if (input) setInput("");
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

  // Container positioning
  let containerClass = "w-full";
  if (variant === "contained") containerClass = "sticky bottom-3 z-20 w-full";
  else if (variant === "fixed") containerClass = "fixed bottom-0 left-0 w-full z-50";

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
          } catch {
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
          {!chatReadOnly ? (
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
          ) : null}
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
            <BizzyChatComposer
              input={input}
              setInput={setInput}
              onSubmit={handleSubmit}
              placeholder={placeholder || "Talk to Bizzi about your books, cash flow, jobs, or taxes…"}
              disabled={chatReadOnly}
              readOnly={chatReadOnly}
              isLoading={!!isLoading}
              inputId="bizzy-chat-input"
              shellClassName={shellClassName}
              autoFocus={false}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------ small utils ------------- */
function AskBizzyGuidedPrompts(props) {
  return <AskBizzyQuickPrompts {...props} />;
}
