import { classifyBookkeepingLifecycle } from './bookkeepingLifecycleClassifier.js';
import { createProcessingProgressCache } from './processingProgressCache.js';
const defaultCache = createProcessingProgressCache();
const TERMINAL = new Set(['completed', 'skipped']);
function outcome(cat = {}) {
  const bucket = classifyBookkeepingLifecycle(cat).bucket;
  if (bucket === 'excluded') return 'excluded_count';
  if (bucket === 'matched') return 'matched_count';
  if (bucket === 'needs_review' || bucket === 'pending') return 'needs_review_count';
  if (cat.status === 'auto_approved' || (cat.decided_by === 'bizzi' && bucket === 'handled')) return 'automatically_categorized_count';
  return 'other_processed_count';
}
function requestMatches(member, request) {
  return request && request.id === member.request_id && (member.recovery_batch_id
    ? request.metadata?.recovery_batch_id === member.recovery_batch_id
    : (request.metadata?.plaid_sync_input_cursor_sha256 ?? null) === (member.generation ?? null) &&
      (request.metadata?.source ?? null) === (member.source ?? null));
}
const REQUEST_COLUMNS = 'id,transaction_id,status,processed_at,updated_at,process_after,attempt_count,max_attempts,blocked_reason,error_code,metadata';
export function projectProcessingRun({ run, accountId, cohort, requests, categories, bankTransactions = [], receipts = [], postingJobs = [] }) {
  const members = [...new Map(cohort.filter(m => m.account_id === accountId).map(m => [m.transaction_id, m])).values()];
  const rs = new Map(requests.map(r => [r.transaction_id, r]));
  const cs = new Map(categories.map(c => [c.transaction_id, c]));
  const postedIds = new Set([...receipts.filter(r=>r.status==='posted'),...postingJobs.filter(r=>r.state==='posted')].map(r=>r.transaction_id));
  const banks = new Map(bankTransactions.map(r => [r.id, r]));
  const recovery = cohort.some(m => m.recovery_batch_id);
  const result = { run_id: run.id, account_id: accountId, total_count: members.length, admitted_count: members.length,
    queued_count: 0, processing_count: 0, automatically_categorized_count: 0, needs_review_count: 0,
    matched_count: 0, excluded_count: 0, other_processed_count: 0, failed_blocked_count: 0, processed_count: 0, unknown_attribution_count: 0, evidence_unavailable_count: 0,
    outcome_basis: recovery ? 'current_durable_lifecycle' : 'run_snapshot',
    started_at: run.started_at || run.created_at, updated_at: run.finished_at || run.updated_at || run.created_at,
    completed_at: null, state: 'queued', automatic_retry: false, reason: null };
  let blocked = false;
  const terminalTimes = [];
  for (const member of members) {
    const r = rs.get(member.transaction_id);
    const initialTerminal = TERMINAL.has(member.initial_status);
    const generationMatches = requestMatches(member,r);
    if (r?.updated_at && (!result.updated_at || r.updated_at > result.updated_at)) result.updated_at = r.updated_at;
    if (r && !TERMINAL.has(r.status) && (generationMatches || member.recovery_batch_id)) {
      if (member.recovery_batch_id && !generationMatches) result.unknown_attribution_count++;
      if (r.status === 'dead_letter' || r.status === 'blocked' || r.blocked_reason || r.error_code === 'paid_entitlement_required') {
        blocked = true; result.failed_blocked_count++;
      } else if (r.status === 'failed') {
        result.failed_blocked_count++;
        if (r.process_after && Number(r.attempt_count) < Number(r.max_attempts)) { result.automatic_retry = true; result.queued_count++; }
        else blocked = true;
      } else if (r.status === 'processing') result.processing_count++;
      else if (['pending', 'queued'].includes(r.status)) result.queued_count++;
      else result.evidence_unavailable_count++;
      continue;
    }
    // An append-only completion snapshot is processing evidence, not a review
    // label. It also closes a completion race with the earlier queue read.
    const saved = run.meta?.processing_outcomes?.[member.transaction_id];
    if (saved?.category && TERMINAL.has(saved.request_status)) {
      result[outcome(saved.category)]++; result.processed_count++; terminalTimes.push(saved.processed_at);
      if(saved.processed_at && saved.processed_at>result.updated_at)result.updated_at=saved.processed_at;
      continue;
    }
    if (member.recovery_batch_id) {
      if (!generationMatches) result.unknown_attribution_count++;
      const cat = cs.get(member.transaction_id);
      const bank = banks.get(member.transaction_id);
      // Current nonterminal work for an exact member always wins over review
      // state, even for legacy requests whose batch attribution is unknown.
      if (!r || TERMINAL.has(r.status)) {
        if (generationMatches && bank && cat && TERMINAL.has(r.status)) {
          result[outcome({ ...bank, ...cat })]++;
          result.processed_count++;
          terminalTimes.push(r.processed_at || r.updated_at);
          continue;
        }
        const lifecycle = classifyBookkeepingLifecycle({ ...bank, ...cat });
        const posted = postedIds.has(member.transaction_id);
        const resolved = bank && !lifecycle.pending && (posted || lifecycle.posted || lifecycle.bucket === 'matched' ||
          lifecycle.excluded || (lifecycle.bucket === 'handled' && (TERMINAL.has(r?.status) ||
            (!lifecycle.failed && !['failed', 'failed_post', 'post_failed'].includes(cat?.status)))));
        if (resolved) {
          result[lifecycle.bucket === 'matched' ? 'matched_count' : lifecycle.excluded ? 'excluded_count' : 'other_processed_count']++;
          result.processed_count++;
          terminalTimes.push(cat?.posted_at || cat?.decided_at || cat?.updated_at);
        } else result.evidence_unavailable_count++;
        continue;
      }
    }
    if (initialTerminal) {
      if (!member.initial_categorization) { result.evidence_unavailable_count++; continue; }
      result[outcome(member.initial_categorization)]++; result.processed_count++; terminalTimes.push(run.finished_at || run.updated_at); continue;
    }
    if (!generationMatches && !member.recovery_batch_id) { result.unknown_attribution_count++; result.evidence_unavailable_count++; continue; }
    if (TERMINAL.has(r.status)) {
      const cat = cs.get(member.transaction_id);
      if (!cat) { result.evidence_unavailable_count++; continue; }
      // Request generation proves processing completion even if its optional
      // outcome snapshot is absent. Label current category evidence honestly.
      if (run.meta?.processing_cohort_version === 1) result.outcome_basis = 'attributed_request_current_outcome';
      result[outcome(cat)]++; result.processed_count++; terminalTimes.push(r.processed_at || r.updated_at);
    }
  }
  result.remaining_count = result.total_count - result.processed_count;
  result.state = blocked ? 'blocked' : result.remaining_count === 0 ? 'completed' : result.automatic_retry ? 'retrying' : result.processing_count ? 'processing' : result.queued_count ? 'queued' : 'evidence_unavailable';
  if (result.evidence_unavailable_count && !blocked) result.reason = 'Some processing evidence is unavailable. This does not establish a processing failure.';
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
export async function getProcessingRunProgress(options) {
  const { db, businessId, accountId, runId, cache = defaultCache } = options;
  if (!businessId || !accountId) throw Object.assign(new Error('scope_required'), { status: 400 });
  const load = () => readProcessingRunProgress(options);
  return cache ? cache.result(db, [businessId, accountId, runId || null], load) : load();
}
async function readProcessingRunProgress({ db, businessId, accountId, runId, now = new Date(), cache = defaultCache }) {
  if (!businessId || !accountId) throw Object.assign(new Error('scope_required'), { status: 400 });
  const accounts = await rows(db.from('plaid_accounts').select('plaid_account_id,plaid_item_id').eq('business_id', businessId).eq('plaid_account_id', accountId).limit(1));
  if (!accounts.length) throw Object.assign(new Error('not_found'), { status: 404 });
  const itemId = accounts[0].plaid_item_id;
  // Discovery is durable and deterministic; a pinned run never switches to a newer run mid-poll.
  let query = db.from('bank_sync_runs').select('id,started_at,finished_at,status,meta')
    .eq('business_id',businessId).eq('plaid_item_id',itemId).contains('meta',{ processing_cohort_version: 1, processing_accounts: [accountId] })
    .order('started_at',{ascending:false}).order('id',{ascending:false});
  if (runId) query=query.eq('id',runId);
  const runs=runId?await rows(query.limit(1)):await paged(()=>query);
  const pendingCohort=r=>r.meta?.processing_cohort?.some(m=>m.account_id===accountId&&!TERMINAL.has(m.initial_status)&&!TERMINAL.has(r.meta?.processing_outcomes?.[m.transaction_id]?.request_status));
  let run=runs.find(pendingCohort)||runs[0],cohort=run?.meta?.processing_cohort;
  const candidates = [];
  if(!run || !runId) {
    // Reviewed recovery already has immutable admitted membership. No queue-delta inference.
    let batchQuery = db.from('plaid_recovery_batches').select('id,plaid_item_id,created_at,updated_at,summary,status')
      .eq('business_id',businessId).eq('plaid_item_id',itemId).in('status',['imported_held','released'])
      .order('created_at',{ascending:false}).order('id',{ascending:false});
    if (runId) batchQuery = batchQuery.eq('id',runId);
    const batches = await paged(() => batchQuery);
    batches.sort((a,b)=>String(b.summary?.admitted_at||b.summary?.applied_at||b.created_at).localeCompare(String(a.summary?.admitted_at||a.summary?.applied_at||a.created_at)) || b.id.localeCompare(a.id));
    for (const recovery of batches) {
      const startedAt = recovery.summary?.admitted_at || recovery.summary?.applied_at || recovery.created_at;
      const loadMembership = () => paged(() => db.from('plaid_recovery_batch_rows').select('batch_id,admitted_transaction_id,plaid_account_id')
        .eq('business_id',businessId).eq('batch_id',recovery.id).eq('plaid_account_id',accountId)
        .not('admitted_transaction_id','is',null).order('id'));
      // Only admitted membership of a released batch is immutable in the
      // recovery workflow. Revalidate batch status/version on every live read.
      const membership = cache && recovery.status === 'released'
        ? await cache.membership(db,[businessId,itemId,accountId,recovery.id,recovery.updated_at,recovery.summary?.admitted_at],loadMembership)
        : await loadMembership();
      if (!membership.length) continue;
      candidates.push({ run: { ...recovery, started_at: startedAt }, cohort: membership.filter(m=>m.batch_id===recovery.id).map(m=>({ transaction_id:m.admitted_transaction_id,account_id:accountId,recovery_batch_id:recovery.id })) });
    }
  }
  if (run) {
    // A live ordinary cohort stays pinned ahead of historical recovery checks.
    // Completed checkpoints must not hide unresolved older recoveries.
    if (pendingCohort(run)) candidates.unshift({run, cohort});
    else candidates.push({run, cohort});
  }
  let resolvedRunId;
  for (const candidate of candidates) {
    run = candidate.run; cohort = candidate.cohort;
    if (!Array.isArray(cohort)) return {ok:true,run:null,unavailable_reason:'Processing cohort is unavailable.'};
    const ids=[...new Set(cohort.filter(m=>m.account_id===accountId).map(m=>m.transaction_id))];
    const requests=[], categories=[], bankTransactions=[], receipts=[], postingJobs=[];
    for(let i=0;i<ids.length;i+=100) {
      const chunk=ids.slice(i,i+100);
      requests.push(...await rows(db.from('bookkeeping_processing_requests').select(REQUEST_COLUMNS).eq('business_id',businessId).in('transaction_id',chunk)));
      categories.push(...await rows(db.from('transaction_categorizations').select('transaction_id,status,meta,decided_by,review_status,posting_status,posted_at,decided_at,updated_at,excluded_at,qbo_txn_id,final_qbo_account_id').eq('business_id',businessId).in('transaction_id',chunk)));
      if (cohort.some(m => m.recovery_batch_id)) {
        bankTransactions.push(...await rows(db.from('bank_transactions').select('id,pending').eq('business_id',businessId).eq('plaid_account_id',accountId).in('id',chunk)));
      }
    }
    // Category/queue evidence usually suffices. Read posting evidence only for
    // exact members lacking a category and any current nonterminal request.
    const categorizedIds = new Set(categories.map(c=>c.transaction_id));
    const activeRequestIds = new Set(requests.filter(r=>!TERMINAL.has(r.status)).map(r=>r.transaction_id));
    const supplemental = ids.filter(id => !categorizedIds.has(id) && !activeRequestIds.has(id));
    if (cohort.some(m=>m.recovery_batch_id)) for(let i=0;i<supplemental.length;i+=100) {
      const chunk=supplemental.slice(i,i+100);
      receipts.push(...await rows(db.from('qbo_posted_transactions').select('transaction_id,status').eq('business_id',businessId).in('transaction_id',chunk)));
      postingJobs.push(...await rows(db.from('bookkeeping_posting_jobs').select('transaction_id,state').eq('business_id',businessId).in('transaction_id',chunk)));
    }
    // Queue completion and the append-only outcome commit together. Re-read after queue rows
    // so a completion racing the initial discovery cannot look like missing durable evidence.
    if(run.meta?.processing_cohort_version===1) {
      const fresh=await rows(db.from('bank_sync_runs').select('id,started_at,finished_at,status,meta').eq('business_id',businessId).eq('id',run.id).limit(1));
      if(!fresh.length)throw new Error('progress_snapshot_unavailable');
      run=fresh[0];
      // Completion evidence and queue completion commit atomically. If the
      // first queue read predates that commit, re-read just those exact members.
      // A still-active attributed request then takes precedence in projection.
      const stale = cohort.filter(m=>m.account_id===accountId &&
        TERMINAL.has(run.meta?.processing_outcomes?.[m.transaction_id]?.request_status) &&
        requests.some(r=>r.transaction_id===m.transaction_id && !TERMINAL.has(r.status) && requestMatches(m,r)))
        .map(m=>m.transaction_id);
      for(let i=0;i<stale.length;i+=100) {
        const newer=await rows(db.from('bookkeeping_processing_requests').select(REQUEST_COLUMNS)
          .eq('business_id',businessId).in('transaction_id',stale.slice(i,i+100)));
        for(const r of newer) requests[requests.findIndex(old=>old.transaction_id===r.transaction_id)]=r;
      }
    }
    // Recovery generation identity is exact too; do not return request/transaction IDs or raw metadata.
    const requestIds = new Map(requests.map(r=>[r.transaction_id,r.id]));
    cohort=cohort.map(m=>m.recovery_batch_id?{...m,request_id:requestIds.get(m.transaction_id)}:m);
    const progress=projectProcessingRun({run,accountId,cohort,requests,categories,bankTransactions,receipts,postingJobs});
    if (run.status === 'released' && progress.state === 'completed') { resolvedRunId = run.id; continue; }
    if(!runId && progress.state==='completed' && Date.parse(progress.completed_at)<now.getTime()-24*60*60*1000) return {ok:true,run:null};
    return {ok:true,run:progress};
  }
  return {ok:true,run:null,...(resolvedRunId ? {resolved_run_id:resolvedRunId} : {})};
}
