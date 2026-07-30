import React from "react";
import { formatDate, formatMoney, labelize } from "./taxPlanningDisplay.js";

export default function TaxSafeHarborSummary({ safeHarbor }) {
  const combined = safeHarbor?.combined || null;
  const status = safeHarbor?.status || combined?.status || "unavailable";
  const unavailable = status === "unavailable";
  const schedule = combined?.quarterSchedule || combined?.schedule || [];
  const next = schedule.find((row) => row?.status === "upcoming" || row?.remaining > 0) || null;
  const coveredPct = percent(combined?.coveredAmount, combined?.requiredAnnual);

  return (
    <section className="rounded-[20px] border border-white/10 bg-white/[0.05] p-4 shadow-[0_18px_48px_rgba(0,0,0,0.32)]">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/48">Safe harbor</div>
      <h2 className="mt-1 text-lg font-semibold text-white">{unavailable ? "Unavailable" : `${coveredPct == null ? "Coverage" : `${coveredPct}% covered`}`}</h2>
      {unavailable ? (
        <p className="mt-3 text-sm leading-relaxed text-white/68">
          Safe-harbor estimate unavailable. {safeHarbor?.warning?.message || safeHarbor?.warnings?.[0]?.message || "Add prior-year tax and payment details to calculate a target."}
        </p>
      ) : (
        <>
          <div className="mt-4 h-3 overflow-hidden rounded-full bg-white/[0.08]">
            <div className="h-full rounded-full bg-emerald-300/75 transition-[width] duration-500" style={{ width: `${Math.min(100, Math.max(0, coveredPct || 0))}%` }} />
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Metric label="Target" value={formatMoney(combined?.requiredAnnual)} />
            <Metric label="Covered" value={formatMoney(combined?.coveredAmount)} />
            <Metric label="Remaining" value={formatMoney(combined?.remainingAmount)} />
          </div>
          <div className="mt-4 rounded-2xl border border-white/8 bg-black/18 px-3 py-3">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-white/58">Next payment</span>
              <span className="font-semibold text-white">{formatDate(next?.dueDate || next?.due || next?.date)} · {formatMoney(next?.remaining ?? next?.amount)}</span>
            </div>
            <div className="mt-2 text-xs text-white/46">Method: {labelize(combined?.method)}</div>
          </div>
        </>
      )}
      <p className="mt-3 text-xs text-white/46">Deadlines and schedules are shown only when supplied by the canonical tax engine.</p>
    </section>
  );
}

function Metric({ label, value }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.12em] text-white/38">{label}</div>
      <div className="mt-1 font-semibold text-white/78">{value}</div>
    </div>
  );
}

function percent(value, target) {
  if (value == null || target == null || Number(target) <= 0) return null;
  return Math.round((Number(value) / Number(target)) * 100);
}
