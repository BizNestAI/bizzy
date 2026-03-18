// File: /components/Tax/TaxDashboard.jsx
import React, { useEffect, useState, useMemo, useCallback } from "react";
import { RefreshCcw, ChevronDown } from "lucide-react";

import TaxMonthlySnapshot from "../../components/Tax/TaxMonthlySnapshot";
import NextPaymentHero from "../../components/Tax/NextPaymentHero";
import SafeHarborMeter from "../../components/Tax/SafeHarborMeter";
import TaxKpiRow from "../../components/Tax/TaxKpiRow";
import TaxTrendCard from "../../components/Tax/TaxTrendCard";
import TaxActionQueue from "../../components/Tax/TaxActionQueue";

import { useBusinessContext } from "../../context/BusinessContext";
import { useNavigate, useLocation } from "react-router-dom";
import { useTaxLiability } from "../../hooks/useTaxLiability";
import useIntegrationManager from "../../hooks/useIntegrationManager.js";
import SubsectionTabs from "../../components/Navigation/SubsectionTabs.jsx";

import ModuleHeader from "../../components/layout/ModuleHeader/ModuleHeader";
// import { getHeroInsight } from "../../services/heroInsights/getHeroInsight";

import { useRightExtras } from "../../insights/RightExtrasContext";
import AgendaWidget from "../../pages/Calendar/AgendaWidget.jsx";
import LiveModePlaceholder from "../../components/common/LiveModePlaceholder.jsx";
import { shouldUseDemoData } from "../../services/demo/demoClient.js";

const SkeletonCard = ({ className = "", lines = 3, height = "h-48" }) => (
  <div
    className={`rounded-[22px] bg-white/[0.05] border border-white/10 shadow-[0_18px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl p-4 sm:p-5 animate-pulse ${className}`}
  >
    <div className={`space-y-3 ${height}`}>
      <div className="h-3 w-28 bg-white/15 rounded-full" />
      <div className="h-5 w-44 bg-white/18 rounded-md" />
      {Array.from({ length: lines }).map((_, idx) => (
        <div
          key={idx}
          className="h-3 w-full bg-white/10 rounded-full"
          style={{ opacity: 0.8 - idx * 0.15 }}
        />
      ))}
    </div>
  </div>
);

/** ⛑️ TEMP client mock to verify UI. Remove once /api/hero-insights/tax is live. */
const TEMP_DEBUG_MOCK_HIGHLIGHT = {
  id: "debug-tax-hero",
  title: "Quarterly estimate due Oct 15",
  summary: "Paying early could avoid penalties and improve cash planning.",
  metric: "Oct 15",
  severity: "warn",
  dismissible: true,
};

export default function TaxDashboard({ onAskBizzy }) {
  const { currentBusiness } = (useBusinessContext?.() || {});
  const businessId = currentBusiness?.id || localStorage.getItem("currentBusinessId");
  const navigate = useCallbackSafeNavigate(useNavigate());
  const location = useLocation();
  const usingDemo = shouldUseDemoData(currentBusiness);
  const integrationManager = useIntegrationManager({ businessId });
  const qbStatus = integrationManager?.getStatus?.("quickbooks")?.status || "disconnected";
  const allowLive = qbStatus === "connected";
  const [refreshing, setRefreshing] = useState(false);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(() => {
    const stored =
      typeof localStorage !== "undefined" ? localStorage.getItem("bizzy:lastTaxRefresh") : null;
    return stored ? Number(stored) : null;
  });

  const periodOptions = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 12 }).map((_, idx) => {
      const d = new Date(now.getFullYear(), now.getMonth() - idx, 1);
      return {
        value: `${d.getFullYear()}-${padMonth(d.getMonth() + 1)}`,
        label: d.toLocaleString(undefined, { month: "short", year: "numeric" }),
      };
    });
  }, []);

  const [periodValue, setPeriodValue] = useState(() => periodOptions[0]?.value || "");
  const selectedPeriodLabel =
    periodOptions.find((o) => o.value === periodValue)?.label || "Select period";

  const formatElapsed = useCallback((ts) => {
    if (!ts) return "just now";
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }, []);

  if (!usingDemo && !allowLive) {
    return <LiveModePlaceholder title="Connect your tax + accounting data to view the Tax Desk" />;
  }

  // Right rail agenda
  const { setRightExtras } = useRightExtras();
  useEffect(() => {
    if (!businessId) return;
    setRightExtras(
      <AgendaWidget
        businessId={businessId}
        module="tax"
        onOpenCalendar={() => navigate("/dashboard/calendar")}
      />
    );
    return () => setRightExtras(null);
  }, [businessId, navigate, setRightExtras]);

  // Shared liability
  const {
    data: liab,
    loading: chartLoading,
    error: chartError,
    refetch: refetchLiab,
  } = useTaxLiability(businessId);

  // Module header “hero” insight (safe if not imported)
  const [hero, setHero] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      let res = null;
      try {
        // safe: typeof on an undeclared identifier won't throw in JS
        if (typeof getHeroInsight === "function") {
          res = await getHeroInsight("tax", { force: true, timeout: 6000 });
        }
      } catch {}
      if (!alive) return;
      setHero(res?.hero ?? TEMP_DEBUG_MOCK_HIGHLIGHT);
    })();
    return () => { alive = false; };
  }, [businessId]);

  const sourceBadge =
    liab?.meta?.source === "mock"
      ? "text-[10px] px-2 py-0.5 rounded-full ring-1 ring-inset ring-[rgba(var(--accent-rgb),.28)] text-[rgba(var(--accent-rgb),.9)] bg-[rgba(var(--accent-rgb),.08)]"
      : "text-[10px] px-2 py-0.5 rounded-full ring-1 ring-inset ring-[rgba(16,185,129,.28)] text-[rgba(16,185,129,.9)] bg-[rgba(16,185,129,.08)]";

  const TOP_CARD_HEIGHT = 260;
  const summary = liab?.summary || {};
  const snapshot = liab?.monthlySnapshot?.metrics || {};
  const topDeduction = snapshot?.topDeductions?.[0];
  const nextDueDays = liab?.meta?.nextEstimatedPaymentDueDays;
  const nextDueAmt = liab?.meta?.estPaymentAmount;
  const loading = chartLoading && !liab;

  const handleRefresh = async () => {
    if (!refetchLiab) return;
    setRefreshing(true);
    try {
      await refetchLiab();
      const now = Date.now();
      setLastRefreshed(now);
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("bizzy:lastTaxRefresh", String(now));
      }
    } catch (e) {
      console.warn("[TaxDashboard] refresh failed", e?.message || e);
    } finally {
      setRefreshing(false);
    }
  };

  const headerControls = (
    <div className="flex items-center gap-3 text-xs text-white/80">
      <div className="relative">
        <button
          onClick={() => setPeriodOpen((v) => !v)}
          className="inline-flex items-center gap-1 rounded-full border border-white/12 bg-[#0c0e12] px-3 py-1.5 text-[12px] transition hover:border-[rgba(var(--accent-rgb),0.6)]"
        >
          {selectedPeriodLabel}
          <ChevronDown className={`h-3.5 w-3.5 transition ${periodOpen ? "rotate-180" : ""}`} />
        </button>
        {periodOpen ? (
          <div className="absolute right-0 mt-2 w-44 overflow-hidden rounded-xl border border-white/10 bg-[#0f1012] shadow-xl z-20">
            {periodOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  setPeriodValue(opt.value);
                  setPeriodOpen(false);
                }}
                className={`w-full px-3 py-2 text-left text-[12px] text-white/90 hover:bg-white/5 ${
                  opt.value === periodValue ? "bg-white/5" : ""
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[11px] text-white/60">
          Live · Updated {formatElapsed(lastRefreshed)}
        </span>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1 rounded-full border border-white/12 bg-[#0c0e12] px-3 py-1.5 text-[12px] transition hover:border-[rgba(var(--accent-rgb),0.6)] disabled:opacity-60"
        >
          <RefreshCcw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>
    </div>
  );

  const nextDueDate = liab?.meta?.nextEstimatedPaymentDate || null;
  const safeHarbor = liab?.safeHarbor || {};
  const trendData = liab?.trend || [];
  const quarters = liab?.quarterly || [];
  const kpiNextDue = { amount: nextDueAmt ?? summary?.balanceDue, days: nextDueDays ?? null };

  return (
    <div key={location.pathname} className="min-h-screen w-full bg-app text-primary">
      <div className="max-w-[1200px] mx-auto px-4 pt-0 pb-2">
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-3">
          <ModuleHeader
            module="tax"
            title="Tax Desk"
            hero={hero}
            onDismissHero={() => setHero(null)}
            className="flex-1"
            right={headerControls}
          />
        </div>
      </div>

      <main className="relative z-0 max-w-[1200px] mx-auto px-4 pt-0 pb-6 flex flex-col gap-5">
        {/* Top row temporarily hidden per request */}

        <section>
          {loading ? (
            <SkeletonCard lines={3} height="h-[140px]" />
          ) : (
            <TaxKpiRow summary={summary} snapshot={snapshot} nextDue={kpiNextDue} />
          )}
        </section>

        <section>
          {loading ? (
            <SkeletonCard lines={4} height="h-[280px]" />
          ) : (
            <TaxTrendCard
              data={trendData}
              quarterly={quarters}
              lastRefreshed={formatElapsed(lastRefreshed)}
              loading={chartLoading}
              error={chartError}
              onRefresh={refetchLiab}
              source={liab?.meta?.source === "mock" ? "mock" : "live"}
            />
          )}
        </section>

        <section id="full-snapshot">
          {loading ? (
            <SkeletonCard lines={5} height="h-[260px]" />
          ) : (
            <div className="rounded-[20px] border border-white/10 bg-white/[0.05] shadow-[0_18px_50px_rgba(0,0,0,0.35)] p-3 sm:p-4">
              <TaxMonthlySnapshot
                businessId={businessId}
                onAskBizzy={(text, payload) => onAskBizzy?.(text, payload)}
                onOpenDeductions={() => navigate("/dashboard/tax/deductions")}
              />
            </div>
          )}
        </section>

        <section>
          {loading ? (
            <SkeletonCard lines={4} height="h-[200px]" />
          ) : (
            <TaxActionQueue
              businessId={businessId}
              watchKey={businessId}
              onAskBizzy={(text, payload) => onAskBizzy?.(text, payload)}
            />
          )}
        </section>
      </main>
    </div>
  );
}

function TopDeductionCard({ topDeduction, onOpenDeductions }) {
  return (
    <div className="rounded-[18px] border border-white/12 bg-white/[0.05] shadow-[0_18px_50px_rgba(0,0,0,0.35)] p-4 flex flex-col gap-2 h-full">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] uppercase tracking-[0.12em] text-white/65">Top deduction</div>
        <button
          type="button"
          onClick={onOpenDeductions}
          className="text-[11px] px-2.5 py-1 rounded-full border border-white/12 text-white/75 hover:text-white hover:bg-white/10 transition"
        >
          View
        </button>
      </div>
      <div className="text-xl font-semibold text-white">
        {topDeduction?.amount != null ? formatCurrencyLocal(topDeduction.amount) : "—"}
      </div>
      <div className="text-[13px] text-white/75">{topDeduction?.category || "No deduction data"}</div>
      {topDeduction?.percentRevenue != null ? (
        <div className="mt-1 space-y-1">
          <div className="text-[12px] text-white/60">Share of revenue</div>
          <div className="h-2 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(0, Math.min(100, Number(topDeduction.percentRevenue) || 0))}%`,
                background:
                  "linear-gradient(90deg, rgba(var(--accent-rgb),0.35), rgba(var(--accent-rgb),0.7))",
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function padMonth(m) {
  return String(m).padStart(2, "0");
}

function formatCurrencyLocal(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(n));
  } catch {
    return `$${Number(n).toLocaleString()}`;
  }
}

/* ------------------------ utils ------------------------ */
function useCallbackSafeNavigate(nav) {
  return (to) => {
    try { nav(to); } catch (_) {}
  };
}
