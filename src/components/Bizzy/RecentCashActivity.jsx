import React from "react";
import CardHeader from "../../components/UI/CardHeader.jsx";
import { usePeriod } from "../../context/PeriodContext";

/**
 * items: [{ id, label, amount, date? }]
 * currency: "$" (default)
 * showHeader?: boolean (default true)
 * eyebrowOverride?: string (optional) // e.g., "RECEIVABLES — NOV 2025"
 */
export default function RecentCashActivity({
  items = [],
  currency = "$",
  showHeader = true,
  eyebrowOverride,
}) {
  const { period } = usePeriod?.() || {};
  const now = new Date();
  const year = period?.year ?? now.getFullYear();
  const monthIndex = (period?.month ?? now.getMonth() + 1) - 1; // 0-based
  const monthShort = new Date(year, monthIndex, 1).toLocaleString(undefined, {
    month: "short",
  });
  const monthStamp = `${monthShort.toUpperCase()} ${year}`;
  const eyebrow = eyebrowOverride || `RECENT CASH ACTIVITY — ${monthStamp}`;

  return (
    <div className="relative">
      {showHeader && <CardHeader eyebrow={eyebrow} className="mb-3" />}

      {(!items || items.length === 0) ? (
        <div className="rounded-2xl border border-white/10 bg-[#0C1016] px-4 py-5 text-sm text-white/60 shadow-[0_18px_30px_rgba(0,0,0,0.35)]">
          No cash activity recorded yet.
        </div>
      ) : (
        <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0C1016] shadow-[0_18px_30px_rgba(0,0,0,0.35)]">
          <div className="absolute inset-0 pointer-events-none" style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.06), rgba(3,5,9,0.85) 55%)" }} />
          <div className="flex items-center justify-between px-4 py-3 text-xs uppercase tracking-[0.18em] text-white/45 border-b border-white/5 relative">
            <span>Activity</span>
            <span>Amount</span>
          </div>
          <div className="divide-y divide-white/5 relative">
            {items.map((ev) => (
              <div key={ev.id} className="group relative flex items-center justify-between px-4 py-3 transition hover:bg-white/5">
                <div className="min-w-0 pr-4">
                  <div className="truncate text-sm text-white/90">{ev.label}</div>
                  {ev.date && (
                    <div className="mt-0.5 text-xs text-white/45">
                      {new Date(ev.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </div>
                  )}
                </div>
                <div className="text-base font-semibold text-white">
                  {currency}{Number(ev.amount).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
