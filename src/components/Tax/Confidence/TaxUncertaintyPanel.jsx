import React from "react";
import { formatMoney, formatPercent, labelize } from "../Explanations/taxExplanationDisplay.js";

export default function TaxUncertaintyPanel({ materialUncertainty }) {
  const drivers = materialUncertainty?.topDrivers || [];
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/48">Uncertainty</div>
      <h3 className="mt-1 text-lg font-semibold text-white">Material drivers</h3>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Metric label="Projection range" value={formatMoney(materialUncertainty?.dollarRange)} />
        <Metric label="Needs review" value={formatMoney(materialUncertainty?.needsReviewAmount)} />
        <Metric label="Review ratio" value={formatPercent(materialUncertainty?.needsReviewRatio)} />
      </div>
      {drivers.length ? (
        <div className="mt-4 space-y-2">
          {drivers.map((driver) => (
            <div key={driver.code} className="rounded-xl border border-white/8 bg-black/18 px-3 py-2 text-sm text-white/68">
              {labelize(driver.code)}: {formatMoney(driver.amount)} <span className="text-white/42">({labelize(driver.materiality)})</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-xl border border-white/8 bg-black/18 px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.12em] text-white/42">{label}</div>
      <div className="mt-1 text-sm font-semibold text-white/84">{value}</div>
    </div>
  );
}
