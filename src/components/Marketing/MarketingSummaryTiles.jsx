import React, { useState } from "react";
import { BarChart2, Users, Activity } from "lucide-react";
import { getMarketingSummary } from "./marketingSummaryData";

const tileConfig = [
  {
    key: "reach",
    label: "Total Reach",
    icon: BarChart2,
    color: "linear-gradient(135deg, rgba(59,130,246,0.25), rgba(10,17,27,0.9))",
    formatter: (summary) => summary.total_reach?.toLocaleString?.() || summary.total_reach || "—",
    footnote: (summary) => summary.change,
  },
  {
    key: "engagement",
    label: "Total Engagement",
    icon: Users,
    color: "linear-gradient(135deg, rgba(147,197,253,0.3), rgba(8,11,17,0.92))",
    formatter: (summary) => summary.total_engagements?.toLocaleString?.() || summary.total_engagements || "—",
    footnote: () => "30-day rollup",
  },
  {
    key: "rate",
    label: "Avg Engagement Rate",
    icon: Activity,
    color: "linear-gradient(135deg, rgba(96,165,250,0.4), rgba(6,8,12,0.95))",
    formatter: (summary) => summary.avg_engagement_rate || "—",
    footnote: () => "vs prior week",
  },
];

export default function MarketingSummaryTiles({ summary }) {
  const data = getMarketingSummary(summary);
  return (
    <div className="w-full px-1 sm:px-2">
      <div className="grid gap-3 lg:grid-cols-3">
        {tileConfig.map((tile) => {
          const Icon = tile.icon;
          return (
            <HoverTile key={tile.key} color={tile.color}>
              <div className="flex items-center justify-between text-white/70 text-[11px] uppercase tracking-[0.25em]">
                <span>{tile.label}</span>
                <Icon size={16} className="text-white/60" />
              </div>
              <div className="mt-2 text-2xl font-semibold text-white">
                {tile.formatter(data)}
              </div>
              <div className="mt-1 text-[12px] text-white/70">
                {tile.footnote(data)}
              </div>
            </HoverTile>
          );
        })}
      </div>
    </div>
  );
}

function HoverTile({ children, color }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      className="rounded-[22px] border px-4 py-3 flex flex-col transition-all duration-300 shadow-[0_18px_45px_rgba(0,0,0,0.45)]"
      style={{
        background: color,
        borderColor: hovered ? "rgba(147,197,253,0.45)" : "rgba(255,255,255,0.12)",
        boxShadow: hovered
          ? "0 25px 55px rgba(59,130,246,0.25)"
          : "0 18px 45px rgba(0,0,0,0.45)",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
    </div>
  );
}
