import React, { useEffect, useRef, useState } from "react";
import BizzyVoiceIcon from "./BizzyVoiceIcon";
import BizzySubmitButton from "./BizzySubmitButton";
import AskBizzyQuickPrompts from "./AskBizzyQuickPrompts";
import ChatGateNotice from "./ChatGateNotice";
import { useBizzyChatContext } from "../../context/BizzyChatContext";
import { ONBOARDING_PROMPTS } from "../../config/chatQuickPrompts";
import { CANVAS_COL_MAX, CANVAS_COL_PAD } from "../../config/chatCanvasLayout";

export default function ChatCanvasBar({
  isOnboardingMode = false,
  placeholder,
}) {
  const {
    sendMessage,
    isLoading,
    openCanvas,
    currentModule = "bizzy",
    quickPrompts = [],
    checkChatAccess,
    chatGateNotice,
    dismissChatGateNotice,
  } = useBizzyChatContext();

  const [input, setInput] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const inputRef = useRef(null);

  const handleSubmit = async (e) => {
    e?.preventDefault();
    const text = (input || "").trim();
    if (!text || isLoading) return;
    const access = await checkChatAccess?.();
    if (!access?.allowed) return;
    setInput("");
    await sendMessage(text, { openCanvas: true, module: currentModule });
  };

  const handlePromptClick = async (text) => {
    if (!text || isLoading) return;
    const access = await checkChatAccess?.();
    if (!access?.allowed) return;
    setInput("");
    await sendMessage(text, { openCanvas: true, module: currentModule });
  };

  // Prefill chat input (e.g., follow-up suggestions)
  useEffect(() => {
    const handler = (event) => {
      const text = (event?.detail?.text || "").toString();
      const autoSend = !!event?.detail?.autoSend;
      if (!text) return;
      setInput(text);
      if (autoSend && !isLoading) {
        setTimeout(async () => {
          const access = await checkChatAccess?.();
          if (!access?.allowed) return;
          openCanvas(currentModule);
          window.dispatchEvent(new Event("bizzy:open-chat"));
          setInput("");
          await sendMessage(text, { openCanvas: true, module: currentModule });
        }, 0);
      }
    };
    window.addEventListener("bizzy:prefill-chat", handler);
    return () => window.removeEventListener("bizzy:prefill-chat", handler);
  }, [currentModule, isLoading, sendMessage, openCanvas, checkChatAccess]);

  const shellClassName = "bg-transparent text-white";
  const neutralShellBg = "linear-gradient(180deg, var(--chatbar-bg), var(--chatbar-bg-2))";
  const neutralShellBorder = "1px solid var(--chatbar-border)";
  const effectiveTone = "neutral";

  return (
    <div className="w-full pointer-events-auto">
      {/* Quick Prompts */}
      <div className="pt-2 pb-0 bizzy-qprompts">
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
          className="px-0"
        />
      </div>
      {/* Input bar */}
      <div data-bizzy-chatbar-shell data-bizzy-chatbar-measured>
        {chatGateNotice ? (
          <ChatGateNotice
            notice={chatGateNotice}
            onDismiss={dismissChatGateNotice}
            className="mb-2"
          />
        ) : null}
        <form onSubmit={handleSubmit} className="mt-1">
          <div
            data-bizzy-chatbar-form
            data-bizzy-chatbar-pill
            className={[
              "flex items-center w-full transition rounded-2xl px-4 py-2",
              effectiveTone === "neutral" ? "rounded-full" : "rounded-2xl",
              shellClassName,
            ].join(" ")}
            onFocus={() => inputRef.current?.focus()}
            style={{
              border: neutralShellBorder,
              boxShadow: "var(--chatbar-shadow)",
              backgroundImage: neutralShellBg,
              backgroundColor: "var(--chatbar-bg)",
            }}
          >
            <textarea
              ref={inputRef}
              id="bizzy-canvas-chat-input"
              name="bizzy-canvas-chat-input"
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
              aria-label="Toggle voice"
              title="Toggle voice"
            >
              <BizzyVoiceIcon
                isRecording={isRecording}
                onToggle={() => setIsRecording((p) => !p)}
                setInput={setInput}
              />
            </div>

            {/* Submit */}
            <div className="ml-2 no-purple-glow">
              <BizzySubmitButton onClick={handleSubmit} isLoading={!!isLoading} />
            </div>
          </div>
        </form>
      </div>
      <style>{`
      .no-purple-glow button,
      .no-purple-glow button:focus,
      .no-purple-glow button:focus-visible,
      .no-purple-glow button:hover,
      .no-purple-glow button:active {
        outline: none !important;
        box-shadow: none !important;
        filter: none !important;
        background-image: none !important;
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
      .no-purple-glow button svg {
        filter: none !important;
      }
    `}</style>
    </div>
  );
}

function AskBizzyGuidedPrompts(props) {
  return <AskBizzyQuickPrompts {...props} />;
}
