// /src/components/Accounting/ExpenseBreakdownChart.jsx
// (green shades palette + responsive radius + center label)
import React, { useEffect, useMemo, useRef, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import useFinancialPeriod from "../../hooks/useFinancialPeriod.js";
import { supabase } from "../../services/supabaseClient";
import CardHeader from "../UI/CardHeader"; // ⬅️ use the shared header
import { getDemoData, shouldForceLiveData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import { apiFetch } from "../../utils/apiBase.js";

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
    const type = r.account_type;
    if (type && String(type || "").toLowerCase() !== "expense") return;
    const name = r.category || r.account_name || "Other";
    const amt = Math.max(0, Number(r.amount ?? r.balance ?? 0));
    if (!(amt > 0)) return;
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
  const { year, month } = useFinancialPeriod(businessIdProp || localStorage.getItem("currentBusinessId"));
  const userId = userIdProp || localStorage.getItem("user_id");
  const businessId = businessIdProp || localStorage.getItem("currentBusinessId");
  const forceLive = shouldForceLiveData();
  const usingDemo = !forceLive && shouldUseDemoData();
  const demoData = useMemo(() => (usingDemo ? getDemoData() : null), [usingDemo]);

  const [data, setData] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | loading | success | empty
  const [source, setSource] = useState(null);

  const monthKeySelected = useMemo(() => {
    if (!year || !month) return null;
    return monthKey(year, month);
  }, [year, month]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (demoData?.financials?.expenseBreakdown) {
        setData(demoData.financials.expenseBreakdown);
        setSource("demo");
        setStatus("success");
        return;
      }
      if (!businessId || !monthKeySelected) {
        const fallback = forceLive ? [] : demoData?.financials?.expenseBreakdown || MOCK;
        setData(fallback);
        setSource(forceLive ? null : "mock");
        setStatus(fallback?.length ? "success" : "empty");
        return;
      }
      setStatus("loading");
      try {
        const url =
          `/api/accounting/expense-breakdown` +
          `?business_id=${encodeURIComponent(businessId)}` +
          (userId ? `&user_id=${encodeURIComponent(userId)}` : "") +
          `&year=${encodeURIComponent(year)}` +
          `&month=${encodeURIComponent(month)}` +
          `&data_mode=live&live_only=true`;
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.log("[ExpenseBreakdown] fetch monthly totals", { year, month, url });
        }
        const resp = await apiFetch(url, {
          headers: { "Content-Type": "application/json", "x-user-id": userId || "", "x-business-id": businessId },
        });
        if (resp.ok) {
          const payload = await resp.json();
          const rows = payload?.rows || [];
          const chartRows = toChartRows(rows);
          const sum = (chartRows || []).reduce((s, r) => s + Number(r.value || 0), 0);
          if (!cancelled && sum > 0) {
            setData(chartRows);
            setSource(payload?.source || "expense_totals_monthly");
            setStatus("success");
            return;
          }
        }
      } catch {}

      try {
        const { data: rows, error } = await supabase
          .from("expense_totals_monthly")
          .select("category,amount,month,source")
          .eq("business_id", businessId)
          .eq("month", monthKeySelected);
        if (error) throw error;

        const chartRows = toChartRows(rows);
        const sum = (chartRows || []).reduce((s, r) => s + Number(r.value || 0), 0);
        if (!cancelled && sum > 0) {
          setData(chartRows);
          setSource(rows?.[0]?.source || "expense_totals_monthly");
          setStatus("success");
          return;
        }
        if (!cancelled) setStatus("empty");
      } catch {}

      try {
        const url =
          `/api/accounting/metrics` +
          `?business_id=${encodeURIComponent(businessId)}` +
          (userId ? `&user_id=${encodeURIComponent(userId)}` : "") +
          `&year=${encodeURIComponent(year)}` +
          `&month=${encodeURIComponent(month)}` +
          `&data_mode=live&live_only=true`;
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.log("[ExpenseBreakdown] fetch fallback metrics", { year, month, url });
        }
        const resp = await apiFetch(url, {
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
          if (!cancelled) setStatus("empty");
        }
      } catch {}

      if (!cancelled) {
        const fallback = forceLive ? [] : demoData?.financials?.expenseBreakdown || MOCK;
        setData(fallback);
        setSource(forceLive ? null : demoData ? "demo" : "mock");
        setStatus(fallback?.length ? "success" : "empty");
      }
    }

    load();
    return () => { cancelled = true; };
  }, [businessId, userId, monthKeySelected, year, month, demoData, forceLive]);

  const total = useMemo(() => (data || []).reduce((s, d) => s + Number(d.value || 0), 0), [data]);
  // measure (for legend sizing)
  const [measureRef, { width: w }] = useMeasure();

  if (status === "loading") {
    return (
      <div className={`rounded-xl bg-white/[0.05] border border-white/10 shadow-[0_18px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl p-4 ${className} animate-pulse`}>
        <div className="space-y-3">
          <div className="h-3 w-28 bg-white/15 rounded-full" />
          <div className="h-5 w-44 bg-white/18 rounded-md" />
          <div className="h-[160px] w-full bg-white/8 rounded-lg" />
        </div>
      </div>
    );
  }
  if (status === "empty" || !data || data.length === 0) {
    return (
      <div className={`bg-zinc-900 border border-white/10 rounded-xl p-4 text-white/70 ${className}`}>
        No expense breakdown yet — run Backfill to populate data.
      </div>
    );
  }

  const isMock = source === "mock";
  const badgeClass = "text-xs px-2 py-1 rounded-full border text-emerald-300 border-emerald-400/40";

  const isNarrow = (w || 0) < 430;
  const chartH = isNarrow ? 158 : 188;
  const boxSize = Math.min(w || 0, chartH);
  const baseR = Math.max(64, Math.floor(boxSize * (compact ? 0.43 : 0.47)));
  const outerRadius = baseR;
  const innerRadius = Math.floor(baseR * (compact ? 0.7 : 0.74));

  const overlayTotalCls = compact ? "text-[14px]" : "text-[16px]";
  const overlayMetaCls = compact ? "text-[10px]" : "text-[11px]";

  return (
    <div
      className={`flex h-full min-h-0 flex-col rounded-xl border border-white/10 bg-[var(--panel)] p-4 shadow-[0_18px_40px_rgba(0,0,0,0.32)] ${className}`}
      style={{ height: "100%", minHeight: height }}
    >
      {/* Consistent compact header (Pulse style) */}
      <CardHeader
        title="EXPENSE BREAKDOWN"
        right={isMock ? null : <span className={badgeClass}>QuickBooks</span>}
        size="sm"
        dense
        className="mb-2"
        titleClassName="text-[13px]" // safe override if supported
      />

      <div
        ref={measureRef}
        className="flex min-h-0 flex-1 flex-col gap-3"
      >
        <div className="relative shrink-0" style={{ height: chartH }}>
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

          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <div className={`${overlayMetaCls} text-white/56`}>Total</div>
              <div className={`font-semibold text-white ${overlayTotalCls}`}>
                ${Number(total).toLocaleString()}
              </div>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 rounded-lg bg-black/[0.08] p-2">
          <div className="h-full overflow-y-auto pr-1 [scrollbar-color:rgba(52,211,153,0.28)_transparent] [scrollbar-width:thin]">
          <div className={`grid min-w-0 gap-2 ${isNarrow ? "grid-cols-1" : "grid-cols-2"}`}>
          {data.map((d, i) => {
            const pct = total ? Math.round((Number(d.value) / total) * 100) : 0;
            const swatch = greenShade(i, data.length);
            return (
              <div key={d.name} className="relative overflow-hidden rounded-md bg-white/[0.025] px-2.5 py-2">
                <div
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 opacity-80"
                  style={{ width: `${Math.max(4, pct)}%`, backgroundColor: swatch }}
                />
                <div className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: swatch }} />
                    <span className="truncate text-[11px] font-semibold text-white/82">{d.name}</span>
                  </div>
                  <div className="whitespace-nowrap text-right text-[11px] tabular-nums">
                    <span className="font-semibold text-white/80">{pct}%</span>
                    <span className="ml-1.5 text-white/45">${Number(d.value).toLocaleString()}</span>
                  </div>
                </div>
              </div>
            );
          })}
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}
