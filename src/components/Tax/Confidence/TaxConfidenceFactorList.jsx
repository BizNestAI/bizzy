import React from "react";
import { formatPercent, labelize } from "../Explanations/taxExplanationDisplay.js";

export default function TaxConfidenceFactorList({ factors = [], penalties = [] }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/48">Methodology</div>
      <h3 className="mt-1 text-lg font-semibold text-white">Factors and penalties</h3>
      <div className="mt-4 space-y-2">
        {factors.length ? factors.map((factor) => (
          <div key={factor.code || factor.category || factor.label} className="rounded-xl border border-white/8 bg-black/18 px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <div className="font-semibold text-white/84">{factor.label || factor.name || labelize(factor.category)}</div>
              <div className="text-sm text-white/72">{Math.round(Number(factor.score || 0))}/100</div>
            </div>
            <div className="mt-1 text-xs text-white/50">{factor.summary || factor.description}</div>
            {factor.weight != null ? <div className="mt-1 text-[11px] text-white/38">Weight: {formatPercent(factor.weight)}</div> : null}
          </div>
        )) : <div className="text-sm text-white/52">No confidence factors available.</div>}
      </div>
      {penalties.length ? (
        <div className="mt-4 space-y-2">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-white/42">Penalties</div>
          {penalties.map((penalty) => (
            <div key={penalty.code || penalty.message} className="rounded-xl border border-amber-300/18 bg-amber-300/[0.06] px-3 py-2 text-xs text-amber-50/82">
              {penalty.message || penalty.code} {penalty.points ? `(-${penalty.points})` : ""}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
