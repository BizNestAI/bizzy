import React from 'react';
import { institutionView, plaidStatusView, postingHoldMessage } from '../../utils/plaidStatusView.js';
export default function PlaidStatusSummary({ health, entity = {}, recovery }) {
  const input = { ...entity, sync_health: health };
  const view = entity.accounts ? institutionView(input, recovery) : plaidStatusView(input, recovery);
  const hold = postingHoldMessage(entity, recovery);
  return <div className="mt-2 text-[11px] text-white/55" data-transaction-sync-health>
    {!view.compact && !entity.accounts ? <div className="font-semibold text-amber-200">{view.label}</div> : null}
    {!view.compact && health?.reason ? <div className="mt-1">{health.reason}</div> : null}
    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
      <span>Last successful sync: {health?.last_successful_sync_at ? new Date(health.last_successful_sync_at).toLocaleString() : 'Not recorded'}</span>
      {health?.transactions_imported_through ? <span>Imported through {health.transactions_imported_through}</span> : null}
    </div>
    {hold ? <div className="mt-1 text-amber-200">{hold}</div> : null}
  </div>;
}
