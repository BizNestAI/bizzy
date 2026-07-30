import React from "react";
import { formatMoney } from "./taxPlanningDisplay.js";

export default function TaxAffordabilityNotice({ reserve }) {
  const recommendedReserve = reserve?.reserve?.recommendedReserve ?? reserve?.recommendedReserve ?? null;
  const currentReserve = reserve?.reserve?.currentReserve ?? reserve?.currentReserve ?? null;
  const reserveGap = reserve?.reserve?.reserveGap ?? reserve?.reserveGap ?? null;
  const affordable = reserve?.cashFlow?.transferAffordable ?? reserve?.affordability?.transferAffordable ?? null;
  const warning = reserve?.cashFlow?.affordabilityWarning || reserve?.affordability?.warning || null;

  return (
    <div className="rounded-2xl border border-white/10 bg-black/18 px-3 py-3">
      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-white/42">Affordability</div>
      <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
        <Metric label="Recommended reserve" value={formatMoney(recommendedReserve)} />
        <Metric label="Current reserve" value={currentReserve == null ? "Not connected" : formatMoney(currentReserve)} />
        <Metric label="Reserve gap" value={formatMoney(reserveGap)} />
      </div>
      <div className="mt-3 rounded-xl border border-emerald-200/16 bg-emerald-300/[0.055] px-3 py-2 text-sm text-emerald-50/82">
        Affordable transfer now: {formatMoney(affordable)}. This does not reduce the tax obligation or reserve gap.
      </div>
      {warning ? <p className="mt-2 text-xs text-amber-50/76">{warning}</p> : null}
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.12em] text-white/38">{label}</div>
      <div className="mt-1 font-semibold text-white/84">{value}</div>
    </div>
  );
}
