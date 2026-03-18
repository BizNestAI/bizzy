// /src/pages/Tax/DeductionsPage.jsx
import React, { useMemo, useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useBusinessContext } from "../../context/BusinessContext";
import { useDeductionsMatrix } from "../../hooks/useDeductionsMatrix";
import DeductionsHeaderKpis from "../../components/Tax/DeductionsHeaderKpis";
import DeductionsMatrix from "../../components/Tax/DeductionsMatrix";
import { RefreshCw, Download, ChevronDown, Search, X, ArrowRight } from "lucide-react";
import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader.jsx";
import { useRightExtras } from "../../insights/RightExtrasContext";
import AgendaWidget from "../../pages/Calendar/AgendaWidget.jsx";
import { supabase } from "../../services/supabaseClient";
import LiveModePlaceholder from "../../components/common/LiveModePlaceholder.jsx";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";
import apiBaseUrl from "../../utils/apiBase.js";
import useOnboardingStatus from "../../hooks/useOnboardingStatus.js";

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
  const [search, setSearch] = useState("");
  // Reduced filters: search only
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(null);

  const RAW = (apiBaseUrl || "").replace(/\/+$/, "");
  const API_HOST = RAW || "";
  const ASK_ROUTE = "/api/gpt/brain/bizzyInsight";

  const {
    data, months, currentMonth, topCategory, thisMonthTotal,
    loading, error, refetch, exportCsv,
  } = useDeductionsMatrix({ businessId, year });
  const { onboardingComplete, qbConnected, plaidConnected, loading: onboardingLoading } = useOnboardingStatus({ businessId });

  const ytdTotal = useMemo(() => data?.totals?.ytdTotal || 0, [data]);
  const source = data?.meta?.source === "mock" ? "Mock" : (data?.meta?.source ? "Live" : "");
  const prevMonthIso = useMemo(() => {
    if (!months || !currentMonth) return null;
    const idx = months.findIndex((m) => m === currentMonth);
    return idx > 0 ? months[idx - 1] : null;
  }, [months, currentMonth]);
  const totalsPrevMonth = useMemo(
    () => (prevMonthIso ? data?.totals?.monthly?.[prevMonthIso] : null),
    [data?.totals?.monthly, prevMonthIso]
  );
  const grid = data?.grid || [];

  const filteredGrid = useMemo(() => {
    let rows = [...grid];
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((r) => (r.category || "").toLowerCase().startsWith(q));
    }
    rows = rows.sort((a, b) => (Number(b.ytdTotal) || 0) - (Number(a.ytdTotal) || 0));
    return rows;
  }, [grid, search]);

  const topCategoryPct = useMemo(() => {
    if (!topCategory?.ytdTotal || !ytdTotal) return null;
    return Math.round((topCategory.ytdTotal / ytdTotal) * 100);
  }, [topCategory, ytdTotal]);

  const mealsRow = useMemo(() => grid.find((r) => (r.category || "").toLowerCase().includes("meal")), [grid]);
  const mealsPct = useMemo(() => {
    if (!mealsRow?.ytdTotal || !ytdTotal) return null;
    return Math.round((mealsRow.ytdTotal / ytdTotal) * 100);
  }, [mealsRow, ytdTotal]);

  const readinessFlags = useMemo(() => {
    const flags = [];
    if (topCategoryPct && topCategoryPct > 45) flags.push("High concentration in one category");
    if (mealsPct && mealsPct > 10) flags.push("Meals unusually high");
    if (!flags.length) flags.push("No major flags");
    return flags;
  }, [topCategoryPct, mealsPct]);

  // Ask Bizzi helper — dispatch prefill event; falls back to API if needed
  const handleAskBizzy = useCallback(
    async (message, ctx = {}) => {
      try {
        window.dispatchEvent(new CustomEvent("bizzy:prefill-chat", { detail: { prompt: message, context: ctx } }));
      } catch (e) {
        console.warn("Prefill chat event failed", e);
      }
      try {
        const token = await getAccessToken();
        if (!token) return;
        await fetch(`${API_HOST}${ASK_ROUTE}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          credentials: "include",
          body: JSON.stringify({ prompt: message, businessId, context: ctx }),
        }).catch(() => {});
      } catch (e) {
        console.warn("[AskBizzy inline error]", e?.message || e);
      }
    },
    [API_HOST, ASK_ROUTE, businessId]
  );

  const sourceBadgeCls = "border-[rgba(var(--accent-rgb),0.4)] text-[rgba(var(--accent-rgb),0.9)] bg-[rgba(var(--accent-rgb),0.12)]";

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

  const usingDemo = shouldUseDemoData(currentBusiness);
  const liveConnectionsReady = onboardingComplete || (qbConnected && plaidConnected);
  const showLivePlaceholder = businessId && !usingDemo && !onboardingLoading && !liveConnectionsReady;

  if (showLivePlaceholder) {
    return <LiveModePlaceholder title="Connect accounting to track deductions" />;
  }

  return (
    <div className="min-h-screen w-full text-white">
      <div className="max-w-6xl mx-auto px-4 md:px-6 pt-4 pb-8 space-y-6">
        {/* Page heading (aligned with main Tax header style) */}
        <ModuleHeader
          module="tax"
          title="Tax Deductions"
          subtitle="Track year-to-date deductions, spot your top categories, and stay ahead of estimated payments."
        />

        {/* KPIs + Controls unified (Jobs-style lighter chrome) */}
        <div
          className="space-y-3 rounded-[24px] bg-white/[0.03] border border-white/6 shadow-[0_18px_50px_rgba(0,0,0,0.35)] p-4 md:p-5"
          style={{ borderColor: "rgba(255,255,255,0.08)" }}
        >
          {/* Action bar above KPIs */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3 bg-white/3 border border-white/6">
            <div className="flex items-center gap-3">
              <span className="text-xs text-white/70 uppercase tracking-[0.35em]">Year</span>
              <div className="relative">
                <select
                  value={year}
                  onChange={(e) => setYear(Number(e.target.value))}
                  className="dark-dropdown appearance-none bg-[#0f1115] text-sm text-white px-3 py-1.5 pr-8 rounded-[11px] focus:outline-none cursor-pointer border border-white/10 shadow-[0_12px_30px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.05)]"
                  style={{ minWidth: 100 }}
                >
                  {yearOptions.map((y) => (
                    <option
                      key={y}
                      value={y}
                      className="bg-[#0b0d11] text-white"
                    >
                      {y}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={16}
                  className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-white/70"
                />
              </div>

              {source ? (
                <span className={`text-[10px] px-2 py-0.5 rounded-full border ${sourceBadgeCls}`}>
                  {source}
                </span>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={refetch}
                className="text-xs inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg transition bg-white/5 hover:bg-white/10"
              >
                {loading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              </button>

              <button
                onClick={exportCsv}
                className="text-xs inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg transition bg-white/5 hover:bg-white/10"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <DeductionsHeaderKpis
              items={buildKpiItems({
                ytdTotal,
                topCategory,
                thisMonthTotal,
                prevMonthTotal: totalsPrevMonth,
                prevMonthTop: topCategory?.monthly?.[prevMonthIso],
                prevMonthThis: totalsPrevMonth,
                currentMonth,
              })}
              compact
              onAskBizzy={handleAskBizzy}
            />
          </div>
        </div>

        {/* Matrix card */}
        <div
          className="rounded-[32px] border overflow-hidden shadow-[0_25px_80px_rgba(0,0,0,0.55)]"
          style={{ borderColor: PANEL_BORDER, background: PANEL_BG }}
        >
          <div className="px-4 pt-4">
            <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-2">
              <Search className="h-4 w-4 text-white/60" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search categories"
                className="bg-transparent text-sm text-white placeholder:text-white/50 focus:outline-none w-full"
              />
              {search ? (
                <button onClick={() => setSearch("")} className="text-white/60 hover:text-white">
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          </div>

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
                grid={filteredGrid}
                totals={data.totals || {}}
                onExport={exportCsv}
                onAdd={() => alert("Hook this up to a create-expense flow or manual entry modal.")}
                onAskBizzy={handleAskBizzy}
                onRowClick={(row) => { setSelectedCategory(row); setDrawerOpen(true); }}
                showTotals={!search.trim()}
              />
            </>
          ) : (
            <div className="p-3 text-sm text-white/70">
              No deductions available. Connect QuickBooks to populate your categorized spend.
            </div>
          )}
        </div>
      </div>

      <CategoryDetailDrawer
        open={drawerOpen}
        row={selectedCategory}
        months={months}
        totals={data?.totals}
        onClose={() => setDrawerOpen(false)}
        onAskBizzi={handleAskBizzy}
      />
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

/* ---------- helper builders ---------- */
function buildKpiItems({ ytdTotal, topCategory, thisMonthTotal, prevMonthTotal, prevMonthTop, prevMonthThis, currentMonth }) {
  const delta = (curr, prev) => {
    if (typeof curr !== "number" || typeof prev !== "number") return null;
    const diff = Math.round(curr - prev);
    if (!Number.isFinite(diff) || diff === 0) return null;
    return `${diff > 0 ? "+" : ""}${diff.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 })} vs last month`;
  };

  const status = (value) => (Number(value || 0) === 0 ? "Needs data" : "Tracked");

  return [
    {
      label: "Total Deductions YTD",
      value: fmtUSD(ytdTotal),
      delta: delta(ytdTotal, prevMonthTotal),
      status: status(thisMonthTotal),
      ask: "How should I trend my deductions this year?",
    },
    {
      label: "Top Category YTD",
      value: topCategory ? `${topCategory.category}: ${fmtUSD(topCategory.ytdTotal)}` : "—",
      delta: topCategory && delta(topCategory.ytdTotal, prevMonthTop),
      status: status(topCategory?.ytdTotal),
      ask: topCategory ? `Is ${topCategory.category} too high compared to peers?` : "What is my highest deduction category?",
    },
    {
      label: "This Month",
      value: fmtUSD(thisMonthTotal),
      delta: delta(thisMonthTotal, prevMonthThis),
      status: status(thisMonthTotal),
      ask: `Are my ${currentMonth || "current"} deductions reasonable?`,
    },
  ];
}

function fmtUSD(n) {
  const v = typeof n === "number" ? n : Number(n || 0);
  return v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function shortMonth(iso) {
  const m = Number(String(iso).slice(5, 7));
  return ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][m - 1] || "";
}

/* ---------- UI subcomponents ---------- */
function DeductionReadinessBanner({ ytdTotal, topCategoryPct, thisMonthTotal, flags = [], onAsk, onReviewBooks }) {
  const items = [
    { label: "YTD deductions", value: fmtUSD(ytdTotal) },
    { label: "Top category %", value: topCategoryPct != null ? `${topCategoryPct}%` : "—" },
    { label: "This month", value: fmtUSD(thisMonthTotal) },
    { label: "Flags", value: flags.join(" • ") },
  ];
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.05] shadow-[0_18px_40px_rgba(0,0,0,0.35)] px-4 py-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 w-full">
        {items.map((item) => (
          <div key={item.label} className="rounded-xl bg-white/[0.04] border border-white/8 px-3 py-2">
            <div className="text-[11px] uppercase tracking-[0.1em] text-white/60">{item.label}</div>
            <div className="text-sm font-semibold text-white truncate">{item.value}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onAsk}
          className="inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-[13px] border border-white/14 bg-white/5 hover:bg-white/10 transition"
        >
          Ask Bizzi
        </button>
        <button
          onClick={onReviewBooks}
          className="inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-[13px] border border-white/10 text-white/80 hover:text-white hover:border-white/14 transition"
        >
          Review Books
        </button>
      </div>
    </div>
  );
}

function CategoryDetailDrawer({ open, row, months = [], totals, onClose, onAskBizzi }) {
  const percent =
    row && totals?.ytdTotal
      ? Math.round(((Number(row.ytdTotal) || 0) / Number(totals.ytdTotal)) * 100)
      : null;

  useEffect(() => {
    function onEsc(e) {
      if (e.key === "Escape") onClose?.();
    }
    if (open) window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open, onClose]);

  return (
    <div className={`fixed inset-0 z-40 ${open ? "pointer-events-auto" : "pointer-events-none"}`}>
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      <div
        className={`absolute right-0 top-0 h-full w-full sm:w-[420px] transform transition-transform duration-200 ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="h-full overflow-y-auto bg-[#0f1115]/95 backdrop-blur-lg border-l border-white/10 shadow-[0_0_40px_rgba(0,0,0,0.5)] p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-[0.12em] text-white/60">Category</div>
              <div className="text-xl font-semibold text-white">{row?.category || "Category"}</div>
            </div>
            <button onClick={onClose} className="text-white/60 hover:text-white">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/5 p-3 space-y-1">
            <div className="flex items-center justify-between text-sm text-white/80">
              <span>YTD total</span>
              <span className="font-semibold">{fmtUSD(row?.ytdTotal)}</span>
            </div>
            <div className="flex items-center justify-between text-sm text-white/70">
              <span>Percent of total</span>
              <span>{percent != null ? `${percent}%` : "—"}</span>
            </div>
          </div>

          <div>
            <div className="text-sm font-semibold text-white mb-2">Month by month</div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              {months.map((iso) => (
                <div key={iso} className="rounded-lg border border-white/8 bg-white/3 px-3 py-2 flex items-center justify-between">
                  <span className="text-white/65">{shortMonth(iso)}</span>
                  <span className="font-mono text-white">{fmtUSD(row?.monthly?.[iso])}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <button
              onClick={() =>
                onAskBizzi?.(`Explain why ${row?.category || "this category"} is elevated and what to check.`, {
                  category: row?.category,
                  ytd: row?.ytdTotal,
                })
              }
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 border border-[rgba(var(--accent-rgb),0.4)] bg-[rgba(var(--accent-rgb),0.12)] text-white hover:bg-[rgba(var(--accent-rgb),0.18)]"
            >
              Ask Bizzi
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>

          <div className="rounded-lg border border-white/8 bg-white/3 px-3 py-2 text-sm text-white/70">
            <div className="font-semibold text-white mb-1">Top transactions</div>
            <div>Transaction details will appear here once connected.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
