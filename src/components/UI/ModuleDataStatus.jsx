import React from 'react';
export default function ModuleDataStatus({ state, onRetry }) {
  if (state === 'refreshing') return <span role="status" className="text-xs text-white/45">Updating…</span>;
  if (state === 'error_with_cache') return <span role="status" className="text-xs text-amber-100/80">Couldn’t update. Showing saved data, which may be out of date. {onRetry ? <button type="button" onClick={onRetry} className="underline">Retry</button> : null}</span>;
  return null;
}
