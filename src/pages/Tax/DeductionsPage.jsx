// /src/pages/Tax/DeductionsPage.jsx
import React, { useMemo, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useBusinessContext } from "../../context/BusinessContext";
import { useDeductionsMatrix } from "../../hooks/useDeductionsMatrix";
import DeductionsHeaderKpis from "../../components/Tax/DeductionsHeaderKpis";
import DeductionsMatrix from "../../components/Tax/DeductionsMatrix";
import { RefreshCw, Download, ShieldCheck } from "lucide-react";
import { useRightExtras } from "../../insights/RightExtrasContext";
import AgendaWidget from "../../pages/calendar/AgendaWidget.jsx";
import { supabase } from "../../services/supabaseClient";
import LiveModePlaceholder from "../../components/common/LiveModePlaceholder.jsx";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";

// Reliable token getter: Supabase first, then localStorage fallback
  async function getAccessToken() {
    try {
      const { data } = await supabase.auth.getSession();
      if (data?.session?.access_token) return data.session.access_token;
    } catch {}
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (/^sb-.*-auth-token$/.test(k)) {
          const parsed = JSON.parse(localStorage.getItem(k) || "{}");
          const tok =
            parsed?.access_token ||
            parsed?.currentSession?.access_token ||
            parsed?.user?.access_token;
          if (tok) return tok;
        }
      }
    } catch {}
    return null;
  }


const PANEL_BG = "var(--panel)";
const PANEL_BORDER = "rgba(191,191,191,0.18)";

export default function DeductionsPage() {
  const { currentBusiness } = useBusinessContext?.() || {};
  const businessId = currentBusiness?.id || localStorage.getItem("currentBusinessId");
  const navigate = useNavigate();

  // Year picker (defaults to current year)
  const currentYear = new Date().getFullYear(); 
  const [year, setYear] = useState(currentYear);

  const RAW = (import.meta.env.VITE_API_BASE || "").replace(/\/+$/, "");
  const API_HOST = RAW || "";
  const ASK_ROUTE = "/api/gpt/brain/bizzyInsight";

  const {
    data, months, currentMonth, topCategory, thisMonthTotal,
    loading, error, refetch, exportCsv,
  } = useDeductionsMatrix({ businessId, year });

  const ytdTotal = useMemo(() => data?.totals?.ytdTotal || 0, [data]);
  const source = data?.meta?.source === "mock" ? "Mock" : (data?.meta?.source ? "Live" : "");

  // Inline Ask Bizzy handler — sends to your /api/gpt/bizzyInsight endpoint
   async function handleAskBizzy(message, ctx = {}) {
     try {
      const token = await getAccessToken();
      if (!token) throw new Error("Unauthorized: missing access token");
       const res = await fetch(`${API_HOST}${ASK_ROUTE}`, {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         ...(token ? { Authorization: `Bearer ${token}` } : {}),
         credentials: "include",
         body: JSON.stringify({ prompt: message, businessId, context: ctx }),
       });
       const json = await res.json();
       if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
       // For MVP: show a quick confirmation. You can also forward json.reply into your chat.
       // TODO: plumb this into Bizzy chat. For now show a lightweight toast/modal.
        console.log("[AskBizzy reply]", json?.reply);
        alert("Bizzy replied. (Check console or wire this into chat.)");
     } catch (e) {
       console.error("[AskBizzy inline error]", e);
       alert(e?.message || "Ask Bizzi failed. Try again.");
     }
   }

  const sourceBadgeCls =
    source === "Mock"
      ? "border-yellow-400/40 text-yellow-300 bg-yellow-500/10"
      : "border-green-400/40 text-green-300 bg-green-500/10";

  // publish AgendaWidget into right rail
   const { setRightExtras } = useRightExtras();
   useEffect(() => {
     if (!businessId) {
       setRightExtras(null);
       return;
     }
     setRightExtras(
       <AgendaWidget
         key={`tax-agenda-${businessId}`}          // remount on business change
         businessId={businessId}
         module="tax"
         onOpenCalendar={() => navigate("/dashboard/calendar")}
       />
     );
     return () => setRightExtras(null);
   }, [businessId, navigate, setRightExtras]);

  // Simple set of years to browse (current ±2). Adjust as you like.
  const yearOptions = [currentYear - 2, currentYear - 1, currentYear, currentYear + 1];

  if (businessId && !shouldUseDemoData(currentBusiness)) {
    return <LiveModePlaceholder title="Connect accounting to track deductions" />;
  }

  return (
    <div className="min-h-screen w-full text-white">
      <div className="max-w-6xl mx-auto px-4 md:px-6 pt-4 pb-8 space-y-6">
        {/* Page heading */}
        <header
          className="rounded-[32px] border px-5 py-6 md:px-8 md:py-7 shadow-[0_30px_80px_rgba(0,0,0,0.55)] flex flex-col gap-4"
          style={{ background: PANEL_BG, borderColor: PANEL_BORDER }}
        >
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-amber-300/70 to-yellow-500/50 flex items-center justify-center text-black">
              <ShieldCheck size={24} />
            </div>
            <div>
              <p className="uppercase text-xs tracking-[0.3em] text-white/60">Tax · Deductions</p>
              <h1 className="text-3xl md:text-[40px] font-semibold leading-tight">Keep every deductible dollar</h1>
            </div>
          </div>
          <p className="text-sm text-white/70 leading-relaxed max-w-3xl">
            Bizzi highlights categorized expenses across your books so you never miss a write-off. Track year-to-date totals,
            stay ahead of estimated payments, and capture receipts before tax season.
          </p>
        </header>

        {/* KPIs */}
        <DeductionsHeaderKpis
          ytdTotal={ytdTotal}
          topCategory={topCategory}
          thisMonthTotal={thisMonthTotal}
        />

        {/* Action bar */}
        <div
          className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3"
          style={{
            background: PANEL_BG,
            border: `1px solid ${PANEL_BORDER}`,
            boxShadow: "0 16px 45px rgba(0,0,0,0.45)",
          }}
        >
          <div className="flex items-center gap-2">
            <label className="text-xs text-white/70 uppercase tracking-[0.4em]">Year</label>
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="text-sm rounded-lg px-3 py-1 focus:outline-none"
              style={{
                background: PANEL_BG,
                border: `1px solid ${PANEL_BORDER}`,
                color: "var(--text)",
                boxShadow: "0 0 0 1px rgba(0,0,0,0.35) inset",
              }}
            >
              {yearOptions.map((y) => (
                <option key={y} value={y} className="bg-app">{y}</option>
              ))}
            </select>

            {/* Source badge */}
            {source ? (
              <span className={`ml-2 text-[10px] px-2 py-0.5 rounded-full border ${sourceBadgeCls}`}>
                {source}
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={refetch}
              className="text-xs inline-flex items-center gap-2 px-3 py-1.5 rounded-lg transition"
              style={{
                border: "1px solid rgba(191,191,191,0.2)",
                background: PANEL_BG,
              }}
            >
              {loading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </button>

            <button
              onClick={exportCsv}
              className="text-xs inline-flex items-center gap-2 px-3 py-1.5 rounded-lg transition"
              style={{
                border: "1px solid rgba(191,191,191,0.2)",
                background: PANEL_BG,
              }}
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>
          </div>
        </div>

        {/* Matrix card */}
        <div
          className="rounded-[32px] border overflow-hidden shadow-[0_25px_80px_rgba(0,0,0,0.55)]"
          style={{ borderColor: PANEL_BORDER, background: PANEL_BG }}
        >
          {loading ? (
            <Skeleton />
          ) : error ? (
            <div className="p-3 text-sm text-red-300">{error}</div>
          ) : data ? (
            <>
              <DeductionsMatrix
                hideHeader                 // 👈 prevent duplicate H2 + subtitle
                months={months}
                currentMonth={currentMonth}
                grid={data.grid || []}
                totals={data.totals || {}}
                onExport={exportCsv}
                onAdd={() => alert("Hook this up to a create-expense flow or manual entry modal.")}
                onAskBizzy={handleAskBizzy}
              />
            </>
          ) : (
            <div className="p-3 text-sm text-white/70">
              No deductions available. Connect QuickBooks to populate your categorized spend.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="p-3 space-y-3 animate-pulse">
      <div className="h-20 rounded-md bg-white/10" />
      <div className="h-56 rounded-md bg-white/10" />
    </div>
  );
}
