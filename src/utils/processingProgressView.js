export function processingProgressView(run) {
  if(!run) return null;
  const completed=run.state==='completed';
  const uncertain=run.state==='evidence_unavailable';
  const stopped=uncertain||completed||run.state==='blocked'||run.state==='failed';
  const n=run.processed_count,total=run.total_count;
  const slow=run.started_at && Date.now()-Date.parse(run.started_at)>120000;
  const currentOutcomes=run.outcome_basis==='current_durable_lifecycle';
  const verb=currentOutcomes?'resolved':'processed';
  const title=uncertain ? 'Processing history unavailable' : completed ? `${total} transaction${total===1?'':'s'} ${currentOutcomes?'resolved':'processed'}`
    : run.state==='blocked'||run.state==='failed' ? `Processing needs attention — ${n} of ${total} ${verb}`
      : currentOutcomes ? `Processing recovery — ${n} of ${total} resolved`
      : n===0 ? `Preparing ${total} new transaction${total===1?'':'s'} for categorization…`
        : `${slow?'Still working —':'Processing'} ${n} of ${total}${slow?' processed':' new transactions'}`;
  const fields=[['automatically_categorized_count','categorized automatically'],['needs_review_count',run.needs_review_count===1?'needs review':'need review'],['matched_count','matched'],['excluded_count','excluded'],['other_processed_count','already resolved'],['failed_blocked_count','failed or blocked']];
  return { title,breakdown:fields.filter(([key])=>run[key]>0).map(([key,label])=>`${run[key]} ${label}`).join(' · '),
    percent:total?Math.max(0,Math.min(100,n/total*100)):100,completed,stopped,remaining:total-n,
    refreshLabel:run.needs_review_count>0?`Refresh feed to review ${run.needs_review_count} transaction${run.needs_review_count===1?'':'s'}`:'Refresh feed' };
}
export function acceptProgress(previous,next) {
  if(!next) return previous;
  if(!previous) return next;
  if(next.run_id!==previous.run_id||next.account_id!==previous.account_id) return previous;
  if(next.total_count!==previous.total_count) return previous;
  // Recovery counts describe current lifecycle, so a newly required request
  // may legitimately reopen work. Ordinary immutable snapshots stay monotonic.
  if(next.outcome_basis==='current_durable_lifecycle' && previous.outcome_basis===next.outcome_basis &&
    (!previous.updated_at || (next.updated_at && next.updated_at>=previous.updated_at))) return next;
  if(next.processed_count<previous.processed_count) {
    if(['blocked','evidence_unavailable'].includes(next.state) && (!previous.updated_at || next.updated_at>=previous.updated_at)) return {...previous,state:next.state,reason:next.reason,automatic_retry:false,failed_blocked_count:Math.min(next.failed_blocked_count || 0,previous.total_count-previous.processed_count),remaining_count:previous.total_count-previous.processed_count,updated_at:next.updated_at};
    return previous;
  }
  if(previous.updated_at&&next.updated_at&&next.updated_at<previous.updated_at) return previous;
  return next;
}
// Rollout: deploy this frontend first and verify it against the old contract;
// deploy the backend second. Old clients cannot interpret resolved_run_id or
// terminal evidence_unavailable responses safely.
export function startProgressPolling({ fetchStatus, onChange, onError, schedule=setTimeout, unschedule=clearTimeout }) {
  const controller=new AbortController();let timer,stopped=false,current=null,previousSignature=null,delay=2500;
  const signature = run => JSON.stringify(run && [run.run_id,run.state,run.total_count,run.processed_count,run.queued_count,run.processing_count,run.failed_blocked_count,run.needs_review_count,run.matched_count,run.excluded_count,run.other_processed_count,run.automatically_categorized_count,run.evidence_unavailable_count,run.unknown_attribution_count,run.automatic_retry]);
  async function poll(){
    if(stopped)return;
    try{
      const result=await fetchStatus({runId:current?.run_id,signal:controller.signal});
      if(stopped)return;
      if(result?.ok===false)throw new Error('unavailable');
      if(current && !result?.run && result?.resolved_run_id===current.run_id) {
        current=null;onChange(null);onError(null);return;
      }
      if(current && !result?.run) {
        current={...current,state:'evidence_unavailable',reason:'This run is no longer available. Showing its last known progress; reselect the account or contact support.'};
        onChange(current);onError(null);return;
      }
      current=acceptProgress(current,result?.run);onChange(current);onError(null);
      const nextSignature=signature(current);
      delay=previousSignature!==null && nextSignature!==previousSignature ? 2500 : Math.min(30000,delay*2);
      previousSignature=nextSignature;
      if(current&&processingProgressView(current).stopped)return;
      // A fresh visit discovers server state without navigation/localStorage. No applicable run means stop.
      if(!current)return;
    }catch{if(stopped||controller.signal.aborted)return;delay=Math.min(30000,delay*2);onError('Progress could not refresh. Showing the last known result.');}
    if(!stopped)timer=schedule(poll,delay);
  }
  void poll();
  return ()=>{stopped=true;controller.abort();if(timer!==undefined)unschedule(timer);};
}
export async function refreshProcessingFeed({ reloadAccounts, reloadCounts, reloadTransactions }) {
  const results=await Promise.all([reloadAccounts(),reloadCounts(),reloadTransactions({refreshCounts:false,refreshProcessingStatus:false})]);
  if(results.some(result=>result!==true))throw new Error('Books could not refresh completely. Try again.');
}
