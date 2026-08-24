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
    chatReadOnly,
    dismissChatGateNotice,
  } = useBizzyChatContext();

  const [input, setInput] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const inputRef = useRef(null);

  const handleSubmit = async (e) => {
    e?.preventDefault();
    if (chatReadOnly) return;
    const text = (input || "").trim();
    if (!text || isLoading) return;
    const access = await checkChatAccess?.();
    if (!access?.allowed) return;
    setInput("");
    await sendMessage(text, { openCanvas: true, module: currentModule });
  };

  const handlePromptClick = async (text) => {
    if (chatReadOnly) return;
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
      if (chatReadOnly) return;
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
  }, [chatReadOnly, currentModule, isLoading, sendMessage, openCanvas, checkChatAccess]);

  const shellClassName = "bg-transparent text-white";
  const neutralShellBg = "linear-gradient(180deg, var(--chatbar-bg), var(--chatbar-bg-2))";
  const neutralShellBorder = "1px solid var(--chatbar-border)";
  const effectiveTone = "neutral";

  return (
    <div className="w-full pointer-events-auto">
      {!chatReadOnly ? (
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
      ) : null}
      {/* Input bar */}
      <div data-bizzy-chatbar-shell data-bizzy-chatbar-measured>
        {chatReadOnly ? (
          <div className="mb-2 rounded-full border border-emerald-200/18 bg-emerald-300/[0.08] px-4 py-2 text-xs font-semibold text-emerald-50/82">
            Chat is unavailable in read-only Admin View.
          </div>
        ) : chatGateNotice ? (
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
                fontFamily: "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial",
                fontSize: "15px",
              }}
            />

            {/* Mic toggle */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => {
                if (chatReadOnly) return;
                setIsRecording((p) => !p);
              }}
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
              aria-label="Toggle voice"
              title={chatReadOnly ? "Voice input is unavailable in read-only Admin View." : "Toggle voice"}
              aria-disabled={chatReadOnly ? "true" : undefined}
            >
              <BizzyVoiceIcon
                isRecording={chatReadOnly ? false : isRecording}
                onToggle={chatReadOnly ? () => {} : () => setIsRecording((p) => !p)}
                setInput={chatReadOnly ? () => {} : setInput}
              />
            </div>

            {/* Submit */}
            <div className="ml-2 no-purple-glow">
              <BizzySubmitButton onClick={chatReadOnly ? undefined : handleSubmit} isLoading={!!isLoading} disabled={chatReadOnly} />
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
