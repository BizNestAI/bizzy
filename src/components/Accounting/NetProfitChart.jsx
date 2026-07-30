// File: /src/components/Accounting/NetProfitChart.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import useFinancialPeriod from "../../hooks/useFinancialPeriod.js";
import { supabase } from "../../services/supabaseClient";
import CardHeader from "../UI/CardHeader"; // ⬅️ shared header
import { getDemoData, shouldForceLiveData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import { apiFetch } from "../../utils/apiBase.js";

/* ---------- helpers ---------- */
function monthShortLabel(y,m){ return new Date(y, m-1, 1).toLocaleString(undefined,{month:"short"});}
function pad2(n){ return String(n).padStart(2,"0"); }
function monthKey(y,m){ return `${y}-${pad2(m)}-01`; }
function seqLastNMonths({year,month,n=12}){ const out=[]; let y=year,m=month; for(let i=0;i<n;i++){out.unshift({year:y,month:m}); if(--m<1){m=12;y--;}} return out;}
function allSame(values){ if(!values.length) return true; return values.every(v=>Number(v)===Number(values[0])); }
function toChartData(rows){ return rows.map(r=>({ month: monthShortLabel(r.year,r.month), profit: Number(r.profit ?? 0) })); }
function buildMock(windowMonths){
  const base=[7200,8200,10400,9300,8700,11600,12300,9900,13800,14200,15500,15700];
  const months = windowMonths.length ? windowMonths : seqLastNMonths({year:new Date().getFullYear(), month:new Date().getMonth()+1, n:12});
  return months.map((m,i)=>({ year:m.year, month:m.month, profit: base[i%base.length] }));
}
function coalesceProfit(payload){
  const obj = payload?.metrics ?? payload ?? {};
  const net = obj.netProfit ?? obj.net_profit;
  if (net != null) return Number(net);
  const rev = obj.totalRevenue ?? obj.total_revenue;
  const exp = obj.totalExpenses ?? obj.total_expenses;
  if (rev != null && exp != null) return Number(rev) - Number(exp);
  return null;
}

/* tiny measure hook (ResizeObserver) */
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

/* ---------- component ---------- */
export default function NetProfitChart({
  userId: userIdProp,
  businessId: businessIdProp,
  /** Parent-controlled sizing */
  height = 260,
  compact = false,
  className = "",
  showGrid = false,        // off by default to remove dotted lines
}) {
  const { year, month } = useFinancialPeriod(businessIdProp || localStorage.getItem("currentBusinessId"));
  const userId = userIdProp || localStorage.getItem("user_id");
  const businessId = businessIdProp || localStorage.getItem("currentBusinessId");
  const forceLive = shouldForceLiveData();
  const usingDemo = !forceLive && shouldUseDemoData();
  const demoData = useMemo(() => (usingDemo ? getDemoData() : null), [usingDemo]);

  const [series, setSeries] = useState(null);
  const [status, setStatus] = useState("idle");
  const [source, setSource] = useState(null); // "quickbooks" | "supabase" | "mock"

  const windowMonths = useMemo(()=>{
    if(!year || !month) return [];
    return seqLastNMonths({ year, month, n: 12 });
  }, [year, month]);

  useEffect(()=>{
    let cancelled=false;

    async function fetchSeries(){
      if (demoData) {
        const map = new Map(
          (demoData?.financials?.monthlyProfit || []).map((r) => [r.month, Number(r.profit || 0)])
        );
        const rows = windowMonths.map(({ year, month }) => ({
          year,
          month,
          profit: map.get(`${year}-${pad2(month)}`) ?? 0,
        }));
        if (!cancelled) {
          setSeries(toChartData(rows));
          setSource("demo");
          setStatus("success");
        }
        return;
      }
      if(!userId || !businessId || windowMonths.length===0){
        const rows = forceLive ? [] : buildMock(windowMonths);
        if(!cancelled){ setSeries(toChartData(rows)); setSource(forceLive ? "empty" : "mock"); setStatus("success"); }
        return;
      }
      setStatus("loading");

      // 1) Try consolidated API
      try{
        const url =
          `/api/accounting/profit-series` +
          `?business_id=${encodeURIComponent(businessId)}` +
          `&user_id=${encodeURIComponent(userId)}` +
          `&end_year=${encodeURIComponent(year)}` +
          `&end_month=${encodeURIComponent(month)}` +
          `&window=12` +
          `&data_mode=live&live_only=true`;
        const r = await apiFetch(url, {
          headers: {"Content-Type":"application/json","x-user-id":userId,"x-business-id":businessId,"x-data-mode":"live"}
        });
        if(r.ok){
          const json = await r.json();
          const rows = (Array.isArray(json?.rows)? json.rows : json)?.map(v=>({
            year:Number(v.year), month:Number(v.month), profit:Number(v.profit ?? 0)
          })) || [];
          if(!cancelled && rows.length){
            setSeries(toChartData(rows));
            setSource(json?.source || "quickbooks");
            setStatus("success");
            return;
          }
        }
      }catch{/* ignore */}

      // 2) Direct Supabase query
      try{
        const keys = windowMonths.map(({year,month})=>monthKey(year,month));
        const { data, error } = await supabase
          .from("financial_metrics")
          .select("month,total_revenue,total_expenses,net_profit")
          .eq("business_id", businessId)
          .in("month", keys);
        if(error) throw error;

        const map = new Map();
        (data||[]).forEach(row=>{
          const profit = row.net_profit != null
            ? Number(row.net_profit)
            : Number(row.total_revenue ?? 0) - Number(row.total_expenses ?? 0);
          map.set(row.month, profit);
        });
        const rows = windowMonths.map(({year,month})=>({
          year, month, profit: map.get(monthKey(year,month)) ?? 0
        }));
        const anyPositive = rows.some(r=>Number(r.profit)>0);
        if(!cancelled && anyPositive){
          setSeries(toChartData(rows));
          setSource("supabase");
          setStatus("success");
          return;
        }
      }catch{/* swallow and try next */}

      // 3) Per-month fallback
      try{
        const rows = await Promise.all(windowMonths.map(async ({year,month})=>{
          const url =
            `/api/accounting/metrics` +
            `?business_id=${encodeURIComponent(businessId)}` +
            `&user_id=${encodeURIComponent(userId)}` +
            `&year=${encodeURIComponent(year)}` +
            `&month=${encodeURIComponent(month)}` +
            `&data_mode=live&live_only=true`;
          try{
            const r = await apiFetch(url, { headers:{"Content-Type":"application/json","x-user-id":userId,"x-business-id":businessId,"x-data-mode":"live"} });
            if(!r.ok) throw new Error(`HTTP ${r.status}`);
            const payload = await r.json();
            const profit = coalesceProfit(payload);
            return { year, month, profit: Number(profit ?? 0) };
          }catch{
            return { year, month, profit: 0 };
          }
        }));

        const values = rows.map(r=>r.profit);
        const shouldMock = !forceLive && allSame(values);
        const rowsFinal = shouldMock ? buildMock(windowMonths) : rows;
        if(!cancelled){
          setSeries(toChartData(rowsFinal));
          setSource(shouldMock ? "mock" : "quickbooks");
          setStatus("success");
        }
      }catch(e){
        console.error("[NetProfitChart] fetch failed:", e);
        if(!cancelled){
          const rows = forceLive ? [] : buildMock(windowMonths);
          setSeries(toChartData(rows));
          setSource(forceLive ? "error" : "mock");
          setStatus("success");
        }
      }
    }

    fetchSeries();
    return ()=>{ cancelled=true; };
  }, [userId, businessId, year, month, windowMonths, demoData, forceLive]);

  // Measure container to tune margins / bar size responsively
  const [measureRef, { width: w }] = useMeasure();  // keep above returns

  if(status==="loading"){
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
  if(!series || !series.length) return null;

  const isMock = source === "mock";
  const badgeClass =
    isMock
      ? "text-xs px-2 py-1 rounded-full border text-amber-300 border-amber-400/40"
      : "text-xs px-2 py-1 rounded-full border text-emerald-300 border-emerald-400/40";

  // Responsive visuals
  const chartH = Math.max(compact ? 318 : 308, height - (compact ? 24 : 42));
  const small = (w || 0) < 520;

  const xTickCount  = small ? 6 : 12;              // months shown (we still force all labels)
  const leftMargin  = small ? 38 : 56;
  const rightMargin = small ? 14 : 24;
  const topMargin   = compact ? 18 : 8;
  const bottomMargin= small ? 28 : 38;             // month labels

  const xTickStyle  = { fill: "rgba(255,255,255,0.66)", fontSize: small ? 11 : 13, fontWeight: 700 };

  // Compute a reasonable barSize from width (12 months)
  const paddingPerBar = small ? 1 : 1;
  const approxBarSize = Math.max(
    compact ? 18 : 22,
    Math.floor(((w || 0) - leftMargin - rightMargin) / 12) - paddingPerBar - (compact ? 4 : 0)
  );

  // Darker emerald to match Insight cards
  const BAR_COLOR = "#00D59C";

  return (
    <div className={`flex h-full flex-col rounded-xl border border-white/10 bg-[var(--panel)] p-5 shadow-[0_18px_40px_rgba(0,0,0,0.32)] ${className}`}>
      {/* Compact CardHeader to match Pulse sizing */}
      <CardHeader
        title="NET PROFIT"
        right={<span className={badgeClass}>{isMock ? "Mock" : "QuickBooks"}</span>}
        size="sm"
        dense
        className={compact ? "mb-3" : "mb-1"}
        titleClassName="text-[13px]" // safe override if supported
      />

      <div ref={measureRef} className="min-h-0 flex-1" style={{ height: chartH }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={series}
            margin={{ top: topMargin, right: rightMargin, left: leftMargin, bottom: bottomMargin }}
          >
            {/* Grid hidden by default to remove dotted background lines */}
            {showGrid && (
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
            )}

            <XAxis
              dataKey="month"
              tick={xTickStyle}
              tickLine={false}
              axisLine={false}
              interval={0}       // force all month labels
              tickCount={xTickCount}
              tickMargin={12}
              minTickGap={0}
              height={38}
            />
            <YAxis
              tick={{ fill: "rgba(255,255,255,0.62)", fontSize: small ? 11 : 13, fontWeight: 700 }}
              tickLine={false}
              axisLine={false}
              width={leftMargin + 4}
              tickFormatter={(v)=>`$${(v/1000).toFixed(0)}k`}
            />
            <Tooltip
              contentStyle={{ backgroundColor: "#111", border: "1px solid #333" }}
              labelStyle={{ color: "#aaa" }}
              formatter={(value)=>[`$${Number(value).toLocaleString()}`,"Net Profit"]}
              wrapperStyle={{ zIndex: 30 }}
            />
            <Bar
              dataKey="profit"
              fill={BAR_COLOR}
              radius={[4,4,0,0]}
              barSize={approxBarSize}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
