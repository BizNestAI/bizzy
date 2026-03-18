import React from "react";

const formatMoney = (val) =>
  `$${Number(val || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatShortDate = (date) => {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export default function TopUnpaidTable({ rows = [], hasQbo = false }) {
  if (!rows.length) {
    return (
      <div className="text-sm text-white/75 rounded-[18px] bg-white/[0.05] px-4 py-5 shadow-[0_18px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl">
        {hasQbo
          ? "No unpaid jobs right now."
          : "Connect QuickBooks or Jobber to see which jobs are still waiting on payment."}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="max-h-[320px] md:max-h-[420px] overflow-y-auto pr-1 custom-scrollbar">
        {rows.map((row) => {
          const issued = formatShortDate(row.invoice_date);
          const due = formatShortDate(row.due_date);
          const overdueText =
            row.days_overdue && row.days_overdue > 0
              ? `${row.days_overdue}d overdue`
              : "Not overdue";
          const followups = row.followups || {};
          let followupText = "Follow-ups: none";
          if (followups.sent_count > 1) {
            followupText = `${followups.sent_count} follow-ups • last sent ${formatShortDate(followups.last_sent_at) || ""}`.trim();
          } else if (followups.sent_count === 1) {
            followupText = `Follow-up sent ${formatShortDate(followups.last_sent_at) || ""}`.trim();
          } else if (followups.next_scheduled_at) {
            followupText = `Follow-up scheduled ${formatShortDate(followups.next_scheduled_at) || ""}`.trim();
          }
          return (
            <div
              key={row.id}
              className="rounded-[14px] bg-white/[0.05] px-4 py-3 flex flex-wrap items-center gap-3 justify-between shadow-[0_10px_24px_rgba(0,0,0,0.25)] backdrop-blur-xl mb-2"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-white truncate">{row.title || "(Unknown customer)"}</div>
                <div className="text-[11px] text-white/55 truncate">
                  {row.external_source || "Manual"} • Invoice {row.external_id || row.id}
                </div>
                <div className="text-[11px] text-white/50 flex flex-wrap gap-2 mt-0.5">
                  {issued ? <span>Issued {issued}</span> : null}
                  {due ? <span>• Due {due}</span> : null}
                  {overdueText ? <span>• {overdueText}</span> : null}
                </div>
                <div className="text-[11px] text-white/45 mt-0.5">{followupText}</div>
              </div>
              <div className="text-right min-w-[120px]">
                <div className="text-[11px] uppercase tracking-wide text-white/50">
                  {row.invoice_status === "partial" ? "Partial" : "Unpaid"}
                </div>
                <div className="text-lg font-semibold text-rose-300">
                  {formatMoney(row.amount_due)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
