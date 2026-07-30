// src/components/Tax/TaxKpiRow.jsx
import React from "react";
import { Wallet2, BarChart3, PiggyBank, TimerReset } from "lucide-react";
import KpiCard from "../UI/KpiCard.jsx";

export default function TaxKpiRow({
  summary = {},
  snapshot = {},
  nextDue = {},
  taxTrendChange = null,
  className = "",
}) {
  const topDeduction = snapshot?.topDeductions?.[0];
  const profitRaw = snapshot?.profitYTD ?? summary?.profitYTD;
  const profit = profitRaw == null || Number.isNaN(Number(profitRaw)) ? null : Number(profitRaw);
  const daysUntilPayment = nextDue?.days == null ? null : Number(nextDue.days);
  const urgentPayment = Number.isFinite(daysUntilPayment) && daysUntilPayment <= 14;
  const overduePayment = Number.isFinite(daysUntilPayment) && daysUntilPayment <= 0;
  const cards = [
    {
      label: "Estimated YTD Tax",
      value: formatCurrency(summary?.ytdEstimated),
      detail: "Year to date",
      tone: "amber",
      trend: Number(taxTrendChange) >= 0 ? "up" : "down",
      change: formatPercent(taxTrendChange),
      icon: <Wallet2 className="h-4 w-4" />,
    },
    {
      label: "Profit YTD",
      value: formatCurrency(profit),
      detail: "Taxable profit",
      tone: profit == null || profit >= 0 ? "emerald" : "rose",
      icon: <BarChart3 className="h-4 w-4" />,
    },
    {
      label: "Top Deduction",
      value: topDeduction ? formatCurrency(topDeduction.amount) : "—",
      detail: topDeduction
        ? `${topDeduction.category}${topDeduction.percentRevenue != null ? ` (${topDeduction.percentRevenue}%)` : ""}`
        : null,
      tone: "emerald",
      icon: <PiggyBank className="h-4 w-4" />,
    },
    {
      label: "Next Payment",
      value: formatCurrency(nextDue?.amount),
      detail: Number.isFinite(daysUntilPayment)
        ? overduePayment
          ? "Due now"
          : `Due in ${daysUntilPayment} days`
        : null,
      tone: urgentPayment ? "amber" : "neutral",
      trend: urgentPayment ? "up" : null,
      change: urgentPayment ? (overduePayment ? "Due" : "Soon") : "",
      icon: <TimerReset className="h-4 w-4" />,
      className: urgentPayment
        ? "border-amber-300/35 shadow-[0_22px_58px_rgba(0,0,0,0.4),0_0_26px_rgba(251,191,36,0.12)]"
        : "",
    },
  ];

  return (
    <div className={`grid grid-cols-2 items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-4 ${className}`}>
      {cards.map((card, idx) => (
        <KpiCard
          key={idx}
          {...card}
          className={`min-h-[132px] ${card.className || ""}`}
          valueClassName={card.label === "Top Deduction" ? "text-[clamp(1.35rem,1.45vw,1.65rem)]" : ""}
        />
      ))}
    </div>
  );
}

function formatCurrency(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(n));
  } catch {
    return `$${Number(n).toLocaleString()}`;
  }
}

function formatPercent(value) {
  if (value == null || Number.isNaN(Number(value))) return "";
  const rounded = Math.round(Number(value));
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}
