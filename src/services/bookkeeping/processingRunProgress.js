import { classifyBookkeepingLifecycle } from './bookkeepingLifecycleClassifier.js';
const TERMINAL = new Set(['completed', 'skipped']);
function outcome(cat = {}) {
  const bucket = classifyBookkeepingLifecycle(cat).bucket;
  if (bucket === 'excluded') return 'excluded_count';
  if (bucket === 'matched') return 'matched_count';
  if (bucket === 'needs_review' || bucket === 'pending') return 'needs_review_count';
  if (cat.status === 'auto_approved' || (cat.decided_by === 'bizzi' && bucket === 'handled')) return 'automatically_categorized_count';
  return 'other_processed_count';
}
export function projectProcessingRun({ run, accountId, cohort, requests, categories }) {
  const members = [...new Map(cohort.filter(m => m.account_id === accountId).map(m => [m.transaction_id, m])).values()];
  const rs = new Map(requests.map(r => [r.transaction_id, r]));
  const cs = new Map(categories.map(c => [c.transaction_id, c]));
  const result = { run_id: run.id, account_id: accountId, total_count: members.length, admitted_count: members.length,
    queued_count: 0, processing_count: 0, automatically_categorized_count: 0, needs_review_count: 0,
    matched_count: 0, excluded_count: 0, other_processed_count: 0, failed_blocked_count: 0, processed_count: 0,
    started_at: run.started_at || run.created_at, updated_at: run.finished_at || run.updated_at || run.created_at,
    completed_at: null, state: 'queued', automatic_retry: false, reason: null };
  let blocked = false;
  const terminalTimes = [];
  for (const member of members) {
    const r = rs.get(member.transaction_id);
    const saved = run.meta?.processing_outcomes?.[member.transaction_id];
    if (saved?.category && TERMINAL.has(saved.request_status)) {
      result[outcome(saved.category)]++; result.processed_count++; terminalTimes.push(saved.processed_at);
      if(saved.processed_at && saved.processed_at>result.updated_at)result.updated_at=saved.processed_at;
      continue;
    }
    const initialTerminal = TERMINAL.has(member.initial_status);
    const generationMatches = r && r.id === member.request_id && (member.recovery_batch_id
      ? r.metadata?.recovery_batch_id === member.recovery_batch_id
      : (r.metadata?.plaid_sync_input_cursor_sha256 ?? null) === (member.generation ?? null) && (r.metadata?.source ?? null) === (member.source ?? null));
    if (initialTerminal) {
      if (!member.initial_categorization) { blocked = true; result.failed_blocked_count++; continue; }
      result[outcome(member.initial_categorization)]++; result.processed_count++; terminalTimes.push(run.finished_at || run.updated_at); continue;
    }
    if (r?.updated_at && (!result.updated_at || r.updated_at > result.updated_at)) result.updated_at = r.updated_at;
    if (!generationMatches) { blocked = true; result.failed_blocked_count++; result.reason = 'Processing evidence is unavailable or belongs to a later import. Review this run before continuing.'; continue; }
    if (r.updated_at && (!result.updated_at || r.updated_at > result.updated_at)) result.updated_at = r.updated_at;
    if (TERMINAL.has(r.status)) {
      if (run.meta?.processing_cohort_version === 1) { blocked = true; result.failed_blocked_count++; result.reason = 'The durable processing outcome is unavailable. Review this run before continuing.'; continue; }
      const cat = cs.get(member.transaction_id);
      if (!cat) { blocked = true; result.failed_blocked_count++; continue; }
      result[outcome(cat)]++; result.processed_count++; terminalTimes.push(r.processed_at || r.updated_at);
    } else if (r.status === 'dead_letter' || r.blocked_reason === 'paid_entitlement_required' || r.error_code === 'paid_entitlement_required') {
      blocked = true; result.failed_blocked_count++;
    } else if (r.status === 'failed') {
      result.failed_blocked_count++;
      if (r.process_after && Number(r.attempt_count) < Number(r.max_attempts)) { result.automatic_retry = true; result.queued_count++; }
      else { blocked = true; }
    } else if (r.status === 'processing') result.processing_count++;
    else if (r.status === 'pending') result.queued_count++;
    else { blocked = true; result.failed_blocked_count++; }
  }
  result.remaining_count = result.total_count - result.processed_count;
  result.state = blocked ? 'blocked' : result.remaining_count === 0 ? 'completed' : result.automatic_retry ? 'retrying' : result.processing_count ? 'processing' : 'queued';
  if (result.state === 'completed') result.completed_at = terminalTimes.filter(Boolean).sort().at(-1) || run.finished_at || run.updated_at || run.created_at;
  if (blocked && !result.reason) result.reason = 'Some transactions require processing support. Completed decisions and posting holds remain unchanged.';
  if (result.automatic_retry && !result.reason) result.reason = 'Some transactions are waiting for an automatic retry.';
  return result;
}
async function rows(query) { const {data,error} = await query; if(error) throw error;return data || []; }
async function paged(makeQuery) {
  const all=[];
  for(let offset=0;;offset+=500){ const page=await rows(makeQuery().range(offset,offset+499));all.push(...page);if(page.length<500)return all; }
}
export async function getProcessingRunProgress({ db, businessId, accountId, runId, now = new Date() }) {
  if (!businessId || !accountId) throw Object.assign(new Error('scope_required'), { status: 400 });
  const accounts = await rows(db.from('plaid_accounts').select('plaid_account_id').eq('business_id', businessId).eq('plaid_account_id', accountId).limit(1));
  if (!accounts.length) throw Object.assign(new Error('not_found'), { status: 404 });
  // Discovery is durable and deterministic; a pinned run never switches to a newer run mid-poll.
  let query = db.from('bank_sync_runs').select('id,started_at,finished_at,status,meta')
    .eq('business_id',businessId).contains('meta',{ processing_cohort_version: 1, processing_accounts: [accountId] })
    .order('started_at',{ascending:false}).order('id',{ascending:false});
  if (runId) query=query.eq('id',runId);
  const runs=runId?await rows(query.limit(1)):await paged(()=>query);
  const pendingCohort=r=>r.meta?.processing_cohort?.some(m=>m.account_id===accountId&&!TERMINAL.has(m.initial_status)&&!TERMINAL.has(r.meta?.processing_outcomes?.[m.transaction_id]?.request_status));
  let run=runs.find(pendingCohort)||runs[0],cohort=run?.meta?.processing_cohort;
  if(!run || !runId) {
    // Reviewed recovery already has immutable admitted membership. No queue-delta inference.
    const membership=await paged(()=> { let q=db.from('plaid_recovery_batch_rows').select('batch_id,admitted_transaction_id,plaid_account_id')
      .eq('business_id',businessId).eq('plaid_account_id',accountId).not('admitted_transaction_id','is',null).order('id'); if(runId)q=q.eq('batch_id',runId);return q; });
    const batchIds=[...new Set(membership.map(m=>m.batch_id))].filter(id=>!runId||id===runId);
    const batches=[];
    for(let i=0;i<batchIds.length;i+=100) batches.push(...await rows(db.from('plaid_recovery_batches').select('id,created_at,updated_at,summary,status').eq('business_id',businessId).in('id',batchIds.slice(i,i+100)).in('status',['imported_held','released'])));
    const recovery=batches.sort((a,b)=>String(b.summary?.admitted_at||b.summary?.applied_at||b.created_at).localeCompare(String(a.summary?.admitted_at||a.summary?.applied_at||a.created_at)) || b.id.localeCompare(a.id))[0];
    if(recovery && (!run || (!pendingCohort(run) && String(recovery.summary?.admitted_at||recovery.summary?.applied_at||recovery.created_at)>String(run.started_at)))) {
      run={...recovery,started_at:recovery.summary?.admitted_at||recovery.summary?.applied_at||recovery.created_at}; cohort=membership.filter(m=>m.batch_id===run.id).map(m=>({ transaction_id:m.admitted_transaction_id,account_id:accountId,recovery_batch_id:run.id }));
    }
  }
  if (!run) return { ok:true, run:null, unavailable_reason: runId ? 'Run is unavailable for this account.' : 'No exact processing cohort is available for this account.' };
  if (!Array.isArray(cohort)) return {ok:true,run:null,unavailable_reason:'Processing cohort is unavailable.'};
  const ids=[...new Set(cohort.filter(m=>m.account_id===accountId).map(m=>m.transaction_id))];
  const requests=[], categories=[];
  for(let i=0;i<ids.length;i+=100) {
    const chunk=ids.slice(i,i+100);
    requests.push(...await rows(db.from('bookkeeping_processing_requests').select('id,transaction_id,status,processed_at,updated_at,process_after,attempt_count,max_attempts,blocked_reason,error_code,metadata').eq('business_id',businessId).in('transaction_id',chunk)));
    categories.push(...await rows(db.from('transaction_categorizations').select('transaction_id,status,meta,decided_by,review_status,posting_status,posted_at,qbo_txn_id,final_qbo_account_id').eq('business_id',businessId).in('transaction_id',chunk)));
  }
  // Queue completion and the append-only outcome commit together. Re-read after queue rows
  // so a completion racing the initial discovery cannot look like missing durable evidence.
  if(run.meta?.processing_cohort_version===1) {
    const fresh=await rows(db.from('bank_sync_runs').select('id,started_at,finished_at,status,meta').eq('business_id',businessId).eq('id',run.id).limit(1));
    if(!fresh.length)throw new Error('progress_snapshot_unavailable');
    run=fresh[0];
  }
  // Recovery generation identity is exact too; do not return request/transaction IDs or raw metadata.
  cohort=cohort.map(m=>m.recovery_batch_id?{...m,request_id:requests.find(r=>r.transaction_id===m.transaction_id)?.id}:m);
  const progress=projectProcessingRun({run,accountId,cohort,requests,categories,now});
  if(!runId && progress.state==='completed' && Date.parse(progress.completed_at)<now.getTime()-24*60*60*1000) return {ok:true,run:null};
  return {ok:true,run:progress};
}
