// File: /src/components/Accounting/BookkeepingSummaryCards.jsx
import React, { memo } from "react";

function BookkeepingSummaryCards({ count, lastCleanupAt, estimatedImpact, loading, fmtCurrency }) {
  const cards = [
    { label: "Uncategorized transactions", value: loading ? "…" : (count || "—"), hint: "These are in “Uncategorized” or “Ask My Accountant” and need review." },
    { label: "Last cleanup", value: loading ? "…" : (lastCleanupAt ? new Date(lastCleanupAt).toLocaleDateString() : "Never") },
    { label: "Estimated impact", value: loading ? "…" : fmtCurrency(estimatedImpact) },
  ];

  return (
    <div className="grid gap-3 md:grid-cols-3">
      {cards.map((card) => (
        <div
          key={card.label}
          className="rounded-lg border border-white/8 bg-[#0f1519] px-3.5 py-3 shadow-[0_8px_24px_rgba(0,0,0,0.18)]"
        >
          <div className="text-[11px] uppercase tracking-wide text-white/60">{card.label}</div>
          <div className="mt-2 text-lg font-semibold text-white">{card.value}</div>
          {card.hint && !loading && (
            <p className="mt-1 text-xs text-white/55">{card.hint}</p>
          )}
        </div>
      ))}
    </div>
  );
}

export default memo(BookkeepingSummaryCards);
