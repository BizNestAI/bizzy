// File: /src/components/Accounting/NetProfitChart.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { usePeriod } from "../../context/PeriodContext";
import { supabase } from "../../services/supabaseClient";
import CardHeader from "../UI/CardHeader"; // ⬅️ shared header
import { getDemoData, shouldForceLiveData, shouldUseDemoData } from "../../services/demo/demoClient.js";

const API_BASE = import.meta.env?.VITE_API_BASE || "";

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
  const { period } = usePeriod();
  const userId = userIdProp || localStorage.getItem("user_id");
  const businessId = businessIdProp || localStorage.getItem("currentBusinessId");
  const forceLive = shouldForceLiveData();
  const usingDemo = !forceLive && shouldUseDemoData();
  const demoData = useMemo(() => (usingDemo ? getDemoData() : null), [usingDemo]);

  const [series, setSeries] = useState(null);
  const [status, setStatus] = useState("idle");
  const [source, setSource] = useState(null); // "quickbooks" | "supabase" | "mock"

  const windowMonths = useMemo(()=>{
    if(!period?.year || !period?.month) return [];
    return seqLastNMonths({ year: period.year, month: period.month, n: 12 });
  }, [period?.year, period?.month]);

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
          `${API_BASE}/api/accounting/profit-series` +
          `?business_id=${encodeURIComponent(businessId)}` +
          `&user_id=${encodeURIComponent(userId)}` +
          `&end_year=${encodeURIComponent(period.year)}` +
          `&end_month=${encodeURIComponent(period.month)}` +
          `&window=12` +
          `&data_mode=live&live_only=true`;
        const r = await fetch(url, {
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
            `${API_BASE}/api/accounting/metrics` +
            `?business_id=${encodeURIComponent(businessId)}` +
            `&user_id=${encodeURIComponent(userId)}` +
            `&year=${encodeURIComponent(year)}` +
            `&month=${encodeURIComponent(month)}` +
            `&data_mode=live&live_only=true`;
          try{
            const r = await fetch(url, { headers:{"Content-Type":"application/json","x-user-id":userId,"x-business-id":businessId,"x-data-mode":"live"} });
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
  }, [userId, businessId, period?.year, period?.month, windowMonths.length, demoData, forceLive]);

  // Measure container to tune margins / bar size responsively
  const [measureRef, { width: w }] = useMeasure();  // keep above returns

  if(status==="loading"){
    return <div className={`bg-zinc-900 border border-white/10 rounded-xl p-4 text-white/70 ${className}`}>Loading profit…</div>;
  }
  if(!series || !series.length) return null;

  const isMock = source === "mock";
  const badgeClass =
    isMock
      ? "text-xs px-2 py-1 rounded-full border text-amber-300 border-amber-400/40"
      : "text-xs px-2 py-1 rounded-full border text-emerald-300 border-emerald-400/40";

  // Responsive visuals
  const chartH = Math.max(200, height);
  const small = (w || 0) < 520;

  const xTickCount  = small ? 6 : 12;              // months shown (we still force all labels)
  const leftMargin  = small ? 28 : 36;
  const rightMargin = 12;
  const topMargin   = 8;
  const bottomMargin= small ? 30 : 38;             // extra space for month labels

  const xTickStyle  = { fill: "#a3a3a3", fontSize: small ? 11 : 12, dy: 6 };

  // Compute a reasonable barSize from width (12 months)
  const paddingPerBar = small ? 4 : 6;
  const approxBarSize = Math.max(
    14,
    Math.floor(((w || 0) - leftMargin - rightMargin) / 12) - paddingPerBar
  );

  // Darker emerald to match Insight cards
  const BAR_COLOR = "#00D59C";

  return (
    <div className={`bg-zinc-900 border border-white/10 rounded-xl p-4 ${className}`}>
      {/* Compact CardHeader to match Pulse sizing */}
      <CardHeader
        title="NET PROFIT"
        right={<span className={badgeClass}>{isMock ? "Mock" : "QuickBooks"}</span>}
        size="sm"
        dense
        className="mb-2"
        titleClassName="text-[13px]" // safe override if supported
      />

      <div ref={measureRef} style={{ height: chartH }}>
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
              height={28}
            />
            <YAxis
              tick={{ fill: "#a3a3a3", fontSize: small ? 11 : 12 }}
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
