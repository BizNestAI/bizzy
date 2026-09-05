import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export default function TaxProfileSelectField({ label, value, options, onChange, helper = "", id = null, required = false }) {
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const generatedId = useId();
  const selectId = id || `tax-profile-${generatedId}`;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuStyle, setMenuStyle] = useState(null);
  const typeaheadRef = useRef("");
  const typeaheadTimerRef = useRef(null);

  const normalizedOptions = useMemo(
    () => (options || []).map((option) => ({
      value: option?.value ?? "",
      label: String(option?.label ?? option?.value ?? "").trim(),
    })),
    [options]
  );
  const selectedIndex = Math.max(0, normalizedOptions.findIndex((option) => String(option.value) === String(value ?? "")));
  const selectedOption = normalizedOptions[selectedIndex] || normalizedOptions[0] || { value: "", label: "Select" };

  const updateMenuPosition = useCallback(() => {
    if (!buttonRef.current || typeof window === "undefined") return;
    const rect = buttonRef.current.getBoundingClientRect();
    const margin = 12;
    const width = Math.max(rect.width, 220);
    const maxWidth = Math.max(180, window.innerWidth - margin * 2);
    const safeWidth = Math.min(width, maxWidth);
    const below = window.innerHeight - rect.bottom - margin;
    const above = rect.top - margin;
    const preferredMaxHeight = String(label || "").toLowerCase().includes("state") ? 280 : 220;
    const openUp = below < 180 && above > below;
    const maxHeight = Math.max(120, Math.min(preferredMaxHeight, openUp ? above - 8 : below - 8));
    const left = Math.min(Math.max(margin, rect.left), window.innerWidth - safeWidth - margin);
    setMenuStyle({
      position: "fixed",
      left,
      top: openUp ? Math.max(margin, rect.top - maxHeight - 8) : Math.min(window.innerHeight - margin, rect.bottom + 8),
      width: safeWidth,
      maxHeight,
    });
  }, [label]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    setActiveIndex(selectedIndex);
    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, selectedIndex, updateMenuPosition]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (buttonRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => () => {
    if (typeaheadTimerRef.current && typeof window !== "undefined") window.clearTimeout(typeaheadTimerRef.current);
  }, []);

  const choose = (option) => {
    onChange?.(option.value);
    setOpen(false);
    if (typeof window !== "undefined") window.requestAnimationFrame(() => buttonRef.current?.focus());
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) setOpen(true);
      else choose(normalizedOptions[activeIndex] || selectedOption);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => {
        const count = normalizedOptions.length || 1;
        return (current + direction + count) % count;
      });
      return;
    }
    if (event.key.length === 1 && /\S/.test(event.key)) {
      typeaheadRef.current += event.key.toLowerCase();
      window.clearTimeout(typeaheadTimerRef.current);
      typeaheadTimerRef.current = window.setTimeout(() => {
        typeaheadRef.current = "";
      }, 500);
      const index = normalizedOptions.findIndex((option) => option.label.toLowerCase().startsWith(typeaheadRef.current));
      if (index >= 0) {
        event.preventDefault();
        setActiveIndex(index);
        if (!open) choose(normalizedOptions[index]);
      }
    }
  };

  return (
    <div className="block">
      <span id={`${selectId}-label`} className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/70">
        <span>{label}</span>
        {required ? (
          <span className="text-[9px] uppercase tracking-[0.12em] text-emerald-200/70">
            Required
          </span>
        ) : null}
      </span>
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={`${selectId}-listbox`}
        aria-labelledby={`${selectId}-label`}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onKeyDown}
        className="dark-dropdown flex h-10 w-full items-center justify-between gap-2 rounded-[13px] border border-white/[0.13] bg-[#111513] px-3 text-left text-sm text-white outline-none transition shadow-[inset_0_1px_0_rgba(255,255,255,0.04),inset_0_-8px_16px_rgba(0,0,0,0.14)] hover:border-emerald-200/28 hover:bg-white/[0.04] focus:ring-2 focus:ring-emerald-300/35"
      >
        <span className={selectedOption.value === "" ? "text-white/42" : "text-white"}>{selectedOption.label}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-white/48 transition ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && menuStyle ? createPortal(
        <div
          ref={menuRef}
          id={`${selectId}-listbox`}
          role="listbox"
          aria-labelledby={`${selectId}-label`}
          style={menuStyle}
          className="z-[120] overflow-y-auto rounded-xl border border-white/12 bg-[#080b0f] p-1 text-sm text-white shadow-[0_22px_54px_rgba(0,0,0,0.72)] ring-1 ring-emerald-300/10"
        >
          {normalizedOptions.map((option, index) => {
            const selected = String(option.value) === String(value ?? "");
            const active = index === activeIndex;
            return (
              <button
                key={`${selectId}-${String(option.value)}`}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(option)}
                className={[
                  "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition",
                  selected ? "bg-emerald-300/[0.13] text-emerald-50" : "text-white/78",
                  active && !selected ? "bg-white/[0.075] text-white" : "",
                ].join(" ")}
              >
                <span className="truncate">{option.label}</span>
                {selected ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-200" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>,
        document.body
      ) : null}
      {helper ? <p className="mt-1 text-[11px] leading-relaxed text-white/46">{helper}</p> : null}
    </div>
  );
}
