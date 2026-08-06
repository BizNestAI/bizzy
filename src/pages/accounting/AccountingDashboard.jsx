// File: /src/pages/Accounting/AccountingDashboard.jsx
import React, { lazy, Suspense, useMemo, useEffect, useState, useRef, useCallback } from 'react';
import { useBusiness } from '../../context/BusinessContext';
import useModuleTheme from '../../hooks/useModuleTheme';
import { useNavigate } from 'react-router-dom';
import AgendaWidget from '../Calendar/AgendaWidget.jsx';

import ModuleHeader from '../../components/layout/ModuleHeader/ModuleHeader';

import FinancialKPICards from '../../components/Accounting/FinancialKPICards';
import MonthlyBriefCard from '../../components/Accounting/MonthlyBriefCard';
import useIntegrationManager from '../../hooks/useIntegrationManager.js';
import { safeFetch } from '../../utils/safeFetch.js';
import { RefreshCcw, ChevronDown } from 'lucide-react';
import useFinancialPeriod from '../../hooks/useFinancialPeriod.js';
import ReconciliationStatusWidget from '../../components/Accounting/ReconciliationStatusWidget.jsx';

const RevenueChart = lazy(() => import('../../components/Accounting/RevenueChart'));
const NetProfitChart = lazy(() => import('../../components/Accounting/NetProfitChart'));
const ExpenseBreakdownChart = lazy(() => import('../../components/Accounting/ExpenseBreakdownChart'));

// ✅ publish right-rail extras to the layout
import { useRightExtras } from '../../insights/RightExtrasContext';
import LiveModePlaceholder from '../../components/common/LiveModePlaceholder.jsx';
import { shouldUseDemoData } from '../../services/demo/demoClient.js';
import { ACCENT_HEX } from '../../config/accent';

/* ------------------ Visual constants ------------------ */
const ACCOUNTING_ACCENT = ACCENT_HEX;
// Graphite / chrome neutrals (slightly darker than before)
const CHROME_BORDER        = 'rgba(165,167,169,0.10)';  // subtle neutral border
const CHROME_BORDER_HOVER  = 'rgba(165,167,169,0.14)';
const EMERALD_DARK_BORDER  = 'rgba(255,255,255,0.06)'; // keep cards neutral (no green frame)

// Panel surface (same as before)
const PANEL_BG = 'var(--panel)';

/* ------------------ Skeleton ------------------ */
const CardSkeleton = ({ h = "h-56", lines = 3 }) => (
  <div
    className={`rounded-2xl ${h} p-4 sm:p-5 bg-white/[0.05] border border-white/10 shadow-[0_18px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl animate-pulse`}
  >
    <div className="space-y-3">
      <div className="h-3 w-24 bg-white/15 rounded-full" />
      <div className="h-5 w-40 bg-white/18 rounded-md" />
      {Array.from({ length: lines }).map((_, idx) => (
        <div
          key={idx}
          className="h-3 w-full bg-white/10 rounded-full"
          style={{ opacity: 0.7 - idx * 0.12 }}
        />
      ))}
    </div>
  </div>
);

/* ------------------ Helpers ------------------ */
const RowGap = ({ children }) => <div className="flex flex-col gap-6 md:gap-7">{children}</div>;
const padMonth = (m) => String(m).padStart(2, '0');

/** Card container with switchable frame variant */
function CardFrame({
  children,
  padded = true,
  className = '',
  style = {},
  variant = 'chrome', // 'chrome' | 'emerald-dark'
}) {
  const borderColor =
    variant === 'emerald-dark' ? EMERALD_DARK_BORDER : CHROME_BORDER;

  return (
    <div
      className={`rounded-2xl overflow-hidden shadow-bizzi transition-colors ${padded ? 'p-3' : ''} ${className}`}
      style={{
        border: `1px solid ${borderColor}`,
        background: PANEL_BG,
        backgroundClip: 'padding-box',
        ...style,
      }}
      // subtle hover lift without neon glow
      onMouseEnter={e => {
        e.currentTarget.style.borderColor =
          variant === 'emerald-dark' ? EMERALD_DARK_BORDER : CHROME_BORDER_HOVER;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = borderColor;
      }}
    >
      <div className="rounded-[inherit] overflow-visible">{children}</div>
    </div>
  );
}

/** ⛑️ Temporary client mock (remove when API returns hero) */
const TEMP_DEBUG_MOCK_HERO = {
  id: 'debug-fin-hero',
  title: 'Revenue up 15% vs last month',
  summary: '',
  metric: '$48,200',
  severity: 'good',
  dismissible: true,
};

export default function AccountingDashboard() {
  const { currentBusiness, loading } = useBusiness();
  const businessId =
    currentBusiness?.id ||
    (typeof localStorage !== "undefined" ? localStorage.getItem("currentBusinessId") : "") ||
    (typeof localStorage !== "undefined" ? localStorage.getItem("business_id") : "") ||
    "";
  const theme = useModuleTheme('accounting');
  const navigate = useNavigate();
  const { setRightExtras } = useRightExtras();
  const { year, month, setYearMonth } = useFinancialPeriod(businessId);

  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [kpiLoading, setKpiLoading] = useState(true);
  const [emptyMonth, setEmptyMonth] = useState(false);
  const [fallbackTag, setFallbackTag] = useState(false);
  const autoFallbackRef = useRef(false);
  const [hasMetrics, setHasMetrics] = useState(false);
  const [backfillStatus, setBackfillStatus] = useState(null);
  const [backfillWarning, setBackfillWarning] = useState("");
  const [lastRefreshed, setLastRefreshed] = useState(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('bizzy:lastFinancialRefresh') : null;
    return stored ? Number(stored) : null;
  });
  const [periodOpen, setPeriodOpen] = useState(false);
  const formatElapsed = useCallback((ts) => {
    if (!ts) return "";
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }, []);

  const bgColor   = theme?.bgClass   || 'bg-app';
  const textColor = theme?.textClass || 'text-primary';

  const userId = useMemo(() => localStorage.getItem('user_id') || '', []);
  const usingDemo = useMemo(() => shouldUseDemoData(currentBusiness), [currentBusiness]);
  const integrationManager = useIntegrationManager({ businessId });
  const qbState = integrationManager?.getStatus?.('quickbooks') || {};
  const qbStatus = qbState?.status || 'disconnected';
  const periodValue = `${year || new Date().getFullYear()}-${padMonth(month || new Date().getMonth() + 1)}`;
  const periodLabel = useCallback(
    () => {
      if (!year || !month) return "";
      return new Date(year, month - 1, 1).toLocaleString(undefined, { month: 'short', year: 'numeric' });
    },
    [year, month]
  );
  const isCurrentMonth = useMemo(() => {
    const now = new Date();
    return year === now.getFullYear() && month === now.getMonth() + 1;
  }, [year, month]);
  const prevMonth = useCallback(() => {
    if (!year || !month) return;
    const d = new Date(year, month - 2, 1);
    setYearMonth(d.getFullYear(), d.getMonth() + 1);
  }, [year, month, setYearMonth]);

  const monthOptions = useMemo(() => {
    const now = new Date();
    const opts = Array.from({ length: 15 }).map((_, idx) => {
      const d = new Date(now.getFullYear(), now.getMonth() - idx, 1);
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      return {
        value: `${y}-${padMonth(m)}`,
        label: d.toLocaleString(undefined, { month: 'short', year: 'numeric' }),
      };
    });
    const exists = opts.some((o) => o.value === periodValue);
    if (!exists && year && month) {
      const d = new Date(year, month - 1, 1);
      opts.unshift({
        value: periodValue,
        label: d.toLocaleString(undefined, { month: 'short', year: 'numeric' }),
      });
    }
    return opts;
  }, [year, month, periodValue]);

  // 🧠 Publish AgendaWidget to the right rail
  useEffect(() => {
    if (!businessId) return;
    setRightExtras(
      <AgendaWidget
        businessId={businessId}
        module="financials"
        onOpenCalendar={() => navigate('/dashboard/calendar')}
      />
    );
    return () => setRightExtras(null);
  }, [businessId, navigate, setRightExtras]);

  // Lightweight check to see if metrics exist; treat as "connected enough"
  useEffect(() => {
    let alive = true;
    async function checkMetrics() {
      if (!businessId || !userId || !year || !month) {
        if (alive) setHasMetrics(false);
        return;
      }
      try {
        const resp = await safeFetch(
          `/api/accounting/metrics?business_id=${encodeURIComponent(businessId)}&user_id=${encodeURIComponent(userId)}&year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}&data_mode=live&live_only=true`,
          { method: "GET" }
        );
        const m = resp?.metrics || {};
        const has =
          Number(m.totalRevenue ?? m.total_revenue ?? 0) !== 0 ||
          Number(m.totalExpenses ?? m.total_expenses ?? 0) !== 0 ||
          Number(m.netProfit ?? m.net_profit ?? 0) !== 0;
        if (alive) setHasMetrics(!!has);
      } catch {
        if (alive) setHasMetrics(false);
      }
    }
    checkMetrics();
    return () => { alive = false; };
  }, [businessId, userId, year, month]);

  // Poll backfill job status when connected (lightweight)
  useEffect(() => {
    let alive = true;
    async function loadBackfill() {
      if (!businessId || qbStatus !== "connected") return;
      try {
        const res = await safeFetch(`/api/qbo/backfill/status?business_id=${encodeURIComponent(businessId)}`);
        if (!alive) return;
        setBackfillStatus(res || null);
        setBackfillWarning("");
      } catch {
        if (!alive) return;
        setBackfillStatus((prev) => prev || null);
        setBackfillWarning("Unable to read backfill status right now.");
      }
    }
    loadBackfill();
    const id = setInterval(loadBackfill, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [businessId, qbStatus]);

  if (loading) return null;
  if (!businessId) return <div className="text-rose-400 p-4">Select a business to view financials.</div>;
  const qbConnected = qbStatus === 'connected';
  const backfillRunning = qbConnected && backfillStatus?.status === "running";
  const needsSync = qbConnected && !usingDemo && !backfillRunning && !hasMetrics;
  const canView = usingDemo || qbConnected;
  if (!canView) {
    return <LiveModePlaceholder title="Connect QuickBooks to view Financial Hub insights" />;
  }

  const showSyncCta = needsSync && !kpiLoading;

  const handleRefresh = async () => {
    if (!businessId) return;
    setRefreshing(true);
    try {
      const qs = `business_id=${encodeURIComponent(businessId)}&data_mode=live&live_only=true`;
      await Promise.all([
        safeFetch(`/api/accounting/revenue-series?${qs}`),
        safeFetch(`/api/accounting/profit-series?${qs}`),
        safeFetch(`/api/accounting/metrics?${qs}`),
      ]);
      const now = Date.now();
      setLastRefreshed(now);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('bizzy:lastFinancialRefresh', String(now));
      }
    } catch (e) {
      console.warn("[AccountingDashboard] refresh failed", e?.message || e);
    } finally {
      setRefreshing(false);
    }
  };

  const handleSyncNow = async () => {
    if (!businessId) return;
    setSyncing(true);
    setSyncError("");
    try {
      await safeFetch(`/api/qbo/backfill/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { business_id: businessId, months: 12, mode: "cash" },
      });
      setBackfillStatus((prev) => ({
        ...(prev || {}),
        status: "running",
        months_done: prev?.months_done || 0,
        months_total: prev?.months_total || 12,
      }));
    } catch (e) {
      setSyncError(e?.message || "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const handleEmptyData = () => {
    if (import.meta.env.MODE !== 'production' && isCurrentMonth && !autoFallbackRef.current) {
      autoFallbackRef.current = true;
      setFallbackTag(true);
      setEmptyMonth(false);
      prevMonth();
      return;
    }
    setEmptyMonth(true);
  };

  const handleLiveData = () => {
    setEmptyMonth(false);
    setFallbackTag(false);
    autoFallbackRef.current = false;
  };

  const handleViewPrevMonth = () => {
    setFallbackTag(true);
    setEmptyMonth(false);
    prevMonth();
  };

  // Heights tuned so charts are fully visible
  const H_REVENUE = 350;
  const H_EXPENSE = 440;
  const H_PROFIT  = 440;

  return (
    /**
     * ⚠️ Keep this root NON-scrolling. No h-screen/min-h-full/overflow here.
     */
    <div className={`w-full px-3 md:px-4 pt-0 pb-2 ${bgColor} ${textColor}`}>
      <div className="max-w-[1100px] mx-auto">
        {/* Header */}
        <ModuleHeader
          module="financials"
          title="Financial Health"
          className="mb-4"
          right={
            <div className="flex items-center gap-3 flex-wrap justify-end">
              <div className="flex items-center gap-2 text-xs text-white/70">
                <div
                  className="relative inline-flex"
                  onMouseEnter={() => setPeriodOpen(true)}
                  onMouseLeave={() => setPeriodOpen(false)}
                >
                  <button
                    type="button"
                    className="appearance-none bg-[rgba(18,18,20,0.92)] border border-white/18 rounded-md pl-3 pr-7 py-[6px] text-xs text-white/90 cursor-pointer shadow-[0_8px_18px_rgba(0,0,0,0.32)] backdrop-blur-md transition-all duration-150 ease-out hover:bg-[rgba(28,28,32,0.98)] hover:border-white/30 focus:outline-none focus:ring-2 focus:ring-white/14"
                    style={{ minWidth: '110px', lineHeight: 1.05 }}
                  >
                    {monthOptions.find((o) => o.value === periodValue)?.label || periodValue}
                  </button>
                  {periodOpen && (
                    <div
                      className="absolute left-0 mt-1 w-full max-h-64 overflow-y-auto rounded-md border border-white/14 bg-[#0b0c10] shadow-[0_18px_42px_rgba(0,0,0,0.55)] z-30 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent"
                      style={{ top: '100%' }}
                    >
                      {monthOptions.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => {
                            const [y, m] = opt.value.split("-");
                            setYearMonth(Number(y), Number(m));
                            setPeriodOpen(false);
                          }}
                          className={`w-full text-left px-3 py-2 text-xs transition ${
                            opt.value === periodValue
                              ? "bg-white/10 text-white"
                              : "text-white/85 hover:bg-white/12"
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {fallbackTag ? (
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/10 text-white/80">
                    Showing latest available month
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleRefresh}
                  disabled={refreshing}
                  className="inline-flex items-center justify-center rounded-full border w-8 h-8 text-white/85 transition disabled:opacity-60 hover:bg-white/14 hover:border-white/50 focus:outline-none focus:ring-2 focus:ring-white/14"
                  style={{ borderColor: "rgba(255,255,255,0.22)", background: "rgba(18,18,20,0.86)" }}
                  aria-label="Refresh live data"
                  title="Refresh"
                >
                  <RefreshCcw className={refreshing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
                </button>
                {lastRefreshed ? (
                  <div className="relative group">
                    <span className="text-xs text-white/70">
                      Live · Updated {formatElapsed(lastRefreshed)}
                    </span>
                    <div
                      className="absolute left-1/2 -translate-x-1/2 mt-1 px-2 py-[6px] rounded bg-black/80 text-[11px] text-white/85 opacity-0 group-hover:opacity-100 pointer-events-none shadow-lg border border-white/10"
                      style={{ whiteSpace: "nowrap", lineHeight: 1.2 }}
                    >
                      {new Date(lastRefreshed).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                        hour12: true,
                      })}
                    </div>
                  </div>
                ) : (
                  <span className="text-xs text-white/50">No refresh yet</span>
                )}
              </div>
            </div>
          }
        />

        {/* Main content */}
        <RowGap>
        {emptyMonth ? (
          <div className="rounded-2xl border border-[rgba(255,255,255,0.14)] bg-[rgba(0,0,0,0.35)] px-4 py-3 flex flex-col gap-2">
            <div className="text-sm text-white/80">
              No activity yet for this month. Try last month.
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleViewPrevMonth}
                className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm text-white/90 transition"
                style={{ borderColor: "rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.45)" }}
              >
                View previous month
              </button>
              <span className="text-xs text-white/60">
                Selected: {periodLabel()}
              </span>
            </div>
          </div>
        ) : null}

        {backfillWarning ? (
          <div className="rounded-2xl border border-amber-500/40 bg-[rgba(255,209,143,0.08)] px-4 py-3 text-amber-100 text-sm">
            {backfillWarning}
          </div>
        ) : null}

        {backfillRunning ? (
          <div className="rounded-2xl border border-[rgba(255,255,255,0.14)] bg-[rgba(0,0,0,0.35)] px-4 py-3 flex flex-col gap-2">
            <div className="text-sm text-white/90">
              Syncing last 12 months… ({backfillStatus?.months_done || 0}/{backfillStatus?.months_total || 12}){backfillStatus?.current_month ? ` • ${backfillStatus.current_month}` : ""}
            </div>
            <div className="text-xs text-white/60">
              This runs in the background. You can keep browsing.
            </div>
          </div>
        ) : null}

        {showSyncCta ? (
          <div className="rounded-2xl border border-[rgba(255,255,255,0.14)] bg-[rgba(0,0,0,0.35)] px-4 py-3 flex flex-col gap-2">
            <div className="text-sm text-white/90">Connected — no data for this period.</div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleSyncNow}
                disabled={syncing}
                className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm text-white/90 transition disabled:opacity-60"
                style={{ borderColor: "rgba(255,255,255,0.18)", background: "rgba(0,0,0,0.45)" }}
              >
                {syncing ? "Syncing…" : "Sync now"}
              </button>
              {syncError ? <span className="text-xs text-rose-300">{syncError}</span> : null}
            </div>
          </div>
        ) : null}

        {/* KPI cards row */}
        <CardFrame padded={false} variant="emerald-dark">
          <div className="rounded-[inherit] p-3">
            <FinancialKPICards
              onLiveData={handleLiveData}
              onEmptyData={handleEmptyData}
              onLoadingChange={setKpiLoading}
            />
          </div>
        </CardFrame>

        {/* Charts — Revenue full-width row */}
        <CardFrame variant="emerald-dark">
          <Suspense fallback={<CardSkeleton h={`h-[${H_REVENUE}px]`} />}>
            <div className="rounded-[inherit] overflow-hidden" style={{ height: H_REVENUE }}>
              <RevenueChart height={H_REVENUE} />
            </div>
          </Suspense>
        </CardFrame>

        {/* Expense + Profit side-by-side */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <CardFrame variant="emerald-dark">
            <Suspense fallback={<CardSkeleton h={`h-[${H_EXPENSE}px]`} />}>
              <div className="rounded-[inherit]" style={{ height: H_EXPENSE }}>
                <ExpenseBreakdownChart height={H_EXPENSE} className="rounded-xl" />
              </div>
            </Suspense>
          </CardFrame>

          <CardFrame variant="emerald-dark">
            <Suspense fallback={<CardSkeleton h={`h-[${H_PROFIT}px]`} />}>
              <div className="rounded-[inherit]" style={{ height: H_PROFIT }}>
                <NetProfitChart height={H_PROFIT} compact className="rounded-xl" />
              </div>
            </Suspense>
          </CardFrame>
        </div>

        {/* Insights below the charts */}
        <CardFrame padded={false} variant="emerald-dark">
          <div className="rounded-[inherit] overflow-hidden">
            <MonthlyBriefCard userId={userId} businessId={businessId} />
          </div>
        </CardFrame>
      </RowGap>
      </div>
    </div>
  );
}
