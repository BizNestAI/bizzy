import React from "react";
import { ArrowRight } from "lucide-react";
import { labelize, routeForAction } from "../Explanations/taxExplanationDisplay.js";

export default function TaxImprovementActions({ actions = [], onAction }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/48">Actions</div>
      <h3 className="mt-1 text-lg font-semibold text-white">Improve this estimate</h3>
      <div className="mt-4 space-y-2">
        {actions.length ? actions.map((action) => (
          <button
            key={action.code || action.title || action.label}
            type="button"
            onClick={() => onAction?.({ ...action, route: routeForAction(action) || action.route })}
            className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/8 bg-black/18 px-3 py-2 text-left hover:bg-white/[0.06] focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
          >
            <span>
              <span className="block text-sm font-semibold text-white/84">{action.title || action.label || labelize(action.code)}</span>
              <span className="mt-1 block text-xs text-white/48">{action.description || action.impact || action.expectedConfidenceGain || "Open the related workflow."}</span>
            </span>
            <ArrowRight className="h-4 w-4 shrink-0 text-white/42" />
          </button>
        )) : <div className="text-sm text-white/52">No improvement actions supplied.</div>}
      </div>
    </section>
  );
}
