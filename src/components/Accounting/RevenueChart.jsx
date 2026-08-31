// /src/components/Accounting/RevenueChart.jsx
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
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
  ReferenceDot,
} from "recharts";
import useFinancialPeriod from "../../hooks/useFinancialPeriod.js";
import CardHeader from "../UI/CardHeader"; // shared header (Pulse style)
import { getDemoData, shouldForceLiveData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import { apiFetch } from "../../utils/apiBase.js";

/* ---------------- helpers ---------------- */
function monthShortLabel(y, m) {
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: "short" });
}
function pad2(n) { return String(n).padStart(2, "0"); }
function monthKey(y, m) { return `${y}-${pad2(m)}-01`; }
function seqLastNMonths({ year, month, n = 12 }) {
  const out = [];
  let y = year;
  let m = month;
  for (let i = 0; i < n; i++) {
    out.unshift({ year: y, month: m });
    m--;
    if (m < 1) { m = 12; y--; }
  }
  return out;
}
function coalesceRevenue(payload) {
  const obj = payload?.metrics ?? payload ?? {};
  return obj.totalRevenue ?? obj.total_revenue ?? null;
}
function toChartData(rows) {
  return rows.map((r, idx) => ({
    month: monthShortLabel(r.year, r.month),
    revenue: Number(r.revenue ?? 0),
    isCurrent: idx === rows.length - 1,
  }));
}
function allSame(values) {
  if (!values.length) return true;
  return values.every((v) => Number(v) === Number(values[0]));
}
function buildMock(windowMonths) {
  const base = [
    18000, 22000, 28000, 32000, 30000, 37000,
    41000, 39000, 44000, 46000, 48000, 50000,
  ];
  const months =
    windowMonths.length
      ? windowMonths
      : seqLastNMonths({
          year: new Date().getFullYear(),
          month: new Date().getMonth() + 1,
          n: 12,
        });
  return months.map((m, i) => ({
    year: m.year,
    month: m.month,
    revenue: base[i % base.length],
  }));
}
function buildSlidingDemoRows(windowMonths, sourceRows = [], valueKey = "revenue") {
  const values = (sourceRows || [])
    .map((row) => Number(row?.[valueKey] ?? 0))
    .filter((value) => Number.isFinite(value));
  const fallback = buildMock(windowMonths).map((row) => Number(row.revenue || 0));
  const seriesValues = values.length ? values : fallback;
  return windowMonths.map(({ year, month }, index) => ({
    year,
    month,
    revenue: seriesValues[index % seriesValues.length] ?? 0,
  }));
}

const REVENUE_SERIES_CACHE = new Map();

function niceRevenueCeiling(value) {
  const padded = Math.max(60000, Number(value || 0) * 1.12);
  if (padded <= 60000) return 60000;
  const magnitude = Math.pow(10, Math.floor(Math.log10(padded)));
  const normalized = padded / magnitude;
  const niceNormalized =
    normalized <= 1.5 ? 1.5 :
    normalized <= 2 ? 2 :
    normalized <= 2.5 ? 2.5 :
    normalized <= 5 ? 5 :
    10;
  return niceNormalized * magnitude;
}

/* ——— tiny measure hook (ResizeObserver) ——— */
function useMeasure() {
  const ref = useRef(null);
  const [rect, setRect] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const cr = entry?.contentRect;
      if (cr) setRect({ width: cr.width, height: cr.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, rect];
}

function RevenueTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const point = payload.find((entry) => entry?.dataKey === "revenue");
  if (!point) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-black/90 px-3 py-2 shadow-lg text-sm text-white/90">
      <div className="text-xs text-white/70 mb-1">{label}</div>
      <div>
        Revenue: <span className="font-semibold text-white">${Number(point.value).toLocaleString()}</span>
      </div>
    </div>
  );
}

/* ----------------------------------------- */
export default function RevenueChart({
  userId: userIdProp,
  businessId: businessIdProp,
  height = 260,
  className = "",
  showGrid = true,
  refreshVersion = 0,
}) {
  const { year, month } = useFinancialPeriod(businessIdProp || localStorage.getItem("currentBusinessId"));
  const userId = userIdProp || localStorage.getItem("user_id");
  const businessId = businessIdProp || localStorage.getItem("currentBusinessId");
  const forceLive = shouldForceLiveData();
  const usingDemo = !forceLive && shouldUseDemoData();
  const demoData = useMemo(() => (usingDemo ? getDemoData() : null), [usingDemo]);

  const [series, setSeries] = useState(null);
  const [status, setStatus] = useState("idle");
  const [source, setSource] = useState(null);
  const gradientId = useId().replace(/:/g, "");

  const windowMonths = useMemo(() => {
    if (!year || !month) return [];
    return seqLastNMonths({ year, month, n: 12 });
  }, [year, month]);

  useEffect(() => {
    let cancelled = false;

    async function fetchSeries() {
      if (demoData) {
        const rows = windowMonths.length
          ? buildSlidingDemoRows(windowMonths, demoData?.financials?.monthlyRevenue, "revenue")
          : [];
        if (!cancelled) {
          setSeries(toChartData(rows));
          setSource("demo");
          setStatus("success");
        }
        return;
      }
      if (!userId || !businessId || windowMonths.length === 0) {
        const rows = forceLive ? [] : buildMock(windowMonths);
        if (!cancelled) {
          setSeries(toChartData(rows));
          setSource(forceLive ? "empty" : "mock");
          setStatus("success");
        }
        return;
      }

      const cacheKey = `${businessId}:${year}:${month}:12`;
      const cached = REVENUE_SERIES_CACHE.get(cacheKey);
      if (cached) {
        setSeries(cached.series);
        setSource(cached.source);
        setStatus("success");
      } else {
        setStatus("loading");
      }

      // Strategy 1: consolidated API (if present)
      try {
        const url =
          `/api/accounting/health/series` +
          `?business_id=${encodeURIComponent(businessId)}` +
          `&user_id=${encodeURIComponent(userId)}` +
          `&end_year=${encodeURIComponent(year)}` +
          `&end_month=${encodeURIComponent(month)}` +
          `&window=12`;
        const resp = await apiFetch(url, {
          headers: {
            "Content-Type": "application/json",
            "x-user-id": userId,
            "x-business-id": businessId,
            "x-data-mode": "live",
          },
        });
        if (resp.ok) {
          const json = await resp.json();
          const rows =
            (Array.isArray(json?.revenue) ? json.revenue : (Array.isArray(json?.rows) ? json.rows : json))?.map((r) => ({
              year: Number(r.year),
              month: Number(r.month),
              revenue: Number(r.revenue ?? r.totalRevenue ?? r.total_revenue ?? 0),
            })) || [];
          if (!cancelled && rows.length) {
            const nextSeries = toChartData(rows);
            setSeries(nextSeries);
            setSource("quickbooks");
            REVENUE_SERIES_CACHE.set(cacheKey, { series: nextSeries, source: "quickbooks" });
            setStatus("success");
            return;
          }
        }
      } catch { /* try next */ }

      // Strategy 2: per-month persisted fallback
      try {
        const rows = await Promise.all(
          windowMonths.map(async ({ year, month }) => {
            const url =
              `/api/accounting/metrics` +
              `?business_id=${encodeURIComponent(businessId)}` +
              `&user_id=${encodeURIComponent(userId)}` +
              `&year=${encodeURIComponent(year)}` +
              `&month=${encodeURIComponent(month)}` +
              `&data_mode=live&persisted_only=true`;
            try {
              const r = await apiFetch(url, {
                headers: {
                  "Content-Type": "application/json",
                  "x-user-id": userId,
                  "x-business-id": businessId,
                  "x-data-mode": "live",
                },
              });
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              const payload = await r.json();
              const revenue = Number(coalesceRevenue(payload) ?? 0);
              return { year, month, revenue };
            } catch {
              return { year, month, revenue: 0 };
            }
          })
        );

        const values = rows.map((r) => r.revenue);
        const shouldMock = !forceLive && allSame(values);
        const rowsFinal = shouldMock ? buildMock(windowMonths) : rows;

        if (!cancelled) {
          const nextSeries = toChartData(rowsFinal);
          const nextSource = shouldMock ? "mock" : "quickbooks";
          setSeries(nextSeries);
          setSource(nextSource);
          REVENUE_SERIES_CACHE.set(cacheKey, { series: nextSeries, source: nextSource });
          setStatus("success");
        }
      } catch (e) {
        console.error("[RevenueChart] series fetch failed:", e);
        if (!cancelled) {
          if (!cached) {
            const rows = forceLive ? [] : buildMock(windowMonths);
            setSeries(toChartData(rows));
            setSource(forceLive ? "error" : "mock");
          }
          setStatus("success");
        }
      }
    }

    fetchSeries();
    return () => { cancelled = true; };
  }, [userId, businessId, year, month, windowMonths, demoData, forceLive, refreshVersion]);

  // Measure container to tune margins/ticks/dots responsively
  const [measureRef, { width: w }] = useMeasure();

  if (status === "loading") {
    return (
      <div className={`rounded-xl bg-white/[0.05] border border-white/10 shadow-[0_18px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl p-4 ${className} animate-pulse`}>
        <div className="space-y-3">
          <div className="h-3 w-32 bg-white/15 rounded-full" />
          <div className="h-5 w-48 bg-white/18 rounded-md" />
          <div className="h-[180px] w-full bg-white/8 rounded-lg" />
        </div>
      </div>
    );
  }
  if (!series || series.length === 0) return null;

  const isMock = source === "mock";
  const badgeClass = "text-xs px-2 py-1 rounded-full border text-emerald-300 border-emerald-400/40";

  // Responsive styling tweaks
  const small = (w || 0) < 520;

  const xTickCount = small ? 6 : 12;
  const leftMargin = small ? 30 : 42;
  const rightMargin = small ? 12 : 22;
  const topMargin = 14;
  const bottomMargin = small ? 44 : 34;

  const lineColor = "#3BE6C7";
  const lineColorSoft = "rgba(59,230,199,0.28)";
  const axisColor = "rgba(255,255,255,0.18)";
  const tickColor = "rgba(255,255,255,0.58)";
  const dotR = small ? 2.25 : 2.75;
  const activeDotR = small ? 5 : 6.5;
  const strokeW = small ? 2 : 2.6;

  const xTickStyle = { fill: tickColor, fontSize: small ? 10 : 11, fontWeight: 600, dy: 6 };
  const currentPoint = series[series.length - 1];
  const yAxisMax = niceRevenueCeiling(Math.max(...series.map((row) => Number(row.revenue) || 0)));

  return (
    <div className={`relative flex h-full flex-col overflow-hidden rounded-xl border border-white/10 bg-[var(--panel)] p-4 shadow-[0_24px_70px_rgba(0,0,0,0.42)] ${className}`}>
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.035] via-transparent to-black/10" />
      {/* Compact CardHeader to match Pulse sizing */}
      <div className="relative">
        <CardHeader
          title="REVENUE — PRIOR 12 MONTHS"
          right={isMock ? null : <span className={badgeClass}>QuickBooks</span>}
          size="sm"
          dense
          className="mb-2"
          titleClassName="text-[13px]" // safe override if supported
        />
      </div>

      <div ref={measureRef} className="relative min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={series}
            margin={{ top: topMargin, right: rightMargin, left: leftMargin, bottom: bottomMargin }}
          >
            <defs>
              <linearGradient id={`${gradientId}-revenueArea`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="35%" stopColor={lineColor} stopOpacity={0.22} />
                <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
              </linearGradient>
              <filter id={`${gradientId}-lineGlow`} x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="0" stdDeviation="4" floodColor={lineColor} floodOpacity="0.28" />
              </filter>
            </defs>

            {showGrid && (
              <CartesianGrid
                vertical={false}
                strokeDasharray="4 8"
                stroke="rgba(255,255,255,0.065)"
              />
            )}

            <XAxis
              dataKey="month"
              stroke={axisColor}
              tickLine={false}
              axisLine={false}
              interval={0}
              tickCount={xTickCount}
              minTickGap={4}
              tickMargin={10}
              tick={xTickStyle}
              height={36}
            />
            <YAxis
              stroke={axisColor}
              tickLine={false}
              axisLine={false}
              domain={[0, yAxisMax]}
              tickCount={5}
              tickFormatter={(val) => `$${(val / 1000).toFixed(0)}k`}
              width={leftMargin + 4}
              tick={{ fill: tickColor, fontSize: small ? 10 : 11, fontWeight: 600 }}
            />
            <Tooltip content={<RevenueTooltip />} wrapperStyle={{ zIndex: 30 }} />
            {currentPoint ? (
              <ReferenceLine
                x={currentPoint.month}
                stroke="rgba(59,230,199,0.24)"
                strokeDasharray="4 5"
                label={{
                  value: "Current",
                  fill: "rgba(209,250,229,0.78)",
                  fontSize: 11,
                  position: "insideTopRight",
                }}
              />
            ) : null}

            {/* Area under the line */}
            <Area
              type="monotone"
              dataKey="revenue"
              stroke="none"
              fill={`url(#${gradientId}-revenueArea)`}
              isAnimationActive={false}
            />

            {/* Line on top */}
            <Line
              type="monotone"
              dataKey="revenue"
              stroke={lineColor}
              strokeWidth={strokeW}
              filter={`url(#${gradientId}-lineGlow)`}
              dot={{ r: dotR, stroke: lineColor, fill: lineColorSoft }}
              activeDot={{ r: activeDotR, stroke: lineColor, fill: lineColor }}
              isAnimationActive={false}
            />
            {currentPoint ? (
              <ReferenceDot
                x={currentPoint.month}
                y={currentPoint.revenue}
                r={activeDotR}
                fill="var(--panel)"
                stroke={lineColor}
                strokeWidth={2.5}
                isFront
              />
            ) : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
