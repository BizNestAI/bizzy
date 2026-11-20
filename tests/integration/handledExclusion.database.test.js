import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stalePendingResolutionDatabaseSchema } from "../helpers/stalePendingResolutionDatabaseSchema.js";

const container=`bizzi-handled-exclusion-${globalThis.process.pid}`;
function docker(args,input) { const r=spawnSync('docker',args,{input,encoding:'utf8',maxBuffer:32e6});if(r.status!==0)throw Error(r.stderr);return r.stdout.trim(); }
function sql(s,user='postgres') { return docker(['exec','-i',container,'psql','-h','127.0.0.1','-U',user,'-d','postgres','-v','ON_ERROR_STOP=1','-Atq'],s); }
function concurrent(s) { const p=spawn('docker',['exec','-i',container,'psql','-h','127.0.0.1','-U','postgres','-v','ON_ERROR_STOP=1','-Atq']);let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.stdin.end(s);return new Promise((resolve,reject)=>p.on('close',code=>code?reject(Error(err)):resolve(out.trim()))); }
const migration=fs.readFileSync('supabase/migrations/20261120233000_handled_exclusion_posting_safety.sql','utf8');
function fixture() {
 const business=randomUUID(),id=randomUUID(),physical=randomUUID(),key=randomUUID();
 sql(`insert into public.business_profiles(id,business_name,industry,team_size,state,services_offered) values('${business}','Synthetic','Synthetic',1,'NC','Synthetic');
 insert into public.plaid_physical_accounts(id,business_id) values('${physical}','${business}');
 insert into public.plaid_items(business_id,plaid_item_id,plaid_access_token,plaid_env,status) values('${business}','${key}','synthetic','production','connected');
 insert into public.bank_transactions(id,business_id,plaid_item_id,plaid_account_id,physical_account_id,plaid_env,plaid_transaction_id,date,name,amount,signed_amount,pending)
 values('${id}','${business}','${key}','${key}','${physical}','production','${id}',current_date-10,'Synthetic',-5.17,-5.17,false);
 insert into public.transaction_categorizations(business_id,transaction_id,status,final_qbo_account_id,final_qbo_account_name,post_after,meta)
 values('${business}','${id}','approved','meals','Meals',null,'{}');`);
 return {business,id};
}
const exclude=f=>`select public.exclude_handled_bookkeeping_transaction('${f.business}','${f.id}','synthetic-actor','operator_confirmed_already_posted','books_review','synthetic-request');`;
const state=f=>sql(`select status from public.transaction_categorizations where transaction_id='${f.id}'`);
const claim=f=>`select public.claim_qbo_posting_intent('${f.business}','${f.id}','synthetic-realm','production','Purchase','req-${f.id}','key-${f.id}');`;
const lock=f=>`select public.acquire_posting_lock('${f.business}','${f.id}',now(),600,'key-${f.id}');`;
function intent(f,status,extra='') { sql(`insert into public.qbo_posted_transactions(business_id,transaction_id,qbo_env,realm_id,qbo_txn_type,status,qbo_txn_id,response_summary) values('${f.business}','${f.id}','production','synthetic-realm','Purchase','${status}',${status==='posted'?"'qbo-receipt'":'null'},'${extra||'{}'}');`); }

test('Handled exclusion atomic PostgreSQL operation and posting serialization',{timeout:180000},async t=>{
 try {
  docker(['run','--pull=never','--network','none','--name',container,'-e','POSTGRES_USER=supabase_admin','-e','POSTGRES_DB=postgres','-e','POSTGRES_PASSWORD=synthetic','-d','postgres:17']);
  for(let i=0;i<100;i++){if(spawnSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','supabase_admin']).status===0)break;await new Promise(r=>setTimeout(r,100));}
  sql(stalePendingResolutionDatabaseSchema(),'supabase_admin');
  const before=sql(`select jsonb_agg(jsonb_build_object('signature',oid::regprocedure::text,'owner',proowner,'acl',proacl)) from pg_proc where oid in ('public.exclude_bookkeeping_transaction(uuid,uuid,text,text,text,text)'::regprocedure,'public.acquire_posting_lock(uuid,uuid,timestamptz,integer,text)'::regprocedure,'public.claim_qbo_posting_intent(uuid,uuid,text,text,text,text,text,jsonb,timestamptz,integer)'::regprocedure);`);
  await t.test('migration failure is atomic and exposes no partial safety adapter',()=>{
   assert.throws(()=>sql(migration.replace("notify pgrst,'reload schema';","select 1/0; notify pgrst,'reload schema';")),/division by zero/);
   assert.equal(sql("select to_regprocedure('public.lock_bookkeeping_exclusion_identity(uuid,uuid)') is null"),'t');
  });
  sql(migration);
  await t.test('migration is rerunnable; signatures, owners and ACLs remain compatible',()=>{
   sql(migration);
   assert.equal(sql("select has_function_privilege('authenticated','public.exclude_handled_bookkeeping_transaction(uuid,uuid,text,text,text,text)','execute')"),'f');
   assert.equal(sql("select has_function_privilege('service_role','public.exclude_handled_bookkeeping_transaction(uuid,uuid,text,text,text,text)','execute')"),'t');
   assert.equal(sql(`select jsonb_agg(jsonb_build_object('signature',oid::regprocedure::text,'owner',proowner,'acl',proacl)) from pg_proc where oid in ('public.exclude_bookkeeping_transaction(uuid,uuid,text,text,text,text)'::regprocedure,'public.acquire_posting_lock(uuid,uuid,timestamptz,integer,text)'::regprocedure,'public.claim_qbo_posting_intent(uuid,uuid,text,text,text,text,text,jsonb,timestamptz,integer)'::regprocedure);`),before);
  });
  await t.test('failed duplicate attempt excludes exactly once, cancels schedule/job/retries, preserves evidence and audit actor',()=>{
   const f=fixture();intent(f,'failed');
   sql(`insert into public.bookkeeping_post_attempts(business_id,transaction_id,status,error_message) values('${f.business}','${f.id}','failed','possible duplicate');
    update public.transaction_categorizations set post_after=now()+interval '1 day',meta='{"next_post_attempt_at":"2030-01-01","post_retry_count":2}' where transaction_id='${f.id}';`);
   const result=JSON.parse(sql(exclude(f)));assert.equal(result.primary_feed,'excluded');assert.equal(state(f),'excluded');
   assert.equal(sql(`select post_after is null and not(meta ? 'next_post_attempt_at') from public.transaction_categorizations where transaction_id='${f.id}'`),'t');
   assert.equal(sql(`select state||':'||(next_attempt_at is null)::text from public.bookkeeping_posting_jobs where transaction_id='${f.id}'`),'cancelled:true');
   assert.equal(sql(`select count(*) from public.bookkeeping_post_attempts where transaction_id='${f.id}'`),'1');
   assert.equal(sql(`select status from public.qbo_posted_transactions where transaction_id='${f.id}'`),'failed');
   assert.equal(JSON.parse(sql(exclude(f))).idempotent,true);
   assert.equal(sql(`select count(*) from public.bookkeeping_exclusion_events where transaction_id='${f.id}' and event_type='exclusion_completed' and actor='synthetic-actor' and prior_lifecycle='handled' and details->>'source'='books_review'`),'1');
   assert.equal(sql(lock(f)),'f');assert.equal(JSON.parse(sql(claim(f))).claimed,false);
   sql(`select public.admit_handled_auto_post(p_business_id=>'${f.business}',p_enabled=>true,p_ids=>array['${f.id}'::uuid]);`);
   assert.equal(state(f),'excluded');assert.equal(sql(`select post_after is null from public.transaction_categorizations where transaction_id='${f.id}'`),'t');
   assert.throws(()=>sql(`update public.transaction_categorizations set post_after=now() where transaction_id='${f.id}'`),/transaction_excluded/);
  });
  await t.test('receipt or successful attempt on exact row prevents exclusion',()=>{
   for(const evidence of ['receipt','attempt']) {const f=fixture();if(evidence==='receipt')intent(f,'posted');else sql(`insert into public.bookkeeping_post_attempts(business_id,transaction_id,status,qbo_txn_id) values('${f.business}','${f.id}','posted','receipt');`);assert.throws(()=>sql(exclude(f)),/transaction_already_posted/);assert.equal(state(f),'approved');}
  });
  await t.test('unknown, processing and failed-but-ambiguous external outcomes hold safely',()=>{
   for(const status of ['unknown','processing','failed']) {const f=fixture();intent(f,status,status==='failed'?'{"qbo_write_may_have_occurred":true}':'{}');assert.throws(()=>sql(exclude(f)),/posting_in_progress/);assert.equal(state(f),'approved');}
  });
  await t.test('separate posted counterpart and receipt remain unchanged',()=>{
   const f=fixture();const other=randomUUID();sql(`insert into public.bank_transactions(id,business_id,plaid_item_id,plaid_account_id,plaid_transaction_id,date,name,amount,pending) select '${other}',business_id,plaid_item_id,plaid_account_id,'${other}',date,name,amount,false from public.bank_transactions where id='${f.id}';
    insert into public.transaction_categorizations(business_id,transaction_id,status,qbo_txn_id,posted_at) values('${f.business}','${other}','posted','counterpart-receipt',now());
    insert into public.qbo_posted_transactions(business_id,transaction_id,qbo_txn_type,status,qbo_txn_id) values('${f.business}','${other}','Purchase','posted','counterpart-receipt');`);
   const before=sql(`select to_jsonb(q) from public.qbo_posted_transactions q where transaction_id='${other}'`);sql(exclude(f));assert.equal(sql(`select to_jsonb(q) from public.qbo_posted_transactions q where transaction_id='${other}'`),before);
   assert.equal(sql(`select status from public.transaction_categorizations where transaction_id='${other}'`),'posted');
  });
  await t.test('no-longer-Handled, cross-business, archived, matched and Posted rows fail safely',()=>{
   const f=fixture();assert.throws(()=>sql(exclude({...f,business:randomUUID()})),/transaction_not_found/);
   for(const status of ['needs_review','matched_existing_qbo','posted']) {const x=fixture();sql(`update public.transaction_categorizations set status='${status}',review_status='needs_review',final_qbo_account_id=null,final_qbo_account_name=null,post_after=null,meta='{}',decided_by='user',decided_at=now(),post_error=null where transaction_id='${x.id}'`);assert.throws(()=>sql(exclude(x)),/transaction_not_handled|transaction_already_posted|transaction_already_matched/,status);}
   const archived=fixture();sql(`update public.bank_transactions set is_archived=true where id='${archived.id}'`);assert.throws(()=>sql(exclude(archived)),/transaction_not_found/);
  });
  await t.test('restore and ordinary Undo state remain independently usable',()=>{
   const f=fixture();sql(exclude(f));const r=JSON.parse(sql(`select public.restore_bookkeeping_transaction('${f.business}','${f.id}','synthetic-actor');`));assert.equal(r.primary_feed,'handled');assert.equal(state(f),'approved');assert.equal(sql(lock(f)),'t');
  });
  await t.test('posting claim wins -> exclusion conflicts; exclusion wins -> both posting entries refuse',async()=>{
   const f=fixture();const posting=concurrent(`begin;${claim(f)}select pg_sleep(0.7);commit;`);
   await new Promise(r=>setTimeout(r,200));assert.throws(()=>sql(exclude(f)),/statement_pending_account_busy/);await posting;assert.throws(()=>sql(exclude(f)),/posting_in_progress/);
   const x=fixture();const excluding=concurrent(`begin;${exclude(x)}select pg_sleep(0.7);commit;`);
   await new Promise(r=>setTimeout(r,200));assert.throws(()=>sql(lock(x)),/statement_pending_account_busy/);await excluding;assert.equal(sql(lock(x)),'f');assert.equal(JSON.parse(sql(claim(x))).claimed,false);
  });
  await t.test('bounded row lock timeout rolls back the entire exclusion and permits retry',async()=>{
   const f=fixture();const holding=concurrent(`begin;select 1 from public.transaction_categorizations where transaction_id='${f.id}' for update;select pg_sleep(2.6);commit;`);await new Promise(r=>setTimeout(r,200));assert.throws(()=>sql(exclude(f)),/lock timeout/);await holding;assert.equal(state(f),'approved');sql(exclude(f));assert.equal(state(f),'excluded');
  });
 } finally {docker(['rm','-f',container]);}
});
