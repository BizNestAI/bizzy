import React, { useMemo } from "react";

const Card = ({ title, desc, meta, actionLabel, onAction }) => (
  <div className="rounded-[22px] border border-white/12 bg-[rgba(18,19,23,0.86)] p-3 sm:p-4 shadow-[0_30px_60px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
    <div className="text-sm font-semibold text-white mb-1">{title}</div>
    <p className="text-xs text-white/65 leading-relaxed">{desc}</p>
    {meta?.length ? (
      <ul className="mt-2 text-[11px] text-white/55 space-y-0.5">
        {meta.map((line) => (
          <li key={line}>• {line}</li>
        ))}
      </ul>
    ) : null}
    {actionLabel ? (
      <button
        type="button"
        onClick={onAction}
        className="mt-3 inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-[11px] font-semibold text-white bg-white/10 hover:bg-white/20 transition shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]"
      >
        {actionLabel}
      </button>
    ) : null}
  </div>
);

export default function NextActionsPanel({ topUnpaid = [], pipeline = {}, hasQbo }) {
  const overdue = topUnpaid.slice(0, 3);

  const needsInvoice = useMemo(() => {
    const completed = pipeline?.completed || [];
    return completed.filter(j => !j.amount_invoiced || j.invoice_status === "none").slice(0, 2);
  }, [pipeline]);

  const readyToSchedule = useMemo(() => {
    const leads = pipeline?.scheduled || [];
    return leads.filter(j => !j.start_date).slice(0, 2);
  }, [pipeline]);

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold text-white/80">Next actions</h4>

      {hasQbo && overdue.length > 0 ? (
        <Card
          title="Follow up on unpaid jobs"
          desc="Nudge clients before the week ends so cash keeps flowing."
          meta={overdue.map((job) => `${job.title || 'Untitled'} — $${Number(job.amount_due || 0).toLocaleString()}`)}
          actionLabel="Open reminders"
        />
      ) : (
        <Card
          title="Connect QuickBooks or Housecall Pro"
          desc="Bring in live invoice status so Bizzi can watch cash for you."
          actionLabel="Connect accounting"
        />
      )}

      {needsInvoice.length ? (
        <Card
          title="Create invoices for completed jobs"
          desc="These finished jobs don’t have invoices yet."
          meta={needsInvoice.map((job) => job.title || 'Untitled job')}
          actionLabel="Review jobs"
        />
      ) : null}

      {readyToSchedule.length ? (
        <Card
          title="Add schedule dates"
          desc="Lock in visit dates so crews aren’t double-booked."
          meta={readyToSchedule.map((job) => job.title || 'Untitled job')}
          actionLabel="Set due dates"
        />
      ) : null}
    </div>
  );
}
