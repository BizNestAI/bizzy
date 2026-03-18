// File: /src/components/Accounting/FinancialKPICards.jsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import useFinancialPeriod from "../../hooks/useFinancialPeriod.js";
import { getDemoData, shouldForceLiveData, shouldUseDemoData } from "../../services/demo/demoClient.js";
import { useBizzyChatContext } from "../../context/BizzyChatContext";
import { Brain as PhBrain } from "@phosphor-icons/react";
import { useBusiness } from "../../context/BusinessContext";
import { apiFetch } from "../../utils/apiBase.js";
import { ACCENT_LINE } from "../../config/accent";

function fmtCurrency(n) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "$0";
  return `$${v.toLocaleString()}`;
}
function fmtPct(n) {
  if (n === null || n === undefined) return "";
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const s = Math.round(v);
  return `${s > 0 ? "+" : ""}${s}%`;
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

function TrendPill({ trend, change }) {
  if (!change) return null;
  const up = trend === "up";
  const Icon = up ? TrendingUp : TrendingDown;
  const cls = up
    ? "text-emerald-300 bg-emerald-400/10 ring-emerald-400/25"
    : "text-rose-300 bg-rose-400/10 ring-rose-400/25";
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-[4px] rounded-full text-[11px] font-medium ring-1 ${cls}`}>
      <Icon size={12} />
      {change}
    </span>
  );
}

export default function FinancialKPICards({
  userId: userIdProp,
  businessId: businessIdProp,
  onLiveData,
  onEmptyData,
  onLoadingChange,
}) {
  const [kpis, setKpis] = useState([]);
  const [loading, setLoading] = useState(true);
  const { sendMessage, openCanvas } = useBizzyChatContext();
  const { currentBusiness } = useBusiness?.() || {};

  const userId = userIdProp || localStorage.getItem("user_id");
  const businessId = businessIdProp || localStorage.getItem("currentBusinessId");
  const { year, month } = useFinancialPeriod(businessId);
  const forceLive = shouldForceLiveData();
  const usingDemo = useMemo(
    () => !forceLive && shouldUseDemoData(currentBusiness),
    [currentBusiness, forceLive]
  );

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
      { label: "Current Revenue", value: fmtCurrency(revenue), previousValue: revenuePrev != null ? fmtCurrency(revPrevNum) : "", trend: Number(revChange) >= 0 ? "up" : "down", change: fmtPct(revChange), tint: "emerald" },
      { label: "Current Expenses", value: fmtCurrency(expenses), previousValue: expensesPrev != null ? fmtCurrency(expPrevNum) : "", trend: Number(expChange) >= 0 ? "up" : "down", change: fmtPct(expChange), tint: "amber" },
      { label: "Net Profit", value: fmtCurrency(profit), previousValue: profitPrev != null ? fmtCurrency(profitPrevNum) : "", trend: Number(profitChange) >= 0 ? "up" : "down", change: fmtPct(profitChange), tint: "emerald" },
      { label: "Profit Margin", value: `${Number.isFinite(margin) ? margin.toFixed(1) : "0.0"}%`, previousValue: Number.isFinite(marginPrevNum) ? `${marginPrevNum.toFixed(1)}%` : "", trend: Number(marginChange) >= 0 ? "up" : "down", change: fmtPct(marginChange), tint: "rose" },
      {
        label: "Top Spending Category",
        value: topCategoryCurrent,
        previousValue: topCategoryPrev,
        trend: topCategoryPrev && topCategoryCurrent === topCategoryPrev ? "up" : "down",
        change: "",
        tint: "amber",
      },
    ];

    setKpis(demoKpis);
  }, []);

  useEffect(() => {
    onLoadingChange?.(loading);
  }, [loading, onLoadingChange]);

  useEffect(() => {
    let cancelled = false;

    async function fetchKPIs() {
      if (usingDemo) {
        populateDemoKpis();
        setLoading(false);
        onLiveData?.();
        return;
      }
      if (!userId || !businessId || !year || !month) {
        setLoading(false);
        setKpis([]);
        onEmptyData?.();
        return;
      }

      setLoading(true);
      const ac = new AbortController();
      try {
        const url =
          `/api/accounting/metrics` +
          `?user_id=${encodeURIComponent(userId)}` +
          `&business_id=${encodeURIComponent(businessId)}` +
          `&year=${encodeURIComponent(year)}` +
          `&month=${encodeURIComponent(month)}` +
          `&data_mode=live&live_only=true`;

        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.log("[FinancialKPICards] fetch", { year, month, url });
        }

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

        if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`);
        if (!ct.includes("application/json"))
          throw new Error(`Non-JSON response (${ct}): ${raw.slice(0, 200)}`);

        const parsed = JSON.parse(raw) || {};
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.log("[FinancialKPICards] raw metrics response", parsed);
        }
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
        if (allNull) {
          setKpis([]);
          onEmptyData?.();
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
          { label: "Current Revenue", value: fmtCurrency(totalRevenue), previousValue: fallbackPriorRevenue != null ? fmtCurrency(fallbackPriorRevenue) : "", trend: Number(revChange) >= 0 ? "up" : "down", change: fmtPct(revChange), tint: "emerald" },
          { label: "Current Expenses", value: fmtCurrency(totalExpenses), previousValue: fallbackPriorExpenses != null ? fmtCurrency(fallbackPriorExpenses) : "", trend: Number(expChange) >= 0 ? "up" : "down", change: fmtPct(expChange), tint: "amber" },
          { label: "Net Profit", value: fmtCurrency(netProfit), previousValue: fallbackPriorNet != null ? fmtCurrency(fallbackPriorNet) : "", trend: Number(profitChange) >= 0 ? "up" : "down", change: fmtPct(profitChange), tint: "emerald" },
      { label: "Profit Margin", value: fmtMargin(profitMarginPct ?? 0), previousValue: fallbackPriorMargin == null ? "" : fmtMargin(fallbackPriorMargin), trend: Number(marginChange) >= 0 ? "up" : "down", change: fmtPct(marginChange), tint: "rose" },
          {
            label: "Top Spending Category",
            value: topSpendingCategory || "N/A",
            previousValue: priorTopCategory ?? "N/A",
            trend: priorTopCategory ? (topSpendingCategory === priorTopCategory ? "up" : "down") : null,
            change: "",
            tint: "amber",
          },
        ];

        if (!cancelled) {
          setKpis(formatted);
          onLiveData?.();
        }
      } catch (err) {
        if (!cancelled) {
          setKpis([]);
          onEmptyData?.();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }

      return () => ac.abort();
    }

    fetchKPIs();
    return () => { cancelled = true; };
  }, [userId, businessId, year, month, usingDemo, populateDemoKpis]);

  const handleAsk = useCallback(
    async (kpi) => {
      if (!kpi) return;
      const prompt = kpi.previousValue
        ? `Explain why ${kpi.label} is ${kpi.value} this month compared to ${kpi.previousValue} last month. Suggest 1–2 actions to improve.`
        : `Explain why ${kpi.label} is ${kpi.value} this month. Suggest 1–2 actions to improve.`;
      openCanvas("accounting");
      window.dispatchEvent(new Event("bizzy:open-chat"));
      await sendMessage(prompt, { openCanvas: true, module: "accounting" });
      requestAnimationFrame(() =>
        window.dispatchEvent(new CustomEvent("bizzy:scrollCanvasBottom"))
      );
    },
    [openCanvas, sendMessage]
  );

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
    <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {kpis.map((kpi, index) => {
        const tintRing =
          kpi.tint === "emerald" ? "focus-visible:ring-emerald-400/30"
        : kpi.tint === "amber"   ? "focus-visible:ring-amber-400/30"
        : kpi.tint === "rose"    ? "focus-visible:ring-rose-400/30"
        : "";

        return (
          <div
            key={index}
            tabIndex={0}
            className={[
              "group relative overflow-hidden rounded-2xl outline-none",
              "bg-zinc-900/70 backdrop-blur-md",
              "border", // border color set via inline style to match Books accent
              "transition-all duration-200",
              "hover:border-[rgba(var(--accent-rgb),0.55)] hover:-translate-y-1.5 hover:shadow-[0_16px_38px_rgba(0,0,0,0.45)]", // subtle lift like InsightCards
              tintRing,
              "min-h-[156px] sm:min-h-[168px]",
            ].join(" ")}
            style={{ borderColor: ACCENT_LINE }}
          >
            {/* Emerald hover frame (dark green) */}
            <div
              className="pointer-events-none absolute inset-0 rounded-2xl border-2 border-emerald-500/25 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
              style={{ boxShadow: "inset 0 0 0 1px rgba(16,185,129,0.15)" }}
            />

            {/* Glass gradient & inner stroke */}
            <div className="pointer-events-none absolute inset-0">
              <div
                className="absolute inset-0 rounded-2xl opacity-[0.9] mix-blend-normal"
                style={{
                  background:
                    "linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 30%, rgba(0,0,0,0.10) 100%)",
                }}
              />
              <div
                className="absolute -top-10 -left-10 h-40 w-40 rounded-full opacity-20 blur-2xl"
                style={{
                  background:
                    "radial-gradient(60% 60% at 50% 50%, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0) 70%)",
                }}
              />
              <div className="absolute inset-0 rounded-[1rem] ring-1 ring-inset ring-white/5" />
            </div>

            {/* Content */}
            <div className="relative z-10 h-full px-3.5 pt-3.5 pb-4 flex flex-col gap-2">
              <div className="text-[11px] font-medium tracking-wide text-white/75 leading-snug whitespace-nowrap overflow-hidden text-ellipsis">
                {kpi.label}
              </div>

              <div className="text-[20px] font-semibold leading-tight text-white sm:text-[21px]">
                {kpi.value}
              </div>

              <div className="flex items-center gap-2 leading-tight">
                <TrendPill trend={kpi.trend} change={kpi.change} />
                <div className="flex flex-col text-[10px] text-white/72 leading-tight whitespace-nowrap">
                  <span className="leading-tight">prior month:</span>
                  {kpi.previousValue ? (
                    <span
                      className={[
                        "tabular-nums text-white/85",
                        kpi.label === "Top Spending Category" ? "font-semibold text-white" : ""
                      ].join(" ").trim()}
                    >
                      {kpi.previousValue}
                    </span>
                  ) : null}
                </div>
              </div>

              {/* Ask Bizzi button removed on forecasts page */}
            </div>

          </div>

        );
      })}
    </div>
  );
}
