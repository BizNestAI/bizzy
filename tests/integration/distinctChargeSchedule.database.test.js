/* global process */
import test from 'node:test';
import {verifyDistinctChargeWorker} from '../helpers/distinctChargeWorkerCase.js';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {stalePendingResolutionDatabaseSchema} from '../helpers/stalePendingResolutionDatabaseSchema.js';
import {withCanonicalDatabase} from '../helpers/canonicalRecheckDatabase.js';
const container=`bizzi-distinct-charge-${process.pid}`,network=`${container}-net`,business=randomUUID();
function docker(args,input){const r=spawnSync('docker',args,{input,encoding:'utf8',maxBuffer:32e6});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
let ready=false;
function sql(text){return docker(['exec','-i',container,'psql','-U',ready?'postgres':'supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1','-Atq'],text);}
function seedAuthUser(id){docker(['exec','-i',container,'psql','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1'],`insert into auth.users(id) values('${id}');`);}
async function ok(query){const r=await query;assert.equal(r.error,null,JSON.stringify(r.error));return r.data;}
test('Verified separate charge recovery and scheduled worker with real PostgreSQL; mocked QBO',{timeout:90000},async ()=>{
 try{
  docker(['network','create','--internal',network]);
  docker(['run','--pull=never','--name',container,'--network',network,'-e','POSTGRES_USER=supabase_admin','-e','POSTGRES_PASSWORD=local-only','-d','postgres:17']);
  for(let i=0;i<100;i++){if(spawnSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','supabase_admin']).status===0)break;await new Promise(r=>setTimeout(r,100));}
  const directory=`/private/tmp/${container}-catalog`;fs.mkdirSync(directory,{recursive:true});
  for(const file of ['catalog.json','supplement.json','scope-roots.json'])fs.copyFileSync(`tests/fixtures/stalePendingProduction/${file}`,`${directory}/${file}`);
  const roots=JSON.parse(fs.readFileSync(`${directory}/scope-roots.json`));roots.relations=[...new Set([...roots.relations,'vendor_rules','transaction_splits','bookkeeping_posting_eligibility_rechecks','bookkeeping_interactive_posting_commands'])];
  fs.writeFileSync(`${directory}/scope-roots.json`,JSON.stringify(roots));
  const build=spawnSync(process.execPath,['scripts/buildStalePendingCatalogFixture.js',directory],{encoding:'utf8'});assert.equal(build.status,0,build.stderr);
  const original=fs.readFileSync('tests/fixtures/stalePendingProduction/prerequisites.sql','utf8');
  const transitions=stalePendingResolutionDatabaseSchema({includeScopeCorrection:true}).slice(original.length);
  sql(fs.readFileSync(`${directory}/prerequisites.sql`,'utf8')+transitions);ready=true;
  for(const file of ['20261120233000_handled_exclusion_posting_safety.sql','20261123230000_canonical_posting_shape_authority.sql','20261124000000_restore_posting_execution_taxonomy_guard.sql','20261124020000_pre_provider_posting_failure_lifecycle.sql'])sql(fs.readFileSync(`supabase/migrations/${file}`,'utf8'));
  const migration=fs.readFileSync('supabase/migrations/20261125010000_reviewed_distinct_charge_schedule.sql','utf8');
  const previous=sql("select md5(pg_get_functiondef('public.auto_post_technical_block(public.transaction_categorizations,text,jsonb,date)'::regprocedure))");
  assert.throws(()=>sql(migration.replace("notify pgrst,'reload schema';","select 1/0;notify pgrst,'reload schema';")),/division by zero/);
  assert.equal(sql("select to_regprocedure('public.inspect_distinct_charge_schedule(uuid,uuid,text)') is null"),'t');
  sql(migration);
  assert.equal(sql("select md5(pg_get_functiondef('public.auto_post_technical_block(public.transaction_categorizations,text,jsonb,date)'::regprocedure))"),previous);
  for(const signature of ['public.inspect_distinct_charge_schedule(uuid,uuid,text)','public.schedule_reviewed_distinct_charge(uuid,uuid,uuid,text,uuid,numeric,text)']) {
   assert.equal(sql(`select has_function_privilege('service_role','${signature}','execute') and not has_function_privilege('anon','${signature}','execute') and not has_function_privilege('authenticated','${signature}','execute')`),'t');
   assert.equal(sql(`select pg_get_userbyid(proowner)||'|'||prosecdef||'|'||array_to_string(proconfig,',') from pg_proc where oid='${signature}'::regprocedure`),'postgres|true|search_path=pg_catalog, public');
  }
  sql("alter role postgres password 'local-only';");
  await withCanonicalDatabase({container,network},async db=>{
   process.env.SUPABASE_URL=db.supabaseUrl;process.env.SUPABASE_SERVICE_ROLE_KEY=db.supabaseKey;
   process.env.QB_ENVIRONMENT='production';process.env.NODE_ENV='test';
   const actor=randomUUID(),source=randomUUID(),other=randomUUID(),key=randomUUID();seedAuthUser(actor);
   sql(`insert into public.business_profiles(id,business_name,industry,team_size,state,services_offered,auto_post_to_quickbooks,bookkeeping_start_date) values('${business}','Synthetic','Synthetic',1,'NC','Synthetic',true,'2026-01-01');
    insert into public.user_profiles(id,email) values('${actor}','museum@example.invalid');
    insert into public.internal_staff_users(user_id,role,active) values('${actor}','owner_admin',true);
    insert into public.plaid_items(business_id,plaid_item_id,plaid_env,plaid_access_token,status) values('${business}','card','production','synthetic','connected');
    insert into public.plaid_accounts(business_id,plaid_item_id,plaid_account_id,plaid_env,name) values('${business}','card','card','production','CREDIT CARD');
    insert into public.quickbooks_tokens(business_id,access_token,refresh_token,realm_id,qbo_env) values('${business}','synthetic','synthetic','museum-realm','production');
    insert into public.qbo_accounts_cache(business_id,realm_id,qbo_env,qbo_account_id,name,account_type) values
    ('${business}','museum-realm','production','source-card','CREDIT CARD','Credit Card'),('${business}','museum-realm','production','entertainment','Entertainment','Expense');
    insert into public.plaid_qbo_account_mappings(business_id,plaid_account_id,qbo_account_id,qbo_account_name,qbo_account_type) values('${business}','card','source-card','CREDIT CARD','CreditCard');
    insert into public.bank_transactions(id,business_id,plaid_item_id,plaid_account_id,plaid_transaction_id,plaid_env,date,amount,direction,pending,name,merchant_name) values
    ('${source}','${business}','card','card','source-one','production','2026-11-09',-28,'OUTFLOW',false,'WITCH DUNGEON MUSEUM','Witch Dungeon Museum'),
    ('${other}','${business}','card','card','source-two','production','2026-11-09',-28,'OUTFLOW',false,'WITCH DUNGEON MUSEUM','Witch Dungeon Museum');`);
   const candidate={qbo_txn_id:'2209',qbo_txn_type:'CreditCardCharge',txn_date:'2026-11-09',amount:28,account_matches:true,date_matches:true,amount_matches:true};
   const meta={safe_to_auto_post:true,posting_in_progress:false,qbo_duplicate_detection_confidence:'AMBIGUOUS',possible_qbo_duplicate:true,qbo_duplicate_candidates:[candidate],post_idempotency_key:'original-key',posting_execution_request_id:'original-request'};
   const sourceSummary={amount:-28,date:'2026-11-09',plaid_transaction_id:'source-one',final_qbo_account_id:'entertainment',mapped_qbo_account_id:'source-card'};
   await ok(db.from('qbo_posted_transactions').insert([
    {business_id:business,transaction_id:source,qbo_env:'production',realm_id:'museum-realm',status:'pending',attempt_count:1,qbo_txn_type:'CreditCardCharge',request_id:'original-request',idempotency_key:'original-key',error:'possible_qbo_duplicate',payload_summary:sourceSummary,last_error:{message:'possible_qbo_duplicate'},response_summary:{duplicate_detection_confidence:'AMBIGUOUS',candidates:[candidate]}}
   ]));
   await ok(db.from('transaction_categorizations').insert([
    {business_id:business,transaction_id:other,status:'approved',final_qbo_account_id:'entertainment',post_after:new Date(Date.now()+3600000).toISOString(),meta:{safe_to_auto_post:true}},
    {business_id:business,transaction_id:source,status:'failed',post_error:'possible_qbo_duplicate',final_qbo_account_id:'entertainment',final_qbo_account_name:'Entertainment',meta}
   ]));
   const firstCat=await ok(db.from('transaction_categorizations').select('*').eq('transaction_id',other).single());
   await verifyDistinctChargeWorker({db,businessId:business,transactionId:other,postAfter:firstCat.post_after,first:true});
   const firstReceipt=await ok(db.from('qbo_posted_transactions').select('*').eq('transaction_id',other).single());
   assert.equal(firstReceipt.qbo_txn_id,'2209');
   const inspect=()=>db.rpc('inspect_distinct_charge_schedule',{p_business_id:business,p_transaction_id:source,p_env:'production'});
   let preview=await ok(inspect());assert.equal(preview.reason,null,JSON.stringify(preview));assert.equal(preview.qbo_txn_id,'2209');assert.equal(preview.conflict_transaction_id,other);
   const args={p_business_id:business,p_transaction_id:source,p_actor_id:actor,p_fingerprint:preview.fingerprint,p_idempotency_key:key,p_grace_hours:24,p_env:'production'};
   const category=()=>db.from('transaction_categorizations').select('*').eq('business_id',business).eq('transaction_id',source).single();
   const intent=()=>db.from('qbo_posted_transactions').select('*').eq('business_id',business).eq('transaction_id',source).single();
   const baseline=await ok(category());
   await ok(db.from('bank_transactions').update({amount:-29}).eq('id',other));
   assert.match((await inspect()).data.reason,/counterpart_changed/);
   await ok(db.from('bank_transactions').update({amount:-28}).eq('id',other));
   await ok(db.from('transaction_categorizations').update({excluded_at:new Date().toISOString()}).eq('business_id',business).eq('transaction_id',source));
   assert.ok((await inspect()).data.reason);
   await ok(db.from('transaction_categorizations').update({excluded_at:null}).eq('business_id',business).eq('transaction_id',source));
   // Exclusion's normal job trigger cancelled the job; restore this test-only
   // failed fixture explicitly before testing the independent matching fence.
   await ok(db.from('bookkeeping_posting_jobs').update({state:'failed',blocking_code:'possible_qbo_duplicate'}).eq('business_id',business).eq('transaction_id',source));
   const [match]=await ok(db.from('bank_qbo_matches').insert({business_id:business,bank_transaction_id:source,status:'confirmed',match_type:'unavailable',confidence_tier:'unavailable',gross_bank_amount_minor:2800,bank_account_match:'unavailable'}).select());
   assert.match((await inspect()).data.reason,/provider_evidence/);
   await ok(db.from('bank_qbo_matches').delete().eq('id',match.id));

   await ok(db.from('bookkeeping_posting_jobs').update({lease_owner:'active',lease_expires_at:new Date(Date.now()+60000).toISOString()}).eq('business_id',business).eq('transaction_id',source));
   assert.match((await inspect()).data.reason,/provider_evidence/);assert.ok((await db.rpc('schedule_reviewed_distinct_charge',args)).error);
   await ok(db.from('bookkeeping_posting_jobs').update({lease_owner:null,lease_expires_at:null}).eq('business_id',business).eq('transaction_id',source));
   await ok(db.from('transaction_categorizations').update({meta:{...meta,ambiguous_provider_outcome:true}}).eq('business_id',business).eq('transaction_id',source));
   assert.match((await inspect()).data.reason,/provider_evidence/);
   await ok(db.from('transaction_categorizations').update({meta}).eq('business_id',business).eq('transaction_id',source));
   await ok(db.from('bookkeeping_post_attempts').insert({business_id:business,transaction_id:source,status:'attempted',attempted_at:new Date().toISOString()}));
   assert.match((await inspect()).data.reason,/provider_evidence/);
   // Test-only fixture reset: production history is never deleted by recovery.
   await ok(db.from('bookkeeping_post_attempts').delete().eq('business_id',business).eq('transaction_id',source));
   await ok(db.from('qbo_posted_transactions').update({qbo_txn_id:'unexpected-receipt'}).eq('business_id',business).eq('transaction_id',source));
   assert.match((await inspect()).data.reason,/provider_evidence/);
   await ok(db.from('qbo_posted_transactions').update({qbo_txn_id:null}).eq('business_id',business).eq('transaction_id',source));
   preview=await ok(inspect());args.p_fingerprint=preview.fingerprint;
   await ok(db.from('internal_staff_users').update({active:false}).eq('user_id',actor));
   assert.ok((await db.rpc('schedule_reviewed_distinct_charge',args)).error);
   await ok(db.from('internal_staff_users').update({active:true}).eq('user_id',actor));
   assert.ok((await db.rpc('schedule_reviewed_distinct_charge',{...args,p_actor_id:randomUUID()})).error);
   assert.ok((await db.rpc('schedule_reviewed_distinct_charge',{...args,p_business_id:randomUUID()})).error);
   assert.ok((await db.rpc('schedule_reviewed_distinct_charge',{...args,p_fingerprint:'stale'})).error);
   const bulk=randomUUID(),scheduled=randomUUID(),existingDue=new Date(Date.now()+48*3600000).toISOString();
   await ok(db.from('bank_transactions').insert([bulk,scheduled].map(id=>({id,business_id:business,plaid_item_id:'card',plaid_account_id:'card',plaid_transaction_id:id,plaid_env:'production',date:'2026-11-10',amount:-12,direction:'OUTFLOW',pending:false,name:'Other expense'}))));
   await ok(db.from('transaction_categorizations').insert([bulk,scheduled].map(id=>({business_id:business,transaction_id:id,status:'approved',final_qbo_account_id:'entertainment',final_qbo_account_name:'Entertainment',meta:{safe_to_auto_post:true},...(id===scheduled?{post_after:existingDue}:{})}))));
   const {previewPostingEligibilityRecheck,executePostingEligibilityRecheck}=await import('../../src/services/bookkeeping/postingEligibilityRecheckService.js');
   const scope={db,businessId:business,month:'2026-11',transactionIds:[source,bulk,scheduled]};
   const rpe=await previewPostingEligibilityRecheck(scope);
   const reviewed=rpe.rows.find(row=>row.transaction_id===source);assert.equal(reviewed.outcome,'distinct_charge_confirmation_required',JSON.stringify(rpe));
   assert.equal(rpe.rows.find(row=>row.transaction_id===bulk).outcome,'eligible_to_schedule',JSON.stringify(rpe));
   assert.equal(rpe.rows.find(row=>row.transaction_id===scheduled).outcome,'already_scheduled');
   const noConfirmation=await executePostingEligibilityRecheck({...scope,actorId:actor,idempotencyKey:randomUUID(),previewVersion:rpe.preview_version,scheduleAutomaticallyEligible:false});
   assert.equal(noConfirmation.rows.find(row=>row.transaction_id===source).outcome,'distinct_charge_confirmation_required');
   assert.equal((await ok(category())).post_after,null);
   const staleConfirmation=await executePostingEligibilityRecheck({...scope,actorId:actor,idempotencyKey:randomUUID(),previewVersion:rpe.preview_version,scheduleAutomaticallyEligible:false,
    distinctChargeConfirmations:[{transaction_id:source,row_version:reviewed.row_version,fingerprint:'stale',confirmed:true}]});
   assert.equal(staleConfirmation.rows.find(row=>row.transaction_id===source).outcome,'conflicted');
   assert.equal((await ok(category())).post_after,null);
   const execution=await executePostingEligibilityRecheck({...scope,actorId:actor,idempotencyKey:key,previewVersion:rpe.preview_version,
    distinctChargeConfirmations:[{transaction_id:source,row_version:reviewed.row_version,fingerprint:reviewed.distinct_charge_review.fingerprint,confirmed:true}]});
   assert.equal(execution.rows.find(row=>row.transaction_id===source).outcome,'distinct_charge_scheduled',JSON.stringify(execution));
   assert.equal(execution.rows.find(row=>row.transaction_id===bulk).outcome,'newly_scheduled');
   assert.equal(execution.rows.find(row=>row.transaction_id===scheduled).outcome,'already_scheduled');
   assert.equal(Date.parse((await ok(db.from('transaction_categorizations').select('post_after').eq('transaction_id',scheduled).single())).post_after),Date.parse(existingDue));
   args.p_fingerprint=reviewed.distinct_charge_review.fingerprint;
   const saved=await ok(db.rpc('schedule_reviewed_distinct_charge',args));assert.equal(saved.ok,true);assert.ok(Date.parse(saved.post_after)>Date.now()+23*3600000);
   const cat=await ok(category());assert.equal(cat.final_qbo_account_id,baseline.final_qbo_account_id);assert.equal(cat.final_qbo_account_name,'Entertainment');
   const receipt=await ok(intent());assert.equal(receipt.request_id,'original-request');assert.equal(receipt.idempotency_key,'original-key');assert.equal(receipt.status,'failed');
   const job=await ok(db.from('bookkeeping_posting_jobs').select('*').eq('business_id',business).eq('transaction_id',source).single());assert.equal(job.state,'retry_scheduled');assert.equal(Date.parse(job.scheduled_at),Date.parse(saved.post_after));
   assert.equal((await ok(db.rpc('schedule_reviewed_distinct_charge',args))).idempotent,true);assert.equal((await ok(category())).post_after,cat.post_after);
   await verifyDistinctChargeWorker({db,businessId:business,transactionId:source,postAfter:cat.post_after,existingReceipt:firstReceipt.response});
   assert.equal((await ok(db.from('qbo_posted_transactions').select('*').eq('business_id',business).eq('status','posted'))).length,2);
   assert.equal((await ok(db.rpc('schedule_reviewed_distinct_charge',args))).idempotent,true);
   assert.equal((await ok(category())).qbo_txn_id,'synthetic-second-receipt');
  });
 } finally {spawnSync('docker',['rm','-f',container]);spawnSync('docker',['network','rm',network]);}
});
