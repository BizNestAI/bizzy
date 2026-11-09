import useMeasure from "./useChartMeasure.js";
import HealthChartTooltip from "./HealthChartTooltip.jsx";
import { FORECAST_COLORS, formatForecastAxis } from "../../utils/forecast/forecastPresentation.js";
// /src/components/Accounting/RevenueChart.jsx
import React, { useEffect, useId, useMemo, useState } from "react";
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

import { getDemoData, shouldForceLiveData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import { apiFetch } from "../../utils/apiBase.js";
import { buildCurrencyAxis } from "../../utils/currencyAxis.js";

/* ---------------- helpers ---------------- */
function monthShortLabel(y, m) {
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: "short" });
}
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
    revenue: r.found === false || r.revenue === null || r.revenue === undefined ? null : Number(r.revenue),
    isSelected: idx === rows.length - 1,
    fullMonth: new Date(r.year, r.month - 1, 1).toLocaleString(undefined, { month: "short", year: "numeric" }),
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

/* ——— tiny measure hook (ResizeObserver) ——— */

export default function RevenueChart({
  userId: userIdProp,
  businessId: businessIdProp,
  year: yearProp,
  month: monthProp,
  className = "",
  showGrid = true,
  refreshVersion = 0,
}) {
  const businessId = businessIdProp || localStorage.getItem("currentBusinessId");
  const period = useFinancialPeriod(businessId);
  const year = yearProp || period.year;
  const month = monthProp || period.month;
  const userId = userIdProp || localStorage.getItem("user_id") || "";
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
      if (!businessId || windowMonths.length === 0) {
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
        const userParam = userId ? `&user_id=${encodeURIComponent(userId)}` : "";
        const url =
          `/api/accounting/health/series` +
          `?business_id=${encodeURIComponent(businessId)}` +
          userParam +
          `&end_year=${encodeURIComponent(year)}` +
          `&end_month=${encodeURIComponent(month)}` +
          `&window=12`;
        const resp = await apiFetch(url, {
          headers: {
            "Content-Type": "application/json",
            "x-user-id": userId || "",
            "x-business-id": businessId,
            "x-data-mode": "live",
          },
          cache: "no-store",
        });
        if (resp.ok) {
          const json = await resp.json();
          const rows =
            (Array.isArray(json?.revenue) ? json.revenue : (Array.isArray(json?.rows) ? json.rows : json))?.map((r) => ({
              year: Number(r.year),
              month: Number(r.month),
              revenue: r.found === false ? null : Number(r.revenue ?? r.totalRevenue ?? r.total_revenue ?? 0),
              found: r.found !== false && (r.revenue ?? r.totalRevenue ?? r.total_revenue) !== null,
            })) || [];
          if (!cancelled && rows.some((row) => row.found)) {
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
            const userParam = userId ? `&user_id=${encodeURIComponent(userId)}` : "";
            const url =
              `/api/accounting/metrics` +
              `?business_id=${encodeURIComponent(businessId)}` +
              userParam +
              `&year=${encodeURIComponent(year)}` +
              `&month=${encodeURIComponent(month)}` +
              `&data_mode=live&persisted_only=true`;
            try {
              const r = await apiFetch(url, {
                headers: {
                  "Content-Type": "application/json",
                  "x-user-id": userId || "",
                  "x-business-id": businessId,
                  "x-data-mode": "live",
                },
                cache: "no-store",
              });
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              const payload = await r.json();
              const rawRevenue = coalesceRevenue(payload);
              const found = rawRevenue != null && Number.isFinite(Number(rawRevenue));
              return { year, month, revenue: found ? Number(rawRevenue) : null, found };
            } catch {
              return { year, month, revenue: null, found: false };
            }
          })
        );

        const values = rows.map((r) => r.revenue).filter((value) => value !== null && value !== undefined);
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

  const small = (w || 0) < 520;
  const values = (series || []).map(r => r.revenue).filter(v => v != null && Number.isFinite(Number(v)));
  const axis = buildCurrencyAxis(values, { includeZero: true, minAtZero: values.every(v => v >= 0), tickCount: 5, headroom: 0.15 });
  const selectedPoint = series?.at(-1);
  const currentPoint = selectedPoint?.revenue != null ? selectedPoint : null;
  const lineColor = FORECAST_COLORS.revenue;
  return <section className={`forecast-chart-surface health-chart-panel financial-health-visual ${className}`} aria-label="Revenue trend">
    <header className="health-panel-header"><h3>Revenue · prior 12 months</h3>{['mock','demo'].includes(source) && <span className="forecast-badge">Sample data</span>}</header>
    {status === 'loading' ? <div className="health-skeleton health-chart-skeleton" role="status">Loading revenue history…</div> : !values.length ? <div className="forecast-empty">No revenue history available for the selected window.</div> : <div ref={measureRef} className="health-chart-canvas health-revenue-canvas">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={series} margin={{ top: 18, right: small ? 24 : 40, left: 12, bottom: 10 }}>
          <defs><linearGradient id={`${gradientId}-revenueArea`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={lineColor} stopOpacity={0.09}/><stop offset="100%" stopColor={lineColor} stopOpacity={0}/></linearGradient></defs>
          {showGrid && <CartesianGrid vertical={false} strokeDasharray="3 6" stroke="rgba(255,255,255,0.07)"/>}
          <XAxis dataKey="month" axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={16} tickMargin={10} height={30} tick={{ fill: '#a3aea7', fontSize: 11 }}/>
          <YAxis width={70} axisLine={false} tickLine={false} domain={axis.domain} ticks={axis.ticks} tickFormatter={formatForecastAxis} tick={{ fill: '#a3aea7', fontSize: 11 }}/>
          <Tooltip content={<HealthChartTooltip />} wrapperStyle={{ zIndex: 30 }} cursor={{ stroke: 'rgba(255,255,255,0.24)' }}/>
          {currentPoint && <ReferenceLine x={currentPoint.month} stroke="rgba(255,255,255,0.16)" strokeDasharray="3 5" label={{ value: 'Selected', fill: '#a3aea7', fontSize: 10, position: 'insideTopRight' }}/>}
          <Area type="monotone" dataKey="revenue" stroke="none" fill={`url(#${gradientId}-revenueArea)`} isAnimationActive={false}/>
          <Line type="monotone" dataKey="revenue" connectNulls={false} stroke={lineColor} strokeWidth={2.5} dot={values.length === 1 ? {r:4} : false} activeDot={{r:5,stroke:'#0c110e',strokeWidth:2}} isAnimationActive={false}/>
          {currentPoint && <ReferenceDot x={currentPoint.month} y={currentPoint.revenue} r={4} fill="#0c110e" stroke={lineColor} strokeWidth={2} isFront/>}
        </ComposedChart>
      </ResponsiveContainer>
    </div>}
  </section>;
}
