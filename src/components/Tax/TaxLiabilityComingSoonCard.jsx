import React from "react";

export default function TaxLiabilityComingSoonCard({ className = "" }) {
  return (
    <section
      aria-label="Quarterly tax estimate coming soon"
      className={`rounded-[20px] border border-white/10 bg-white/[0.04] px-4 py-4 text-white shadow-[0_18px_45px_rgba(0,0,0,0.28)] sm:px-5 ${className}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/48">Quarterly tax estimate</div>
          <h2 className="mt-2 text-lg font-semibold leading-tight text-white">Quarterly tax estimate</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-white/58">
            Bizzi will combine your business profit, confirmed deductions, tax profile, payments, and other income to estimate federal and state quarterly taxes.
          </p>
          <p className="mt-2 text-sm leading-6 text-white/50">
            Your deductions can still be reviewed and organized in the Deductions workspace.
          </p>
        </div>
        <span className="inline-flex w-fit shrink-0 rounded-full border border-emerald-300/22 bg-emerald-300/[0.08] px-3 py-1.5 text-xs font-semibold text-emerald-100">
          Coming soon
        </span>
      </div>
    </section>
  );
}
