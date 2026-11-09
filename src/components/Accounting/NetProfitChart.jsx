import useMeasure from "./useChartMeasure.js";
import HealthChartTooltip from "./HealthChartTooltip.jsx";
import { FORECAST_COLORS, formatForecastAxis } from "../../utils/forecast/forecastPresentation.js";
// File: /src/components/Accounting/NetProfitChart.jsx
import React, { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, Cell, ReferenceLine, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import useFinancialPeriod from "../../hooks/useFinancialPeriod.js";

import { getDemoData, shouldForceLiveData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import { apiFetch } from "../../utils/apiBase.js";
import { buildCurrencyAxis } from "../../utils/currencyAxis.js";

/* ---------- helpers ---------- */
function monthShortLabel(y,m){ return new Date(y, m-1, 1).toLocaleString(undefined,{month:"short"});}
function seqLastNMonths({year,month,n=12}){ const out=[]; let y=year,m=month; for(let i=0;i<n;i++){out.unshift({year:y,month:m}); if(--m<1){m=12;y--;}} return out;}
function allSame(values){ if(!values.length) return true; return values.every(v=>Number(v)===Number(values[0])); }
function toChartData(rows){ return rows.map(r=>({ month: monthShortLabel(r.year,r.month), fullMonth: new Date(r.year,r.month-1,1).toLocaleString(undefined,{month:"short",year:"numeric"}), profit: r.found === false || r.profit === null || r.profit === undefined ? null : Number(r.profit) })); }
function buildMock(windowMonths){
  const base=[7200,8200,10400,9300,8700,11600,12300,9900,13800,14200,15500,15700];
  const months = windowMonths.length ? windowMonths : seqLastNMonths({year:new Date().getFullYear(), month:new Date().getMonth()+1, n:12});
  return months.map((m,i)=>({ year:m.year, month:m.month, profit: base[i%base.length] }));
}
function buildSlidingDemoRows(windowMonths, sourceRows = [], valueKey = "profit") {
  const values = (sourceRows || [])
    .map((row) => Number(row?.[valueKey] ?? 0))
    .filter((value) => Number.isFinite(value));
  const fallback = buildMock(windowMonths).map((row) => Number(row.profit || 0));
  const seriesValues = values.length ? values : fallback;
  return windowMonths.map(({ year, month }, index) => ({
    year,
    month,
    profit: seriesValues[index % seriesValues.length] ?? 0,
  }));
}

const NET_PROFIT_SERIES_CACHE = new Map();

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

export default function NetProfitChart({
  userId: userIdProp,
  businessId: businessIdProp,
  year: yearProp,
  month: monthProp,
  /** Parent-controlled sizing */
  compact = false,
  className = "",
  showGrid = false,        // off by default to remove dotted lines
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
  const [source, setSource] = useState(null); // "quickbooks" | "supabase" | "mock"

  const windowMonths = useMemo(()=>{
    if(!year || !month) return [];
    return seqLastNMonths({ year, month, n: 12 });
  }, [year, month]);

  useEffect(()=>{
    let cancelled=false;

    async function fetchSeries(){
      if (demoData) {
        const rows = windowMonths.length
          ? buildSlidingDemoRows(windowMonths, demoData?.financials?.monthlyProfit, "profit")
          : [];
        if (!cancelled) {
          setSeries(toChartData(rows));
          setSource("demo");
          setStatus("success");
        }
        return;
      }
      if(!businessId || windowMonths.length===0){
        const rows = forceLive ? [] : buildMock(windowMonths);
        if(!cancelled){ setSeries(toChartData(rows)); setSource(forceLive ? "empty" : "mock"); setStatus("success"); }
        return;
      }
      const cacheKey = `${businessId}:${year}:${month}:12`;
      const cached = NET_PROFIT_SERIES_CACHE.get(cacheKey);
      if (cached) {
        setSeries(cached.series);
        setSource(cached.source);
        setStatus("success");
      } else {
        setStatus("loading");
      }

      // 1) Try consolidated API
      try{
        const userParam = userId ? `&user_id=${encodeURIComponent(userId)}` : "";
        const url =
          `/api/accounting/health/series` +
          `?business_id=${encodeURIComponent(businessId)}` +
          userParam +
          `&end_year=${encodeURIComponent(year)}` +
          `&end_month=${encodeURIComponent(month)}` +
          `&window=12`;
        const r = await apiFetch(url, {
          headers: {"Content-Type":"application/json","x-user-id":userId || "","x-business-id":businessId,"x-data-mode":"live"},
          cache: "no-store",
        });
        if(r.ok){
          const json = await r.json();
          const rows = (Array.isArray(json?.profit) ? json.profit : (Array.isArray(json?.rows)? json.rows : json))?.map(v=>({
            year:Number(v.year),
            month:Number(v.month),
            profit:v.found === false ? null : Number(v.profit ?? 0),
            found:v.found !== false && v.profit !== null && v.profit !== undefined,
          })) || [];
          if(!cancelled && rows.some((row) => row.found)){
            const nextSeries = toChartData(rows);
            const nextSource = json?.source || "quickbooks";
            setSeries(nextSeries);
            setSource(nextSource);
            NET_PROFIT_SERIES_CACHE.set(cacheKey, { series: nextSeries, source: nextSource });
            setStatus("success");
            return;
          }
        }
      }catch{/* ignore */}

      // 2) Per-month persisted fallback
      try{
        const rows = await Promise.all(windowMonths.map(async ({year,month})=>{
          const userParam = userId ? `&user_id=${encodeURIComponent(userId)}` : "";
          const url =
            `/api/accounting/metrics` +
            `?business_id=${encodeURIComponent(businessId)}` +
            userParam +
            `&year=${encodeURIComponent(year)}` +
            `&month=${encodeURIComponent(month)}` +
            `&data_mode=live&persisted_only=true`;
          try{
            const r = await apiFetch(url, {
              headers:{"Content-Type":"application/json","x-user-id":userId || "","x-business-id":businessId,"x-data-mode":"live"},
              cache: "no-store",
            });
            if(!r.ok) throw new Error(`HTTP ${r.status}`);
            const payload = await r.json();
            const profit = coalesceProfit(payload);
            const found = profit != null && Number.isFinite(Number(profit));
            return { year, month, profit: found ? Number(profit) : null, found };
          }catch{
            return { year, month, profit: null, found: false };
          }
        }));

        const values = rows.map(r=>r.profit).filter((value) => value !== null && value !== undefined);
        const shouldMock = !forceLive && allSame(values);
        const rowsFinal = shouldMock ? buildMock(windowMonths) : rows;
        if(!cancelled){
          const nextSeries = toChartData(rowsFinal);
          const nextSource = shouldMock ? "mock" : "quickbooks";
          setSeries(nextSeries);
          setSource(nextSource);
          NET_PROFIT_SERIES_CACHE.set(cacheKey, { series: nextSeries, source: nextSource });
          setStatus("success");
        }
      }catch(e){
        console.error("[NetProfitChart] fetch failed:", e);
        if(!cancelled){
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
    return ()=>{ cancelled=true; };
  }, [userId, businessId, year, month, windowMonths, demoData, forceLive, refreshVersion]);

  // Measure container to tune margins / bar size responsively
  const [measureRef, { width: w }] = useMeasure();  // keep above returns

  const values = (series || []).map(r => r.profit).filter(v => v != null && Number.isFinite(Number(v)));
  const axis = buildCurrencyAxis(values, { includeZero: true, minAtZero: values.every(v => v >= 0), tickCount: 5, headroom: 0.15 });
  const small = (w || 0) < 520;
  return <section className={`forecast-chart-surface health-chart-panel financial-health-visual ${className}`} aria-label="Net profit trend">
    <header className="health-panel-header"><h3>Net profit · prior 12 months</h3>{['mock','demo'].includes(source) && <span className="forecast-badge">Sample data</span>}</header>
    {status === 'loading' ? <div className="health-skeleton health-chart-skeleton" role="status">Loading profit history…</div> : !values.length ? <div className="forecast-empty">No profit history available for the selected window.</div> : <div ref={measureRef} className="health-chart-canvas">
      <ResponsiveContainer width="100%" height="100%"><BarChart data={series} margin={{top:18,right:small ? 24 : 40,left:12,bottom:10}}>
        {showGrid && <CartesianGrid vertical={false} strokeDasharray="3 6" stroke="rgba(255,255,255,0.07)"/>}
        <XAxis dataKey="month" tick={{fill:'#a3aea7',fontSize:11}} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={compact ? 10 : 16} tickMargin={10} height={30}/>
        <YAxis width={70} tick={{fill:'#a3aea7',fontSize:11}} tickLine={false} axisLine={false} domain={axis.domain} ticks={axis.ticks} tickFormatter={formatForecastAxis}/>
        <ReferenceLine y={0} stroke="rgba(251,191,36,0.28)" strokeDasharray="4 5"/>
        {series?.length > 0 && <ReferenceLine x={series.at(-1).month} stroke="rgba(255,255,255,0.16)" strokeDasharray="3 5" label={{value:'Selected',fill:'#a3aea7',fontSize:10,position:'insideTopRight'}}/>}
        <Tooltip content={<HealthChartTooltip kind="profit"/>} wrapperStyle={{zIndex:30}} cursor={{fill:'rgba(255,255,255,0.035)'}}/>
        <Bar dataKey="profit" radius={[3,3,3,3]} maxBarSize={26} isAnimationActive={false}>
          {series.map((r,i)=><Cell key={i} fill={r.profit < 0 ? FORECAST_COLORS.negative : FORECAST_COLORS.positive} fillOpacity={i === series.length-1 ? 1 : 0.8} stroke={i === series.length-1 ? (r.profit < 0 ? FORECAST_COLORS.negative : FORECAST_COLORS.positive) : 'none'} strokeWidth={2}/>)}
        </Bar>
      </BarChart></ResponsiveContainer>
    </div>}
  </section>;
}
