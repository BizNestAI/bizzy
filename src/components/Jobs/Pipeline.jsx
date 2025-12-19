import React from "react";

const formatMoney = (val) => {
  if (val == null) return "—";
  return `$${Number(val).toLocaleString()}`;
};

const Column = ({ title, items = [] }) => (
  <div className="rounded-[22px] border border-white/12 bg-gradient-to-b from-white/[0.08] via-white/[0.03] to-white/[0.01] flex flex-col backdrop-blur-2xl shadow-[0_25px_55px_rgba(0,0,0,0.45)]">
    <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 text-sm font-semibold text-white/90">
      <span>{title}</span>
      <span className="text-[11px] text-white/55">{items.length}</span>
    </div>
    <div className="flex-1 overflow-y-auto divide-y divide-white/5">
      {items.length === 0 && (
        <div className="text-xs text-white/55 px-4 py-6">No jobs in this stage.</div>
      )}
      {items.map((job) => (
        <article key={job.id} className="px-4 py-3 space-y-1 hover:bg-white/[0.05] transition rounded-xl">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-medium text-white truncate">{job.title || 'Untitled job'}</h4>
            <span className="text-[11px] px-2 py-0.5 rounded-full border border-white/10 text-white/65 capitalize">
              {job.invoice_status || 'none'}
            </span>
          </div>
          <div className="text-[11px] text-white/55 flex flex-wrap gap-x-2">
            <span>{job.external_source || 'Manual source'}</span>
            {job.external_id && <span>#{job.external_id}</span>}
          </div>
          <div className="flex items-center justify-between text-[12px] text-white/70">
            <span className="font-mono text-[13px] text-white/85">
              {job.amount_contracted ? formatMoney(job.amount_contracted) : job.amount_estimated ? `Est ${formatMoney(job.amount_estimated)}` : '—'}
            </span>
            <span>
              {job.due_date
                ? `Due ${new Date(job.due_date).toLocaleDateString()}`
                : job.start_date
                ? `Starts ${new Date(job.start_date).toLocaleDateString()}`
                : 'No date'}
            </span>
          </div>
        </article>
      ))}
    </div>
  </div>
);

export default function Pipeline({ columns }) {
  const cols = columns || {};
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      <Column title="Scheduled" items={cols.scheduled} />
      <Column title="In Progress" items={cols.in_progress} />
      <Column title="Completed" items={cols.completed} />
    </div>
  );
}
