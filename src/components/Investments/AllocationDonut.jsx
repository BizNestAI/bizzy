// src/components/Investments/AllocationDonut.jsx
import React, { useMemo } from "react";
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
} from "recharts";

const NEON = "#C084FC";
const COLORS = [NEON, "#8AB4FF", "#34D399", "#F59E0B", "#60A5FA", "#F472B6", "#A78BFA", "#22D3EE"];
const fmtUSD = (n) => `$${(Number(n || 0)).toLocaleString()}`;
const fmtPct = (n) => `${(Math.round(Number(n || 0) * 10) / 10).toFixed(1)}%`;

function titleCase(s = "") {
  return s
    .toString()
    .split(/[_\s-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Compact tooltip — appears where you hover (no entrance animation) */
function AllocTooltip({ active, payload, coordinate, totalUSD }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  const pct = Number(p.value || 0);
  const dollars = (totalUSD * pct) / 100;

  const style = {
    position: "absolute",
    left: coordinate?.x ?? 0,
    top: (coordinate?.y ?? 0) - 8,
    transform: "translate(-50%, -100%)",
    background: "#0B0E13",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 12,
    padding: "8px 10px",
    pointerEvents: "none",
    whiteSpace: "nowrap",
    minWidth: 140,
  };

  return (
    <div style={style}>
      <div style={{ color: "white", fontWeight: 600, marginBottom: 2 }}>
        {titleCase(p.name)}
      </div>
      <div style={{ color: "rgba(255,255,255,0.85)", fontSize: 12 }}>{fmtUSD(dollars)}</div>
      <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 12 }}>{fmtPct(pct)} of total</div>
    </div>
  );
}

export default function AllocationDonut({
  allocation = null,
  totalUSD = 0,
  caption = "Aggregated Asset Allocation",
  height = 220, // optionally control height from AccountCards
}) {
  const allocArr = useMemo(() => {
    if (!allocation || typeof allocation !== "object") return [];
    return Object.entries(allocation)
      .map(([name, value]) => ({ name, value: Number(value) }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [allocation]);

  return (
    <section
      className="rounded-2xl p-3 sm:p-4 border"
      style={{
        borderColor: "rgba(179,136,255,0.20)", // muted purple ring
        background: "#0f1012",
        boxShadow: "0 10px 24px rgba(0,0,0,.22)",
      }}
    >
      <div className="text-[12px] uppercase tracking-wide text-white/60 mb-2">
        {caption}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Donut + center total overlay */}
        <div className="relative lg:col-span-1" style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={allocArr}
                dataKey="value"
                nameKey="name"
                innerRadius={60}
                outerRadius={85}
                paddingAngle={3}
                isAnimationActive={false}
              >
                {allocArr.map((entry, idx) => (
                  <Cell
                    key={entry.name || idx}
                    fill={COLORS[idx % COLORS.length]}
                    stroke="rgba(255,255,255,0.08)"
                  />
                ))}
              </Pie>

              {/* Tooltip: instant, next-to-cursor (no slide-in/fly-in) */}
              <Tooltip
                content={<AllocTooltip totalUSD={totalUSD} />}
                wrapperStyle={{ outline: "none" }}
                isAnimationActive={false}
                cursor={{ fill: "rgba(255,255,255,0.04)" }}
              />
            </PieChart>
          </ResponsiveContainer>

          {/* HTML overlay in the exact center of the donut */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="text-center leading-tight">
              <div className="text-white font-semibold text-[13px] sm:text-[14px]">
                {fmtUSD(totalUSD)}
              </div>
              <div className="text-white/60 text-[11px]">Total</div>
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="lg:col-span-2">
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {allocArr.map((d, i) => {
              const color = COLORS[i % COLORS.length];
              const dollars = totalUSD * (d.value / 100);
              return (
                <li key={d.name} className="flex items-center gap-3">
                  <span className="inline-block h-3 w-3 rounded-full" style={{ background: color }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] sm:text-sm text-white/90 truncate">{titleCase(d.name)}</div>
                    <div className="text-[12px] text-white/60">
                      {fmtPct(d.value)} • {fmtUSD(dollars)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="text-[12px] text-white/40 mt-3">
            Based on {fmtUSD(totalUSD)} brokerage value (tax-advantaged balances omitted).
          </div>
        </div>
      </div>
    </section>
  );
}
