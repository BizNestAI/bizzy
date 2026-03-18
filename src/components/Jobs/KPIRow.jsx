import React from "react";

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const cards = [
  { key: 'leads', label: 'New Leads (7d)' },
  { key: 'scheduled', label: 'Jobs Scheduled (next 14d)' },
  { key: 'winrate', label: 'Win Rate (30d)' },
  { key: 'ar', label: 'Outstanding A/R' },
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
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
      {cards.map((card) => (
        <div
          key={card.key}
          className="rounded-[18px] bg-white/[0.05] p-4 sm:p-5 shadow-[0_18px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl"
          style={{
            boxShadow: "0 18px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.04), 0 0 0 1px rgba(var(--accent-rgb),0.08)",
          }}
        >
          <div className="text-[11px] uppercase tracking-wide text-white/70 flex items-center gap-2">
            <span className="inline-block h-[6px] w-[6px] rounded-full" style={{ background: "rgba(var(--accent-rgb),0.7)", boxShadow: "0 0 10px rgba(var(--accent-rgb),0.5)" }} />
            {card.label}
          </div>
          <div className="mt-1 text-2xl font-semibold text-white">
            {formatValue(card.key, map[card.key])}
          </div>
          {card.key === 'ar' && (
            <div className="text-[11px] text-white/55 mt-0.5">Keep under $15K to maintain a 2+ month runway.</div>
          )}
          {card.key === 'winrate' && map[card.key] != null && (
            <div className="text-[11px] text-white/55 mt-0.5">Won jobs ÷ (won + lost) over the last 30 days.</div>
          )}
        </div>
      ))}
    </div>
  );
}
