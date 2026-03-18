// /src/components/Tax/TaxLiabilityChart.jsx
import React, { useMemo } from "react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import CardHeader from "../UI/CardHeader";
import { RefreshCw } from "lucide-react";

const ACCENT = "rgba(var(--accent-rgb),1)";
const ACCENT_FILL = "rgba(var(--accent-rgb),0.18)";

function monthLabel(iso = "") {
  const dt = new Date(`${iso}-01T00:00:00Z`);
  return dt.toLocaleString(undefined, { month: "short" });
}
function fmtMoney(val = 0) {
  const n = Number(val) || 0;
  if (Math.abs(n) >= 1000) return `$${Math.round(n / 100) / 10}k`;
  return `$${n}`;
}

function TaxTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const point = payload[0];
  const value = point?.value ?? 0;
  return (
    <div className="rounded-xl border border-white/12 bg-black/85 px-3 py-2 text-xs text-white shadow-xl">
      <div className="text-white/70 mb-1">{label}</div>
      <div className="text-white">
        Estimated tax: <span className="font-semibold">{fmtMoney(value)}</span>
      </div>
    </div>
  );
}

/**
 * Props:
 * - data: Array<{ month: "YYYY-MM", estTax: number }>
 * - height?: number
 * - title?: string
 * - source?: "mock" | "live"
 * - loading?: boolean
 * - onRefresh?: () => void
 * - showGrid?: boolean
 * - quarters?: Array<{ quarter?: string, index?: number, label?: string }>
 * - showHeader?: boolean
 */
export default function TaxLiabilityChart({
  data = [],
  height = 260,
  title = "TAX LIABILITY TREND",
  source,
  loading = false,
  onRefresh,
  showGrid = false,
  quarters = [],
  showHeader = true,
}) {
  const chartData = useMemo(
    () =>
      (data || []).map((d) => ({
        label: monthLabel(d.month?.slice(0, 7) || d.month || ""),
        tax: Number(d.estTax ?? 0),
      })),
    [data]
  );

  return (
    <div className="rounded-3xl border border-white/10 bg-[#0A0C12] shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
      {showHeader ? (
        <CardHeader
          title={title}
          badge={source === "mock" ? "Demo" : source === "live" ? "Live" : undefined}
          actions={
            onRefresh ? (
              <button
                type="button"
                onClick={onRefresh}
                className="inline-flex items-center gap-2 rounded-lg border border-white/12 px-3 py-1.5 text-xs text-white hover:bg-white/5 transition"
              >
                <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
                Refresh
              </button>
            ) : null
          }
        />
      ) : null}
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 28, right: 16, left: 12, bottom: 18 }}>
            {showGrid ? <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} /> : null}
            {(quarters || []).map((q, idx) => {
              const xLabel = chartData[q.index ?? 0]?.label || q.label;
              if (!xLabel) return null;
              return (
                <ReferenceLine
                  key={`${xLabel}-${idx}`}
                  x={xLabel}
                  stroke="rgba(255,255,255,0.18)"
                  strokeDasharray="4 7"
                  ifOverflow="extendDomain"
                  label={
                    q.quarter
                      ? { value: q.quarter, position: "top", fill: "rgba(255,255,255,0.6)", fontSize: 10 }
                      : undefined
                  }
                />
              );
            })}
            <defs>
              <linearGradient id="taxArea" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={ACCENT_FILL} stopOpacity={1} />
                <stop offset="100%" stopColor="rgba(var(--accent-rgb),0.02)" stopOpacity={0.4} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={{ fill: "rgba(255,255,255,0.65)", fontSize: 12 }}
              interval="preserveStartEnd"
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={{ fill: "rgba(255,255,255,0.65)", fontSize: 12 }}
              tickFormatter={(v) => fmtMoney(v)}
              width={48}
            />
            <Tooltip
              content={<TaxTooltip />}
            />
            <Area type="monotone" dataKey="tax" stroke="none" fill="url(#taxArea)" fillOpacity={1} />
            <Line
              type="monotone"
              dataKey="tax"
              stroke={ACCENT}
              strokeWidth={2.2}
              dot={{ r: 3.2, fill: "#0F172A", stroke: ACCENT, strokeWidth: 1.2 }}
              activeDot={{ r: 5, fill: ACCENT, stroke: "#0F172A", strokeWidth: 1.4 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
