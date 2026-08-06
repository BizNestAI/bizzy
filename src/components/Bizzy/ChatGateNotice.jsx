import React from "react";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";

export default function ChatGateNotice({ notice, onDismiss, className = "" }) {
  const navigate = useNavigate();
  if (!notice) return null;

  return (
    <div
      className={[
        "flex items-center justify-between gap-3 rounded-2xl border border-white/[0.08] bg-[linear-gradient(135deg,rgba(255,255,255,0.055),rgba(255,255,255,0.026)_52%,rgba(0,0,0,0.22))] px-3.5 py-2.5 text-sm text-white shadow-[0_18px_44px_rgba(0,0,0,0.28)] backdrop-blur-xl",
        className,
      ].join(" ")}
      role="status"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-300 shadow-[0_0_14px_rgba(52,211,153,0.45)]" />
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/52">
            {notice.title}
          </div>
          <div className="mt-1 text-[13px] leading-snug text-white/72">
            {notice.message}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {notice.blocked ? (
          <button
            type="button"
            onClick={() => navigate("/dashboard/settings?tab=Billing")}
            className="hidden rounded-full border border-emerald-200/18 bg-emerald-300/[0.09] px-3 py-1.5 text-[12px] font-semibold text-emerald-50 transition hover:border-emerald-200/28 hover:bg-emerald-300/[0.14] focus:outline-none focus:ring-2 focus:ring-emerald-300/30 sm:inline-flex"
          >
            Billing
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Close subscription notice"
          onClick={onDismiss}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.035] text-white/50 transition hover:border-white/14 hover:bg-white/[0.07] hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/30"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
