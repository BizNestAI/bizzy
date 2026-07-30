import React from "react";
import { formatMoney, labelize } from "../Explanations/taxExplanationDisplay.js";

export default function TaxConfidenceSummary({ confidence, overview }) {
  const blocker = confidence?.blockers?.[0] || overview?.readiness?.blockers?.[0] || null;
  const action = confidence?.improvementActions?.[0] || overview?.readiness?.actions?.[0] || null;
  const uncertainty = confidence?.materialUncertainty || {};
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/48">Confidence summary</div>
          <h3 className="mt-1 text-2xl font-semibold text-white">{labelize(confidence?.level)} confidence</h3>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/64">
            {confidence?.explanation || "Confidence reflects profile completeness, transaction classification, source freshness, payments, safe harbor, and reserve setup. It is not a filing guarantee."}
          </p>
        </div>
        {confidence?.score != null ? (
          <div className="rounded-2xl border border-white/10 bg-black/18 px-3 py-2 text-right">
            <div className="text-[10px] uppercase tracking-[0.12em] text-white/42">Score</div>
            <div className="mt-1 text-lg font-semibold text-white">{Math.round(Number(confidence.score))}/100</div>
          </div>
        ) : null}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <Metric label="Estimate" value={confidence?.estimateReady ? "Ready" : "Needs input"} />
        <Metric label="Reserve" value={confidence?.reserveReady ? "Ready" : "Needs input"} />
        <Metric label="Status" value={labelize(confidence?.status || overview?.readiness?.status)} />
        <Metric label="Uncertainty range" value={formatMoney(uncertainty.dollarRange)} />
      </div>
      {blocker ? (
        <div className="mt-4 rounded-2xl border border-rose-300/22 bg-rose-400/[0.08] px-3 py-2 text-sm text-rose-50">
          <div className="font-semibold">Top blocker: {labelize(blocker.code)}</div>
          <div className="mt-1 text-rose-50/80">{blocker.message || blocker.description}</div>
          {blocker.affectedOutputs?.length ? <div className="mt-1 text-xs text-rose-50/62">Affects: {blocker.affectedOutputs.join(", ")}</div> : null}
        </div>
      ) : null}
      {action ? (
        <div className="mt-3 rounded-2xl border border-emerald-300/18 bg-emerald-300/[0.055] px-3 py-2 text-sm text-emerald-50/82">
          Improve next: {action.title || action.label || action.code}
          {action.description ? <span className="text-emerald-50/62"> — {action.description}</span> : null}
        </div>
      ) : null}
    </section>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-black/18 px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.12em] text-white/42">{label}</div>
      <div className="mt-1 text-sm font-semibold text-white/86">{value || "Not available"}</div>
    </div>
  );
}
