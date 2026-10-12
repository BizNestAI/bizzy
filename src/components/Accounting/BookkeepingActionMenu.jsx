import React from "react";

export default function BookkeepingActionMenu({ matrix, busy = false, readOnly = false, onAction, status = "" }) {
  const actions = Array.isArray(matrix?.actions) ? matrix.actions : [];
  const primary = actions.find((action) => action.is_primary);
  if (!actions.length) return null;

  const run = (action) => {
    if (busy || readOnly || !action?.enabled) return;
    onAction?.(action);
  };

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
      <details className="group relative">
        <summary className="flex min-h-7 cursor-pointer list-none items-center justify-center rounded-lg border border-white/15 bg-white/[0.04] px-2 text-[10px] font-semibold text-white/75 marker:content-none">
          All actions
        </summary>
        <div className="absolute right-0 z-40 mt-1 max-h-[min(70vh,520px)] w-[min(320px,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-white/15 bg-[#101312] p-2 shadow-2xl">
          {(matrix.groups || []).map((group) => (
            <section key={group.key} className="mb-2 last:mb-0">
              <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-white/35">{group.label}</div>
              {group.actions.map((code) => {
                const action = actions.find((item) => item.action_code === code);
                if (!action) return null;
                return (
                  <button
                    key={code}
                    type="button"
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
        </div>
      </details>
      {status ? <div className="truncate text-center text-[9px] text-white/35" title={status}>{status}</div> : null}
    </div>
  );
}
