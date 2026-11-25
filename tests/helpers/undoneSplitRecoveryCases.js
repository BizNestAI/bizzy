import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const literal=value=>`'${String(value).replaceAll("'","''")}'`;
export function undoneSplitRecoveryFixture({sql,fixture,scope}) {
 const {id}=fixture(),{bid,actor}=scope(),owner=randomUUID(),request=`bizzi_${randomUUID().replaceAll('-','')}`,key=`original-${id}`;
 sql(`select public.acquire_posting_lock('${bid}','${id}',statement_timestamp(),600,'${key}');select public.claim_qbo_posting_intent('${bid}','${id}','${bid}','production','Purchase','${request}','${key}');
  update public.qbo_posted_transactions set processing_started_at=statement_timestamp()-interval '11 minutes',lease_expires_at=statement_timestamp()-interval '1 minute' where transaction_id='${id}';
  insert into public.bookkeeping_post_attempts(business_id,transaction_id,status,attempted_at,error_message,payload_summary)
   select '${bid}','${id}','failed',processing_started_at+interval '0.5 seconds','posting_shape_changed','{"categorization_status":"approved","final_qbo_account_id":null}' from public.qbo_posted_transactions where transaction_id='${id}';
  update public.transaction_categorizations set status='failed',post_error='posting_shape_changed',post_after=null,meta=(meta-'posting_shape_binding')||'{"posting_execution_owner":"${owner}","posting_execution_request_id":"${request}","posting_failure_code":"posting_shape_changed","posting_in_progress":false}' where transaction_id='${id}';
  -- Capture the historical Undo that predates the guarded split reset RPC.
  update public.transaction_categorizations set status='needs_review',post_error=null,post_after=null,final_qbo_account_id=null,final_qbo_account_name=null,decided_by='user',decided_at=statement_timestamp(),
   meta=meta||jsonb_build_object('review_reopen_authorized',true,'review_reopen_reason','approval_undone_by_user','posting_cancelled_at',statement_timestamp(),'posting_generation',gen_random_uuid()) where transaction_id='${id}';
  update public.bookkeeping_posting_jobs set lease_expires_at=(select lease_expires_at from public.qbo_posted_transactions where transaction_id='${id}') where transaction_id='${id}';`);
 const context=()=>JSON.parse(sql(`select jsonb_build_object('business_id',c.business_id,'transaction_id',c.transaction_id,'env',i.qbo_env,'realm_id',i.realm_id,'owner',c.meta->>'posting_execution_owner','request_id',i.request_id,'idempotency_key',i.idempotency_key,'generation',c.meta->>'posting_generation','claimed_at',i.processing_started_at,'lease_expires_at',i.lease_expires_at,'category_updated_at',c.updated_at,'review_reopened_at',c.review_reopened_at,'intent_id',i.id,'job_id',j.id,'attempt_id',a.id,'split_id',s.id,'split_lines_hash',encode(sha256(convert_to(s.lines::text,'UTF8')),'hex'))
  from public.transaction_categorizations c join public.qbo_posted_transactions i using(business_id,transaction_id) join public.bookkeeping_posting_jobs j using(business_id,transaction_id) join public.transaction_splits s using(business_id,transaction_id) join public.bookkeeping_post_attempts a using(business_id,transaction_id) where c.transaction_id='${id}' and s.status='confirmed' order by a.attempted_at limit 1`));
 const evidence={failure_stage:'initial_execution_guard',failure_code:'posting_shape_changed',no_provider_write_verified:true,
  worker_commit:'142ac885000f398384ffe82086769bb32b5c2853',worker_log_reference:'synthetic isolated initial-guard failure',operator_register_review:'synthetic no matching transaction',operator_audit_log_review:'synthetic no matching audit activity'};
 const args={businessId:bid,transactionId:id,actorId:actor,context:context(),evidence,key:`reconcile-${id}`};
 const command=(overrides={})=>{const p={...args,...overrides};return `select public.reconcile_undone_split_pre_provider(${literal(p.businessId)},${literal(p.transactionId)},${literal(p.actorId)},${literal(JSON.stringify(p.context))}::jsonb,${literal(JSON.stringify(p.evidence))}::jsonb,${literal(p.key)})`;};
 const snapshot=()=>sql(`select jsonb_build_object('c',(select to_jsonb(c) from public.transaction_categorizations c where transaction_id='${id}'),'i',(select to_jsonb(i) from public.qbo_posted_transactions i where transaction_id='${id}'),'j',(select to_jsonb(j) from public.bookkeeping_posting_jobs j where transaction_id='${id}'),'s',(select jsonb_agg(to_jsonb(s) order by id) from public.transaction_splits s where transaction_id='${id}'),'a',(select jsonb_agg(to_jsonb(a) order by id) from public.bookkeeping_post_attempts a where transaction_id='${id}'))`);
 return {id,bid,actor,args,context,command,snapshot};
}

export async function undoneSplitRecoveryCases({t,sql,fixture,scope}) {
 await t.test('undone split recovery rejects live claims, ambiguous evidence, foreign identity and unauthorized actors atomically',()=>{
  const f=undoneSplitRecoveryFixture({sql,fixture,scope});
  const denied=(overrides,pattern)=>{const before=f.snapshot();assert.throws(()=>sql(f.command(overrides)),pattern);assert.equal(f.snapshot(),before);};
  denied({actorId:randomUUID()},/internal_actor_not_authorized/);
  denied({businessId:randomUUID()},/evidence_required/);
  denied({context:{...f.args.context,request_id:'foreign'}},/foreign_or_stale/);
  denied({evidence:{...f.args.evidence,no_provider_write_verified:false}},/evidence_required/);
  sql(`update public.qbo_posted_transactions set lease_expires_at=statement_timestamp()+interval '1 minute' where transaction_id='${f.id}'`);
  denied({context:f.context()},/active_claim/);
  sql(`update public.qbo_posted_transactions set lease_expires_at=${literal(f.args.context.lease_expires_at)} where transaction_id='${f.id}';update public.bookkeeping_posting_jobs set lease_expires_at=statement_timestamp()+interval '1 minute' where transaction_id='${f.id}'`);
  denied({},/active_claim/);
  sql(`update public.bookkeeping_posting_jobs set lease_expires_at=${literal(f.args.context.lease_expires_at)} where transaction_id='${f.id}';update public.transaction_categorizations set meta=meta||'{"ambiguous_provider_outcome":true}' where transaction_id='${f.id}'`);
  denied({context:f.context()},/provider_evidence_requires_reconciliation/);
 });
 await t.test('recovery preserves the original attempt and identities, cancels leases and is idempotent with no schedule',()=>{
  const f=undoneSplitRecoveryFixture({sql,fixture,scope}),before=JSON.parse(f.snapshot());
  // Fail after the intent update and audit insertion; the entire operation rolls back.
  sql(`create function public.test_fail_recovery_job() returns trigger language plpgsql as $$ begin if new.lease_expires_at is null and old.lease_expires_at is not null then raise exception 'injected_recovery_failure';end if;return new;end $$;
   create trigger test_fail_recovery_job before update on public.bookkeeping_posting_jobs for each row execute function public.test_fail_recovery_job();`);
  assert.throws(()=>sql(f.command()),/injected_recovery_failure/);assert.deepEqual(JSON.parse(f.snapshot()),before);
  sql('drop trigger test_fail_recovery_job on public.bookkeeping_posting_jobs;drop function public.test_fail_recovery_job();');
  const result=JSON.parse(sql(f.command()));assert.equal(result.idempotent,false);
  const after=JSON.parse(f.snapshot());assert.equal(after.i.status,'failed');assert.equal(after.i.lease_expires_at,null);assert.equal(after.i.processing_started_at,null);
  for(const key of ['id','request_id','idempotency_key','attempt_count','qbo_txn_id','response','posted_at'])assert.deepEqual(after.i[key],before.i[key],key);
  assert.equal(after.j.state,'cancelled');for(const key of ['lease_owner','lease_expires_at','scheduled_at','next_attempt_at'])assert.equal(after.j[key],null,key);
  for(const key of ['status','review_status','posting_status','review_reopened_at','post_after','final_qbo_account_id'])assert.deepEqual(after.c[key],before.c[key],key);
  assert.deepEqual(after.s,before.s);assert.deepEqual(after.a.find(a=>a.id===before.a[0].id),before.a[0]);assert.equal(after.a.length,2);
  assert.equal(JSON.parse(sql(f.command())).idempotent,true);assert.deepEqual(JSON.parse(f.snapshot()),after);
  assert.throws(()=>sql(f.command({evidence:{...f.args.evidence,operator_register_review:'different'}})),/already_recorded/);
 });
}
