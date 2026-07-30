// /src/components/Tax/DeductionsHeaderKpis.jsx
import React from "react";
import KpiCard from "../UI/KpiCard.jsx";

export default function DeductionsHeaderKpis({ ytdTotal = 0, topCategory, thisMonthTotal = 0, compact = false, items: itemsProp, onAskBizzi }) {
  const defaultItems = [
    { label: "Total Deductions YTD", value: fmtUSD(ytdTotal) },
    {
      label: "Top Category YTD",
      value: topCategory ? fmtUSD(topCategory.ytdTotal) : "—",
      detail: topCategory?.category || "",
    },
    { label: "This Month", value: fmtUSD(thisMonthTotal) },
  ];
  const items = itemsProp || defaultItems;

  return (
    <div
      className="rounded-[28px] border border-[rgba(191,191,191,0.14)] bg-white/[0.03] shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-xl"
      style={{ padding: compact ? "10px 12px" : "14px 16px" }}
    >
      <div className="grid grid-cols-1 items-stretch gap-2 md:grid-cols-3 md:gap-3">
        {items.map((item) => {
          const card = (
            <KpiCard
              label={item.label}
              value={item.value}
              detail={item.detail || ""}
              change={item.delta || ""}
              tone={getTone(item.status)}
              compact={compact}
              className="h-full min-h-[108px]"
              valueClassName={compact ? "text-lg" : "text-[clamp(1.35rem,1.8vw,1.75rem)]"}
            />
          );
          if (!onAskBizzi) return <div key={item.label}>{card}</div>;
          return (
            <button
              key={item.label}
              type="button"
              onClick={() => onAskBizzi(item.ask || `Tell me more about ${item.label}`)}
              className="block text-left"
            >
              {card}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function getTone(status) {
  if (status === "bad" || status === "critical") return "rose";
  if (status === "warn" || status === "warning") return "amber";
  return "emerald";
}

function fmtUSD(n) {
  const v = typeof n === "number" ? n : Number(n || 0);
  return v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
