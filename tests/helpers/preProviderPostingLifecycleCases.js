import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
export async function preProviderPostingLifecycleCases({t,sql,splitFixture,scope,rpc,cat,staff,existingSchedule,decision,bind,lockIdentity}) {
 const lifecycleMigration=fs.readFileSync('supabase/migrations/20261124020000_pre_provider_posting_failure_lifecycle.sql','utf8');
 await t.test('pre-provider lifecycle migration is atomic, idempotent and preserves eligibility privileges',()=>{
  const properties=()=>sql("select to_jsonb(p)-'prosrc' from pg_proc p where oid='public.canonical_posting_eligibility(uuid,uuid,text,text)'::regprocedure");
  const before=properties();assert.throws(()=>sql(lifecycleMigration.replace("notify pgrst, 'reload schema';","select 1/0;notify pgrst, 'reload schema';")),/division by zero/);assert.equal(properties(),before);
  assert.equal(sql("select to_regprocedure('public.reject_posting_before_provider(uuid,uuid,text,jsonb,text)') is null"),'t');
  sql(lifecycleMigration);assert.equal(properties(),before);sql(lifecycleMigration);assert.equal(properties(),before);
  assert.equal(sql("select has_function_privilege('service_role','public.reject_posting_before_provider(uuid,uuid,text,jsonb,text)','execute') and not has_function_privilege('authenticated','public.reject_posting_before_provider(uuid,uuid,text,jsonb,text)','execute') and not has_function_privilege('anon','public.reject_posting_before_provider(uuid,uuid,text,jsonb,text)','execute')"),'t');
 });
 await t.test('unbound legacy schedule cannot execute; authorized binding preserves its exact deadline',()=>{
  const {id}=splitFixture();existingSchedule(id,'2001-11-23T22:56:28.607Z');const before=cat(id).post_after;
  assert.equal(decision(id,'worker').reason,'existing_schedule_binding_required');
  const actor=staff();assert.equal(bind(id,actor).outcome,'bound_existing_schedule');assert.equal(cat(id).post_after,before);assert.equal(decision(id,'worker').reason,null);
 });
 const rejectedClaim=()=>{
  const {id}=splitFixture();rpc(',p_enabled=>true');const {bid,account,realm}=scope();
  const lock=lockIdentity(id),request=randomUUID(),owner=randomUUID();
  const claim=JSON.parse(sql(`select public.claim_qbo_posting_intent('${bid}','${id}','${realm}','production','Purchase','${request}','synthetic-key')`));assert.equal(claim.claimed,true);
  sql(`update public.transaction_categorizations set meta=(meta-'posting_shape_binding')||'${JSON.stringify({posting_execution_owner:owner,posting_execution_request_id:request})}' where transaction_id='${id}'`);
  const context={...lock,owner,request_id:request,idempotency_key:'synthetic-key',business_id:bid,transaction_id:id,env:'production',realm_id:realm,claimed_at:claim.intent.processing_started_at,lease_expires_at:claim.intent.lease_expires_at,final_account_id:null,source_account_id:'source',plaid_account_id:account,date:'2026-11-01',amount:-517.55,manual:true,post_error:null};
  return {id,bid,context,reject:(extra={})=>JSON.parse(sql(`select public.reject_posting_before_provider('${bid}','${id}','production','${JSON.stringify({...context,...extra})}','posting_shape_changed')`))};
 };
 await t.test('technical rejection atomically closes job, intent, attempt and category and replays once',()=>{
  const f=rejectedClaim();assert.equal(f.reject().ok,true);const saved=cat(f.id);assert.equal(saved.status,'failed');assert.equal(saved.posting_status,'posting_failed');assert.equal(saved.post_after,null);assert.equal(saved.meta.posting_in_progress,false);
  assert.equal(sql(`select state||':'||coalesce(lease_expires_at::text,'none') from public.bookkeeping_posting_jobs where transaction_id='${f.id}'`),'failed:none');
  assert.equal(sql(`select status||':'||(response_summary->>'qbo_write_may_have_occurred') from public.qbo_posted_transactions where transaction_id='${f.id}'`),'failed:false');
  assert.equal(f.reject().idempotent,true);assert.equal(sql(`select count(*) from public.bookkeeping_post_attempts where transaction_id='${f.id}' and status='failed'`),'1');
  assert.throws(()=>f.reject({owner:randomUUID()}),/foreign_or_stale_posting_rejection/);
 });
 await t.test('rejection rolls all records back when final projection validation fails',()=>{
  const f=rejectedClaim();sql(`update public.transaction_categorizations set meta=meta||'{"post_retry_count":"invalid"}' where transaction_id='${f.id}'`);
  assert.throws(()=>f.reject(),/posting_rejection_job_not_finalized/);
  assert.equal(sql(`select status from public.qbo_posted_transactions where transaction_id='${f.id}'`),'processing');assert.equal(sql(`select count(*) from public.bookkeeping_post_attempts where transaction_id='${f.id}'`),'0');
 });
 await t.test('cross-business identity and provider evidence cannot finalize as a safe rejection',()=>{
  const f=rejectedClaim();assert.throws(()=>f.reject({business_id:randomUUID()}),/rejection_identity_required/);
  sql(`update public.qbo_posted_transactions set response_summary='{"qbo_write_may_have_occurred":true}' where transaction_id='${f.id}'`);
  assert.throws(()=>f.reject(),/provider_evidence_requires_reconciliation/);
  assert.equal(sql(`select status from public.qbo_posted_transactions where transaction_id='${f.id}'`),'processing');
 });
 await t.test('explicit same-claim expired failure reconciliation closes stale processing without scheduling or changing request identity',()=>{
  const f=rejectedClaim();
  sql(`insert into public.bookkeeping_post_attempts(business_id,transaction_id,status,error_message) values('${f.bid}','${f.id}','failed','posting_shape_changed');
   update public.transaction_categorizations set status='failed',post_error='posting_shape_changed',post_after=null,meta=meta||'{"posting_in_progress":false}' where transaction_id='${f.id}';
   update public.qbo_posted_transactions set lease_expires_at=statement_timestamp()-interval '1 second' where transaction_id='${f.id}'`);
  f.context.lease_expires_at=sql(`select lease_expires_at from public.qbo_posted_transactions where transaction_id='${f.id}'`);
  const request=f.context.request_id;assert.equal(f.reject().ok,true);assert.equal(cat(f.id).post_after,null);
  assert.equal(sql(`select request_id from public.qbo_posted_transactions where transaction_id='${f.id}'`),request);
  assert.equal(sql(`select state from public.bookkeeping_posting_jobs where transaction_id='${f.id}'`),'failed');
 });
}
