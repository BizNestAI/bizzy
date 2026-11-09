// File: /src/components/Accounting/FinancialKPICards.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useFinancialPeriod from "../../hooks/useFinancialPeriod.js";
import { getDemoData, shouldForceLiveData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import { useBusiness } from "../../context/BusinessContext";
import { safeFetch } from "../../utils/safeFetch.js";
import { readModuleSnapshot, writeModuleSnapshot, invalidateModuleSnapshots, moduleSessionIdentity } from '../../services/modules/moduleSessionCache.js';
import { resolveModuleDataState, unsafeModuleError } from '../../services/modules/moduleDataState.js';
import ModuleDataStatus from '../UI/ModuleDataStatus.jsx';
import HealthKpiStrip from "./HealthKpiStrip.jsx";
import { formatForecastCurrency } from "../../utils/forecast/forecastPresentation.js";

function fmtCurrency(n) {
  return n == null || !Number.isFinite(Number(n)) ? '—' : formatForecastCurrency(n);
}
function fmtCompactCurrency(n) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "$0";
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `${sign}$${Math.round(abs).toLocaleString()}`;
}
function fmtPct(n) {
  if (n === null || n === undefined) return "";
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const s = Math.round(v);
  return `${s > 0 ? "+" : ""}${s}%`;
}
function fmtPoints(n) {
  if (n === null || n === undefined) return "";
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const rounded = Math.round(v * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(Math.abs(rounded) % 1 === 0 ? 0 : 1)} pts`;
}
function pctDelta(current, prior) {
  if (current == null || prior == null) return null;
  const currentNum = Number(current);
  const priorNum = Number(prior);
  if (!Number.isFinite(currentNum) || !Number.isFinite(priorNum) || priorNum === 0) return null;
  return ((currentNum - priorNum) / Math.abs(priorNum)) * 100;
}
function metricTrend(change, { lowerIsBetter = false } = {}) {
  if (change === null || change === undefined || !Number.isFinite(Number(change))) return null;
  if (Number(change) === 0) return null;
  return lowerIsBetter ? (Number(change) > 0 ? "down" : "up") : (Number(change) > 0 ? "up" : "down");
}
function fmtMargin(value) {
  if (value === null || value === undefined || value === "") return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  const pct = num; // Callers have already normalized ratios to percentage points.
  const rounded = Math.round(pct * 10) / 10; // nearest tenth
  return `${rounded.toFixed(1)}%`;
}


function FinancialKPICards({
  userId: userIdProp,
  businessId: businessIdProp,
  year: yearProp,
  month: monthProp,
  onLiveData,
  onEmptyData,
  onError,
  onLoadingChange,
  refreshVersion = 0,
}) {
  const { currentBusiness } = useBusiness?.() || {};

  const userId = userIdProp || localStorage.getItem("user_id") || "";
  const businessId = businessIdProp || localStorage.getItem("currentBusinessId");
  const period = useFinancialPeriod(businessId);
  const year = yearProp || period.year;
  const month = monthProp || period.month;
  const forceLive = shouldForceLiveData();
  const usingDemo = useMemo(
    () => !forceLive && shouldUseDemoData(currentBusiness),
    [currentBusiness, forceLive]
  );
  const cacheScope = { businessId, year, month, resource: 'kpis', admin: currentBusiness?.admin_view === true };
  const saved = readModuleSnapshot('financials', cacheScope)?.data;
  const [kpis, setKpis] = useState(() => saved || []);
  const [loading, setLoading] = useState(() => !saved);
  const [updating, setUpdating] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [retry, setRetry] = useState(0);
  const onLiveDataRef = useRef(onLiveData);
  const onEmptyDataRef = useRef(onEmptyData);
  const onErrorRef = useRef(onError);
  const onLoadingChangeRef = useRef(onLoadingChange);

  useEffect(() => {
    onLiveDataRef.current = onLiveData;
  }, [onLiveData]);

  useEffect(() => {
    onEmptyDataRef.current = onEmptyData;
  }, [onEmptyData]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    onLoadingChangeRef.current = onLoadingChange;
  }, [onLoadingChange]);

  const populateDemoKpis = useCallback(() => {
    const demo = getDemoData();
    const fin = demo?.financials || {};
    const prev = fin?.prevMonth || {};
    const k = fin?.kpis || {};

    const revenue = Number(fin.mtdRevenue ?? 0);
    const revenuePrev = fin.revenuePrev ?? fin.prevRevenue ?? prev.revenue ?? null;
    const expenses = Number(fin.mtdExpenses ?? 0);
    const expensesPrev = fin.expensesPrev ?? fin.prevExpenses ?? prev.expenses ?? null;
    const profit = Number(fin.mtdProfit ?? 0);
    const profitPrev = fin.profitPrev ?? fin.prevProfit ?? prev.profit ?? null;
    const margin = Number(fin.profitMarginPct ?? 0);
    const marginPrev = fin.marginPrev ?? fin.prevMargin ?? prev.profitMarginPct ?? null;

    const revPrevNum = Number(revenuePrev);
    const expPrevNum = Number(expensesPrev);
    const profitPrevNum = Number(profitPrev);
    const marginPrevNum = Number(marginPrev);

    const revChange = Number.isFinite(revPrevNum) && revPrevNum !== 0 ? ((revenue - revPrevNum) / revPrevNum) * 100 : null;
    const expChange = Number.isFinite(expPrevNum) && expPrevNum !== 0 ? ((expenses - expPrevNum) / expPrevNum) * 100 : null;
    const profitChange = Number.isFinite(profitPrevNum) && profitPrevNum !== 0 ? ((profit - profitPrevNum) / profitPrevNum) * 100 : null;
    const marginChange = Number.isFinite(margin) && Number.isFinite(marginPrevNum)
      ? margin - marginPrevNum
      : null;

    const topCategoryCurrent = k.topSpendingCategory || "Labor";
    const topCategoryPrev = fin?.prevMonth?.topSpendingCategory || k.prevTopSpendingCategory || "N/A";

    const demoKpis = [
      { label: "Current Revenue", value: fmtCurrency(revenue), detail: revenuePrev != null ? `Prior month ${fmtCompactCurrency(revPrevNum)}` : "This month's revenue", trend: metricTrend(revChange), change: fmtPct(revChange), tint: "emerald" },
      { label: "Current Expenses", value: fmtCurrency(expenses), detail: expensesPrev != null ? `Prior month ${fmtCompactCurrency(expPrevNum)}` : "This month's spend", trend: metricTrend(expChange, { lowerIsBetter: true }), change: fmtPct(expChange), tint: "amber" },
      { label: "Net Profit", value: fmtCurrency(profit), detail: profitPrev != null ? `Prior month ${fmtCompactCurrency(profitPrevNum)}` : "Revenue after expenses", trend: metricTrend(profitChange), change: fmtPct(profitChange), tint: "emerald" },
      { label: "Profit Margin", value: `${Number.isFinite(margin) ? margin.toFixed(1) : "0.0"}%`, detail: Number.isFinite(marginPrevNum) ? `Prior month ${marginPrevNum.toFixed(1)}%` : "Net profit as % of revenue", trend: metricTrend(marginChange), change: fmtPoints(marginChange), tint: "rose" },
      {
        label: "Top Spending Category",
        value: topCategoryCurrent,
        detail: topCategoryPrev && topCategoryPrev !== "N/A" ? `Prior top: ${topCategoryPrev}` : "Largest expense group",
        trend: topCategoryPrev && topCategoryCurrent === topCategoryPrev ? "up" : "down",
        change: "",
        tint: "amber",
      },
    ];

    setKpis(demoKpis);
  }, []);

  useEffect(() => {
    onLoadingChangeRef.current?.(loading);
  }, [loading]);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();

    async function fetchKPIs() {
      if (usingDemo) {
        if (cancelled) return;
        populateDemoKpis();
        setLoading(false);
        onLiveDataRef.current?.();
        return;
      }
      if (!businessId || !year || !month) {
        if (cancelled) return;
        setLoading(false);
        setKpis([]);
        onEmptyDataRef.current?.();
        return;
      }

      const cacheScope = { businessId, year, month, resource: "kpis", admin: currentBusiness?.admin_view === true };
      const cached = readModuleSnapshot("financials", cacheScope)?.data;
      setUpdating(Boolean(cached));
      setLoadError(null);
      if (cached) {
        setKpis(cached);
        setLoading(false);
        onLiveDataRef.current?.();
      } else {
        setLoading(true);
      }
      try {
        const userParam = userId ? `&user_id=${encodeURIComponent(userId)}` : "";
        const url =
          `/api/accounting/health/monthly-summary` +
          `?business_id=${encodeURIComponent(businessId)}` +
          userParam +
          `&year=${encodeURIComponent(year)}` +
          `&month=${encodeURIComponent(month)}`;

        const parsed = await safeFetch(url, {
          headers: {
            "Content-Type": "application/json",
            "x-user-id": userId || "",
            "x-business-id": businessId,
          },
          signal: ac.signal,
          cache: "no-store",
        });

        const m = parsed.metrics || parsed;

        const totalRevenue = m.total_revenue ?? m.totalRevenue ?? null;
        const totalExpenses = m.total_expenses ?? m.totalExpenses ?? null;
        const netProfit = m.net_profit ?? m.netProfit ?? null;
        const rawMargin = m.profit_margin ?? m.profitMargin ?? null;
        const profitMarginPct = rawMargin == null ? null : Number(rawMargin);
        const rawTopSpendingCategory = m.top_spending_category ?? m.topSpendingCategory ?? null;
        const topSpendingCategory = typeof rawTopSpendingCategory === "object" && rawTopSpendingCategory !== null
          ? rawTopSpendingCategory.name ?? rawTopSpendingCategory.category ?? null
          : rawTopSpendingCategory;

        const priorEnvelope = parsed.prior_month ?? parsed.priorMonth ?? null;
        const prior = priorEnvelope?.metrics || m.priorMonth || m.prior_month || {};
        const priorAvailable = priorEnvelope?.data_status === "available";
        const priorRevenue = prior.total_revenue ?? prior.totalRevenue ?? null;
        const priorExpenses = prior.total_expenses ?? prior.totalExpenses ?? null;
        const priorNet = prior.net_profit ?? prior.netProfit ?? null;
        const rawPriorMargin = prior.profit_margin ?? prior.profitMargin ?? null;
        const priorMarginPct = rawPriorMargin == null ? null : Number(rawPriorMargin);
        const rawPriorTopCategory = prior.top_spending_category ?? prior.topSpendingCategory ?? null;
        const priorTopCategory = typeof rawPriorTopCategory === "object" && rawPriorTopCategory !== null
          ? rawPriorTopCategory.name ?? rawPriorTopCategory.category ?? null
          : rawPriorTopCategory;

        const allNull =
          totalRevenue == null &&
          totalExpenses == null &&
          netProfit == null &&
          profitMarginPct == null &&
          !topSpendingCategory;
        const isEmptyPayload = parsed.empty === true || parsed.source === "cache_miss" || parsed.data_status === "missing" || parsed.data_status === "empty";
        if (isEmptyPayload || allNull) {
          setKpis([]);
          writeModuleSnapshot("financials", cacheScope, []);
          onEmptyDataRef.current?.(parsed.data_status || (allNull ? "missing" : "empty"));
          return;
        }

        const revChange = priorAvailable ? pctDelta(totalRevenue, priorRevenue) : null;
        const expChange = priorAvailable ? pctDelta(totalExpenses, priorExpenses) : null;
        const profitChange = priorAvailable ? pctDelta(netProfit, priorNet) : null;
        const marginChange = priorAvailable && profitMarginPct != null && priorMarginPct != null && Number.isFinite(Number(profitMarginPct)) && Number.isFinite(Number(priorMarginPct))
          ? Number(profitMarginPct) - Number(priorMarginPct)
          : null;
        const unavailable = "Prior month unavailable";

        const formatted = [
          { label: "Current Revenue", value: fmtCurrency(totalRevenue), detail: priorAvailable ? `Prior month ${fmtCompactCurrency(priorRevenue)}` : unavailable, trend: metricTrend(revChange), change: fmtPct(revChange), tint: "emerald" },
          { label: "Current Expenses", value: fmtCurrency(totalExpenses), detail: priorAvailable ? `Prior month ${fmtCompactCurrency(priorExpenses)}` : unavailable, trend: metricTrend(expChange, { lowerIsBetter: true }), change: fmtPct(expChange), tint: "amber" },
          { label: "Net Profit", value: fmtCurrency(netProfit), detail: priorAvailable ? `Prior month ${fmtCompactCurrency(priorNet)}` : unavailable, trend: metricTrend(profitChange), change: fmtPct(profitChange), tint: "emerald" },
          { label: "Profit Margin", value: fmtMargin(profitMarginPct), detail: priorAvailable ? `Prior month ${fmtMargin(priorMarginPct)}` : unavailable, trend: metricTrend(marginChange), change: fmtPoints(marginChange), tint: "rose" },
          {
            label: "Top Spending Category",
            value: topSpendingCategory || "N/A",
            detail: priorTopCategory ? `Prior top: ${priorTopCategory}` : "Largest expense group",
            trend: priorTopCategory ? (topSpendingCategory === priorTopCategory ? "up" : "down") : null,
            change: "",
            tint: "amber",
          },
        ];

        if (!cancelled) {
          setKpis(formatted);
          writeModuleSnapshot("financials", cacheScope, formatted);
          onLiveDataRef.current?.();
        }
      } catch (error) {
        if (error?.name === "AbortError") return;
        if (!cancelled) {
          setLoadError(error);
          if (!cached || unsafeModuleError(error)) setKpis([]);
          if (unsafeModuleError(error)) invalidateModuleSnapshots('financials', businessId);
          onErrorRef.current?.(error);
        }
      } finally {
        if (!cancelled) { setLoading(false); setUpdating(false); }
      }
    }

    fetchKPIs();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [userId, businessId, year, month, usingDemo, populateDemoKpis, refreshVersion, retry, currentBusiness?.admin_view]);

  if (loading) return <HealthKpiStrip loading />;
  return <div>
    <ModuleDataStatus state={resolveModuleDataState({ hasData: Boolean(saved) || kpis.length > 0, fetching: updating, error: loadError })} onRetry={() => setRetry(value => value + 1)} />
    {loadError && !kpis.length ? <p className="forecast-error" role="alert">Financial data couldn’t load. <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></p> : null}
    <HealthKpiStrip kpis={kpis} />
    <p className="health-accounting-note">Net profit includes cost of goods sold and other income or expenses reported by QuickBooks.</p>
  </div>;
}

export default function ScopedFinancialKPICards(props) {
  const { currentBusiness } = useBusiness();
  const businessId = props.businessId || currentBusiness?.id || localStorage.getItem('currentBusinessId');
  const period = useFinancialPeriod(businessId);
  return <FinancialKPICards key={`${moduleSessionIdentity()}:${businessId}:${props.year || period.year}:${props.month || period.month}:${currentBusiness?.admin_view === true}`} {...props} />;
}
