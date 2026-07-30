import React from "react";
import { AlertTriangle, CheckCircle2, ArrowRight } from "lucide-react";

export default function TaxSetupBanner({ model, onAction }) {
  const setup = model?.status?.setupState || {};
  const shouldShow =
    model?.status?.isPartial ||
    model?.status?.isUnavailable ||
    model?.status?.estimateReady === false ||
    model?.status?.reserveReady === false ||
    setup.code;
  if (!shouldShow) return null;

  const primaryAction = setup.actions?.[0] || model?.actions?.[0] || model?.confidence?.topImprovementAction;
  const estimateReady = model?.status?.estimateReady;
  const reserveReady = model?.status?.reserveReady;

  return (
    <section
      aria-labelledby="tax-readiness-heading"
      className="rounded-[20px] border border-amber-300/22 bg-amber-300/[0.075] px-4 py-3 text-white shadow-[0_18px_45px_rgba(0,0,0,0.28)]"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-200" aria-hidden="true" />
          <div>
            <h2 id="tax-readiness-heading" className="text-sm font-semibold text-amber-50">
              {model?.status?.isPartial ? "Partial tax estimate available" : "Tax setup needs attention"}
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-white/72">
              {setup.message || "Some tax inputs are incomplete. Available sections remain visible with unavailable values clearly labeled."}
            </p>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-white/64">
              <ReadinessPill ready={estimateReady} label="Estimate" />
              <ReadinessPill ready={reserveReady} label="Reserve" />
            </div>
          </div>
        </div>
        {primaryAction?.label ? (
          <button
            type="button"
            onClick={() => onAction?.(primaryAction)}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-amber-200/30 bg-black/20 px-3 py-2 text-sm font-semibold text-amber-50 transition hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-amber-200/40"
          >
            {primaryAction.label}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </section>
  );
}

function ReadinessPill({ ready, label }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-black/18 px-2.5 py-1">
      <CheckCircle2 className={`h-3.5 w-3.5 ${ready ? "text-emerald-200" : "text-white/35"}`} aria-hidden="true" />
      {label}: {ready ? "ready" : "needs input"}
    </span>
  );
}
