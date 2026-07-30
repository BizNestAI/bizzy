// /src/components/Tax/TaxLiabilityChart.jsx
import React, { useId, useMemo } from "react";
import {
  Area,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
  ReferenceDot,
} from "recharts";
import CardHeader from "../UI/CardHeader";
import { RefreshCw } from "lucide-react";
import { buildTaxTrendChartData } from "./taxTrendAdapter.js";

const ACTUAL_STROKE = "rgba(var(--accent-rgb),1)";
const PROJECTED_STROKE = "rgba(125,211,252,0.82)";
const MARKER_STROKE = "rgba(251,191,36,0.82)";

export default function TaxLiabilityChart({
  data = [],
  taxYear,
  asOfDate,
  payments,
  reserve,
  deadlines = [],
  height = 280,
  title = "TAX LIABILITY TRAJECTORY",
  source,
  loading = false,
  onRefresh,
  showGrid = true,
  showHeader = true,
  explanation,
  onPointSelect,
}) {
  const chartId = useId().replace(/:/g, "");
  const model = useMemo(
    () => buildTaxTrendChartData({ trend: data, taxYear, asOfDate, payments, reserve, deadlines }),
    [data, taxYear, asOfDate, payments, reserve, deadlines]
  );
  const hasData = model.points.some((point) => point.actualValue != null || point.projectedValue != null);

  return (
    <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[var(--panel)] shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.035] via-transparent to-black/10" />
      {showHeader ? (
        <div className="relative">
          <CardHeader
            title={title}
            badge={source === "demo" || source === "mock" ? "Demo" : source === "live" ? "Live" : undefined}
            actions={
              onRefresh ? (
                <button
                  type="button"
                  onClick={onRefresh}
                  className="inline-flex items-center gap-2 rounded-lg border border-white/12 px-3 py-1.5 text-xs text-white transition hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-emerald-300/35"
                >
                  <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
                  Refresh
                </button>
              ) : null
            }
          />
        </div>
      ) : null}

      <div className="relative px-3 pt-3">
        <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px] text-white/62" aria-label="Chart legend">
          <LegendSwatch label="Actual / through today" className="border-solid border-[rgba(var(--accent-rgb),1)]" />
          <LegendSwatch label="Projected" className="border-dashed border-slate-200/80" />
          {model.deadlineMarkers.length ? <LegendSwatch label="Deadline" className="border-dotted border-amber-200/90" /> : null}
        </div>
        <p id={`${chartId}-summary`} className="sr-only">
          {model.chartDescription}
        </p>
        {explanation ? (
          <p className="mb-2 text-xs leading-relaxed text-white/56">{explanation}</p>
        ) : null}
      </div>

      <div className="relative" style={{ height }} role="img" aria-describedby={`${chartId}-summary`}>
        {!hasData ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-white/58">
            Tax trajectory is not available yet. Complete setup or refresh once canonical trend data exists.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={model.points}
              margin={{ top: 24, right: 22, left: 12, bottom: 18 }}
              onClick={(state) => {
                const point = state?.activePayload?.find((item) => item?.payload)?.payload;
                if (point) onPointSelect?.(point);
              }}
              style={onPointSelect ? { cursor: "pointer" } : undefined}
            >
              {showGrid ? (
                <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="4 8" vertical={false} />
              ) : null}
              <defs>
                <filter id={`${chartId}-actualGlow`} x="-20%" y="-20%" width="140%" height="140%">
                  <feDropShadow dx="0" dy="0" stdDeviation="4" floodColor="rgba(var(--accent-rgb),1)" floodOpacity="0.18" />
                </filter>
                <filter id={`${chartId}-projectedGlow`} x="-20%" y="-20%" width="140%" height="140%">
                  <feDropShadow dx="0" dy="0" stdDeviation="4" floodColor="rgba(125,211,252,1)" floodOpacity="0.12" />
                </filter>
                <linearGradient id={`${chartId}-actualFill`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="rgba(var(--accent-rgb),0.18)" />
                  <stop offset="72%" stopColor="rgba(var(--accent-rgb),0.035)" />
                  <stop offset="100%" stopColor="rgba(var(--accent-rgb),0)" />
                </linearGradient>
                <linearGradient id={`${chartId}-projectedFill`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="rgba(125,211,252,0.14)" />
                  <stop offset="74%" stopColor="rgba(125,211,252,0.025)" />
                  <stop offset="100%" stopColor="rgba(125,211,252,0)" />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="key"
                tickLine={false}
                axisLine={false}
                tick={{ fill: "rgba(255,255,255,0.58)", fontSize: 11, fontWeight: 600 }}
                tickFormatter={(key) => model.points.find((point) => point.key === key)?.monthLabel || key}
                interval="preserveStartEnd"
                minTickGap={18}
              />
              <YAxis
                domain={model.yDomain}
                tickLine={false}
                axisLine={false}
                tick={{ fill: "rgba(255,255,255,0.58)", fontSize: 11, fontWeight: 600 }}
                tickFormatter={(value) => formatCompactMoney(value)}
                width={50}
              />
              <Tooltip content={<TaxTooltip />} wrapperStyle={{ outline: "none" }} />

              {model.quarterMarkers.map((marker) => (
                <ReferenceLine
                  key={marker.key}
                  x={marker.month}
                  stroke="rgba(255,255,255,0.14)"
                  strokeDasharray="3 7"
                  ifOverflow="extendDomain"
                  label={{ value: marker.label, position: "top", fill: "rgba(255,255,255,0.48)", fontSize: 10 }}
                />
              ))}
              {model.deadlineMarkers.map((marker) => (
                <ReferenceLine
                  key={marker.key}
                  x={marker.month}
                  stroke={MARKER_STROKE}
                  strokeDasharray="2 5"
                  ifOverflow="extendDomain"
                  label={{ value: "Due", position: "insideTop", fill: "rgba(253,230,138,0.72)", fontSize: 10 }}
                />
              ))}
              {model.currentPoint ? (
                <ReferenceLine
                  x={model.currentPoint.key}
                  stroke="rgba(var(--accent-rgb),0.28)"
                  strokeDasharray="4 5"
                  label={{
                    value: asOfDate ? `Through ${formatShortDate(asOfDate)}` : "Current estimate",
                    fill: "rgba(209,250,229,0.82)",
                    fontSize: 11,
                    position: "insideTopRight",
                  }}
                />
              ) : null}

              <Area
                type="monotone"
                dataKey="actualValue"
                name="Actual / through today"
                stroke="none"
                fill={`url(#${chartId}-actualFill)`}
                connectNulls={false}
                isAnimationActive={false}
                activeDot={false}
              />
              <Area
                type="monotone"
                dataKey="projectedValue"
                name="Projected"
                stroke="none"
                fill={`url(#${chartId}-projectedFill)`}
                connectNulls={false}
                isAnimationActive={false}
                activeDot={false}
              />
              <Line
                type="monotone"
                dataKey="actualValue"
                name="Actual / through today"
                stroke={ACTUAL_STROKE}
                strokeWidth={2.8}
                connectNulls={false}
                filter={`url(#${chartId}-actualGlow)`}
                dot={{ r: 3, fill: "var(--panel)", stroke: ACTUAL_STROKE, strokeWidth: 1.5 }}
                activeDot={{ r: 6, fill: ACTUAL_STROKE, stroke: "var(--panel)", strokeWidth: 1.7 }}
              />
              <Line
                type="monotone"
                dataKey="projectedValue"
                name="Projected"
                stroke={PROJECTED_STROKE}
                strokeWidth={2.55}
                strokeDasharray="7 6"
                connectNulls={false}
                filter={`url(#${chartId}-projectedGlow)`}
                dot={{ r: 2.5, fill: "var(--panel)", stroke: PROJECTED_STROKE, strokeWidth: 1.3 }}
                activeDot={{ r: 5, fill: PROJECTED_STROKE, stroke: "var(--panel)", strokeWidth: 1.5 }}
              />
              {model.currentPoint && (model.currentPoint.actualValue ?? model.currentPoint.projectedValue) != null ? (
                <ReferenceDot
                  x={model.currentPoint.key}
                  y={model.currentPoint.actualValue ?? model.currentPoint.projectedValue}
                  r={6}
                  fill="var(--panel)"
                  stroke={ACTUAL_STROKE}
                  strokeWidth={2.4}
                  isFront
                />
              ) : null}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function TaxTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const point = payload.find((item) => item?.payload)?.payload;
  if (!point) return null;
  const cumulative = point.actualValue ?? point.projectedValue ?? point.combinedValue;
  const warning = point.warnings?.[0];
  return (
    <div className="max-w-[280px] rounded-xl border border-white/12 bg-black/90 px-3 py-2 text-xs text-white shadow-xl">
      <div className="text-sm font-semibold text-white">{point.fullLabel}</div>
      <div className="mb-2 text-white/58">{point.periodLabel}</div>
      <TooltipRow label="Estimated cumulative tax" value={formatMoney(cumulative)} />
      <TooltipRow label="Projected year-end" value={formatMoney(point.projectedYearEndTax)} />
      <TooltipRow label="Paid and withheld" value={formatMoney(point.paymentsApplied)} />
      <TooltipRow label="Reserve target" value={formatMoney(point.reserveTarget)} />
      {point.confidenceLevel ? <TooltipRow label="Confidence" value={capitalize(point.confidenceLevel)} /> : null}
      {warning ? <div className="mt-2 rounded-lg bg-amber-300/10 px-2 py-1 text-amber-100">{warning.message || warning.code}</div> : null}
    </div>
  );
}

function TooltipRow({ label, value }) {
  return (
    <div className="mt-1 flex items-start justify-between gap-3">
      <span className="text-white/55">{label}</span>
      <span className="text-right font-semibold text-white">{value}</span>
    </div>
  );
}

function LegendSwatch({ label, className }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`inline-block w-7 border-t-2 ${className}`} aria-hidden="true" />
      {label}
    </span>
  );
}

function formatMoney(value) {
  if (value == null || !Number.isFinite(Number(value))) return "Not available";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value));
}

function formatCompactMoney(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  if (Math.abs(n) >= 1000) return `$${Math.round(n / 100) / 10}k`;
  return `$${n}`;
}

function formatShortDate(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "today";
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function capitalize(value) {
  return String(value || "").replaceAll("_", " ").replace(/^\w/, (char) => char.toUpperCase());
}
