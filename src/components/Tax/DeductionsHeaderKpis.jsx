// /src/components/Tax/DeductionsHeaderKpis.jsx
import React from "react";

export default function DeductionsHeaderKpis({ ytdTotal = 0, topCategory, thisMonthTotal = 0 }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      <KPI label="Total Deductions YTD" value={fmtUSD(ytdTotal)} />
      <KPI
        label="Top Category YTD"
        value={topCategory ? `${topCategory.category}: ${fmtUSD(topCategory.ytdTotal)}` : "—"}
      />
      <KPI label="This Month" value={fmtUSD(thisMonthTotal)} />
    </div>
  );
}

function KPI({ label, value }) {
  return (
    <div className="rounded-2xl p-3 bg-white/5 border border-yellow-500/20 flex flex-col justify-between">
      <div className="text-[11px] text-yellow-200/80">{label}</div>
      <div className="mt-1 text-xl font-semibold text-yellow-100 font-mono tabular-nums">{value}</div>
    </div>
  );
}

function fmtUSD(n) {
  const v = typeof n === "number" ? n : Number(n || 0);
  return v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
