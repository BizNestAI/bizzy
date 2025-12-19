// File: /src/components/Accounting/FinancialKPICards.jsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import AskBizzyInsightButton from "../Bizzy/AskBizzyInsightButton";
import { usePeriod } from "../../context/PeriodContext";
import { getDemoData, shouldUseDemoData } from "../../services/demo/demoClient.js";

const API_BASE = import.meta.env?.VITE_API_BASE || "";

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

function TrendPill({ trend, change }) {
  if (!change) return null;
  const up = trend === "up";
  const Icon = up ? TrendingUp : TrendingDown;
  const cls = up
    ? "text-emerald-300 bg-emerald-400/10 ring-emerald-400/25"
    : "text-rose-300 bg-rose-400/10 ring-rose-400/25";
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ring-1 ${cls}`}>
      <Icon size={14} />
      {change}
    </span>
  );
}

export default function FinancialKPICards({
  userId: userIdProp,
  businessId: businessIdProp,
}) {
  const [kpis, setKpis] = useState([]);
  const [loading, setLoading] = useState(true);

  const userId = userIdProp || localStorage.getItem("user_id");
  const businessId = businessIdProp || localStorage.getItem("currentBusinessId");
  const { period } = usePeriod();
  const usingDemo = useMemo(() => shouldUseDemoData(), [businessId]);

  const populateDemoKpis = useCallback(() => {
    const demo = getDemoData();
    const fin = demo?.financials || {};
    const prev = fin?.prevMonth || {};
    const k = fin?.kpis || {};

    const revenue = Number(fin.mtdRevenue ?? 0);
    const revenuePrev = Number(prev.revenue ?? 0);
    const expenses = Number(fin.mtdExpenses ?? 0);
    const expensesPrev = Number(prev.expenses ?? 0);
    const profit = Number(fin.mtdProfit ?? 0);
    const profitPrev = Number(prev.profit ?? 0);
    const margin = Number(fin.profitMarginPct ?? 0);
    const marginPrev = Number(prev.profitMarginPct ?? 0);

    const revChange = revenuePrev > 0 ? ((revenue - revenuePrev) / revenuePrev) * 100 : null;
    const expChange = expensesPrev > 0 ? ((expenses - expensesPrev) / expensesPrev) * 100 : null;
    const profitChange = profitPrev !== 0 ? ((profit - profitPrev) / profitPrev) * 100 : null;
    const marginChange = Number.isFinite(margin) && Number.isFinite(marginPrev)
      ? margin - marginPrev
      : null;

    const demoKpis = [
      { label: "Current Revenue", value: fmtCurrency(revenue), previousValue: revenuePrev ? fmtCurrency(revenuePrev) : "", trend: Number(revChange) >= 0 ? "up" : "down", change: fmtPct(revChange), tint: "emerald" },
      { label: "Current Expenses", value: fmtCurrency(expenses), previousValue: expensesPrev ? fmtCurrency(expensesPrev) : "", trend: Number(expChange) >= 0 ? "up" : "down", change: fmtPct(expChange), tint: "amber" },
      { label: "Net Profit", value: fmtCurrency(profit), previousValue: profitPrev ? fmtCurrency(profitPrev) : "", trend: Number(profitChange) >= 0 ? "up" : "down", change: fmtPct(profitChange), tint: "emerald" },
      { label: "Profit Margin", value: `${Number.isFinite(margin) ? margin.toFixed(1) : "0.0"}%`, previousValue: Number.isFinite(marginPrev) ? `${marginPrev.toFixed(1)}%` : "", trend: Number(marginChange) >= 0 ? "up" : "down", change: fmtPct(marginChange), tint: "rose" },
      { label: "Top Spending Category", value: k.topSpendingCategory || "Labor", previousValue: "", trend: "up", change: "", tint: "amber" },
    ];

    setKpis(demoKpis);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchKPIs() {
      if (usingDemo) {
        populateDemoKpis();
        setLoading(false);
        return;
      }
      if (!userId || !businessId || !period?.year || !period?.month) {
        setLoading(false);
        populateDemoKpis();
        return;
      }

      setLoading(true);
      const ac = new AbortController();
      try {
        const url =
          `${API_BASE}/api/accounting/metrics` +
          `?user_id=${encodeURIComponent(userId)}` +
          `&business_id=${encodeURIComponent(businessId)}` +
          `&year=${encodeURIComponent(period.year)}` +
          `&month=${encodeURIComponent(period.month)}`;

        const res = await fetch(url, {
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
        const m = parsed.metrics || parsed;
        const deltas = parsed.deltas || null;

        const totalRevenue = m.totalRevenue ?? m.total_revenue;
        const totalExpenses = m.totalExpenses ?? m.total_expenses;
        const netProfit = m.netProfit ?? m.net_profit;
        const profitMargin = m.profitMargin ?? m.profit_margin;
        const topSpendingCategory = m.topSpendingCategory ?? m.top_spending_category;

        const prior = m.priorMonth ?? m.prior_month ?? {};
        const priorRevenue = prior.totalRevenue ?? prior.total_revenue;
        const priorExpenses = prior.totalExpenses ?? prior.total_expenses;
        const priorNet = prior.netProfit ?? prior.net_profit;
        const priorMargin = prior.profitMargin ?? prior.profit_margin;
        const priorTopCategory = prior.topSpendingCategory ?? prior.top_spending_category;

        if (
          totalRevenue == null &&
          totalExpenses == null &&
          netProfit == null &&
          profitMargin == null &&
          !topSpendingCategory
        ) {
          populateDemoKpis();
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
          (Number.isFinite(Number(profitMargin)) && Number.isFinite(Number(priorMargin))
            ? Number(profitMargin) - Number(priorMargin)
            : null);

        const formatted = [
          { label: "Current Revenue", value: fmtCurrency(totalRevenue), previousValue: priorRevenue != null ? fmtCurrency(priorRevenue) : "", trend: Number(revChange) >= 0 ? "up" : "down", change: fmtPct(revChange), tint: "emerald" },
          { label: "Current Expenses", value: fmtCurrency(totalExpenses), previousValue: priorExpenses != null ? fmtCurrency(priorExpenses) : "", trend: Number(expChange) >= 0 ? "up" : "down", change: fmtPct(expChange), tint: "amber" },
          { label: "Net Profit", value: fmtCurrency(netProfit), previousValue: priorNet != null ? fmtCurrency(priorNet) : "", trend: Number(profitChange) >= 0 ? "up" : "down", change: fmtPct(profitChange), tint: "emerald" },
          { label: "Profit Margin", value: `${Number(profitMargin ?? 0).toFixed(1)}%`, previousValue: priorMargin == null ? "" : `${Number(priorMargin).toFixed(1)}%`, trend: Number(marginChange) >= 0 ? "up" : "down", change: fmtPct(marginChange), tint: "rose" },
          { label: "Top Spending Category", value: topSpendingCategory || "N/A", previousValue: priorTopCategory || "", trend: topSpendingCategory && priorTopCategory && topSpendingCategory === priorTopCategory ? "up" : "down", change: "", tint: "amber" },
        ];

        if (!cancelled) setKpis(formatted);
      } catch (err) {
        if (!cancelled) populateDemoKpis();
      } finally {
        if (!cancelled) setLoading(false);
      }

      return () => ac.abort();
    }

    fetchKPIs();
    return () => { cancelled = true; };
  }, [userId, businessId, period?.year, period?.month, usingDemo, populateDemoKpis]);

  if (loading) {
    return <div className="text-white/70 text-sm">Loading financial KPIs…</div>;
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
              "border border-white/5",        // calm base border
              "transition-all duration-200",
              "hover:border-white/10",        // subtle chrome on hover
              tintRing,
              "min-h-[152px] sm:min-h-[164px]",
            ].join(" ")}
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

            {/* Ask Bizzi */}
            <div className="absolute right-3 top-3 z-20 pointer-events-auto">
              <AskBizzyInsightButton
                metric={kpi.label}
                value={kpi.value}
                previousValue={kpi.previousValue}
              />
            </div>

            {/* Content */}
            <div className="relative z-10 p-4 pr-20 pb-5 flex flex-col gap-2">
              <div className="mb-1 text-[12px] font-medium tracking-wide text-white/65">
                {kpi.label}
              </div>

              <div className="text-[20px] font-semibold leading-tight text-white sm:text-[22px]">
                {kpi.value}
              </div>

              <div className="mt-auto flex items-center gap-2 pt-1">
                <TrendPill trend={kpi.trend} change={kpi.change} />
                {kpi.previousValue ? (
                  <div className="text-xs text-white/45">
                    vs prior&nbsp;•&nbsp;<span className="tabular-nums">{kpi.previousValue}</span>
                  </div>
                ) : (
                  <div className="text-xs text-white/45">vs prior</div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
