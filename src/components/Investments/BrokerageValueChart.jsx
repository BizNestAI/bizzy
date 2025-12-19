// src/components/Investments/BrokerageValueChart.jsx
import React, { useMemo, useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceDot,
} from "recharts";

const NEON = "#C084FC";

// ---------- helpers ----------
const fmtUSD = (n) => `$${(Number(n || 0)).toLocaleString()}`;

function monthLabels(count = 12) {
  const now = new Date();
  const labels = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    labels.push(d.toLocaleString(undefined, { month: "short" }));
  }
  return labels;
}

function mockValueSeriesFromTotal(total) {
  const labels = monthLabels(12);
  let base = Number(total || 0);
  if (base <= 0) base = 10000;
  const out = [];
  let acc = base * 0.92;
  for (let i = 0; i < labels.length; i++) {
    const wiggle = Math.sin(i / 2.8) * (base * 0.01) + (Math.random() - 0.5) * (base * 0.005);
    acc = Math.max(0, acc + wiggle);
    out.push({ m: labels[i], v: Math.round(acc) });
  }
  return out;
}

// Normalize whatever we get from server (value_series) into [{m, v}]
function normalizeSeries(series, fallbackTotal) {
  if (Array.isArray(series) && series.length) {
    const first = series[0] || {};
    if ("m" in first && "v" in first) return series.map((r) => ({ m: r.m, v: Number(r.v || 0) }));
    return series.map((r) => ({
      m: r.m || r.month || r.date || "",
      v: Number(r.v ?? r.value ?? r.amount ?? 0),
    }));
  }
  return mockValueSeriesFromTotal(fallbackTotal);
}

// Sum multiple accounts by month label
function sumSeries(allSeries) {
  const labels = monthLabels(12);
  const map = new Map(labels.map((l) => [l, 0]));
  (allSeries || []).forEach((s) => {
    (s || []).forEach(({ m, v }) => {
      if (!map.has(m)) map.set(m, 0);
      map.set(m, map.get(m) + Number(v || 0));
    });
  });
  return labels.map((m) => ({ m, v: map.get(m) || 0 }));
}

export default function BrokerageValueChart({
  accounts = [],
  totalUSD = 0,
  /** optional: chart height (px) */
  height = 180,
}) {
  // Build toggle options (All + each account)
  const toggleOptions = useMemo(() => {
    const list = [
      { id: "all", label: "All accounts", series: null },
      ...accounts.map((a, i) => ({
        id: a.id || a.account_id || String(i),
        label: a.account_name || a.institution || "Account",
        account: a,
      })),
    ];
    return list;
  }, [accounts]);

  const [selected, setSelected] = useState(toggleOptions[0]?.id || "all");

  // Build series for selected option
  const series = useMemo(() => {
    if (selected === "all") {
      const all = accounts.map((a) =>
        normalizeSeries(a?.value_series, a?.balance_usd || totalUSD)
      );
      return sumSeries(all);
    }
    const acc = toggleOptions.find((o) => o.id === selected)?.account;
    if (!acc) return mockValueSeriesFromTotal(totalUSD);
    return normalizeSeries(acc.value_series, acc.balance_usd || totalUSD);
  }, [selected, toggleOptions, accounts, totalUSD]);

  // Axis domain + last point
  const { yDomain, lastPoint } = useMemo(() => {
    const vals = series.map((d) => Number(d.v || 0));
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const pad = Math.max(1, (max - min) * 0.08);
    return {
      yDomain: [Math.max(0, min - pad), max + pad],
      lastPoint: series[series.length - 1],
    };
  }, [series]);

  return (
    <div className="w-full">
      {/* Top row: big value + note on the left; toggle on the right.
          (we removed the small duplicate title here) */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-3xl font-semibold">{fmtUSD(totalUSD)}</div>
          <div className="text-[11px] text-white/50 mt-0.5">
            (Tax-advantaged accounts omitted here; see allocation below)
          </div>
        </div>

        {/* Toggle pills */}
        {toggleOptions.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {toggleOptions.map((opt) => {
              const active = selected === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={() => setSelected(opt.id)}
                  className={[
                    "text-[12px] px-3 py-1.5 rounded-full border bg-black/30",
                    active
                      ? "border-white/40 text-white"
                      : "border-white/10 text-white/70 hover:border-white/25 hover:text-white",
                  ].join(" ")}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Chart */}
      <div className="mt-4" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={series}
            margin={{ top: 8, right: 12, left: 0, bottom: 8 }}
          >
            <defs>
              <linearGradient id="invArea" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={NEON} stopOpacity={0.35} />
                <stop offset="100%" stopColor={NEON} stopOpacity={0.02} />
              </linearGradient>
            </defs>

            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis
              dataKey="m"
              tick={{ fontSize: 11, fill: "rgba(255,255,255,0.75)" }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              yAxisId={0}
              domain={yDomain}
              tickFormatter={(v) => `$${Math.round(v / 1000)}k`}
              tick={{ fontSize: 11, fill: "rgba(255,255,255,0.75)" }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              formatter={(v) => [fmtUSD(v), "Value"]}
              labelFormatter={(l) => `Month: ${l}`}
              contentStyle={{
                background: "#0B0E13",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 12,
              }}
            />

            {/* Shaded area anchored to visible domain (not 0) */}
            <Area
              yAxisId={0}
              baseValue="dataMin"
              type="monotone"
              dataKey="v"
              stroke="none"
              fill="url(#invArea)"
              isAnimationActive={false}
            />
            <Line
              yAxisId={0}
              type="monotone"
              dataKey="v"
              stroke={NEON}
              strokeWidth={2}
              dot={false}
            />
            {lastPoint && (
              <ReferenceDot
                yAxisId={0}
                x={lastPoint.m}
                y={lastPoint.v}
                r={4}
                fill={NEON}
                stroke="white"
                strokeWidth={1}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
