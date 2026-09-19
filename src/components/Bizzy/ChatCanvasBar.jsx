import React, { useEffect, useState } from "react";
import BizzyChatComposer from "./BizzyChatComposer";
import AskBizzyQuickPrompts from "./AskBizzyQuickPrompts";
import ChatGateNotice from "./ChatGateNotice";
import { useBizzyChatContext } from "../../context/BizzyChatContext";
import { ONBOARDING_PROMPTS } from "../../config/chatQuickPrompts";

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
        <BizzyChatComposer
          input={input}
          setInput={setInput}
          onSubmit={handleSubmit}
          placeholder={placeholder || "Talk to Bizzi about your books, cash flow, jobs, or taxes…"}
          disabled={chatReadOnly}
          readOnly={chatReadOnly}
          isLoading={!!isLoading}
          inputId="bizzy-canvas-chat-input"
        />
      </div>
    </div>
  );
}

function AskBizzyGuidedPrompts(props) {
  return <AskBizzyQuickPrompts {...props} />;
}
