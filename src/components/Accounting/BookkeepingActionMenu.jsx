import React from "react";
import { createPortal } from "react-dom";

const VIEWPORT_GAP = 12;
const MENU_WIDTH = 320;

function menuPosition(trigger) {
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(MENU_WIDTH, window.innerWidth - VIEWPORT_GAP * 2);
  const left = Math.max(VIEWPORT_GAP, Math.min(rect.right - width, window.innerWidth - width - VIEWPORT_GAP));
  const roomBelow = window.innerHeight - rect.bottom - VIEWPORT_GAP;
  const roomAbove = rect.top - VIEWPORT_GAP;
  const placeAbove = roomBelow < 260 && roomAbove > roomBelow;
  return {
    left,
    width,
    maxHeight: Math.max(160, Math.min(520, placeAbove ? roomAbove : roomBelow)),
    ...(placeAbove ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
  };
}

export default function BookkeepingActionMenu({ matrix, busy = false, readOnly = false, onAction, status = "" }) {
  const actions = Array.isArray(matrix?.actions) ? matrix.actions : [];
  const primary = actions.find((action) => action.is_primary);
  const [open, setOpen] = React.useState(false);
  const [position, setPosition] = React.useState(null);
  const triggerRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const menuId = React.useId();

  const close = React.useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  React.useLayoutEffect(() => {
    if (!open || !triggerRef.current) return undefined;
    const update = () => setPosition(menuPosition(triggerRef.current));
    const onPointerDown = (event) => {
      if (panelRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return;
      close(true);
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    };
    update();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [close, open]);

  if (!actions.length) return null;

  const run = (action) => {
    if (busy || readOnly || !action?.enabled) return;
    close(true);
    onAction?.(action);
  };

  const panel = open && position && typeof document !== "undefined" ? createPortal(
    <div
      ref={panelRef}
      id={menuId}
      role="menu"
      aria-label="Bookkeeping actions"
      style={{ position: "fixed", zIndex: 1000, ...position }}
      className="overflow-y-auto rounded-xl border border-white/15 bg-[#101312] p-2 shadow-2xl"
    >
      {(matrix.groups || []).map((group) => (
        <section key={group.key} className="mb-2 last:mb-0" aria-label={group.label}>
          <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-white/35">{group.label}</div>
          {group.actions.map((code) => {
            const action = actions.find((item) => item.action_code === code);
            if (!action) return null;
            return (
              <button
                key={code}
                type="button"
                role="menuitem"
                disabled={busy || readOnly || !action.enabled}
                onClick={() => run(action)}
                title={action.disabled_reason || undefined}
                className="block w-full rounded-lg px-2 py-1.5 text-left text-[10px] text-white/80 hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:text-white/30"
              >
                <span className="block font-semibold">{action.label}{action.is_primary ? " · Primary" : ""}</span>
                {!action.enabled && action.disabled_reason ? <span className="mt-0.5 block leading-3 text-white/30">{action.disabled_reason}</span> : null}
              </button>
            );
          })}
        </section>
      ))}
    </div>,
    document.body,
  ) : null;

  return (
    <div className="flex min-w-0 flex-col items-stretch gap-1.5 text-left">
      {primary ? (
        <button
          type="button"
          disabled={busy || readOnly || !primary.enabled}
          onClick={() => run(primary)}
          title={primary.disabled_reason || undefined}
          className="inline-flex min-h-8 items-center justify-center rounded-lg border border-sky-300/30 bg-sky-400/10 px-2.5 text-[10px] font-semibold text-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Working…" : primary.label}
        </button>
      ) : null}
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-7 items-center justify-center rounded-lg border border-white/15 bg-white/[0.04] px-2 text-[10px] font-semibold text-white/75"
      >
        All actions
      </button>
      {panel}
      {status ? <div className="truncate text-center text-[9px] text-white/35" title={status}>{status}</div> : null}
    </div>
  );
}
