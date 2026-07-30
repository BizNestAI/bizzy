import React from "react";
import { formatDate, formatMoney, labelize, paymentSourceLabel, paymentStatusLabel, paymentTypeLabel } from "./taxPlanningDisplay.js";

export default function TaxPaymentHistory({ rows = [], loading, onVoid }) {
  return (
    <section id="tax-payment-history" className="rounded-[20px] border border-white/10 bg-white/[0.045] p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/48">Payment history</div>
          <h3 className="mt-1 text-base font-semibold text-white">Tax payments</h3>
          <p className="mt-1 text-sm text-white/50">Record estimated payments, withholding, credits, and extension payments to improve remaining-liability and reserve tracking.</p>
        </div>
        {loading ? <span className="text-xs text-white/48">Loading...</span> : null}
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="min-w-[920px] w-full text-left text-sm">
          <thead className="text-[11px] uppercase tracking-[0.12em] text-white/42">
            <tr className="border-b border-white/10">
              <th className="py-2 pr-3">Date</th>
              <th className="px-3 py-2">Jurisdiction</th>
              <th className="px-3 py-2">State</th>
              <th className="px-3 py-2">Payment type</th>
              <th className="px-3 py-2">Period</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Notes</th>
              <th className="py-2 pl-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((row) => (
              <tr key={row.id || `${row.paymentDate}-${row.amount}-${row.paymentType}`} className="border-b border-white/[0.06]">
                <td className="py-3 pr-3 text-white/62">{formatDate(row.paymentDate)}</td>
                <td className="px-3 py-3 text-white/72">{labelize(row.jurisdiction)}</td>
                <td className="px-3 py-3 text-white/62">{row.stateCode || "—"}</td>
                <td className="px-3 py-3 text-white/72">{paymentTypeLabel(row.paymentType)}</td>
                <td className="px-3 py-3 text-white/62">{row.metadata?.quarter || row.quarter || "—"}</td>
                <td className="px-3 py-3 text-right tabular-nums text-white/84">{formatMoney(row.amount)}</td>
                <td className="px-3 py-3 text-white/62">{paymentSourceLabel(row.source)}</td>
                <td className="px-3 py-3 text-white/62">{paymentStatusLabel(row.status)}</td>
                <td className="max-w-[180px] truncate px-3 py-3 text-white/50">{row.metadata?.notes || row.notes || "—"}</td>
                <td className="py-3 pl-3">
                  <button type="button" disabled={!row.id || row.status === "void"} onClick={() => onVoid?.(row)} className="rounded-full border border-white/10 bg-black/18 px-2.5 py-1 text-xs font-semibold text-white/58 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40">
                    Void
                  </button>
                </td>
              </tr>
            )) : (
              <tr>
                <td colSpan={10} className="py-8 text-center text-white/54">No tax payments recorded yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
