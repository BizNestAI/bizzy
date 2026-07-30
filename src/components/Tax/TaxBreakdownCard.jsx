import React from "react";

export default function TaxBreakdownCard({ breakdown }) {
  const rows = [];
  if (!breakdown?.isUnknownEntity) {
    rows.push(["Federal income tax", breakdown?.federalIncomeTax]);
    if (!breakdown?.isSCorp) rows.push(["Self-employment tax", breakdown?.selfEmploymentTax]);
    rows.push(["State tax", breakdown?.stateTax]);
    if (breakdown?.otherTax != null) rows.push(["Other tax", breakdown.otherTax]);
  }

  return (
    <section className="rounded-[20px] border border-white/10 bg-white/[0.05] p-4 shadow-[0_18px_48px_rgba(0,0,0,0.32)]">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/48">Tax breakdown</div>
      <h2 className="mt-1 text-lg font-semibold text-white">Components</h2>
      {breakdown?.isUnknownEntity ? (
        <p className="mt-3 text-sm leading-relaxed text-white/68">
          Entity tax treatment is not configured yet. Component amounts are hidden until Bizzi knows how this business is taxed.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3 border-b border-white/8 pb-2 last:border-b-0 last:pb-0">
              <span className="text-sm text-white/62">{label}</span>
              <span className="text-sm font-semibold tabular-nums text-white">{formatCurrency(value)}</span>
            </div>
          ))}
        </div>
      )}
      {breakdown?.sCorpContext ? (
        <p className="mt-4 rounded-2xl border border-white/10 bg-black/18 px-3 py-2 text-xs leading-relaxed text-white/62">
          {breakdown.sCorpContext}
        </p>
      ) : null}
      {breakdown?.qbiDeferred ? (
        <p className="mt-3 text-xs text-amber-100/80">QBI deduction is not yet included in this estimate.</p>
      ) : null}
    </section>
  );
}

function formatCurrency(value) {
  if (value == null || Number.isNaN(Number(value))) return "Not available";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value));
}
