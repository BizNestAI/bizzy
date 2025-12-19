// /src/components/Tax/TaxLiabilityChart.jsx
import React, { useMemo, useRef, useState } from "react";
import CardHeader from "../ui/CardHeader";
import { RefreshCw } from "lucide-react";

/**
 * Props:
 * - data: Array<{ month: "YYYY-MM", estTax: number }>
 * - overlay?: Array<{ month: "YYYY-MM", netCash: number, atRisk?: boolean }>
 * - quarters?: Array<{ quarter: "Q1"|"Q2"|"Q3"|"Q4", due: ISODate }>
 * - height?: number (default 180)  -> height of the SVG plot area (not counting header)
 * - currency?: string (default "USD")
 * - title?: string (default "TAX LIABILITY TREND")
 * - source?: "mock" | "live" | undefined (adds a small badge if provided)
 * - loading?: boolean (for refresh button spinner)
 * - onRefresh?: () => void  (optional)
 * - showGrid?: boolean (default true)
 */
export default function TaxLiabilityChart({
  data = [],
  overlay = [],
  quarters = [],
  height = 180,
  currency = "USD",
  title = "TAX LIABILITY TREND",
  source,
  loading = false,
  onRefresh,
  showGrid = true,
}) {
  const GOLD = "rgba(227, 194, 92, 1)";               // muted gold (tax theme)
  const GOLD_AREA_TOP = "rgba(227, 194, 92, 0.22)";
  const GRID = "rgba(255,255,255,0.06)";
  const AXIS = "rgba(255,255,255,0.65)";
  const CYAN = "rgba(125, 211, 252, 0.65)";

  const containerRef = useRef(null);
  const [hover, setHover] = useState(null); // {x, y, label, value, month}

  const {
    viewBox,
    path,
    area,
    xTicks,
    yTicks,
    xScale,
    yScale,
    pts,
    overlayPts,
    qMarkers,
    maxY,
  } = useMemo(() => {
    const w = 640; // virtual width; scales to container width
    const h = height;
    const pad = { top: 10, right: 16, bottom: 28, left: 44 };

    const months = (data || []).map((d) => d.month);
    const xs = (i) => {
      if (!data?.length || data.length === 1)
        return pad.left + (w - pad.left - pad.right) / 2;
      return pad.left + (i * (w - pad.left - pad.right)) / (data.length - 1);
    };

    const values = (data || []).map((d) => Number(d.estTax) || 0);
    let baseMin = Math.min(0, ...values);
    let baseMax = Math.max(0, ...values);
    let span = baseMax - baseMin;
    const lowerBound = 4000;
    if (span < lowerBound) {
      const center = (baseMax + baseMin) / 2;
      baseMin = center - lowerBound / 2;
      baseMax = center + lowerBound / 2;
      span = lowerBound;
    }
    baseMax += span * 0.1;
    baseMin = Math.max(0, baseMin - span * 0.05);
    const { ticks: niceTicks, niceMin, niceMax } = buildNiceTicks(baseMin, baseMax, 4);
    const yMin = niceMin;
    const yMax = niceMax;
    const range = yMax - yMin || 1;

    const ys = (v) => {
      const clamped = Math.max(yMin, Math.min(yMax, Number(v) || 0));
      const t = (clamped - yMin) / range;
      return h - pad.bottom - t * (h - pad.top - pad.bottom);
    };

    // main series
    const pts = (data || []).map((d, i) => [xs(i), ys(+d.estTax || 0), d]);
    let path = "";
    if (pts.length) {
      path = `M ${pts[0][0]},${pts[0][1]}`;
      for (let i = 1; i < pts.length; i++) path += ` L ${pts[i][0]},${pts[i][1]}`;
    }

    // area fill under line
    let area = "";
    if (pts.length) {
      area = `M ${pts[0][0]},${h - pad.bottom}`;
      for (let i = 0; i < pts.length; i++) area += ` L ${pts[i][0]},${pts[i][1]}`;
      area += ` L ${pts[pts.length - 1][0]},${h - pad.bottom} Z`;
    }

    // overlay (net cash)
    const monthToIndex = new Map(months.map((m, i) => [m, i]));
    const overlayPts = (overlay || [])
      .map((o) => {
        const i = monthToIndex.get((o.month || "").slice(0, 7));
        if (i == null) return null;
        return [xs(i), ys(+o.netCash || 0), o];
      })
      .filter(Boolean);

    // ticks
    const xTicks = months.map((m, i) => ({ x: xs(i), label: m.slice(5) })); // "MM"
    const yTicks = niceTicks.map((val) => ({ y: ys(val), label: fmtMoney(val, currency) }));

    // quarter markers
    const dueMap = new Map(quarters.map((q) => [String(q.due).slice(0, 7), q]));
    const qMarkers = months
      .map((m, i) => {
        const q = dueMap.get(m);
        if (!q) return null;
        return { x: xs(i), label: q.quarter, due: q.due };
      })
      .filter(Boolean);

    const viewBox = `0 0 ${w} ${h}`;
    return {
      viewBox,
      path,
      area,
      xTicks,
      yTicks,
      xScale: xs,
      yScale: ys,
      pts,
      overlayPts,
      qMarkers,
      maxY: yMax,
    };
  }, [data, overlay, quarters, height, currency]);

  function onMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (!pts?.length || rect.width === 0) return setHover(null);
    const scaledX = (px / rect.width) * 640;
    const nearest = pts.reduce((best, p) => {
      const dx = Math.abs(p[0] - scaledX);
      return !best || dx < best.dx ? { dx, p } : best;
    }, null);
    if (!nearest) return setHover(null);
    const [x, y, d] = nearest.p;
    setHover({
      x,
      y,
      value: d.estTax,
      month: d.month,
      label: `${d.month}: ${fmtMoney(d.estTax, currency)}`,
    });
  }
  function onLeave() {
    setHover(null);
  }

  // tooltip positioning clamp within container
  const tooltipLeft = (x) => {
    const w = containerRef.current?.clientWidth || 640;
    const px = (x / 640) * w;
    const width = 160; // tooltip width assumption
    return Math.min(Math.max(8, px - width / 2), Math.max(8, w - width - 8));
  };

  // Source badge (optional)
  const sourceBadge =
    source === "mock"
      ? "text-[10px] px-2 py-0.5 rounded-full ring-1 ring-inset ring-[rgba(227,194,92,.28)] text-[rgba(227,194,92,.9)] bg-[rgba(227,194,92,.08)]"
      : source === "live"
      ? "text-[10px] px-2 py-0.5 rounded-full ring-1 ring-inset ring-[rgba(16,185,129,.28)] text-[rgba(16,185,129,.9)] bg-[rgba(16,185,129,.08)]"
      : "";

  return (
    <div ref={containerRef} className="w-full">
      {/* Header to match app-wide CardHeader style */}
      <CardHeader
        title={title?.toUpperCase?.() ?? title}
        size="sm"
        dense
        className="mb-2"
        titleClassName="text-[13px]"
        right={
          <div className="flex items-center gap-2">
            {source ? <span className={sourceBadge}>{source === "mock" ? "Mock" : "Live"}</span> : null}
            {onRefresh ? (
              <button
                type="button"
                onClick={onRefresh}
                className="text-[12px] inline-flex items-center gap-1.5 px-2 py-1 rounded-md ring-1 ring-inset ring-white/12 hover:bg-white/10"
              >
                {loading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Refresh
              </button>
            ) : null}
          </div>
        }
      />

      {/* Plot area */}
      <div className="relative w-full" style={{ height }}>
        <svg viewBox={viewBox} className="absolute inset-0 h-full w-full">
          <defs>
            <linearGradient id="taxAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopOpacity="0.22" stopColor={GOLD} />
              <stop offset="100%" stopOpacity="0" stopColor={GOLD} />
            </linearGradient>
          </defs>

          {/* Gridlines (very light) */}
          {showGrid &&
            yTicks.map((t, i) => (
              <line
                key={`gy${i}`}
                x1="44"
                x2="624"
                y1={t.y}
                y2={t.y}
                stroke={GRID}
                strokeDasharray="2 4"
              />
            ))}

          {/* Area + line */}
          <path d={area} fill="url(#taxAreaGrad)" />
          <path d={path} fill="none" stroke={GOLD} strokeWidth="2" opacity="0.9" />

          {/* Overlay line (net cash, muted cyan dashed) */}
          {overlayPts?.length ? (
            <path
              d={`M ${overlayPts.map((p) => `${p[0]},${p[1]}`).join(" L ")}`}
              fill="none"
              stroke={CYAN}
              strokeWidth="1.5"
              strokeDasharray="4 4"
            />
          ) : null}

          {/* At-risk markers */}
          {overlayPts?.length
            ? overlayPts
                .filter((p) => p[2]?.atRisk)
                .map((p, i) => <circle key={`risk${i}`} cx={p[0]} cy={p[1]} r="3.5" fill="#ef4444" />)
            : null}

          {/* Quarter markers in muted gold */}
          {qMarkers.map((m, i) => (
            <g key={`q${i}`}>
              <line x1={m.x} x2={m.x} y1="10" y2={height - 28} stroke="rgba(227,194,92,0.18)" />
              <rect x={m.x - 10} y="12" width="20" height="12" rx="3" fill="rgba(227,194,92,0.14)" />
              <text x={m.x} y="21" fontSize="9" fill={GOLD} textAnchor="middle">
                {m.label}
              </text>
            </g>
          ))}

          {/* Axes */}
          {yTicks.map((t, i) => (
            <text key={`ty${i}`} x="40" y={t.y + 3} fontSize="10" fill={AXIS} textAnchor="end">
              {t.label}
            </text>
          ))}
          {xTicks.map((t, i) => (
            <text key={`tx${i}`} x={t.x} y={height - 10} fontSize="10" fill={AXIS} textAnchor="middle">
              {t.label}
            </text>
          ))}

          {/* Hover target */}
          <rect
            x="0"
            y="0"
            width="100%"
            height="100%"
            fill="transparent"
            onMouseMove={onMove}
            onMouseLeave={onLeave}
          />

          {/* Hover guides */}
          {hover ? (
            <g>
              <line x1={hover.x} x2={hover.x} y1="10" y2={height - 28} stroke="rgba(255,255,255,0.25)" />
              <circle cx={hover.x} cy={hover.y} r="3.5" fill={GOLD} />
            </g>
          ) : null}
        </svg>

        {/* Tooltip */}
        {hover ? (
          <div
            className="pointer-events-none absolute px-2 py-1 rounded-md text-[11px] bg-black/75 ring-1 ring-inset ring-white/10 text-white/90"
            style={{
              left: tooltipLeft(hover.x),
              top: 6,
              width: 160,
            }}
            role="tooltip"
          >
            {hover.label}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ------- helpers ------- */
function fmtMoney(n, currency = "USD") {
  return (typeof n === "number" ? n : Number(n || 0)).toLocaleString(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  });
}
function niceNumber(range, round) {
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / Math.pow(10, exponent);
  let niceFraction;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else {
    if (fraction <= 1) niceFraction = 1;
    else if (fraction <= 2) niceFraction = 2;
    else if (fraction <= 5) niceFraction = 5;
    else niceFraction = 10;
  }
  return niceFraction * Math.pow(10, exponent);
}

function buildNiceTicks(min, max, target = 4) {
  let range = max - min;
  if (!Number.isFinite(range) || range === 0) {
    range = Math.abs(max || 1);
    min -= range * 0.1;
    max += range * 0.1;
  }
  const niceRange = niceNumber(Math.abs(max - min) || 1, false);
  const spacing = niceNumber(niceRange / Math.max(1, target - 1), true);
  const niceMin = Math.floor(min / spacing) * spacing;
  const niceMax = Math.ceil(max / spacing) * spacing;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + spacing * 0.5; v += spacing) {
    ticks.push(v);
  }
  return { ticks, niceMin, niceMax };
}
