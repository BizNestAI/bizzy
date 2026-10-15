import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getBusinessQuickPrompts } from "../../config/businessQuickPrompts.js";

function textOf(item) { return typeof item === "string" ? item : item?.text; }

export default function AskBizzyQuickPrompts({
  module = "general", prompts, onPromptClick, max, className = "", chipClassName = "",
  accentColor = null, disabled = false, disabledReason = "Chat is unavailable in read-only Admin View.",
  availability = {}, settingsHref = "/dashboard/settings?tab=Integrations&focus=financial-reporting",
}) {
  const list = (Array.isArray(prompts) && prompts.length ? prompts : getBusinessQuickPrompts(module));
  const visible = Number.isFinite(max) ? list.slice(0, max) : list;
  const rowRef = useRef(null);
  const descriptionId = `bizzy-prompt-description-${useId().replace(/:/g, "")}`;
  const [overflow, setOverflow] = useState({ previous: false, next: false });
  const [hoverIdx, setHoverIdx] = useState(null);

  const syncOverflow = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    setOverflow({ previous: row.scrollLeft > 2, next: row.scrollLeft + row.clientWidth < row.scrollWidth - 2 });
  }, []);

  useEffect(() => {
    syncOverflow();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(syncOverflow) : null;
    if (rowRef.current) observer?.observe(rowRef.current);
    window.addEventListener("resize", syncOverflow);
    return () => { observer?.disconnect(); window.removeEventListener("resize", syncOverflow); };
  }, [syncOverflow, visible.length]);

  const scroll = (direction) => rowRef.current?.scrollBy({ left: direction * Math.max(220, rowRef.current.clientWidth * 0.7), behavior: "smooth" });
  const isChatHomeRow = className.includes("bizzy-chathome");

  return (
    <div className={`relative w-full px-2 py-0 ${className}`}>
      <span id={descriptionId} className="sr-only">Choose a verified business question. Disabled questions explain the required setup.</span>
      {overflow.previous ? <button type="button" onClick={() => scroll(-1)} aria-label="Previous quick prompts" className="absolute left-0 top-1/2 z-20 -translate-y-1/2 rounded-full border border-white/15 bg-black/85 p-1 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300"><ChevronLeft size={16} /></button> : null}
      {overflow.next ? <button type="button" onClick={() => scroll(1)} aria-label="Next quick prompts" className="absolute right-0 top-1/2 z-20 -translate-y-1/2 rounded-full border border-white/15 bg-black/85 p-1 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300"><ChevronRight size={16} /></button> : null}
      {overflow.previous ? <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 z-10 w-12 bg-gradient-to-r from-black to-transparent" /> : null}
      {overflow.next ? <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l from-black to-transparent" /> : null}
      <div ref={rowRef} tabIndex={0} role="region" aria-label="Business quick prompts" aria-describedby={descriptionId}
        onScroll={syncOverflow}
        onKeyDown={(event) => { if (event.key === "ArrowLeft") { event.preventDefault(); scroll(-1); } if (event.key === "ArrowRight") { event.preventDefault(); scroll(1); } }}
        className={`flex gap-2 overflow-x-auto no-scrollbar snap-x snap-mandatory pb-1 items-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 ${isChatHomeRow ? "bizzy-chathome-chiprow" : ""}`}
        data-bizzy-chip-row={isChatHomeRow ? true : undefined}>
        {visible.map((item, idx) => {
          const text = textOf(item);
          const intent = typeof item === "object" ? item.intent : null;
          const itemAvailability = intent ? availability[intent] : null;
          const itemDisabled = disabled || itemAvailability?.available === false;
          const reason = disabled ? disabledReason : itemAvailability?.message || "Finish Financial reporting setup in Settings to use this question.";
          const reasonId = `${descriptionId}-${idx}`;
          const active = hoverIdx === idx;
          return <div key={`${intent || module}-${text}`} className="flex shrink-0 items-center gap-1">
            <button type="button" disabled={itemDisabled} aria-disabled={itemDisabled || undefined} aria-describedby={`${descriptionId} ${itemDisabled ? reasonId : ""}`.trim()}
              onClick={() => !itemDisabled && onPromptClick?.(typeof item === "string" ? { text } : item)}
              onMouseEnter={() => setHoverIdx(idx)} onMouseLeave={() => setHoverIdx(null)}
              className={`bizzy-quickprompt bizzy-chip inline-flex snap-start whitespace-nowrap rounded-full border px-3 py-1 text-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 ${itemDisabled ? "cursor-not-allowed opacity-45" : ""} ${chipClassName}`}
              style={{ color: active ? (accentColor || "#f5f6f7") : "rgba(255,255,255,0.9)", borderColor: active ? "var(--accent-line)" : "var(--surface-border)", background: active ? "var(--surface-graphite-2)" : "var(--surface-graphite)" }}>
              {text}
            </button>
            {itemDisabled ? <span id={reasonId} className="sr-only">{reason} {itemAvailability?.canConfigure ? `Open ${settingsHref}.` : ""}</span> : null}
          </div>;
        })}
      </div>
      {visible.some((item) => availability[typeof item === "object" ? item.intent : ""]?.available === false && availability[typeof item === "object" ? item.intent : ""]?.canConfigure) ? (
        <a href={settingsHref} className="mt-1 inline-flex text-xs font-semibold text-emerald-300 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Finish Financial reporting setup in Settings</a>
      ) : null}
    </div>
  );
}
