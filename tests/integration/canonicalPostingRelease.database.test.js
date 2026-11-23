/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {prepareCanonicalFixture} from '../../scripts/prepareCanonicalPostingReleaseFixture.js';
import {prepareCanonicalRunner,verifyCanonicalRunner,releaseFile} from '../../scripts/prepareCanonicalPostingReleaseRunner.js';
const container=`bizzi-canonical-release-${process.pid}`;
function docker(args,input){const r=spawnSync('docker',args,{input,encoding:'utf8',maxBuffer:32e6});if(r.status!==0)throw Error(r.stderr);return r.stdout.trim();}
function sql(text,user='postgres'){return docker(['exec','-i',container,'psql','-h','127.0.0.1','-U',user,'-d','postgres','-X','-v','ON_ERROR_STOP=1','-Atq'],text);}
const read=f=>fs.readFileSync(f,'utf8');
const functions=()=>JSON.parse(sql(`select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),'acl',p.proacl,'config',p.proconfig,'definer',p.prosecdef,'volatility',p.provolatile,'definition',md5(pg_get_functiondef(p.oid))) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`));
const triggers=()=>sql(`select jsonb_agg(jsonb_build_object('relation',tgrelid::regclass::text,'name',tgname,'definition',pg_get_triggerdef(oid),'enabled',tgenabled) order by tgrelid::regclass::text,tgname) from pg_trigger where not tgisinternal`);

test('canonical release upgrades captured effective roles/schema plus explicit installed fences atomically',{timeout:180000},async t=>{
 try{
  docker(['run','--pull=never','--network','none','--name',container,'-e','POSTGRES_USER=supabase_admin','-e','POSTGRES_DB=postgres','-e','POSTGRES_PASSWORD=synthetic','-d','postgres:17']);
  for(let i=0;i<100;i++){if(spawnSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','supabase_admin']).status===0)break;await new Promise(r=>setTimeout(r,100));}
  const fixture=prepareCanonicalFixture();sql(read(`${fixture}/prerequisites.sql`),'supabase_admin');
  // Explicit compatibility transitions only. Never replay the remote_schema
  // history, old admission migration, or main repository migration chain.
  for(const file of ['20261117230000_stale_pending_admin_resolution.sql','20261118220000_stale_pending_global_admin_availability.sql','20261118230000_stale_pending_permanent_admin_capability.sql'])sql(read(`scripts/releases/stale-pending/supabase/migrations/${file}`));
  for(const file of ['20261120220000_stale_pending_durable_account_scope.sql','20261120233000_handled_exclusion_posting_safety.sql'])sql(read(`supabase/migrations/${file}`));
  assert.equal(sql("select rolsuper from pg_roles where rolname=current_user"),'f');
  const runner=`/private/tmp/bizzi-canonical-compat-${process.pid}`;
  prepareCanonicalRunner({ledgerPath:'scripts/releases/canonical-posting-shape/captured-ledger.json',output:runner,fixtureOnly:true});verifyCanonicalRunner(runner);
  const migration=read(`${runner}/supabase/migrations/${releaseFile}`),before=functions(),beforeTriggers=triggers();
  await t.test('validation failure after DDL rolls back every installed object and grant',()=>{
   assert.throws(()=>sql(migration.replace("notify pgrst, 'reload schema';","select 1/0;\nnotify pgrst, 'reload schema';")),/division by zero/);
   assert.deepEqual(functions(),before);assert.equal(triggers(),beforeTriggers);
   assert.equal(sql("select to_regprocedure('public.canonical_posting_eligibility(uuid,uuid,text,text)') is null"),'t');
  });
  await t.test('migration applies under captured non-superuser owner and preserves every existing security property',()=>{
   sql(migration);const after=functions();
   for(const original of before){const installed=after.find(x=>x.signature===original.signature);assert.ok(installed,original.signature);
    const changed=/^(?:auto_post_technical_block|admit_handled_auto_post|approve_bookkeeping_with_admission|sync_bookkeeping_posting_job)\(/.test(original.signature);
    assert.deepEqual(changed?{...installed,definition:null}:installed,changed?{...original,definition:null}:original,original.signature);
   }
   for(const trigger of JSON.parse(beforeTriggers))assert.ok(JSON.parse(triggers()).some(x=>JSON.stringify(x)===JSON.stringify(trigger)),trigger.name);
   assert.equal(sql("select count(*) from pg_trigger where tgname in ('a_bind_canonical_posting_schedule','a_serialize_confirmed_split_edit') and tgenabled='O'"),'2');
   for(const signature of ['canonical_posting_eligibility(uuid,uuid,text,text)','return_posting_to_review(uuid,uuid,timestamp with time zone,text)']){
    assert.equal(sql(`select has_function_privilege('service_role','public.${signature}','execute') and not has_function_privilege('authenticated','public.${signature}','execute') and not has_function_privilege('anon','public.${signature}','execute')`),'t');
   }
   for(const [name,marker] of [['auto_post_technical_block','statement_pending_authority'],['auto_post_technical_block','canonical_posting_shape'],['admit_handled_auto_post','lock_statement_pending_ids'],['acquire_posting_lock','lock_bookkeeping_exclusion_identity'],['claim_qbo_posting_intent','lock_bookkeeping_exclusion_identity']])assert.equal(sql(`select bool_and(position('${marker}' in prosrc)>0) from pg_proc where pronamespace='public'::regnamespace and proname='${name}'`),'t',name+marker);
  });
  await t.test('confirmed loan split compiles and schedules using the captured table and trigger contracts',()=>{
   const b=randomUUID(),id=randomUUID(),actor=randomUUID(),key=randomUUID(),physical=randomUUID(),sid=randomUUID();
   sql(`insert into auth.users(id) values('${actor}');`,'supabase_admin');
   sql(`insert into public.user_profiles(id,email) values('${actor}','synthetic@example.invalid');
    insert into public.business_profiles(id,user_id,business_name,industry,team_size,state,services_offered) values('${b}','${actor}','Synthetic','Synthetic',1,'NC','Synthetic');
    insert into public.plaid_physical_accounts(id,business_id) values('${physical}','${b}');
    insert into public.plaid_items(business_id,plaid_item_id,plaid_access_token,plaid_env,status) values('${b}','${key}','synthetic','production','connected');
    insert into public.plaid_accounts(business_id,plaid_item_id,plaid_account_id,physical_account_id,plaid_env,name) values('${b}','${key}','${key}','${physical}','production','Synthetic');
    insert into public.quickbooks_tokens(business_id,access_token,refresh_token,realm_id,qbo_env) values('${b}','synthetic','synthetic','realm','production');
    insert into public.qbo_accounts_cache(business_id,realm_id,qbo_env,qbo_account_id,name,account_type) values('${b}','realm','production','source','Checking','Bank'),('${b}','realm','production','principal','Car Loan','Long Term Liability'),('${b}','realm','production','interest','Interest','Expense');
    insert into public.plaid_qbo_account_mappings(business_id,plaid_account_id,qbo_account_id,qbo_account_type,qbo_account_name) values('${b}','${key}','source','Bank','Checking');
    insert into public.bank_transactions(id,business_id,plaid_item_id,plaid_account_id,physical_account_id,plaid_env,plaid_transaction_id,date,name,amount,signed_amount,direction,pending) values('${id}','${b}','${key}','${key}','${physical}','production','${id}',current_date-10,'Synthetic',-517.55,-517.55,'OUTFLOW',false);
    insert into public.transaction_splits(id,business_id,transaction_id,total_amount_minor,confirmed_by,confirmed_actor_type,lines) values('${sid}','${b}','${id}',51755,'${actor}','admin','[{"amount_minor":46755,"qbo_account_id":"principal","description":"Principal"},{"amount_minor":5000,"qbo_account_id":"interest","description":"Interest"}]');
    insert into public.transaction_categorizations(business_id,transaction_id,status,decided_by,decided_at,meta) values('${b}','${id}','approved','admin',now(),'{"taxonomy_type":"split_transaction","split_transaction_status":"confirmed","split_transaction_id":"${sid}"}');`);
   const shape=JSON.parse(sql(`select public.canonical_posting_eligibility('${b}','${id}','production','worker')`));assert.equal(shape.reason,null);assert.equal(shape.entity_type,'Purchase');assert.deepEqual(shape.payload.Line.map(x=>x.Amount),[467.55,50]);
   const result=JSON.parse(sql(`select public.admit_handled_auto_post('${b}',true)`));assert.equal(result.scheduled,1,JSON.stringify(result));
   assert.equal(sql(`select final_qbo_account_id is null and post_after>now() and meta->>'posting_shape_binding' is not null from public.transaction_categorizations where transaction_id='${id}'`),'t');
  });
  await t.test('verification and scheduled-preflight SQL execute read-only with all fences present',()=>{
   sql(`create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text);insert into supabase_migrations.schema_migrations values('20261123230000','canonical_posting_shape_authority');`);
   const report=sql(read('scripts/releases/canonical-posting-shape/verify.sql'));assert.ok(report.includes('20261123230000'));
   const labels=['canonical SQL compiler','split execution binding','statement settlement authority retained','admission material fingerprint','admission statement fence retained','execution delegates to technical guard','split account validation','split balance validation','split approval snapshot','split claim serialization','atomic documented reopen','posting lock exclusion fence','posting claim exclusion fence','exclusion account fence'];
   for(const label of labels)assert.ok(report.split('\n').some(line=>line===`${label}|t|t`),label);
   for(const name of ['canonical_posting_shape','canonical_posting_eligibility','bind_canonical_posting_schedule','serialize_confirmed_split_edit','return_posting_to_review'])assert.ok(report.split('\n').some(line=>line.startsWith('public.'+name+'(')&&line.endsWith('|t|t|t')),name);

   sql(read('scripts/releases/canonical-posting-shape/inspect-car-loan.sql'));
   const readiness=sql(read('scripts/releases/canonical-posting-shape/scheduled-preflight.sql'));assert.ok(readiness.includes('PASS'),readiness);
  });
 }finally{docker(['rm','-f',container]);}
});
