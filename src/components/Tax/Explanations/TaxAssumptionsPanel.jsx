import React from "react";
import { labelize, normalizeList, safeFormulaValue } from "./taxExplanationDisplay.js";

export default function TaxAssumptionsPanel({ assumptions = [], onAction }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/48">Assumptions</div>
      <h3 className="mt-1 text-lg font-semibold text-white">Inputs Bizzi assumed</h3>
      <div className="mt-4 space-y-2">
        {normalizeList(assumptions).length ? normalizeList(assumptions).map((assumption, index) => (
          <div key={assumption.code || index} className="rounded-xl border border-white/8 bg-black/18 px-3 py-2">
            <div className="text-sm font-semibold text-white/84">{assumption.label || assumption.title || labelize(assumption.code)}</div>
            <div className="mt-1 text-xs text-white/52">Value: {safeFormulaValue(assumption.value)}</div>
            <div className="mt-1 text-xs text-white/38">Source: {labelize(assumption.source)} • Confidence: {labelize(assumption.confidence || assumption.confidenceLevel)}</div>
            {assumption.editable || assumption.action ? (
              <button type="button" onClick={() => onAction?.(assumption.action || assumption)} className="mt-2 rounded-full border border-white/10 px-2.5 py-1 text-xs font-semibold text-white/62 hover:bg-white/10 hover:text-white">
                Update input
              </button>
            ) : null}
          </div>
        )) : <div className="text-sm text-white/52">No assumptions supplied for this calculation.</div>}
      </div>
    </section>
  );
}
