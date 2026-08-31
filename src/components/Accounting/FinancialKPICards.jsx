// File: /src/components/Accounting/FinancialKPICards.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useFinancialPeriod from "../../hooks/useFinancialPeriod.js";
import { getDemoData, shouldForceLiveData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import { useBusiness } from "../../context/BusinessContext";
import { apiFetch } from "../../utils/apiBase.js";
import KpiCard from "../UI/KpiCard.jsx";

function fmtCurrency(n) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "$0";
  return `$${v.toLocaleString()}`;
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
function fmtMargin(value) {
  if (value === null || value === undefined || value === "") return "0.0%";
  const num = Number(value);
  if (!Number.isFinite(num)) return "0.0%";
  // If the stored value looks like a ratio (-0.37), scale to percent; otherwise use as-is
  const pct = Math.abs(num) <= 1 ? num * 100 : num;
  const rounded = Math.round(pct * 10) / 10; // nearest tenth
  return `${rounded.toFixed(1)}%`;
}

const KPI_CACHE = new Map();

export default function FinancialKPICards({
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
  const [kpis, setKpis] = useState([]);
  const [loading, setLoading] = useState(true);
  const { currentBusiness } = useBusiness?.() || {};

  const userId = userIdProp || localStorage.getItem("user_id");
  const businessId = businessIdProp || localStorage.getItem("currentBusinessId");
  const period = useFinancialPeriod(businessId);
  const year = yearProp || period.year;
  const month = monthProp || period.month;
  const forceLive = shouldForceLiveData();
  const usingDemo = useMemo(
    () => !forceLive && shouldUseDemoData(currentBusiness),
    [currentBusiness, forceLive]
  );
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
      { label: "Current Revenue", value: fmtCurrency(revenue), detail: revenuePrev != null ? `Prior month ${fmtCompactCurrency(revPrevNum)}` : "This month's revenue", trend: Number(revChange) >= 0 ? "up" : "down", change: fmtPct(revChange), tint: "emerald" },
      { label: "Current Expenses", value: fmtCurrency(expenses), detail: expensesPrev != null ? `Prior month ${fmtCompactCurrency(expPrevNum)}` : "This month's spend", trend: Number(expChange) >= 0 ? "up" : "down", change: fmtPct(expChange), tint: "amber" },
      { label: "Net Profit", value: fmtCurrency(profit), detail: profitPrev != null ? `Prior month ${fmtCompactCurrency(profitPrevNum)}` : "Revenue after expenses", trend: Number(profitChange) >= 0 ? "up" : "down", change: fmtPct(profitChange), tint: "emerald" },
      { label: "Profit Margin", value: `${Number.isFinite(margin) ? margin.toFixed(1) : "0.0"}%`, detail: Number.isFinite(marginPrevNum) ? `Prior month ${marginPrevNum.toFixed(1)}%` : "Net profit as % of revenue", trend: Number(marginChange) >= 0 ? "up" : "down", change: fmtPoints(marginChange), tint: "rose" },
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
      if (!userId || !businessId || !year || !month) {
        if (cancelled) return;
        setLoading(false);
        setKpis([]);
        onEmptyDataRef.current?.();
        return;
      }

      const cacheKey = `${businessId}:${year}:${month}`;
      const cached = KPI_CACHE.get(cacheKey);
      if (cached) {
        setKpis(cached);
        setLoading(false);
        onLiveDataRef.current?.();
      } else {
        setLoading(true);
      }
      try {
        const url =
          `/api/accounting/health/monthly-summary` +
          `?user_id=${encodeURIComponent(userId)}` +
          `&business_id=${encodeURIComponent(businessId)}` +
          `&year=${encodeURIComponent(year)}` +
          `&month=${encodeURIComponent(month)}`;

        const res = await apiFetch(url, {
          headers: {
            "Content-Type": "application/json",
            "x-user-id": userId,
            "x-business-id": businessId,
          },
          signal: ac.signal,
        });

        const ct = res.headers.get("content-type") || "";
        const raw = await res.text();

        if (!res.ok) {
          const error = new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`);
          error.status = res.status;
          throw error;
        }
        if (!ct.includes("application/json"))
          throw new Error(`Non-JSON response (${ct}): ${raw.slice(0, 200)}`);

        const parsed = JSON.parse(raw) || {};
        const m = parsed.metrics || parsed;
        const deltas = parsed.deltas || null;

        const totalRevenue = m.total_revenue ?? m.totalRevenue ?? null;
        const totalExpenses = m.total_expenses ?? m.totalExpenses ?? null;
        const netProfit = m.net_profit ?? m.netProfit ?? null;
        const rawMargin = m.profit_margin ?? m.profitMargin ?? null;
        const profitMarginPct = rawMargin == null ? null : (Math.abs(Number(rawMargin)) <= 1 ? Number(rawMargin) * 100 : Number(rawMargin));
        const topSpendingCategory = m.top_spending_category ?? m.topSpendingCategory ?? null;

        const prior = m.priorMonth ?? m.prior_month ?? {};
        const priorRevenue = prior.total_revenue ?? prior.totalRevenue ?? null;
        const priorExpenses = prior.total_expenses ?? prior.totalExpenses ?? null;
        const priorNet = prior.net_profit ?? prior.netProfit ?? null;
        const rawPriorMargin = prior.profit_margin ?? prior.profitMargin ?? null;
        const priorMarginPct = rawPriorMargin == null ? null : (Math.abs(Number(rawPriorMargin)) <= 1 ? Number(rawPriorMargin) * 100 : Number(rawPriorMargin));
        const priorTopCategory = prior.top_spending_category ?? prior.topSpendingCategory ?? null;

        const allNull =
          totalRevenue == null &&
          totalExpenses == null &&
          netProfit == null &&
          profitMarginPct == null &&
          !topSpendingCategory;
        const isEmptyPayload = parsed.empty === true || parsed.source === "cache_miss" || parsed.data_status === "missing";
        if (isEmptyPayload || allNull) {
          setKpis([]);
          onEmptyDataRef.current?.();
          return;
        }

        const revChange =
          deltas?.revenue_mom_pct ??
          (Number(priorRevenue) > 0
            ? ((Number(totalRevenue) - Number(priorRevenue)) / Number(priorRevenue)) * 100
            : null);

        const expChange =
          deltas?.expenses_mom_pct ??
          (Number(priorExpenses) > 0
            ? ((Number(totalExpenses) - Number(priorExpenses)) / Number(priorExpenses)) * 100
            : null);

        const profitChange =
          deltas?.profit_mom_pct ??
          (Number(priorNet) !== 0 && Number.isFinite(Number(priorNet))
            ? ((Number(netProfit) - Number(priorNet)) / Number(priorNet)) * 100
            : null);

        const marginChange =
          deltas?.margin_mom_pct ??
          (Number.isFinite(Number(profitMarginPct)) && Number.isFinite(Number(priorMarginPct))
            ? Number(profitMarginPct) - Number(priorMarginPct)
            : null);

        const derivePriorFromChange = (current, pctChange) => {
          const currNum = Number(current);
          const pctNum = Number(pctChange);
          if (!Number.isFinite(currNum) || !Number.isFinite(pctNum)) return null;
          // pctChange is MoM %, so curr = prev * (1 + pct/100) -> prev = curr / (1 + pct/100)
          const denom = 1 + pctNum / 100;
          if (Math.abs(denom) < 1e-6) return null;
          return currNum / denom;
        };

        const fallbackPriorRevenue  = priorRevenue  == null ? derivePriorFromChange(totalRevenue, revChange)   : priorRevenue;
        const fallbackPriorExpenses = priorExpenses == null ? derivePriorFromChange(totalExpenses, expChange) : priorExpenses;
        const fallbackPriorNet      = priorNet      == null ? derivePriorFromChange(netProfit, profitChange)  : priorNet;
        const fallbackPriorMargin   = priorMarginPct == null && Number.isFinite(Number(marginChange)) && Number.isFinite(Number(profitMarginPct))
          ? Number(profitMarginPct) - Number(marginChange)
          : priorMarginPct;

        const formatted = [
          { label: "Current Revenue", value: fmtCurrency(totalRevenue), detail: fallbackPriorRevenue != null ? `Prior month ${fmtCompactCurrency(fallbackPriorRevenue)}` : "This month's revenue", trend: Number(revChange) >= 0 ? "up" : "down", change: fmtPct(revChange), tint: "emerald" },
          { label: "Current Expenses", value: fmtCurrency(totalExpenses), detail: fallbackPriorExpenses != null ? `Prior month ${fmtCompactCurrency(fallbackPriorExpenses)}` : "This month's spend", trend: Number(expChange) >= 0 ? "up" : "down", change: fmtPct(expChange), tint: "amber" },
          { label: "Net Profit", value: fmtCurrency(netProfit), detail: fallbackPriorNet != null ? `Prior month ${fmtCompactCurrency(fallbackPriorNet)}` : "Revenue after expenses", trend: Number(profitChange) >= 0 ? "up" : "down", change: fmtPct(profitChange), tint: "emerald" },
          { label: "Profit Margin", value: fmtMargin(profitMarginPct ?? 0), detail: fallbackPriorMargin == null ? "Net profit as % of revenue" : `Prior month ${fmtMargin(fallbackPriorMargin)}`, trend: Number(marginChange) >= 0 ? "up" : "down", change: fmtPoints(marginChange), tint: "rose" },
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
          KPI_CACHE.set(cacheKey, formatted);
          onLiveDataRef.current?.();
        }
      } catch (error) {
        if (error?.name === "AbortError") return;
        if (!cancelled) {
          if (!cached) setKpis([]);
          onErrorRef.current?.(error);
        }
      } finally {
        if (!cancelled && !cached) setLoading(false);
      }
    }

    fetchKPIs();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [userId, businessId, year, month, usingDemo, populateDemoKpis, refreshVersion]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 w-full">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="rounded-[18px] bg-white/[0.05] shadow-[0_18px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl p-4 sm:p-5 space-y-3 animate-pulse"
          >
            <div className="h-3 w-24 bg-white/[0.15] rounded-full" />
            <div className="h-6 w-32 bg-white/[0.18] rounded-md" />
            <div className="h-3 w-20 bg-white/[0.12] rounded-full" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid w-full grid-cols-1 items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {kpis.map((kpi, index) => (
        <KpiCard
          key={index}
          label={kpi.label}
          value={kpi.value}
          detail={kpi.detail}
          trend={kpi.trend}
          change={kpi.change}
          tone={getKpiTone(kpi)}
          variant="financial"
          className="min-h-[148px] outline-none"
          multilineValue={kpi.label === "Top Spending Category"}
          valueClassName={kpi.label === "Top Spending Category" ? "text-[clamp(1.15rem,1.15vw,1.42rem)] leading-snug" : ""}
        />
      ))}
    </div>
  );
}

function getKpiTone(kpi) {
  if (kpi.label === "Top Spending Category") return "neutral";
  if (kpi.label === "Current Expenses") return "neutral";
  if (kpi.trend === "down") return "neutral";
  return "emerald";
}
