import React, { useEffect, useRef } from "react";
import BizzySubmitButton from "./BizzySubmitButton";
import BizzyVoiceIcon from "./BizzyVoiceIcon";

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
}) {
  const inputRef = useRef(null);
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

  return (
    <form onSubmit={handleSubmit} className="mt-1">
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
          <BizzyVoiceIcon
            setInput={unavailable ? () => {} : setInput}
            disabled={unavailable}
            className="bizzy-chat-composer__control"
            title={unavailable ? "Voice input is unavailable in read-only Admin View." : "Toggle voice"}
          />
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
