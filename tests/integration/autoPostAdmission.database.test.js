import { postingExecutionTaxonomyGuardCases } from "../helpers/postingExecutionTaxonomyGuardCases.js";
import { canonicalPostingShapeCases } from "../helpers/canonicalPostingShapeCases.js";
/* global process, Buffer */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { plaidDatabaseSchema } from "../helpers/plaidDatabaseSchema.js";
import { guardQboWrites, assertPostingExecutionIntegrity, postingAttemptEvidence, postingLockContext } from "../../src/services/bookkeeping/postingExecutionIntegrity.js";
import { testAdmissionRoutes } from "../helpers/autoPostAdmissionRoutes.js";
const name=`bizzi-admission-${process.pid}`;
const network=`${name}-net`;
const read=(f)=>fs.readFileSync(`supabase/migrations/${f}`,"utf8");
function sql(s) {
  const r=spawnSync("docker",["exec","-i",name,"psql","-U","postgres","-v","ON_ERROR_STOP=1","-At"],{input:s,encoding:"utf8",maxBuffer:16e6});
  assert.equal(r.status,0,r.stderr);return r.stdout.trim();
}
function concurrent(s) {return new Promise((resolve,reject)=>{const p=spawn("docker",["exec","-i",name,"psql","-U","postgres","-v","ON_ERROR_STOP=1","-At"]);let out="",err="";p.stdout.on("data",b=>out+=b);p.stderr.on("data",b=>err+=b);p.on("exit",code=>code?reject(new Error(err)):resolve(out.trim()));p.stdin.end(s);});}
let bid, account, item;
function fixture() {
 bid=randomUUID();account=randomUUID();item=randomUUID();
 sql(`insert into public.business_profiles(id,business_name,industry,team_size,state,services_offered) values('${bid}','Synthetic','Synthetic',1,'NC','Synthetic');
 insert into public.plaid_items(business_id,plaid_item_id,plaid_env,plaid_access_token,status) values('${bid}','${item}','production','synthetic','connected');
 insert into public.plaid_accounts(business_id,plaid_item_id,plaid_account_id,plaid_env,name) values('${bid}','${item}','${account}','production','Synthetic');
 insert into public.quickbooks_tokens(business_id,realm_id,qbo_env,status,is_active,access_token,refresh_token) values('${bid}','synthetic','production','active',true,'synthetic','synthetic');
 insert into public.qbo_accounts_cache(business_id,realm_id,qbo_env,qbo_account_id,name,account_type) values('${bid}','synthetic','production','source','Synthetic source','Bank'),('${bid}','synthetic','production','destination','Synthetic destination','Expense');
 insert into public.plaid_qbo_account_mappings(business_id,plaid_account_id,qbo_account_id,qbo_account_type,qbo_account_name) values('${bid}','${account}','source','Bank','Synthetic source');`);
}
function row({status='auto_approved',meta={},pending=false,date='2026-11-01',schedule=null}={}) {
 const id=randomUUID();sql(`insert into public.bank_transactions(id,business_id,plaid_item_id,plaid_account_id,plaid_transaction_id,plaid_env,name,date,amount,direction,pending) values('${id}','${bid}','${item}','${account}','${id}','production','Synthetic','${date}',-10,'OUTFLOW',${pending});
 insert into public.transaction_categorizations(business_id,transaction_id,status,final_qbo_account_id,meta,post_after) values('${bid}','${id}','${status}','destination','${JSON.stringify(meta)}',${schedule?`'${schedule}'`:'null'});`);return id;
}
const rpc=(more='')=>JSON.parse(sql(`select public.admit_handled_auto_post(p_business_id=>'${bid}'${more});`));
const cat=id=>JSON.parse(sql(`select to_jsonb(c) from public.transaction_categorizations c where business_id='${bid}' and transaction_id='${id}';`));
function lockIdentity(id) {
  assert.equal(sql(`select public.acquire_posting_lock('${bid}','${id}','${new Date().toISOString()}'::text,600,'synthetic-key');`),'t');
  return postingLockContext(cat(id).meta);
}

test('guarded Handled admission on real PostgreSQL', {timeout:180000},async t=>{
 try {
  const net=spawnSync('docker',['network','create','--internal',network],{encoding:'utf8'});assert.equal(net.status,0,net.stderr);
  const start=spawnSync('docker',['run','--pull=never','--network',network,'--name',name,'-e','POSTGRES_PASSWORD=local-only','-d','postgres:17'],{encoding:'utf8'});assert.equal(start.status,0,start.stderr);
  for(let i=0;i<100;i++){if(spawnSync('docker',['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres']).status===0)break;await new Promise(r=>setTimeout(r,100));}
  let schema=plaidDatabaseSchema();
  for(const [file,table] of [['20260827_canonical_chart_of_accounts.sql','qbo_accounts_cache'],['20260603_monthly_review_console.sql','monthly_review_runs'],['20260602_financial_monthly_review_stamps.sql','financial_monthly_review_stamps'],['20260920_accounting_period_close_authority.sql','accounting_period_closes']]) {
   const ddl=read(file).match(new RegExp(`create table if not exists public.${table} \\([\\s\\S]*?\\n\\);`,'i'));assert.ok(ddl,table);schema+='\n'+ddl[0];
  }
  schema+='\n'+read('20260823_add_bookkeeping_start_date.sql')+'\n'+read('20260921_auto_post_backlog_safety.sql')+'\n'+read('20260922_auto_post_scope_confirmation_rpc.sql');
  const runtime=read('20261101094000_reconcile_handled_posting_job_runtime_states.sql');schema+='\n'+runtime.slice(runtime.indexOf('create or replace function'),runtime.indexOf('alter function'));
  schema+='\n'+read('20260827_canonical_chart_of_accounts.sql').match(/alter table if exists public\.transaction_categorizations[\s\S]*?;/gi).join('\n');
  schema+='\n'+read('20260925_atomic_bookkeeping_approval.sql')+'\n'+read('20261013170000_settled_credit_card_inflow_approval.sql');
  schema+='\n'+read('20260517_acquire_posting_lock_rpc.sql');
  sql(schema);
  const beforeShape=sql("select count(*) from pg_trigger where not tgisinternal");
  sql(read('20261111220000_auto_post_handled_admission.sql'));
  assert.equal(sql("select count(*) from pg_trigger where not tgisinternal"),beforeShape);
  assert.equal(sql("select count(*) from information_schema.columns where table_schema='public' and column_name='auto_post_admission'"),'0');
  await t.test('dormant migration: old backend writes under existing On policy do not schedule',()=>{
    fixture();sql(`update public.business_profiles set auto_post_to_quickbooks=true where id='${bid}';`);
    const id=row({status:'needs_review'});sql(`update public.transaction_categorizations set status='auto_approved' where transaction_id='${id}';`);
    assert.equal(cat(id).post_after,null);assert.equal(cat(id).meta.auto_post_admission,undefined);
  });
  await t.test('canonical approval adapter preserves an existing deadline atomically',()=>{
    fixture();const id=row({schedule:'2099-01-01T00:00:00Z'});
    const approval={transaction_id:id,status:'approved',final_qbo_account_id:'destination',final_qbo_account_name:'Synthetic',approval_idempotency_key:'synthetic-approval',decided_at:new Date().toISOString(),updated_at:new Date().toISOString(),post_after:null,meta:{auto_post_admission:{version:2,state:'pending'}}};
    sql(`select count(*) from public.approve_bookkeeping_with_admission('${bid}',null,'system','${JSON.stringify([approval])}',false);`);
    assert.equal(Date.parse(cat(id).post_after),Date.parse('2099-01-01'));assert.equal(cat(id).meta.auto_post_admission,undefined);
  });
  await t.test('positive accounting authority, false confidence, Needs Review and ambiguous failed',()=>{
    fixture();const ids=['approved','auto_approved','handled','failed','needs_review'].map(status=>row({status,meta:{safe_to_auto_post:false}}));
    const result=rpc(',p_enabled=>true');assert.equal(result.scheduled,3);assert.equal(result.evaluated,3);
    for(const id of ids.slice(0,3)){assert.ok(cat(id).post_after);assert.equal(cat(id).meta.safe_to_auto_post,true);assert.equal(Date.parse(cat(id).post_after)-Date.parse(result.event_at),86400000);}
    assert.equal(cat(ids[3]).post_after,null);assert.equal(cat(ids[4]).post_after,null);
    assert.equal(cat(ids[2]).meta.auto_post_admission.recent[0].previous_status,'handled');
  });
  await t.test('failed rows never enter admission, including caller-forged history and previous Handled claims',()=>{
    fixture();const id=row({status:'approved'});sql(`update public.transaction_categorizations set status='failed' where transaction_id='${id}';`);
    const other=row({status:'failed',meta:{previous_legacy_status:'handled',previous_status:'approved',safe_to_auto_post:true}});
    sql(`update public.transaction_categorizations set decided_at=statement_timestamp() where transaction_id='${other}';
      set role service_role;insert into public.bookkeeping_lifecycle_events(business_id,transaction_id,new_review_status,new_posting_status,previous_legacy_status,new_legacy_status) values('${bid}','${other}','handled','posting_failed','approved','failed');reset role;`);
    assert.equal(rpc(',p_enabled=>true').scheduled,0);
    for(const failed of [id,other]) {
      const args=`,p_ids=>array['${failed}']::uuid[]`;
      assert.equal(rpc(args+',p_preview=>true').rows[0].reason,'failed_requires_existing_retry_workflow');
      assert.equal(rpc(args+`,p_source=>'handled'`).scheduled,0);
      const anchor=new Date().toISOString(),actor=randomUUID();
      const repair=args+`,p_source=>'repair',p_repair_anchor=>'${anchor}',p_actor=>'${actor}'`;
      const preview=rpc(repair+',p_preview=>true');
      assert.equal(rpc(repair+`,p_preview_hash=>'${preview.preview_hash}',p_preview_at=>'${preview.preview_at}'`).scheduled,0);
      assert.equal(cat(failed).post_after,null);
    }
    const approval={transaction_id:other,status:'failed',final_qbo_account_id:'destination',final_qbo_account_name:'Synthetic',approval_idempotency_key:'failed-cannot-schedule',decided_at:new Date().toISOString(),updated_at:new Date().toISOString(),post_after:'2099-01-01',meta:{auto_post_admission:{version:2,state:'pending'}}};
    sql(`select count(*) from public.approve_bookkeeping_with_admission('${bid}',null,'system','${JSON.stringify([approval])}',false);`);
    assert.equal(cat(other).post_after,null);assert.equal(cat(other).meta.auto_post_admission,undefined);
  });
  await t.test('mixed concrete technical blockers, valid schedules and stale evidence preservation',()=>{
    fixture();const good=row({meta:{safe_to_auto_post:false,decision:'keep'}});const pending=row({pending:true});const matched=row({meta:{matched_existing_qbo:true}});const duplicate=row({meta:{existing_qbo_match_confirmed:true}});const archived=row();const invalid=row();const period=row({date:'2026-09-01'});const unsupported=row({meta:{taxonomy_type:'refund'}});const intent=row();const held=row();const scheduled=row({schedule:'2099-01-01T00:00:00Z'});
    sql(`update public.transaction_categorizations set post_error='pending_transaction_not_postable',meta=meta||'{"post_block_reason":"low_classifier_confidence"}' where transaction_id='${good}';
      update public.bank_transactions set is_archived=true where id='${archived}';update public.transaction_categorizations set final_qbo_account_id='invalid' where transaction_id='${invalid}';
      insert into public.financial_monthly_review_stamps(business_id,review_month) values('${bid}','2026-09-01');
      insert into public.qbo_posted_transactions(business_id,transaction_id,qbo_env,qbo_txn_type,status) values('${bid}','${intent}','production','Purchase','unknown');`);
    const batch=randomUUID();sql(`insert into public.plaid_recovery_batches(id,business_id,plaid_env,plaid_item_id,cutoff_date,status,posting_hold) values('${batch}','${bid}','production','${item}','2026-01-01','preview_ready',true);update public.transaction_categorizations set posting_hold_batch_id='${batch}' where transaction_id='${held}';`);
    const result=rpc(',p_enabled=>true');assert.equal(result.scheduled,1);assert.equal(result.already_scheduled,1);for(const id of [pending,matched,duplicate,archived,invalid,period,unsupported,intent,held])assert.equal(cat(id).post_after,null);
    assert.equal(cat(good).meta.decision,'keep');assert.equal(cat(good).meta.auto_post_admission.recent[0].previous_error,'pending_transaction_not_postable');assert.equal(cat(good).post_error,null);assert.equal(Date.parse(cat(scheduled).post_after),Date.parse('2099-01-01'));
  });
  await t.test('concurrent enables share immutable timestamp and never extend existing schedules',async()=>{
    fixture();const id=row();const business=bid;
    const all=await Promise.all([concurrent(`select public.admit_handled_auto_post('${business}',true);`),concurrent(`select public.admit_handled_auto_post('${business}',true);`)]);
    assert.equal(JSON.parse(all[0]).event_at,JSON.parse(all[1]).event_at);const deadline=cat(id).post_after;assert.equal(rpc(',p_enabled=>true').scheduled,0);assert.equal(cat(id).post_after,deadline);
  });
  await t.test('policy + every evaluated mutation roll back on a later-row failure',()=>{
    fixture();const ids=[row(),row()].sort();sql(`create function public.fail_narrow_fixture() returns trigger language plpgsql as $$ begin if new.transaction_id='${ids[1]}' and new.post_after is not null then raise exception 'synthetic';end if;return new;end $$;create trigger zz_fail_narrow before update on public.transaction_categorizations for each row execute function public.fail_narrow_fixture();`);
    assert.throws(()=>rpc(',p_enabled=>true'));assert.equal(sql(`select auto_post_to_quickbooks from public.business_profiles where id='${bid}';`),'f');for(const id of ids)assert.equal(cat(id).post_after,null);
    sql('drop trigger zz_fail_narrow on public.transaction_categorizations;drop function public.fail_narrow_fixture();');assert.equal(rpc(',p_enabled=>true').scheduled,2);
  });
  await t.test('read-only, bounded, exact repair manifest; cross-business rejection and replay',()=>{
    fixture();const business=bid;const id=row();sql(`update public.business_profiles set auto_post_to_quickbooks=true,auto_post_enabled_at='2026-11-01' where id='${bid}';`);
    const actor=randomUUID(),anchor=new Date().toISOString();const args=`,p_source=>'repair',p_ids=>array['${id}']::uuid[],p_repair_anchor=>'${anchor}',p_actor=>'${actor}'`;
    const preview=rpc(args+',p_preview=>true');assert.equal(cat(id).post_after,null);
    sql(`begin read only;select public.admit_handled_auto_post(p_business_id=>'${bid}',p_preview=>true,p_source=>'repair',p_ids=>array['${id}']::uuid[],p_repair_anchor=>'${anchor}',p_actor=>'${actor}');rollback;`);
    assert.throws(()=>rpc(args+`,p_preview_hash=>'bad',p_preview_at=>'${preview.preview_at}'`));
    assert.throws(()=>rpc(args+`,p_preview_hash=>'${preview.preview_hash}',p_preview_at=>'2026-01-01'`));
    const result=rpc(args+`,p_preview_hash=>'${preview.preview_hash}',p_preview_at=>'${preview.preview_at}'`);assert.equal(result.scheduled,1);const deadline=cat(id).post_after;assert.equal(Date.parse(deadline)-Date.parse(anchor),86400000);
    assert.equal(rpc(args+`,p_preview_hash=>'${preview.preview_hash}',p_preview_at=>'${preview.preview_at}'`).already_scheduled,1);assert.equal(cat(id).post_after,deadline);
    fixture();const foreign=row();bid=business;assert.throws(()=>rpc(`,p_preview=>true,p_ids=>array['${id}','${foreign}']::uuid[],p_source=>'repair',p_repair_anchor=>'${anchor}',p_actor=>'${actor}'`));
  });
  await t.test('single-RPC effective date confirmation is atomic and respects cutoff',()=>{
    fixture();const id=row();const actor=randomUUID();const args=`,p_ids=>array['${id}']::uuid[],p_effective_date=>'2026-10-01',p_actor=>'${actor}'`;
    const preview=rpc(args+',p_preview=>true');const result=rpc(args+`,p_enabled=>true,p_preview_hash=>'${preview.preview_hash}',p_preview_at=>'${preview.preview_at}'`);
    assert.equal(result.scheduled,1);assert.equal(sql(`select auto_post_effective_date from public.business_profiles where id='${bid}';`),'2026-10-01');
  });
  await t.test('Off roundtrip preserves schedules; 100 cycles and repeated evidence stay bounded',()=>{
    fixture();const id=row();const result=rpc(',p_enabled=>true');const deadline=cat(id).post_after;
    sql(`do $$ begin for j in 1..100 loop perform public.admit_handled_auto_post('${bid}',false);perform public.admit_handled_auto_post('${bid}',true);end loop;end $$;`);
    assert.equal(cat(id).post_after,deadline);
    sql(`do $$ begin for j in 1..150 loop update public.transaction_categorizations set meta=public.auto_post_admission_meta(meta,jsonb_build_object('state','retry','source','handled','at',clock_timestamp(),'reason','technical_recheck_unavailable')) where transaction_id='${id}';end loop;end $$;`);
    const owned=cat(id).meta.auto_post_admission;assert.equal(owned.recent.length,4);assert.ok(owned.older_compacted>=146);assert.ok(Buffer.byteLength(JSON.stringify(owned))<=4096);assert.ok(result.event_at);
  });
  await t.test('narrow pending-to-posted enrollment uses explicit IDs, no bank trigger',()=>{
    fixture();const id=row({pending:true});rpc(',p_enabled=>true');assert.equal(cat(id).post_after,null);
    sql(`update public.bank_transactions set pending=false where id='${id}';`);assert.equal(cat(id).post_after,null);
    assert.equal(rpc(`,p_source=>'settled',p_ids=>array['${id}']::uuid[]`).scheduled,1);
  });
  await t.test('execution rejects foreign/stale leases, then rechecks mapping, hold, period and receipt',()=>{
    fixture();const id=row();rpc(',p_enabled=>true');const owner=randomUUID();
    sql(`insert into public.qbo_posted_transactions(business_id,transaction_id,qbo_env,qbo_txn_type,status,request_id,idempotency_key,realm_id,processing_started_at,lease_expires_at) values('${bid}','${id}','production','Purchase','processing','synthetic-request','synthetic-key','synthetic',statement_timestamp(),statement_timestamp()+interval '10 minutes');update public.transaction_categorizations set meta=meta||'{"posting_execution_owner":"${owner}","posting_execution_request_id":"synthetic-request"}' where transaction_id='${id}';`);
    const lease=JSON.parse(sql(`select jsonb_build_object('claimed_at',processing_started_at,'lease_expires_at',lease_expires_at) from public.qbo_posted_transactions where transaction_id='${id}';`));
    const context={...lease,...lockIdentity(id),business_id:bid,transaction_id:id,env:'production',owner,request_id:'synthetic-request',idempotency_key:'synthetic-key',realm_id:'synthetic',final_account_id:'destination',source_account_id:'source',plaid_account_id:account,date:'2026-11-01',amount:-10,manual:false};
    const check=(ctx=context)=>sql(`select coalesce(public.check_auto_post_technical_integrity('${bid}','${id}','production','${JSON.stringify(ctx)}'),'NONE');`);
    assert.equal(check(),'NONE');assert.equal(check({...context,owner:'foreign'}),'foreign_or_stale_posting_lease');assert.equal(check({...context,claimed_at:'2026-01-01'}),'foreign_or_stale_posting_lease');
    sql(`update public.qbo_accounts_cache set active=false where business_id='${bid}' and qbo_account_id='destination';`);assert.equal(check(),'invalid_final_qbo_account');sql(`update public.qbo_accounts_cache set active=true where business_id='${bid}';`);
    sql(`insert into public.financial_monthly_review_stamps(business_id,review_month) values('${bid}','2026-11-01');`);assert.equal(check(),'accounting_period_locked');sql(`delete from public.financial_monthly_review_stamps where business_id='${bid}';`);
    const batch=randomUUID();sql(`insert into public.plaid_recovery_batches(id,business_id,plaid_env,plaid_item_id,cutoff_date,status,posting_hold) values('${batch}','${bid}','production','${item}','2026-01-01','preview_ready',true);update public.transaction_categorizations set posting_hold_batch_id='${batch}' where transaction_id='${id}';`);assert.equal(check(),'recovery_posting_hold');sql(`update public.plaid_recovery_batches set posting_hold=false where id='${batch}';`);
    sql(`update public.qbo_posted_transactions set qbo_txn_id='synthetic-receipt',status='posted' where transaction_id='${id}';`);assert.equal(check(),'foreign_or_stale_posting_lease');
  });
  await t.test('claim -> current attempted evidence -> final gate -> stub write -> durable success; replaced identities fail closed',async()=>{
    fixture();const id=row({meta:{posting_generation:'generation-1'}});rpc(',p_enabled=>true');
    const lock=lockIdentity(id),owner=randomUUID();
    const claim=JSON.parse(sql(`select public.claim_qbo_posting_intent('${bid}','${id}','synthetic','production','Purchase','synthetic-request','synthetic-key');`));
    assert.equal(claim.claimed,true);
    sql(`update public.transaction_categorizations set meta=meta||'${JSON.stringify({posting_execution_owner:owner,posting_execution_request_id:'synthetic-request'})}' where transaction_id='${id}';`);
    const context={...lock,business_id:bid,transaction_id:id,env:'production',owner,request_id:'synthetic-request',idempotency_key:'synthetic-key',
      claimed_at:claim.intent.processing_started_at,lease_expires_at:claim.intent.lease_expires_at,realm_id:'synthetic',
      final_account_id:'destination',source_account_id:'source',plaid_account_id:account,date:'2026-11-01',amount:-10,manual:false,post_error:null};
    const attempt=postingAttemptEvidence(context,Date.parse(context.claimed_at)-1000);
    assert.ok(Date.parse(attempt.attemptedAt)>=Date.parse(context.claimed_at));
    sql(`insert into public.bookkeeping_post_attempts(business_id,transaction_id,status,attempted_at,payload_summary) values('${bid}','${id}','attempted','${attempt.attemptedAt}','${JSON.stringify(attempt.payloadSummary)}');`);
    const db={rpc:async(_name,args)=>({data:sql(`select coalesce(public.check_auto_post_technical_integrity('${args.p_business_id}','${args.p_transaction_id}','${args.p_env}','${JSON.stringify(args.p_context)}'),'');`)||null})};
    const check=ctx=>assertPostingExecutionIntegrity({db,businessId:bid,transactionId:id,env:'production',context:ctx});
    await check(context);
    for(const patch of [{owner:'foreign'},{request_id:'foreign'},{business_id:randomUUID()},{transaction_id:randomUUID()},{env:'sandbox'},{realm_id:'foreign'},{claimed_at:'2026-01-01'}])await assert.rejects(check({...context,...patch}));
    let writes=0;const qbo=guardQboWrites({createPurchase:async()=>{writes++;return {id:'stub-receipt'};}},()=>check(context));
    for(const foreign of [{...attempt.payloadSummary,posting_execution_owner:'foreign'},{...attempt.payloadSummary,posting_request_id:'foreign'}]) {
      const attemptId=sql(`insert into public.bookkeeping_post_attempts(business_id,transaction_id,status,attempted_at,payload_summary) values('${bid}','${id}','attempted','${attempt.attemptedAt}','${JSON.stringify(foreign)}') returning id;`).split('\n')[0];
      await assert.rejects(qbo.createPurchase({}));assert.equal(writes,0);
      sql(`delete from public.bookkeeping_post_attempts where id='${attemptId}';`);
    }
    // Change after preflight, immediately before the guarded financial boundary.
    for(const patch of [{posting_cancelled_at:new Date().toISOString()},{posting_generation:'generation-2'},{posting_started_at:'2026-01-01'},{posting_in_progress:false}]) {
      const before=cat(id).meta;
      sql(`update public.transaction_categorizations set meta=meta||'${JSON.stringify(patch)}' where transaction_id='${id}';`);
      await assert.rejects(qbo.createPurchase({}));assert.equal(writes,0);
      sql(`update public.transaction_categorizations set meta='${JSON.stringify(before)}' where transaction_id='${id}';`);
    }
    for(const column of ['processing_started_at','lease_expires_at']) {
      sql(`update public.qbo_posted_transactions set ${column}='2026-01-01' where transaction_id='${id}';`);
      await assert.rejects(qbo.createPurchase({}));assert.equal(writes,0);
      sql(`update public.qbo_posted_transactions set ${column}='${column==='processing_started_at'?context.claimed_at:context.lease_expires_at}' where transaction_id='${id}';`);
    }
    // Even the same owner's unresolved older attempt cannot be reused.
    sql(`insert into public.bookkeeping_post_attempts(business_id,transaction_id,status,attempted_at,payload_summary) values('${bid}','${id}','attempted','2026-01-01','${JSON.stringify(attempt.payloadSummary)}');`);
    await assert.rejects(qbo.createPurchase({}));assert.equal(writes,0);
    sql(`delete from public.bookkeeping_post_attempts where transaction_id='${id}' and attempted_at='2026-01-01';`);
    const oldAttempt={...attempt.payloadSummary,posting_execution_owner:'old-owner',posting_claimed_at:'2026-01-01T00:00:00Z'};
    const rejection={...oldAttempt,qbo_write_may_have_occurred:false,rejected_at:'2026-01-01T00:00:01Z'};
    sql(`insert into public.bookkeeping_post_attempts(business_id,transaction_id,status,attempted_at,payload_summary) values('${bid}','${id}','attempted','2026-01-01','${JSON.stringify(oldAttempt)}');
      insert into public.bookkeeping_post_attempts(business_id,transaction_id,status,attempted_at) values('${bid}','${id}','failed','2026-01-01T00:00:01Z');
      update public.qbo_posted_transactions set response_summary='${JSON.stringify(rejection)}' where transaction_id='${id}';`);
    await check(context); // a conclusively closed prior attempt is not reused
    sql(`update public.bookkeeping_post_attempts set payload_summary=payload_summary||'{"posting_claimed_at":"2026-01-01T00:00:02Z"}' where transaction_id='${id}' and attempted_at='2026-01-01';`);
    await assert.rejects(qbo.createPurchase({}));assert.equal(writes,0); // stale rejection cannot clear a newer ambiguous claim
    sql(`update public.bookkeeping_post_attempts set payload_summary='${JSON.stringify(oldAttempt)}' where transaction_id='${id}' and attempted_at='2026-01-01';`);
    // Current failed rows are never admitted, but an already-owned existing
    // retry retains its execution contract and is not sent back to admission.
    sql(`update public.transaction_categorizations set status='failed' where transaction_id='${id}';`);
    await check(context);
    const result=await qbo.createPurchase({});assert.equal(writes,1);
    sql(`update public.qbo_posted_transactions set status='posted',qbo_txn_id='${result.id}',posted_at=statement_timestamp() where transaction_id='${id}';
      update public.transaction_categorizations set status='posted',qbo_txn_id='${result.id}',posted_at=statement_timestamp() where transaction_id='${id}';`);
    assert.equal(cat(id).qbo_txn_id,'stub-receipt');await assert.rejects(qbo.createPurchase({}));assert.equal(writes,1);
  });
  await t.test('specialized pair execution validates both legs and the exact current pair lease',async()=>{
    fixture();const a=row(),b=row(),pair=randomUUID(),owner=randomUUID();rpc(',p_enabled=>true');
    sql(`insert into public.credit_card_payment_pairs(id,business_id,checking_transaction_id,credit_card_transaction_id,checking_plaid_account_id,credit_card_plaid_account_id,checking_qbo_account_id,credit_card_qbo_account_id,amount,payment_date,status,request_id,idempotency_key,posting_started_at,lease_expires_at) values('${pair}','${bid}','${a}','${b}','${account}','${account}','source','source',10,'2026-11-01','posting','pair-request','pair-key',statement_timestamp(),statement_timestamp()+interval '10 minutes');
    update public.transaction_categorizations set meta=meta||'{"taxonomy_type":"cc_payment","cc_payment_pair_id":"${pair}","posting_execution_owner":"${owner}","posting_execution_request_id":"pair-request"}' where transaction_id in ('${a}','${b}');`);
    const lease=JSON.parse(sql(`select jsonb_build_object('claimed_at',posting_started_at,'lease_expires_at',lease_expires_at) from public.credit_card_payment_pairs where id='${pair}'`));
    const ctx={...lease,business_id:bid,transaction_id:a,env:'production',pair_id:pair,owner,request_id:'pair-request',idempotency_key:'pair-key',realm_id:'synthetic',from_account_id:'source',to_account_id:'source',pair_amount:10,pair_date:'2026-11-01',legs:[a,b].map(id=>({id,...lockIdentity(id),plaid_account_id:account,date:'2026-11-01',amount:-10}))};
    const check=(context=ctx)=>sql(`select coalesce(public.check_auto_post_technical_integrity('${bid}','${a}','production','${JSON.stringify(context)}'),'NONE')`);
    assert.equal(check(),'NONE');assert.equal(check({...ctx,owner:'foreign'}),'foreign_or_stale_posting_lease');
    let writes=0;const qbo=guardQboWrites({createTransfer:async()=>{writes++;}},async()=>{assert.equal(check(),'NONE');});
    for(const patch of [{posting_cancelled_at:new Date().toISOString()},{posting_generation:'changed-after-preflight'}]) {
      const before=cat(b).meta;sql(`update public.transaction_categorizations set meta=meta||'${JSON.stringify(patch)}' where transaction_id='${b}';`);
      await assert.rejects(qbo.createTransfer({}));assert.equal(writes,0);
      sql(`update public.transaction_categorizations set meta='${JSON.stringify(before)}' where transaction_id='${b}';`);
    }
    sql(`update public.bank_transactions set pending=true where id='${b}'`);assert.equal(check(),'pending_transaction_not_postable');
    sql(`update public.bank_transactions set pending=false,amount=-11 where id='${b}'`);assert.equal(check(),'posting_payload_changed');
  });
  await t.test('ordinary writers are not fenced; changed state fails execution; future schedules not due',async()=>{
    fixture();row();const business=bid;
    await Promise.all([concurrent(`select public.admit_handled_auto_post('${business}',true);`),concurrent(`update public.qbo_accounts_cache set active=false where business_id='${business}' and qbo_account_id='destination';`)]);
    assert.equal(sql(`select count(*) from public.transaction_categorizations where business_id='${bid}' and post_after<=now();`),'0');
    assert.equal(sql("select count(*) from pg_trigger where tgname='aa_auto_post_admission_fence'"),'0');
  });
  await t.test('query cost / real-volume measurement and strict row cap',()=>{
    fixture();sql(`with bank as(insert into public.bank_transactions(business_id,plaid_item_id,plaid_account_id,plaid_transaction_id,plaid_env,name,date,amount,direction,pending) select '${bid}','${item}','${account}',gen_random_uuid()::text,'production','Synthetic','2026-11-01',-10,'OUTFLOW',false from generate_series(1,2000) returning id) insert into public.transaction_categorizations(business_id,transaction_id,status,final_qbo_account_id) select '${bid}',id,'auto_approved','destination' from bank;`);
    const begin=performance.now();const result=rpc(',p_enabled=>true');console.log('NARROW_BENCHMARK',JSON.stringify({rows:2000,ms:performance.now()-begin,scheduled:result.scheduled}));assert.equal(result.scheduled,2000);
    fixture();for(let j=0;j<3;j++)row();const overflow=rpc(',p_enabled=>true,p_limit=>2');assert.equal(overflow.error,'backlog_limit_exceeded');assert.equal(sql(`select auto_post_to_quickbooks from public.business_profiles where id='${bid}';`),'f');assert.throws(()=>rpc(',p_enabled=>true,p_limit=>null'));
  });
  await t.test('private helpers and customer RPC grants remain denied',()=>{
    assert.equal(sql("select bool_and(not has_function_privilege('anon',p.oid,'EXECUTE')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('auto_post_technical_block','auto_post_admission_meta','admit_handled_auto_post','check_auto_post_technical_integrity')"),'t');
    assert.equal(sql("select has_function_privilege('service_role','public.auto_post_admission_meta(jsonb,jsonb)','EXECUTE')"),'f');
  });
  await t.test('local client, scope routes and authorized Admin View preview/repair use the real database',async()=>{
    fixture();const businessId=bid,transactionId=row();row({status:'failed'});fixture();const foreignBusinessId=bid,foreignId=row();
    await testAdmissionRoutes({sql,businessId,transactionId,foreignBusinessId,foreignId,container:name,network});
  });
  sql('grant select on public.qbo_accounts_cache to service_role');
  sql(read('20261101106000_monthly_review_posting_eligibility_rechecks.sql'));
  sql(read('20261014_transaction_split_workflow.sql'));
  // Model the installed later-migration wrappers and settings, rather than
  // letting the new migration replace an older unwrapped function body.
  sql(`create function public.canonical_test_existing_fence() returns void language plpgsql as $$ begin if current_setting('test.reject_fence',true)='yes' then raise exception 'existing_fence_preserved'; end if; end $$;
   do $$ declare o oid; def text; body text; begin
    o:='public.admit_handled_auto_post(uuid,boolean,numeric,integer,boolean,uuid[],text,timestamptz,text,timestamptz,uuid,date,text)'::regprocedure;
    select pg_get_functiondef(o),prosrc into def,body from pg_proc where oid=o;
    execute replace(def,body,replace(body,E'begin\n if p_business_id',E'begin\n perform public.canonical_test_existing_fence();\n if p_business_id'));
   end $$;
   alter function public.auto_post_technical_block(public.transaction_categorizations,text,jsonb,date) set lock_timeout='2s';`);
  sql(read('20261123230000_canonical_posting_shape_authority.sql'));
  await t.test('forward migration retains installed function fences and configuration',()=>{
    assert.equal(sql("select 'lock_timeout=2s'=any(proconfig) from pg_proc where oid='public.auto_post_technical_block(public.transaction_categorizations,text,jsonb,date)'::regprocedure"),'t');
    fixture();row();assert.throws(()=>sql(`set test.reject_fence='yes';select public.admit_handled_auto_post('${bid}',true);`),/existing_fence_preserved/);
  });
  sql(read('20261124000000_restore_posting_execution_taxonomy_guard.sql'));
  const canonicalOptions={t,sql,fixture,row,rpc,cat,concurrent,lockIdentity,container:name,network,scope:()=>({bid,account,item})};
  await postingExecutionTaxonomyGuardCases(canonicalOptions);
  await canonicalPostingShapeCases(canonicalOptions);
 }finally {spawnSync('docker',['rm','-f',`${name}-api`,name]);spawnSync('docker',['network','rm',network]);}
});
