import React, { useEffect, useId, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import BizzySubmitButton from "./BizzySubmitButton";
import AskBizzyQuickPrompts from "./AskBizzyQuickPrompts";

const DEFAULT_PLACEHOLDER = "Talk to Bizzi about your books, cash flow, jobs, or taxes…";

export default function BizzyChatComposer({
  input,
  setInput,
  onSubmit,
  placeholder = DEFAULT_PLACEHOLDER,
  disabled = false,
  readOnly = false,
  isLoading = false,
  inputId = "bizzy-chat-input",
  shellClassName = "",
  autoFocus = false,
  quickPrompts,
  quickPromptModule = "general",
  quickPromptMax,
  quickPromptClassName = "",
  quickPromptChipClassName = "",
  quickPromptAccentColor = null,
  quickPromptStyle,
  onQuickPromptClick,
}) {
  const inputRef = useRef(null);
  const promptPanelId = `bizzy-quick-prompts-${useId().replace(/:/g, "")}`;
  const [quickPromptsOpen, setQuickPromptsOpen] = useState(false);
  const trimmed = String(input || "").trim();
  const unavailable = disabled || readOnly;

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [input]);

  useEffect(() => {
    if (!autoFocus || unavailable) return;
    const raf = requestAnimationFrame(() => inputRef.current?.focus?.());
    return () => cancelAnimationFrame(raf);
  }, [autoFocus, unavailable]);

  const handleSubmit = (event) => {
    event?.preventDefault?.();
    if (unavailable || isLoading || !trimmed) return;
    onSubmit?.(event);
  };

  const handlePromptClick = async (text) => {
    setQuickPromptsOpen(false);
    try {
      await onQuickPromptClick?.(text);
    } finally {
      requestAnimationFrame(() => inputRef.current?.focus?.());
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-1 bizzy-chat-composer-group"
      data-bizzy-composer-variant={shellClassName.includes("chathome") ? "centered" : "docked"}
      style={quickPromptStyle}
    >
      <div
        id={promptPanelId}
        className={`bizzy-quick-prompts-panel ${quickPromptsOpen ? "is-open" : ""}`}
        aria-hidden={!quickPromptsOpen}
        inert={!quickPromptsOpen}
        data-bizzy-quick-prompts
        data-state={quickPromptsOpen ? "open" : "closed"}
      >
        <div className="bizzy-quick-prompts-panel__inner bizzy-qprompts">
          <AskBizzyQuickPrompts
            module={quickPromptModule}
            prompts={quickPrompts}
            onPromptClick={handlePromptClick}
            max={quickPromptMax}
            accentColor={quickPromptAccentColor}
            className={quickPromptClassName}
            chipClassName={quickPromptChipClassName}
          />
        </div>
      </div>
      <div
        data-bizzy-chatbar-form
        data-bizzy-chatbar-pill
        className={["bizzy-chatbar", "bizzy-chat-composer", shellClassName].filter(Boolean).join(" ")}
      >
        <textarea
          ref={inputRef}
          id={inputId}
          name={inputId}
          value={input}
          onChange={(event) => {
            if (unavailable) return;
            setInput?.(event.target.value);
          }}
          onKeyDown={(event) => {
            if (unavailable) {
              if (event.key === "Enter") event.preventDefault();
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              handleSubmit(event);
            }
          }}
          placeholder={unavailable ? "Chat is unavailable in read-only Admin View." : placeholder}
          disabled={disabled}
          readOnly={readOnly}
          aria-disabled={unavailable ? "true" : undefined}
          rows={1}
          className="bizzy-chat-composer__input scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-transparent"
        />

        <div className="bizzy-chat-composer__actions">
          <button
            type="button"
            onClick={() => setQuickPromptsOpen((open) => !open)}
            disabled={unavailable}
            className={`bizzy-chat-composer__control bizzy-chat-composer__quick-prompts ${quickPromptsOpen ? "is-open" : ""}`}
            title="Quick prompts"
            aria-label={quickPromptsOpen ? "Hide quick prompts" : "Show quick prompts"}
            aria-expanded={quickPromptsOpen}
            aria-controls={promptPanelId}
          >
            <Sparkles size={19} aria-hidden="true" />
          </button>
          <BizzySubmitButton
            onClick={handleSubmit}
            isLoading={!!isLoading}
            disabled={unavailable || !trimmed}
            active={Boolean(trimmed) && !unavailable}
            size={42}
            className="bizzy-chat-composer__send"
          />
        </div>
      </div>
    </form>
  );
}
