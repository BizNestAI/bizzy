// src/components/Tax/NextPaymentHero.jsx
import React, { useMemo } from "react";
import { CalendarClock, Clock3, MessageCircle, ShieldCheck, ArrowUpRight } from "lucide-react";
import { ACCENT_HEX } from "../../config/accent";

const CARD_BG =
  "linear-gradient(135deg, rgba(255,255,255,0.06), rgba(255,255,255,0.03) 45%, rgba(0,0,0,0.45))";
const BORDER = "rgba(255,255,255,0.12)";
const SHADOW = "0 18px 50px rgba(0,0,0,0.35)";

export default function NextPaymentHero({
  amount,
  dueDate,
  dueDays,
  balanceDue,
  onAskBizzy,
  onViewDeductions,
}) {
  const now = Date.now();
  const effectiveDate = useMemo(() => {
    if (dueDate) return new Date(dueDate);
    if (typeof dueDays === "number") return new Date(now + dueDays * 24 * 60 * 60 * 1000);
    return null;
  }, [dueDate, dueDays, now]);

  const countdown = useMemo(() => {
    if (!effectiveDate) return null;
    const diff = Math.ceil((effectiveDate.getTime() - now) / (24 * 60 * 60 * 1000));
    return diff;
  }, [effectiveDate, now]);

  const status = useMemo(() => {
    if (!effectiveDate && typeof dueDays !== "number") return { label: "On track", tone: "ok" };
    const diffDays = countdown ?? 30;
    if (diffDays < 0) return { label: "Overdue", tone: "bad" };
    if (diffDays <= 7) return { label: "At risk", tone: "warn" };
    return { label: "On track", tone: "ok" };
  }, [countdown, dueDays, effectiveDate]);

  const formattedDate = effectiveDate
    ? effectiveDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : "—";

  const primaryLabel = amount != null ? formatCurrency(amount) : "—";
  const countdownText = countdown != null ? (countdown >= 0 ? `in ${countdown} days` : `${Math.abs(countdown)}d overdue`) : null;

  return (
    <div
      className="rounded-[22px] border p-4 sm:p-5 text-white relative overflow-hidden"
      style={{
        background: CARD_BG,
        borderColor: BORDER,
        boxShadow: SHADOW,
      }}
    >
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute -left-24 -top-24 w-64 h-64 rounded-full"
          style={{ background: `radial-gradient(circle, ${hexToRgba(ACCENT_HEX, 0.14)}, transparent 65%)` }}
        />
        <div className="absolute -right-16 bottom-0 w-56 h-56 rounded-full"
          style={{ background: `radial-gradient(circle, rgba(255,255,255,0.05), transparent 70%)` }}
        />
      </div>

      <div className="relative flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[12px] uppercase tracking-[0.12em] text-white/65">Next payment due</div>
            <div className="mt-1 text-3xl sm:text-[34px] font-semibold leading-tight tabular-nums">{primaryLabel}</div>
            <div className="mt-1 text-white/75 text-sm inline-flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-white/60" />
              <span>{formattedDate}</span>
              {countdownText ? (
                <span className="inline-flex items-center gap-1 text-[12px] px-2 py-0.5 rounded-full bg-white/6 border border-white/10">
                  <Clock3 className="h-3.5 w-3.5" />
                  {countdownText}
                </span>
              ) : null}
            </div>
          </div>

          <StatusPill status={status} />
        </div>

        <p className="text-[13px] text-white/75 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-[rgba(var(--accent-rgb),0.85)]" />
          Bizzi will keep you safe-harbor compliant.
        </p>

        <div className="flex flex-wrap items-center gap-2 text-[13px] text-white/70">
          <span className="px-2 py-1 rounded-lg bg-white/5 border border-white/10">
            Balance due: {balanceDue != null ? formatCurrency(balanceDue) : "—"}
          </span>
        </div>

        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onAskBizzy?.("Help me plan my next tax payment", { amount, dueDate: effectiveDate?.toISOString?.() })}
            className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium text-black"
            style={{
              background: `linear-gradient(120deg, ${hexToRgba(ACCENT_HEX, 0.95)}, ${hexToRgba(ACCENT_HEX, 0.8)})`,
              boxShadow: "0 0 0 1px rgba(var(--accent-rgb),0.18), 0 0 22px rgba(var(--accent-rgb),0.10)",
            }}
          >
            Plan payment
            <ArrowUpRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onAskBizzy?.("What should I know about this tax payment?", { amount, dueDate })}
            className="inline-flex items-center gap-2 rounded-full px-3 py-2 text-[13px] border border-white/14 bg-white/5 hover:bg-white/8 transition"
          >
            <MessageCircle className="h-4 w-4" />
            Ask Bizzi
          </button>
          <button
            type="button"
            onClick={onViewDeductions}
            className="inline-flex items-center gap-2 rounded-full px-3 py-2 text-[13px] border border-white/10 text-white/80 hover:text-white hover:border-white/14 transition"
          >
            View deductions
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const tone = status?.tone || "ok";
  const map = {
    ok: { bg: "bg-emerald-500/15", text: "text-emerald-300", ring: "ring-emerald-400/25", label: "On track" },
    warn: { bg: "bg-amber-500/15", text: "text-amber-200", ring: "ring-amber-400/25", label: "At risk" },
    bad: { bg: "bg-rose-500/15", text: "text-rose-300", ring: "ring-rose-400/25", label: "Overdue" },
  };
  const cls = map[tone] || map.ok;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full ring-1 ring-inset ${cls.bg} ${cls.text} ${cls.ring}`}>
      <span className="inline-block h-2 w-2 rounded-full bg-current" aria-hidden />
      {status?.label || cls.label}
    </span>
  );
}

function formatCurrency(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(n));
  } catch {
    return `$${Number(n).toLocaleString()}`;
  }
}

function hexToRgba(hex, alpha = 1) {
  if (!hex) return `rgba(255,255,255,${alpha})`;
  const clean = hex.replace("#", "");
  const expand = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const int = Number.parseInt(expand || "0", 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}
