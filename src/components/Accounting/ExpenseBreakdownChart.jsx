import useMeasure from "./useChartMeasure.js";
import HealthChartTooltip from "./HealthChartTooltip.jsx";
import { FORECAST_COLORS, formatForecastCurrency } from "../../utils/forecast/forecastPresentation.js";
// /src/components/Accounting/ExpenseBreakdownChart.jsx
// (green shades palette + responsive radius + center label)
import React, { useEffect, useMemo, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import useFinancialPeriod from "../../hooks/useFinancialPeriod.js";

import { getDemoData, shouldForceLiveData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import { apiFetch } from "../../utils/apiBase.js";

const categoryColors = [FORECAST_COLORS.expenses, FORECAST_COLORS.revenue, '#94a3b8', FORECAST_COLORS.positive, '#c9b89b'];
const categoryColor = i => categoryColors[i % categoryColors.length];

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

const EXPENSE_BREAKDOWN_CACHE = new Map();

// measure

export default function ExpenseBreakdownChart({
  userId: userIdProp,
  businessId: businessIdProp,
  year: yearProp,
  month: monthProp,
  height = 260,
  compact = false,
  className = "",
  refreshVersion = 0,
}) {
  const businessId = businessIdProp || localStorage.getItem("currentBusinessId");
  const period = useFinancialPeriod(businessId);
  const year = yearProp || period.year;
  const month = monthProp || period.month;
  const userId = userIdProp || localStorage.getItem("user_id");
  const forceLive = shouldForceLiveData();
  const usingDemo = !forceLive && shouldUseDemoData();
  const demoData = useMemo(() => (usingDemo ? getDemoData() : null), [usingDemo]);

  const [data, setData] = useState(null);
  const [adjustments, setAdjustments] = useState([]);
  const [displayTotals, setDisplayTotals] = useState(null);
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
        setAdjustments([]);
        setDisplayTotals(null);
        setSource("demo");
        setStatus("success");
        return;
      }
      if (!businessId || !monthKeySelected) {
        const fallback = forceLive ? [] : demoData?.financials?.expenseBreakdown || MOCK;
        setData(fallback);
        setAdjustments([]);
        setDisplayTotals(null);
        setSource(forceLive ? null : "mock");
        setStatus(fallback?.length ? "success" : "empty");
        return;
      }
      const cacheKey = `${businessId}:${monthKeySelected}`;
      const cached = EXPENSE_BREAKDOWN_CACHE.get(cacheKey);
      if (cached) {
        setData(cached.data);
        setAdjustments(cached.adjustments || []);
        setDisplayTotals(cached.displayTotals || null);
        setSource(cached.source);
        setStatus("success");
      } else {
        setStatus("loading");
      }
      try {
        const url =
          `/api/accounting/health/monthly-summary` +
          `?business_id=${encodeURIComponent(businessId)}` +
          (userId ? `&user_id=${encodeURIComponent(userId)}` : "") +
          `&year=${encodeURIComponent(year)}` +
          `&month=${encodeURIComponent(month)}`;
        const resp = await apiFetch(url, {
          headers: { "Content-Type": "application/json", "x-user-id": userId || "", "x-business-id": businessId },
          cache: "no-store",
        });
        if (resp.ok) {
          const payload = await resp.json();
          const rows = payload?.expense_breakdown || payload?.rows || [];
          const adjustmentRows = payload?.expense_adjustments || [];
          const chartRows = toChartRows(rows);
          const sum = (chartRows || []).reduce((s, r) => s + Number(r.value || 0), 0);
          if (!cancelled && sum > 0) {
            setData(chartRows);
            setAdjustments(adjustmentRows);
            setDisplayTotals(payload?.expense_display_totals || null);
            setSource(payload?.source || "expense_totals_monthly");
            EXPENSE_BREAKDOWN_CACHE.set(cacheKey, {
              data: chartRows,
              adjustments: adjustmentRows,
              displayTotals: payload?.expense_display_totals || null,
              source: payload?.source || "expense_totals_monthly",
            });
            setStatus("success");
            return;
          }
        }
      } catch {
        // Fall through to the legacy persisted metrics endpoint.
      }

      try {
        const url =
          `/api/accounting/metrics` +
          `?business_id=${encodeURIComponent(businessId)}` +
          (userId ? `&user_id=${encodeURIComponent(userId)}` : "") +
          `&year=${encodeURIComponent(year)}` +
          `&month=${encodeURIComponent(month)}` +
          `&data_mode=live&persisted_only=true`;
        const resp = await apiFetch(url, {
          headers: { "Content-Type": "application/json", "x-user-id": userId || "", "x-business-id": businessId },
          cache: "no-store",
        });
        if (resp.ok) {
          const payload = await resp.json();
          const rows = payload?.accountBreakdown || [];
          const chartRows = toChartRows(rows);
          const sum = (chartRows || []).reduce((s, r) => s + Number(r.value || 0), 0);
          if (!cancelled && sum > 0) {
            setData(chartRows);
            setAdjustments([]);
            setDisplayTotals(null);
            setSource(payload?.source === "mock" && !forceLive ? "mock" : "quickbooks");
            EXPENSE_BREAKDOWN_CACHE.set(cacheKey, {
              data: chartRows,
              adjustments: [],
              displayTotals: null,
              source: payload?.source === "mock" && !forceLive ? "mock" : "quickbooks",
            });
            setStatus("success");
            return;
          }
          if (!cancelled && !cached) setStatus("empty");
        }
      } catch {
        // Preserve cached data or the normal empty fallback below.
      }

      if (!cancelled) {
        if (!cached) {
          const fallback = forceLive ? [] : demoData?.financials?.expenseBreakdown || MOCK;
          setData(fallback);
          setAdjustments([]);
          setDisplayTotals(null);
          setSource(forceLive ? null : demoData ? "demo" : "mock");
          setStatus(fallback?.length ? "success" : "empty");
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [businessId, userId, monthKeySelected, year, month, demoData, forceLive, refreshVersion]);

  const total = useMemo(() => (data || []).reduce((s, d) => s + Number(d.value || 0), 0), [data]);
  const adjustmentTotal = useMemo(
    () => (adjustments || []).reduce((s, d) => s + Number(d.amount || 0), 0),
    [adjustments]
  );
  const netExpenses = displayTotals?.net_expenses ?? displayTotals?.netExpenses ?? null;
  // measure (for legend sizing)
  const [measureRef, { width: w }] = useMeasure();

  const largest = data?.reduce((best, row) => !best || row.value > best.value ? row : best, null);
  return <section className={`forecast-chart-surface health-chart-panel financial-health-visual health-expense-panel ${className}`} aria-label="Expense breakdown" style={{minHeight:height}}>
    <header className="health-panel-header"><div><h3>Expense breakdown</h3>{largest && <p>Largest category: {largest.name} · {formatForecastCurrency(largest.value)} · {Math.round(largest.value / total * 100)}%</p>}</div>{['mock','demo'].includes(source) && <span className="forecast-badge">Sample data</span>}</header>
    {status === 'loading' ? <div className="health-skeleton health-chart-skeleton" role="status">Loading expenses…</div> : !data?.length ? <div className="forecast-empty">No expense breakdown yet — run Backfill to populate data.</div> : <div ref={measureRef} className="health-expense-content">
      <div className="health-donut" style={{height:compact ? 180 : 195}}>
        <ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={data} dataKey="value" nameKey="name" innerRadius={compact ? 52 : 58} outerRadius={compact ? 72 : 80} paddingAngle={2} stroke="#0c110e" cx="50%" cy="50%" labelLine={false} isAnimationActive={false}>
          {data.map((entry,i)=><Cell key={entry.name} fill={categoryColor(i)}/>)}
        </Pie><Tooltip content={<HealthChartTooltip kind="expense"/>} wrapperStyle={{zIndex:30}} isAnimationActive={false}/></PieChart></ResponsiveContainer>
        <div className="health-donut-total"><span>{adjustmentTotal < 0 ? 'Before credits' : 'Total expenses'}</span><strong>{formatForecastCurrency(total)}</strong></div>
      </div>
      <ul className={`health-expense-legend ${w > 640 ? 'health-legend-wide' : ''}`} aria-label="Expense categories">
        {data.map((d,i)=>{const pct=total ? Math.round(Number(d.value)/total*100) : 0;return <li key={d.name}><span className="forecast-series-dot" style={{background:categoryColor(i)}}/><span className="health-category-name">{d.name}</span><span className="health-category-percent">{pct}%</span><strong>{formatForecastCurrency(d.value)}</strong></li>;})}
      </ul>
      {adjustmentTotal < 0 && <div className="health-expense-adjustments"><p><span>Less: refunds and credits</span><strong>{formatForecastCurrency(adjustmentTotal)}</strong></p>{netExpenses !== null && <p><span>Net expenses</span><strong>{formatForecastCurrency(netExpenses)}</strong></p>}</div>}
    </div>}
  </section>;
}
