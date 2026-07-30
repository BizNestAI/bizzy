import React from "react";
import KpiCard from "../UI/KpiCard.jsx";

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const cards = [
  { key: 'leads', label: 'New Leads (7d)', detail: 'Last 7 days', tone: 'emerald' },
  { key: 'scheduled', label: 'Jobs Scheduled (next 14d)', detail: 'Next 14 days', tone: 'emerald' },
  { key: 'winrate', label: 'Win Rate (30d)', detail: 'Won jobs ÷ won + lost', tone: 'emerald' },
  { key: 'ar', label: 'Outstanding A/R', detail: 'Keep under $15K', tone: 'amber' },
];

const formatValue = (key, value) => {
  if (value == null) return '—';
  if (key === 'ar') return currency.format(value || 0);
  if (key === 'winrate') return `${value}%`;
  return value;
};

export default function KPIRow({ leads7, scheduled14, winRate30, outstandingAR }) {
  const map = {
    leads: leads7 ?? 0,
    scheduled: scheduled14 ?? 0,
    winrate: winRate30 ?? null,
    ar: outstandingAR ?? null,
  };

  return (
    <div className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
      {cards.map((card) => {
        const value = map[card.key];
        const tone =
          card.key === 'ar'
            ? Number(value || 0) > 15000 ? 'amber' : 'emerald'
            : card.key === 'winrate'
              ? Number(value || 0) >= 50 ? 'emerald' : 'amber'
              : card.tone;

        return (
          <KpiCard
          key={card.key}
          label={card.label}
          value={formatValue(card.key, value)}
          detail={card.detail}
          tone={tone}
          className="min-h-[132px]"
        />
        );
      })}
    </div>
  );
}
