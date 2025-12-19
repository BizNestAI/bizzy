// /src/components/Accounting/RevenueChart.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { usePeriod } from "../../context/PeriodContext";
import { supabase } from "../../services/supabaseClient";
import CardHeader from "../ui/CardHeader"; // shared header (Pulse style)
import { getDemoData, shouldForceLiveData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import { useBusiness } from "../../context/BusinessContext";

const API_BASE = import.meta.env?.VITE_API_BASE || "";

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
  return rows.map((r) => ({
    month: monthShortLabel(r.year, r.month),
    revenue: Number(r.revenue ?? 0),
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
  compact = false,         // reserved
  className = "",
  showGrid = false,        // default: no grid
}) {
  const { period } = usePeriod();
  const userId = userIdProp || localStorage.getItem("user_id");
  const businessId = businessIdProp || localStorage.getItem("currentBusinessId");
  const forceLive = shouldForceLiveData();
  const usingDemo = !forceLive && shouldUseDemoData();
  const demoData = useMemo(() => (usingDemo ? getDemoData() : null), [usingDemo]);

  const [series, setSeries] = useState(null);
  const [status, setStatus] = useState("idle");
  const [source, setSource] = useState(null);

  const windowMonths = useMemo(() => {
    if (!period?.year || !period?.month) return [];
    return seqLastNMonths({ year: period.year, month: period.month, n: 12 });
  }, [period?.year, period?.month]);

  useEffect(() => {
    let cancelled = false;

    async function fetchSeries() {
      if (demoData) {
        const rows = (() => {
          const map = new Map(
            (demoData?.financials?.monthlyRevenue || []).map((r) => [r.month, Number(r.revenue || 0)])
          );
          if (!windowMonths.length) return [];
          return windowMonths.map(({ year, month }) => ({
            year,
            month,
            revenue: map.get(`${year}-${pad2(month)}`) ?? 0,
          }));
        })();
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

      setStatus("loading");

      // Strategy 1: consolidated API (if present)
      try {
        const url =
          `${API_BASE}/api/accounting/revenue-series` +
          `?business_id=${encodeURIComponent(businessId)}` +
          `&user_id=${encodeURIComponent(userId)}` +
          `&end_year=${encodeURIComponent(period.year)}` +
          `&end_month=${encodeURIComponent(period.month)}` +
          `&window=12` +
          `&data_mode=live&live_only=true`;
        const resp = await fetch(url, {
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
            (Array.isArray(json?.rows) ? json.rows : json)?.map((r) => ({
              year: Number(r.year),
              month: Number(r.month),
              revenue: Number(r.revenue ?? r.totalRevenue ?? r.total_revenue ?? 0),
            })) || [];
          if (!cancelled && rows.length) {
            setSeries(toChartData(rows));
            setSource("quickbooks");
            setStatus("success");
            return;
          }
        }
      } catch { /* try next */ }

      // Strategy 2: Supabase direct
      try {
        const keys = windowMonths.map(({ year, month }) => monthKey(year, month));
        const { data, error } = await supabase
          .from("financial_metrics")
          .select("month,total_revenue")
          .eq("business_id", businessId)
          .in("month", keys);

        if (error) throw error;

        const map = new Map();
        (data || []).forEach((row) => map.set(row.month, Number(row.total_revenue ?? 0)));

        const rows = windowMonths.map(({ year, month }) => ({
          year, month, revenue: map.get(monthKey(year, month)) ?? 0,
        }));

        const values = rows.map((r) => r.revenue);
        const anyPositive = values.some((v) => Number(v) > 0);
        if (!cancelled && anyPositive) {
          setSeries(toChartData(rows));
          setSource("quickbooks");
          setStatus("success");
          return;
        }
      } catch { /* try next */ }

      // Strategy 3: per-month fallback
      try {
        const rows = await Promise.all(
          windowMonths.map(async ({ year, month }) => {
            const url =
              `${API_BASE}/api/accounting/metrics` +
              `?business_id=${encodeURIComponent(businessId)}` +
              `&user_id=${encodeURIComponent(userId)}` +
              `&year=${encodeURIComponent(year)}` +
              `&month=${encodeURIComponent(month)}` +
              `&data_mode=live&live_only=true`;
            try {
              const r = await fetch(url, {
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
          setSeries(toChartData(rowsFinal));
          setSource(shouldMock ? "mock" : "quickbooks");
          setStatus("success");
        }
      } catch (e) {
        console.error("[RevenueChart] series fetch failed:", e);
        if (!cancelled) {
          const rows = forceLive ? [] : buildMock(windowMonths);
          setSeries(toChartData(rows));
          setSource(forceLive ? "error" : "mock");
          setStatus("success");
        }
      }
    }

    fetchSeries();
    return () => { cancelled = true; };
  }, [userId, businessId, period?.year, period?.month, windowMonths.length, demoData, forceLive]);

  // Measure container to tune margins/ticks/dots responsively
  const [measureRef, { width: w }] = useMeasure();

  if (status === "loading") {
    return (
      <div className={`bg-zinc-900 border border-white/10 rounded-xl p-4 text-white/70 ${className}`}>
        Loading revenue…
      </div>
    );
  }
  if (!series || series.length === 0) return null;

  const isMock = source === "mock";
  const badgeClass =
    isMock
      ? "text-xs px-2 py-1 rounded-full border text-amber-300 border-amber-400/40"
      : "text-xs px-2 py-1 rounded-full border text-emerald-300 border-emerald-400/40";

  // Responsive styling tweaks
  const chartH = Math.max(200, height);
  const small = (w || 0) < 520;

  const xTickCount = small ? 6 : 12;
  const leftMargin = small ? 28 : 36;
  const rightMargin = 12;
  const topMargin = 8;
  const bottomMargin = small ? 60 : 48;

  const dotR = small ? 2.5 : 3;
  const activeDotR = small ? 5 : 6;
  const strokeW = small ? 2 : 2.5;

  const xTickStyle = { fill: "#9aa0a6", fontSize: small ? 11 : 12, dy: 6 };

  return (
    <div className={`bg-zinc-900 border border-white/10 rounded-xl p-4 ${className}`}>
      {/* Compact CardHeader to match Pulse sizing */}
      <CardHeader
        title="REVENUE — PRIOR 12 MONTHS"
        right={<span className={badgeClass}>{isMock ? "Mock" : "QuickBooks"}</span>}
        size="sm"
        dense
        className="mb-2"
        titleClassName="text-[13px]" // safe override if supported
      />

      <div ref={measureRef} style={{ height: chartH }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={series}
            margin={{ top: topMargin, right: rightMargin, left: leftMargin, bottom: bottomMargin }}
          >
            <defs>
              <linearGradient id="revenueArea" x1="0" y1="0" x2="0" y2="1">
                <stop offset="45%" stopColor="#00FFB2" stopOpacity={0.28} />
                <stop offset="100%" stopColor="#00FFB2" stopOpacity={0} />
              </linearGradient>
            </defs>

            {/* Grid hidden by default */}
            {showGrid && <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />}

            <XAxis
              dataKey="month"
              stroke="#9aa0a6"
              tickLine={false}
              axisLine={false}
              interval={0}
              tickCount={xTickCount}
              minTickGap={6}
              tickMargin={10}
              tick={xTickStyle}
            />
            <YAxis
              stroke="#9aa0a6"
              tickLine={false}
              axisLine={false}
              tickFormatter={(val) => `$${(val / 1000).toFixed(0)}k`}
              width={leftMargin + 4}
            />
            <Tooltip content={<RevenueTooltip />} wrapperStyle={{ zIndex: 30 }} />

            {/* Area under the line */}
            <Area
              type="monotone"
              dataKey="revenue"
              stroke="none"
              fill="url(#revenueArea)"
              isAnimationActive={false}
            />

            {/* Line on top */}
            <Line
              type="monotone"
              dataKey="revenue"
              stroke="#00FFB2"
              strokeWidth={strokeW}
              dot={{ r: dotR, stroke: "#00FFB2", fill: "#00FFB2" }}
              activeDot={{ r: activeDotR }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
