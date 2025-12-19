import React from "react";

export default function TopUnpaidTable({ rows = [] }) {
  if (!rows.length) {
    return (
      <div className="text-sm text-white/75 rounded-[22px] border border-dashed border-white/20 bg-white/[0.02] backdrop-blur-2xl px-4 py-5 shadow-[0_30px_60px_rgba(0,0,0,0.35)]">
        Connect QuickBooks, Jobber, or Housecall Pro to see which jobs are still waiting on payment.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.slice(0, 5).map((row) => (
        <div
          key={row.id}
          className="rounded-[22px] border border-white/12 bg-gradient-to-br from-white/[0.05] to-transparent px-4 py-3 flex flex-wrap items-center gap-3 justify-between backdrop-blur-2xl shadow-[0_30px_60px_rgba(0,0,0,0.45)]"
        >
          <div className="min-w-0">
            <div className="text-sm font-semibold text-white truncate">{row.title || 'Untitled job'}</div>
            <div className="text-[11px] text-white/55">{row.external_source || 'Manual'} • invoice {row.external_id || row.id}</div>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wide text-white/50">
              {row.invoice_status === 'partial' ? 'Partial paid' : 'Unpaid'}
            </div>
            <div className="text-lg font-semibold text-rose-300">
              ${Number(row.amount_due || 0).toLocaleString()}
            </div>
          </div>
        </div>
      ))}
      {rows.length > 5 && (
        <div className="text-[12px] text-white/55 italic">
          Showing top {Math.min(rows.length, 5)} of {rows.length} unpaid jobs.
        </div>
      )}
    </div>
  );
}
