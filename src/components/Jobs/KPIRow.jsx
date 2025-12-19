import React from "react";

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const cards = [
  { key: 'leads', label: 'New Leads (7d)', tone: 'from-cyan-500/20 to-cyan-500/5' },
  { key: 'scheduled', label: 'Jobs Scheduled (next 14d)', tone: 'from-sky-500/15 to-sky-500/5' },
  { key: 'winrate', label: 'Win Rate (30d)', tone: 'from-violet-500/15 to-violet-500/5' },
  { key: 'ar', label: 'Outstanding A/R', tone: 'from-rose-500/15 to-rose-500/5' },
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
          className={`rounded-[22px] border border-white/15 bg-gradient-to-br ${card.tone} p-4 sm:p-5 shadow-[0_28px_55px_rgba(0,0,0,0.45)] backdrop-blur-2xl`}
          style={{
            backgroundImage: `linear-gradient(140deg, rgba(19,22,27,0.7), rgba(10,11,13,0.65)), var(--bg)`,
            borderColor: 'rgba(255,255,255,0.12)',
          }}
        >
          <div className="text-[11px] uppercase tracking-wide text-white/60">{card.label}</div>
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
