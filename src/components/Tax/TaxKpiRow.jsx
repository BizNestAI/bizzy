// src/components/Tax/TaxKpiRow.jsx
import React from "react";
import { ACCENT_LINE } from "../../config/accent";
import { Wallet2, BarChart3, PiggyBank, TimerReset } from "lucide-react";

export default function TaxKpiRow({ summary = {}, snapshot = {}, nextDue = {}, className = "" }) {
  const topDeduction = snapshot?.topDeductions?.[0];
  const cards = [
    {
      label: "Estimated YTD Tax",
      value: summary?.ytdEstimated,
      icon: <Wallet2 className="h-4 w-4" />,
    },
    {
      label: "Profit YTD",
      value: snapshot?.profitYTD ?? summary?.profitYTD,
      icon: <BarChart3 className="h-4 w-4" />,
    },
    {
      label: "Top Deduction",
      value: topDeduction ? topDeduction.amount : null,
      detail: topDeduction
        ? `${topDeduction.category}${topDeduction.percentRevenue != null ? ` (${topDeduction.percentRevenue}%)` : ""}`
        : null,
      icon: <PiggyBank className="h-4 w-4" />,
    },
    {
      label: "Next Payment",
      value: nextDue?.amount,
      detail: nextDue?.days != null ? `in ${nextDue.days} days` : null,
      icon: <TimerReset className="h-4 w-4" />,
    },
  ];

  return (
    <div className={`grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 ${className}`}>
      {cards.map((card, idx) => (
        <KpiCard key={idx} {...card} />
      ))}
    </div>
  );
}

function KpiCard({ label, value, detail, icon }) {
  return (
    <div
      className="group relative rounded-[16px] bg-white/[0.05] shadow-[0_18px_50px_rgba(0,0,0,0.35)] px-3.5 py-3 flex flex-col gap-1.5 border transition-all duration-200 hover:-translate-y-1 hover:border-[rgba(var(--accent-rgb),0.55)]"
      style={{ borderColor: ACCENT_LINE }}
    >
      {/* Accent hover frame to match Financial KPI cards */}
      <div
        className="pointer-events-none absolute inset-0 rounded-[16px] opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100 border-2 border-[rgba(var(--accent-rgb),0.35)]"
        style={{ boxShadow: "inset 0 0 0 1px rgba(16,185,129,0.15)" }}
      />
      <div className="absolute inset-0 rounded-[16px] ring-1 ring-inset ring-white/8 pointer-events-none" />

      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-[0.1em] text-white/65">{label}</span>
        <span className="text-white/70">{icon}</span>
      </div>
      <div className="text-[19px] font-semibold text-white tabular-nums">
        {value != null && value !== "" ? formatCurrency(value) : "—"}
      </div>
      {detail ? <div className="text-[12px] text-white/65">{detail}</div> : null}
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
