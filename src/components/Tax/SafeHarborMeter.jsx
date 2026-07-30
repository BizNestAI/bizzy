// src/components/Tax/SafeHarborMeter.jsx
import React, { useMemo } from "react";
import { ShieldQuestion, AlertTriangle } from "lucide-react";

const CARD_CLASSES =
  "rounded-[18px] border border-white/12 bg-gradient-to-br from-white/8 via-white/[0.03] to-black/60 shadow-[0_18px_50px_rgba(0,0,0,0.35)]";

export default function SafeHarborMeter({ safeHarbor = {}, summary = {}, onAskBizzy }) {
  const { target, covered, remaining, percent } = useMemo(() => {
    const targetVal = safeHarbor?.requiredAnnual ?? safeHarbor?.combined?.requiredAnnual ?? null;
    const coveredVal = safeHarbor?.coveredAmount ?? safeHarbor?.combined?.coveredAmount ?? summary?.ytdPaid ?? null;
    const remainingVal = safeHarbor?.remainingAmount ?? safeHarbor?.combined?.remainingAmount ?? (
      targetVal != null && coveredVal != null ? Math.max(targetVal - coveredVal, 0) : null
    );
    const pct = targetVal && coveredVal != null ? Math.max(0, Math.min(100, Math.round((coveredVal / targetVal) * 100))) : null;
    return { target: targetVal, covered: coveredVal, remaining: remainingVal, percent: pct };
  }, [safeHarbor, summary?.ytdPaid]);

  return (
    <div className={`${CARD_CLASSES} p-4 sm:p-5 text-white`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[12px] uppercase tracking-[0.12em] text-white/65">Safe harbor status</div>
          <div className="text-lg font-semibold mt-1">Coverage {percent != null ? `${percent}%` : "—"}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            title="Safe harbor means paying at least 100% of last year's tax or 90% of this year's to avoid penalties."
            className="rounded-full border border-white/14 bg-white/5 p-1.5 text-white/75 hover:bg-white/10 transition"
          >
            <ShieldQuestion className="h-4 w-4" />
          </button>
        </div>
      </div>

      <ProgressBar percent={percent ?? 0} />

      <div className="mt-3 grid grid-cols-2 gap-2 text-[13px] text-white/75">
        <Metric label="Target" value={target} />
        <Metric label="Covered" value={covered} />
        <Metric label="Remaining" value={remaining} accent />
        <Metric
          label="Method"
          value={safeHarbor?.method ? formatMethod(safeHarbor.method) : "—"}
          icon={safeHarbor?.method ? null : <AlertTriangle className="h-3.5 w-3.5 text-amber-200" />}
        />
      </div>

      <div className="mt-3">
        <button
          type="button"
          onClick={() => onAskBizzy?.("Confirm my safe harbor coverage", { target, covered, remaining })}
          className="text-[12px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-white/12 bg-white/5 hover:bg-white/10 transition"
        >
          Ask Bizzi to check
        </button>
      </div>
    </div>
  );
}

function Metric({ label, value, accent = false, icon = null }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.08em] text-white/60">{label}</div>
      <div className={`mt-0.5 text-[14px] font-semibold tabular-nums ${accent ? "text-[rgba(var(--accent-rgb),0.95)]" : "text-white"}`}>
        {icon}
        {value != null && value !== "" ? (
          typeof value === "number" ? (
            formatCurrency(value)
          ) : (
            value
          )
        ) : (
          "—"
        )}
      </div>
    </div>
  );
}

function ProgressBar({ percent }) {
  return (
    <div className="mt-3 h-3 rounded-full bg-white/10 border border-white/12 overflow-hidden">
      <div
        className="h-full rounded-full"
        style={{
          width: `${percent}%`,
          background:
            "linear-gradient(90deg, rgba(var(--accent-rgb),0.65), rgba(var(--accent-rgb),0.9))",
          boxShadow: "0 0 0 1px rgba(var(--accent-rgb),0.18), 0 0 22px rgba(var(--accent-rgb),0.18)",
        }}
      />
    </div>
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

function formatMethod(method) {
  if (!method) return "—";
  if (method === "prior_year") return "Prior year safe harbor";
  if (method === "current_year") return "Current year projection";
  return method;
}
