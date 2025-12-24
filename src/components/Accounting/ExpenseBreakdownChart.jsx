// /src/components/Accounting/ExpenseBreakdownChart.jsx
// (green shades palette + responsive radius + center label)
import React, { useEffect, useMemo, useRef, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { usePeriod } from "../../context/PeriodContext";
import { supabase } from "../../services/supabaseClient";
import CardHeader from "../UI/CardHeader"; // ⬅️ use the shared header
import { getDemoData, shouldForceLiveData, shouldUseDemoData } from "../../services/demo/demoClient.js";

const API_BASE = import.meta.env?.VITE_API_BASE || "";

// --- Generate tasteful emerald/teal greens for Financials ---
function greenShade(i, n) {
  if (!Number.isFinite(n) || n <= 1) return "hsl(162 70% 46%)";
  const hue = 162, sat = 68, lMin = 34, lMax = 68;
  const t = i / (n - 1);
  const light = Math.round(lMin + t * (lMax - lMin));
  return `hsl(${hue} ${sat}% ${light}%)`;
}

function pad2(n) { return String(n).padStart(2, "0"); }
function monthKey(y, m) { return `${y}-${pad2(m)}-01`; }

const MOCK = [
  { name: "Payroll", value: 14500 },
  { name: "Materials", value: 9600 },
  { name: "Software", value: 3300 },
  { name: "Marketing", value: 2200 },
  { name: "Other", value: 2900 },
];

function toChartRows(rows) {
  const map = new Map();
  (rows || []).forEach((r) => {
    if ((r.account_type || "").toLowerCase() !== "expense") return;
    const name = r.account_name || "Other";
    const amt = Math.max(0, Number(r.balance ?? 0));
    map.set(name, (map.get(name) || 0) + (Number.isFinite(amt) ? amt : 0));
  });

  const entries = Array.from(map.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  if (entries.length <= 5) return entries;
  const top4 = entries.slice(0, 4);
  const otherSum = entries.slice(4).reduce((s, e) => s + e.value, 0);
  return [...top4, { name: "Other", value: otherSum }];
}

// Tooltip (unchanged)
const CustomTooltip = ({ active, payload }) => {
  if (!active || !payload || !payload.length) return null;
  const { name, value } = payload[0];
  return (
    <div
      style={{
        position: "relative",
        zIndex: 20,
        background: "#0b0b0b",
        border: "1px solid #333",
        padding: "8px 10px",
        borderRadius: 8,
        color: "#fff",
        boxShadow: "0 4px 10px rgba(0,0,0,0.6)",
      }}
    >
      <div style={{ color: "#9ca3af", fontSize: 12, marginBottom: 2 }}>{name}</div>
      <div style={{ fontWeight: 600 }}>{`$${Number(value).toLocaleString()}`}</div>
    </div>
  );
};

// measure
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

export default function ExpenseBreakdownChart({
  userId: userIdProp,
  businessId: businessIdProp,
  height = 260,
  compact = false,
  className = "",
}) {
  const { period } = usePeriod();
  const userId = userIdProp || localStorage.getItem("user_id");
  const businessId = businessIdProp || localStorage.getItem("currentBusinessId");
  const forceLive = shouldForceLiveData();
  const usingDemo = !forceLive && shouldUseDemoData();
  const demoData = useMemo(() => (usingDemo ? getDemoData() : null), [usingDemo]);

  const [data, setData] = useState(null);
  const [status, setStatus] = useState("idle");
  const [source, setSource] = useState(null);

  const month = useMemo(() => {
    if (!period?.year || !period?.month) return null;
    return monthKey(period.year, period.month);
  }, [period?.year, period?.month]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (demoData?.financials?.expenseBreakdown) {
        setData(demoData.financials.expenseBreakdown);
        setSource("demo");
        setStatus("success");
        return;
      }
      if (!businessId || !month) {
        const fallback = forceLive ? [] : demoData?.financials?.expenseBreakdown || MOCK;
        setData(fallback);
        setSource(forceLive ? null : "mock");
        setStatus("success");
        return;
      }
      setStatus("loading");
      try {
        const { data: rows, error } = await supabase
          .from("account_breakdown")
          .select("account_name,account_type,balance,month")
          .eq("business_id", businessId)
          .eq("month", month);
        if (error) throw error;

        const chartRows = toChartRows(rows);
        const sum = (chartRows || []).reduce((s, r) => s + Number(r.value || 0), 0);
        if (!cancelled && sum > 0) {
          setData(chartRows);
          setSource("quickbooks");
          setStatus("success");
          return;
        }
      } catch {}

      try {
        const url =
          `${API_BASE}/api/accounting/metrics` +
          `?business_id=${encodeURIComponent(businessId)}` +
          (userId ? `&user_id=${encodeURIComponent(userId)}` : "") +
          `&year=${encodeURIComponent(period.year)}` +
          `&month=${encodeURIComponent(period.month)}`;
        const resp = await fetch(url, {
          headers: { "Content-Type": "application/json", "x-user-id": userId || "", "x-business-id": businessId },
        });
        if (resp.ok) {
          const payload = await resp.json();
          const rows = payload?.accountBreakdown || [];
          const chartRows = toChartRows(rows);
          const sum = (chartRows || []).reduce((s, r) => s + Number(r.value || 0), 0);
          if (!cancelled && sum > 0) {
            setData(chartRows);
            setSource(payload?.source === "mock" && !forceLive ? "mock" : "quickbooks");
            setStatus("success");
            return;
          }
        }
      } catch {}

      if (!cancelled) {
        const fallback = forceLive ? [] : demoData?.financials?.expenseBreakdown || MOCK;
        setData(fallback);
        setSource(forceLive ? null : demoData ? "demo" : "mock");
        setStatus("success");
      }
    }

    load();
    return () => { cancelled = true; };
  }, [businessId, userId, month, period?.year, period?.month, demoData, forceLive]);

  const total = useMemo(() => (data || []).reduce((s, d) => s + Number(d.value || 0), 0), [data]);
  const top = useMemo(() => (data || []).slice().sort((a, b) => b.value - a.value)[0], [data]);

  // measure (for legend sizing)
  const [measureRef, { width: w }] = useMeasure();

  if (status === "loading") {
    return (
      <div className={`bg-zinc-900 border border-white/10 rounded-xl p-4 text-white/70 ${className}`}>
        Loading expenses…
      </div>
    );
  }
  if (!data || data.length === 0) return null;

  const isMock = source === "mock";
  const badgeClass =
    isMock
      ? "text-xs px-2 py-1 rounded-full border text-amber-300 border-amber-400/40"
      : "text-xs px-2 py-1 rounded-full border text-emerald-300 border-emerald-400/40";

  // ---- Legend layout
  const itemsCount = (data || []).length;
  const isNarrow   = (w || 0) < 640;   // <= sm
  const cols       = isNarrow ? 2 : 3;
  const rowsNeeded = Math.ceil(itemsCount / cols);

  const rowHeight  = isNarrow ? 22 : 24;
  const rowGap     = 10;
  const topPad     = 14;
  const bottomPad  = 16;

  const legendAllowance =
    topPad + rowsNeeded * rowHeight + (rowsNeeded - 1) * rowGap + bottomPad;

  const chartH = Math.max(140, height - legendAllowance);
  const boxSize = Math.min(w || 0, chartH);
  const baseR = Math.max(60, Math.floor(boxSize * (compact ? 0.42 : 0.48)));
  const outerRadius = baseR;
  const innerRadius = Math.floor(baseR * (compact ? 0.60 : 0.64));

  const overlayTotalCls = compact ? "text-[14px]" : "text-[16px]";
  const overlayMetaCls = compact ? "text-[10px]" : "text-[11px]";

  return (
    <div className={`bg-zinc-900 border border-white/10 rounded-xl p-4 ${className}`}>
      {/* Consistent compact header (Pulse style) */}
      <CardHeader
        title="EXPENSE BREAKDOWN"
        right={<span className={badgeClass}>{isMock ? "Mock" : "QuickBooks"}</span>}
        size="sm"
        dense
        className="mb-2"
        titleClassName="text-[13px]" // safe override if supported
      />

      {/* Pie area */}
      <div ref={measureRef} className="relative" style={{ height: chartH }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={innerRadius}
              outerRadius={outerRadius}
              paddingAngle={2}
              cx="50%"
              cy="50%"
              labelLine={false}
              isAnimationActive={false}
            >
              {data.map((entry, i) => (
                <Cell key={`cell-${i}`} fill={greenShade(i, data.length)} />
              ))}
            </Pie>

            <Tooltip
              content={<CustomTooltip />}
              wrapperStyle={{ zIndex: 30 }}
              isAnimationActive={false}
              offset={12}
              allowEscapeViewBox={{ x: true, y: true }}
            />
          </PieChart>
        </ResponsiveContainer>

        {/* Center overlay */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <div className={`${overlayMetaCls} text-white/60`}>Total</div>
            <div className={`text-white font-semibold ${overlayTotalCls}`}>
              ${Number(total).toLocaleString()}
            </div>
            {top?.name && (
              <div className={`${overlayMetaCls} text-white/60`}>Top: {top.name}</div>
            )}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div
        className={`mt-0 grid ${isNarrow ? "grid-cols-2" : "grid-cols-3"} text-[12px] text-white/80`}
        style={{ rowGap, marginTop: topPad }}
      >
        {data.map((d, i) => {
          const pct = total ? Math.round((Number(d.value) / total) * 100) : 0;
          const swatch = greenShade(i, data.length);
          return (
            <div key={d.name} className="flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: swatch }} />
              <span className="truncate">{d.name}</span>
              <span className="ml-auto tabular-nums text-white/60">
                {pct}% • ${Number(d.value).toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
