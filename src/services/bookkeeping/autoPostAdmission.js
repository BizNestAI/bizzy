/* global process */
export const HANDLED_ADMISSION_VERSION = 2;
export const MAX_ADMISSION_ROWS = 2000;
const AUTHORIZED = new Set(["approved", "auto_approved", "handled"]);
const envName = () => process.env.QB_ENVIRONMENT || "production";
const ascii = (v, max) => /^[a-zA-Z0-9_:.+\-TZ ]*$/.test(String(v || "")) ? String(v || "").slice(0, max) : "";

// Own namespace only: <=4 recent entries, <=4096 UTF8 bytes. No raw messages.
export function boundedAdmissionMeta(meta = {}, entry = {}) {
  const old = meta.auto_post_admission || {};
  const clean = (e) => ({ state: ["pending", "retry", "blocked", "scheduled"].includes(e.state) ? e.state : "blocked", source: ascii(e.source,24), at: ascii(e.at,40), reason: ascii(e.reason,80) });
  const value = clean(entry);
  const recent = [...(Array.isArray(old.recent) ? old.recent.slice(-3).map(clean) : []), value];
  const total = Math.min(2147483647, Math.max(0, Number.isSafeInteger(old.total) ? old.total : 0) + 1);
  const owned = { ...value, version: HANDLED_ADMISSION_VERSION, recent, total, older_compacted: Math.max(0,total-recent.length) };
  if (new TextEncoder().encode(JSON.stringify(owned)).length > 4096) throw new Error("admission_evidence_budget_exceeded");
  return { ...meta, auto_post_admission: owned };
}

// Only canonical NEW decisions use this marker. The periodic fallback must not
// enroll old unmarked production backlog. Specialized workflows retain theirs.
export function prepareHandledAdmissionRow(row, now = new Date().toISOString()) {
  if (!AUTHORIZED.has(row?.status) || !row.final_qbo_account_id || row.qbo_txn_id || row.posted_at || row.meta?.taxonomy_type || row.meta?.cc_payment_pair_id) return row;
  return { ...row, post_after: null, meta: boundedAdmissionMeta(row.meta, { state: "pending", source: "handled", at: now }) };
}

function withDeadline(query, timeoutMs) {
  return typeof query.abortSignal === "function" ? query.abortSignal(AbortSignal.timeout(timeoutMs)) : query;
}

export async function admitHandledAutoPost({ db, businessId, enabled = null, graceHours = 24, limit = MAX_ADMISSION_ROWS, preview = false, transactionIds = null, previewHash = null, repairAnchor = null, previewAt = null, actorId = null, effectiveDate = null, source = "enable", timeoutMs = 10000 } = {}) {
  const args = { p_business_id:businessId,p_enabled:enabled,p_grace_hours:graceHours,p_limit:limit,p_preview:preview,p_ids:transactionIds,
    p_preview_hash:previewHash,p_repair_anchor:repairAnchor,p_env:envName(),p_preview_at:previewAt,p_actor:actorId,p_effective_date:effectiveDate,p_source:source };
  const deadline=Date.now()+timeoutMs;
  const remaining=()=>Math.max(1,deadline-Date.now());
  let failure;
  for (let attempt=0;attempt<3;attempt++) {
    try {
      const {data,error} = await withDeadline(db.rpc("admit_handled_auto_post",args),remaining());
      if (!error) return data;
      failure=error;
      if (!["40001","40P01"].includes(error.code)||Date.now()>=deadline) break;
    } catch { failure={code:"transport"};break; }
  }
  // Policy may already be On (new Handled activity), but failed atomic enable
  // cannot have committed. Re-read rather than reporting a guessed toggle.
  let enabledNow=null;
  let policy={};
  try { if(Date.now()>=deadline)throw new Error("deadline");const r=await withDeadline(db.from("business_profiles").select("auto_post_to_quickbooks,auto_post_enabled_at,auto_post_effective_date,auto_post_scope_mode").eq("id",businessId).maybeSingle(),remaining());if(!r.error){policy=r.data||{};enabledNow=policy.auto_post_to_quickbooks??null;} } catch { /* unavailable is explicit */ }
  const validation = ["cross_business_or_unknown_ids","invalid_admission_ids","invalid_admission_parameters","approved_repair_anchor_required","stale_or_changed_admission_preview","repair_anchor_requires_fresh_approval"].includes(failure?.message);
  return {...policy,ok:false,enabled:enabledNow,auto_post_to_quickbooks:enabledNow,state:validation?"terminal":"retry",error:validation?failure.message:"auto_post_admission_needs_retry",sqlstate:/^[A-Z0-9]{5}$/.test(failure?.code||"")?failure.code:null,retryable_failure_count:validation?0:1,scheduled:0,evaluated:0};
}

async function markAdmissionRetry(db,businessId,ids) {
  // Best effort, bounded CAS. The already committed pending marker is retained
  // even when storage is unavailable; never rewrite decisions or schedules.
  try {
    const {data,error}=await db.from("transaction_categorizations").select("transaction_id,meta,updated_at").eq("business_id",businessId).in("transaction_id",ids).is("post_after",null);
    if(error)return;
    for(const row of data||[]) {
      if(row.meta?.auto_post_admission?.version!==2||!["pending","retry"].includes(row.meta.auto_post_admission.state))continue;
      await db.from("transaction_categorizations").update({meta:boundedAdmissionMeta(row.meta,{state:"retry",source:"handled",at:new Date().toISOString(),reason:"admission_rpc_unavailable"})})
        .eq("business_id",businessId).eq("transaction_id",row.transaction_id).eq("updated_at",row.updated_at).is("post_after",null);
    }
  } catch { /* durable pending evidence survives this unavailable diagnostic write */ }
}

export async function admitNewHandledRows({db,businessId,rows,source="handled"}) {
  const ids=rows.filter(r=>AUTHORIZED.has(r.status)&&r.meta?.auto_post_admission?.version===HANDLED_ADMISSION_VERSION).map(r=>r.transaction_id);
  if(!ids.length)return null;
  const result=await admitHandledAutoPost({db,businessId,transactionIds:ids,source,graceHours:Number(process.env.BOOKS_POST_GRACE_HOURS||24)});
  if(result?.state==="retry")await markAdmissionRetry(db,businessId,ids);
  return result;
}

// Existing posting jobs are the durable fallback. Run AFTER normal due posting.
// At most 100 enrolled rows / two businesses / three seconds per sweep.
export async function continueAutoPostAdmissions(db,{budgetMs=3000,clock=Date.now}={}) {
  const deadline=clock()+budgetMs;
  try {
    const query=db.from("transaction_categorizations").select("transaction_id,business_id,meta,business_profiles!inner(auto_post_to_quickbooks)")
      .eq("business_profiles.auto_post_to_quickbooks",true).is("post_after",null).in("meta->auto_post_admission->>state",["pending","retry"]).order("updated_at",{ascending:true}).limit(100);
    const {data,error}=await withDeadline(query,Math.max(1,deadline-clock()));
    if(error)return [{ok:false,state:"retry"}];
    const groups=new Map();
    for(const row of data||[]){if(row.meta?.auto_post_admission?.version!==2)continue;if(!groups.has(row.business_id))groups.set(row.business_id,[]);groups.get(row.business_id).push(row.transaction_id);}
    const results=[];
    for(const [businessId,ids] of [...groups].slice(0,2)) {
      if(clock()>=deadline)break;
      results.push(await admitHandledAutoPost({db,businessId,transactionIds:ids,source:"handled",graceHours:Number(process.env.BOOKS_POST_GRACE_HOURS||24),timeoutMs:Math.max(1,deadline-clock())}));
    }
    return results;
  } catch { return [{ok:false,state:"retry"}]; }
}

export async function getAutoPostAdmissionState(db,businessId) {
  const {data,error,count}=await db.from("transaction_categorizations").select("meta",{count:"exact"}).eq("business_id",businessId).is("post_after",null)
    .in("meta->auto_post_admission->>state",["pending","retry"]).limit(100);
  if(error)return {state:"retry",pending_count:null};
  return {state:(count??data?.length??0)>0?((data||[]).some(r=>r.meta?.auto_post_admission?.state==="retry")?"retry":"pending"):"complete",pending_count:count??data?.length??0};
}

// Called only for identities observed settling in the canonical Plaid merge.
// Registration precedes the existing sync checkpoint, so a later RPC failure
// cannot strand the work. No table-wide pending transition trigger is needed.
export async function registerSettledHandledAdmissions({db,businessId,transactionIds}) {
  const ids=[...new Set(transactionIds)];if(ids.length>2000)throw new Error("bounded_settlement_ids_required");if(!ids.length)return;
  const {data,error}=await db.from("transaction_categorizations").select("transaction_id,status,final_qbo_account_id,meta,updated_at,qbo_txn_id,posted_at")
    .eq("business_id",businessId).in("transaction_id",ids).in("status",["approved","auto_approved","handled"]).is("post_after",null);
  if(error)throw error;
  for(const row of data||[]) {
    if(row.meta?.auto_post_admission?.version===2&&row.meta.auto_post_admission.state==="scheduled")continue;
    const next=prepareHandledAdmissionRow(row);
    if(next===row)continue;
    const result=await db.from("transaction_categorizations").update({meta:next.meta}).eq("business_id",businessId).eq("transaction_id",row.transaction_id)
      .eq("updated_at",row.updated_at).is("post_after",null).is("qbo_txn_id",null);
    if(result.error)throw result.error;
  }
}
