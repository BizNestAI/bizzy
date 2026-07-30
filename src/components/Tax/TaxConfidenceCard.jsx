import React from "react";
import { ArrowRight } from "lucide-react";

const LEVEL_LABELS = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
  unavailable: "Unavailable",
};

export default function TaxConfidenceCard({ confidence, onAction, onOpenDetails }) {
  const level = confidence?.level || "unavailable";
  const action = confidence?.topImprovementAction;
  return (
    <section className="rounded-[20px] border border-white/10 bg-white/[0.05] p-4 shadow-[0_18px_48px_rgba(0,0,0,0.32)]">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/48">Confidence</div>
      <div className="mt-1 flex items-start justify-between gap-3">
        <h2 className="text-lg font-semibold text-white">{LEVEL_LABELS[level] || labelize(level)}</h2>
        {confidence?.score != null ? (
          <span className="rounded-full border border-white/12 bg-black/20 px-2.5 py-1 text-xs font-semibold text-white/72">
            {Math.round(Number(confidence.score))}/100
          </span>
        ) : null}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
        <ReadyPill label="Estimate" ready={confidence?.estimateReady} />
        <ReadyPill label="Reserve" ready={confidence?.reserveReady} />
      </div>
      <p className="mt-4 min-h-10 text-sm leading-relaxed text-white/66">
        {confidence?.topBlocker?.message || "Confidence reflects profile completeness, transaction classification, source freshness, payments, and reserve setup."}
      </p>
      {action?.label ? (
        <button
          type="button"
          onClick={() => onAction?.(action)}
          className="mt-3 inline-flex items-center gap-2 rounded-full border border-white/12 bg-black/20 px-3 py-2 text-sm font-semibold text-white/76 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/40"
        >
          {action.label}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
      {onOpenDetails ? (
        <button
          type="button"
          onClick={onOpenDetails}
          className="mt-3 ml-2 inline-flex items-center gap-2 rounded-full border border-white/12 bg-black/20 px-3 py-2 text-sm font-semibold text-white/70 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/40"
        >
          View details
        </button>
      ) : null}
    </section>
  );
}

function ReadyPill({ label, ready }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-black/18 px-3 py-2">
      <div className="text-white/42">{label}</div>
      <div className="mt-1 font-semibold text-white">{ready ? "Ready" : "Needs input"}</div>
    </div>
  );
}

function labelize(value) {
  return value ? String(value).replaceAll("_", " ") : "Unavailable";
}
