import React, { useState } from 'react';
import { processingProgressView } from '../../utils/processingProgressView.js';
export default function ProcessingProgressNotice({ run, error, onRefresh }) {
  const [dismissed,setDismissed]=useState(null),[busy,setBusy]=useState(false),[refreshError,setRefreshError]=useState(null);
  const view=processingProgressView(run);
  if(!view)return error?<p role="status" className="mb-2 text-xs text-slate-400">{error}</p>:null;
  if(dismissed===`${run.account_id}:${run.run_id}`)return null;
  return <section className={`mb-2 rounded-xl border px-3 py-2 text-xs ${run.state==='blocked'?'border-amber-400/25 bg-amber-400/5':'border-emerald-400/20 bg-emerald-400/5'}`} aria-label="Transaction processing progress">
    <div role="status" aria-live="polite"><p className="font-semibold text-slate-100">{view.title}</p><p className="mt-1 text-slate-400">{view.breakdown}</p></div>
    {!view.stopped?<progress className="mt-2 h-1 w-full accent-emerald-400" value={run.processed_count} max={run.total_count||1} aria-label="Processed transactions"/>:null}
    {run.reason?<p className="mt-1 text-amber-200">{run.reason} {run.remaining_count} remaining.{run.automatic_retry?' Automatic retry is pending.':''}</p>:null}
    {error||refreshError?<p role="status" className="mt-1 text-amber-200">{refreshError||error}</p>:null}
    {view.stopped?<button type="button" disabled={busy} className="mt-2 rounded px-2 py-1 font-semibold text-emerald-200 focus-visible:outline disabled:opacity-50" onClick={async()=>{
      setBusy(true);setRefreshError(null);
      try{await onRefresh();if(view.completed)setDismissed(`${run.account_id}:${run.run_id}`);}
      catch{setRefreshError('Books could not refresh completely. Try again.');}
      finally{setBusy(false);}
    }}>{busy?'Refreshing…':view.refreshLabel}</button>:null}
  </section>;
}
