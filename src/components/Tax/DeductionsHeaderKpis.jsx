// /src/components/Tax/DeductionsHeaderKpis.jsx
import React from "react";
import { MessageCircle } from "lucide-react";

export default function DeductionsHeaderKpis({ ytdTotal = 0, topCategory, thisMonthTotal = 0, compact = false, items: itemsProp, onAskBizzi }) {
  const defaultItems = [
    { label: "Total Deductions YTD", value: fmtUSD(ytdTotal) },
    { label: "Top Category YTD", value: topCategory ? `${topCategory.category}: ${fmtUSD(topCategory.ytdTotal)}` : "—" },
    { label: "This Month", value: fmtUSD(thisMonthTotal) },
  ];
  const items = itemsProp || defaultItems;

  return (
    <div
      className="rounded-[28px] border border-[rgba(191,191,191,0.14)] bg-white/[0.03] shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-xl"
      style={{ padding: compact ? "10px 12px" : "14px 16px" }}
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 md:gap-3">
        {items.map((item) => (
          <KPI key={item.label} label={item.label} value={item.value} delta={item.delta} status={item.status} compact={compact} onAskBizzi={() => onAskBizzi?.(item.ask || `Tell me more about ${item.label}`)} />
        ))}
      </div>
    </div>
  );
}

function KPI({ label, value, delta, status, compact, onAskBizzi }) {
  return (
    <div
      className="rounded-[18px] px-3 py-2 flex flex-col justify-between relative overflow-hidden"
      style={{
        background: "linear-gradient(180deg, rgba(20,20,22,0.85), rgba(12,12,14,0.85))",
        border: "1px solid rgba(255,255,255,0.06)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
      }}
    >
      <div className="text-[11px] text-[rgba(var(--accent-rgb),0.85)] uppercase tracking-[0.08em]">
        {label}
      </div>
      <div className={`mt-1 ${compact ? "text-lg" : "text-xl"} font-semibold text-white font-mono tabular-nums`}>
        <span className="text-[rgba(var(--accent-rgb),0.9)] mr-1">▸</span>
        {value}
      </div>
      <div className="mt-1 flex items-center justify-between text-[12px] text-white/70">
        {delta ? <span>{delta}</span> : <span className="text-white/40">—</span>}
        {/* Status pill removed */}
      </div>
    </div>
  );
}

function fmtUSD(n) {
  const v = typeof n === "number" ? n : Number(n || 0);
  return v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
