export function processingProgressView(run) {
  if(!run) return null;
  const completed=run.state==='completed';
  const stopped=completed||run.state==='blocked'||run.state==='failed';
  const n=run.processed_count,total=run.total_count;
  const slow=run.started_at && Date.now()-Date.parse(run.started_at)>120000;
  const title=completed ? `${total} transaction${total===1?'':'s'} processed`
    : run.state==='blocked'||run.state==='failed' ? `Processing needs attention — ${n} of ${total} processed`
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
  if(next.processed_count<previous.processed_count) {
    if(next.state==='blocked' && (!previous.updated_at || next.updated_at>=previous.updated_at)) return {...previous,state:'blocked',reason:next.reason,automatic_retry:false,failed_blocked_count:previous.total_count-previous.processed_count,remaining_count:previous.total_count-previous.processed_count,updated_at:next.updated_at};
    return previous;
  }
  if(previous.updated_at&&next.updated_at&&next.updated_at<previous.updated_at) return previous;
  return next;
}
export function startProgressPolling({ fetchStatus, onChange, onError, schedule=setTimeout, unschedule=clearTimeout, now=Date.now }) {
  const controller=new AbortController();let timer,stopped=false,current=null;const started=now();
  async function poll(){
    if(stopped)return;
    try{
      const result=await fetchStatus({runId:current?.run_id,signal:controller.signal});
      if(stopped)return;
      if(result?.ok===false)throw new Error('unavailable');
      if(current && !result?.run) {
        current={...current,state:'blocked',reason:'This run is no longer available. Showing its last known progress; reselect the account or contact support.'};
        onChange(current);onError(null);return;
      }
      current=acceptProgress(current,result?.run);onChange(current);onError(null);
      if(current&&processingProgressView(current).stopped)return;
      // A fresh visit discovers server state without navigation/localStorage. No applicable run means stop.
      if(!current)return;
    }catch{if(stopped||controller.signal.aborted)return;onError('Progress could not refresh. Showing the last known result.');}
    if(!stopped)timer=schedule(poll,now()-started>120000?10000:2500);
  }
  void poll();
  return ()=>{stopped=true;controller.abort();if(timer!==undefined)unschedule(timer);};
}
export async function refreshProcessingFeed({ reloadAccounts, reloadCounts, reloadTransactions }) {
  const results=await Promise.all([reloadAccounts(),reloadCounts(),reloadTransactions({refreshCounts:false,refreshProcessingStatus:false})]);
  if(results.some(result=>result!==true))throw new Error('Books could not refresh completely. Try again.');
}
