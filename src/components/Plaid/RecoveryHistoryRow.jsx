import React from 'react';
export default function RecoveryHistoryRow({ count, completedAt, postingHold, onDetails }) {
  return <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-white/8 py-2 text-[11px]" data-recovery-history-summary>
    <div className="min-w-0">
      <span className="font-semibold text-emerald-200">Recovery completed</span>
      {Number.isFinite(count) ? <span className="ml-2 text-white/60">{count} transaction{count === 1 ? '' : 's'} imported</span> : null}
      {completedAt ? <span className="ml-2 text-white/60">{new Date(completedAt).toLocaleString()}</span> : null}
      <span className="ml-2 text-white/60">{postingHold === false ? 'Posting hold released' : postingHold === true ? 'Posting hold active' : 'Posting-hold status unavailable'}</span>
    </div>
    <button type="button" onClick={onDetails} className="shrink-0 rounded px-2 py-1 text-white/70 hover:text-white focus-visible:outline focus-visible:outline-emerald-300" aria-label="View completed recovery details">View details</button>
  </div>;
}
