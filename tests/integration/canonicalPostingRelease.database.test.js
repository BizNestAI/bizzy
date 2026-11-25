/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {preProviderPostingLifecycleCases} from '../helpers/preProviderPostingLifecycleCases.js';
import {splitPostingRuntimeCases} from '../helpers/splitPostingRuntimeCases.js';
import {undoneSplitRecoveryCases} from '../helpers/undoneSplitRecoveryCases.js';
import {prepareCanonicalFixture} from '../../scripts/prepareCanonicalPostingReleaseFixture.js';
import {prepareCanonicalRunner,verifyCanonicalRunner,releaseFile} from '../../scripts/prepareCanonicalPostingReleaseRunner.js';
const container=`bizzi-canonical-release-${process.pid}`;
const network=`${container}-net`;
function docker(args,input){const r=spawnSync('docker',args,{input,encoding:'utf8',maxBuffer:32e6});if(r.status!==0)throw Error(r.stderr);return r.stdout.trim();}
function sql(text,user='postgres'){return docker(['exec','-i',container,'psql','-h','127.0.0.1','-U',user,'-d','postgres','-X','-v','ON_ERROR_STOP=1','-Atq'],text);}
const read=f=>fs.readFileSync(f,'utf8');
const functions=()=>JSON.parse(sql(`select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),'acl',p.proacl,'config',p.proconfig,'definer',p.prosecdef,'volatility',p.provolatile,'definition',md5(pg_get_functiondef(p.oid))) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`));
const triggers=()=>sql(`select jsonb_agg(jsonb_build_object('relation',tgrelid::regclass::text,'name',tgname,'definition',pg_get_triggerdef(oid),'enabled',tgenabled) order by tgrelid::regclass::text,tgname) from pg_trigger where not tgisinternal`);

test('canonical release upgrades captured effective roles/schema plus explicit installed fences atomically',{timeout:180000},async t=>{
 try{
  docker(['network','create','--internal',network]);
  docker(['run','--pull=never','--network',network,'--name',container,'-e','POSTGRES_USER=supabase_admin','-e','POSTGRES_DB=postgres','-e','POSTGRES_PASSWORD=synthetic','-d','postgres:17']);
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
  await t.test('forward execution guard is atomic, idempotent and changes only one body under captured owners',()=>{
   const forward=read('supabase/migrations/20261124000000_restore_posting_execution_taxonomy_guard.sql'),before=functions(),oldTriggers=triggers();
   assert.throws(()=>sql(forward.replace("notify pgrst, 'reload schema';","select 1/0;\nnotify pgrst, 'reload schema';")),/division by zero/);
   assert.deepEqual(functions(),before);assert.equal(triggers(),oldTriggers);
   const unknown="begin; do $$ declare d text; b text; begin select pg_get_functiondef(oid),prosrc into d,b from pg_proc where oid='public.auto_post_technical_block(public.transaction_categorizations,text,jsonb,date)'::regprocedure; execute replace(d,b,replace(b,'elsif p_context is null then return','elsif p_context is null /* unknown contract */ then return')); end $$;\n"+forward.replace(/^begin;/,'');
   assert.throws(()=>sql(unknown),/posting_execution_guard_contract_unknown/);assert.deepEqual(functions(),before);assert.equal(triggers(),oldTriggers);
   sql(forward);const after=functions();sql(forward);assert.deepEqual(functions(),after);assert.equal(triggers(),oldTriggers);
   for(const original of before){const installed=after.find(x=>x.signature===original.signature);
    const changed=original.signature.startsWith('auto_post_technical_block(');
    assert.deepEqual(changed?{...installed,definition:null}:installed,changed?{...original,definition:null}:original,original.signature);
    if(changed)assert.notEqual(installed.definition,original.definition);
   }
   assert.equal(sql("select position('or b.direction is null' in prosrc)>0 from pg_proc where oid='public.auto_post_technical_block(public.transaction_categorizations,text,jsonb,date)'::regprocedure"),'t');
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
   sql(`create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text);insert into supabase_migrations.schema_migrations values('20261123230000','canonical_posting_shape_authority'),('20261124000000','restore_posting_execution_taxonomy_guard');`);
   const forwardReport=sql(read('scripts/releases/posting-execution-guard/verify.sql'));assert.ok(forwardReport.includes('20261124000000'));assert.ok(forwardReport.split('\n').some(line=>line.endsWith('|t|t|t|t|t|t|t')));
   const report=sql(read('scripts/releases/canonical-posting-shape/verify.sql'));assert.ok(report.includes('20261123230000'));
   const labels=['canonical SQL compiler','split execution binding','statement settlement authority retained','admission material fingerprint','admission statement fence retained','execution delegates to technical guard','split account validation','split balance validation','split approval snapshot','split claim serialization','atomic documented reopen','posting lock exclusion fence','posting claim exclusion fence','exclusion account fence'];
   for(const label of labels)assert.ok(report.split('\n').some(line=>line===`${label}|t|t`),label);
   for(const name of ['canonical_posting_shape','canonical_posting_eligibility','bind_canonical_posting_schedule','serialize_confirmed_split_edit','return_posting_to_review'])assert.ok(report.split('\n').some(line=>line.startsWith('public.'+name+'(')&&line.endsWith('|t|t|t')),name);

   sql(read('scripts/releases/canonical-posting-shape/inspect-car-loan.sql'));
   const readiness=sql(read('scripts/releases/canonical-posting-shape/scheduled-preflight.sql'));assert.ok(readiness.includes('PASS'),readiness);
  });
  let bid,account,actor;
  const splitFixture=()=>{
   bid=randomUUID();account=randomUUID();actor=randomUUID();const id=randomUUID(),physical=randomUUID(),sid=randomUUID();
   sql(`insert into auth.users(id) values('${actor}')`,'supabase_admin');
   sql(`insert into public.user_profiles(id,email) values('${actor}','synthetic@example.invalid');
    insert into public.internal_staff_users(user_id,role,active) values('${actor}','operator',true);
    insert into public.business_profiles(id,user_id,business_name,industry,team_size,state,services_offered) values('${bid}','${actor}','Synthetic','Synthetic',1,'NC','Synthetic');
    insert into public.plaid_physical_accounts(id,business_id) values('${physical}','${bid}');
    insert into public.plaid_items(business_id,plaid_item_id,plaid_access_token,plaid_env,status) values('${bid}','${account}','synthetic','production','connected');
    insert into public.plaid_accounts(business_id,plaid_item_id,plaid_account_id,physical_account_id,plaid_env,name) values('${bid}','${account}','${account}','${physical}','production','Synthetic');
    insert into public.quickbooks_tokens(business_id,access_token,refresh_token,realm_id,qbo_env) values('${bid}','synthetic','synthetic','${bid}','production');
    insert into public.qbo_accounts_cache(business_id,realm_id,qbo_env,qbo_account_id,name,account_type) values('${bid}','${bid}','production','source','Checking','Bank'),('${bid}','${bid}','production','principal','Car Loan','Long Term Liability'),('${bid}','${bid}','production','interest','Interest','Expense');
    insert into public.plaid_qbo_account_mappings(business_id,plaid_account_id,qbo_account_id,qbo_account_type,qbo_account_name) values('${bid}','${account}','source','Bank','Checking');
    insert into public.bank_transactions(id,business_id,plaid_item_id,plaid_account_id,physical_account_id,plaid_env,plaid_transaction_id,date,name,amount,signed_amount,direction,pending) values('${id}','${bid}','${account}','${account}','${physical}','production','${id}','2026-11-01','Synthetic',-517.55,-517.55,'OUTFLOW',false);
    insert into public.transaction_splits(id,business_id,transaction_id,total_amount_minor,confirmed_by,confirmed_actor_type,lines) values('${sid}','${bid}','${id}',51755,'${actor}','admin','[{"amount_minor":46755,"qbo_account_id":"principal","description":"Principal"},{"amount_minor":5000,"qbo_account_id":"interest","description":"Interest"}]');
    insert into public.transaction_categorizations(business_id,transaction_id,status,decided_by,decided_at,meta) values('${bid}','${id}','approved','admin',now(),'{"taxonomy_type":"split_transaction","split_transaction_status":"confirmed","split_transaction_id":"${sid}"}');`);
   return {id,sid};
  };
  const cat=id=>JSON.parse(sql(`select to_jsonb(c) from public.transaction_categorizations c where business_id='${bid}' and transaction_id='${id}'`));
  const rpc=(more='')=>JSON.parse(sql(`select public.admit_handled_auto_post(p_business_id=>'${bid}'${more})`));
  const inspect=id=>JSON.parse(sql(`select public.inspect_existing_split_schedule('${bid}','${id}')`));
  await preProviderPostingLifecycleCases({t,sql,splitFixture,scope:()=>({bid,account,realm:bid}),rpc,cat,staff:()=>actor,
   existingSchedule:(id,due)=>{rpc(',p_enabled=>true');sql(`update public.transaction_categorizations set post_after='${due}' where transaction_id='${id}';update public.transaction_categorizations set meta=meta-'posting_shape_binding' where transaction_id='${id}'`);},
   decision:(id,phase)=>JSON.parse(sql(`select public.canonical_posting_eligibility('${bid}','${id}','production','${phase}')`)),
   bind:(id,actor)=>{const expected=inspect(id);return JSON.parse(sql(`select public.bind_existing_split_schedule('${bid}','${id}','${actor}','${expected.binding}','${expected.updated_at}','${randomUUID()}')`));},
   lockIdentity:id=>{assert.equal(sql(`select public.acquire_posting_lock('${bid}','${id}',statement_timestamp(),600,'synthetic-key')`),'t');return {generation:cat(id).meta.posting_generation,lock_started_at:cat(id).meta.posting_started_at,lock_key:cat(id).meta.post_idempotency_key};},
  });
  sql("alter role postgres login password 'local-only'",'supabase_admin');
  // Explicit command-table fixture dependencies, not historical replay.
  sql(read('supabase/migrations/20261011_interactive_posting_commands.sql'));
  sql(read('supabase/migrations/20261016_interactive_posting_parent_child_results.sql'));
  await t.test('nullable parent command migration is atomic and ordinary commands still require a GL',()=>{
   const forward=read('supabase/migrations/20261124030000_split_direct_posting_command_authority.sql');
   const security=()=>sql("select jsonb_build_object('owner',pg_get_userbyid(relowner),'acl',relacl,'rls',relrowsecurity,'force_rls',relforcerowsecurity) from pg_class where oid='public.bookkeeping_interactive_posting_commands'::regclass");
   const beforeSecurity=security();
   const indexes=()=>sql("select jsonb_agg(indexdef order by indexname) from pg_indexes where schemaname='public' and tablename='bookkeeping_interactive_posting_commands'");const beforeIndexes=indexes();
   const {id}=splitFixture();sql(`insert into public.bookkeeping_interactive_posting_commands(operation_id,business_id,transaction_ids,selected_qbo_account_id) values('ordinary-before-migration','${bid}',array['${id}'::uuid],'interest')`);
   const ordinary=sql("select to_jsonb(c) from public.bookkeeping_interactive_posting_commands c where operation_id='ordinary-before-migration'");
   assert.throws(()=>sql(forward.replace("notify pgrst, 'reload schema';","select 1/0;notify pgrst, 'reload schema';")),/division by zero/);
   assert.equal(sql("select attnotnull from pg_attribute where attrelid='public.bookkeeping_interactive_posting_commands'::regclass and attname='selected_qbo_account_id'"),'t');
   assert.equal(security(),beforeSecurity);assert.equal(indexes(),beforeIndexes);
   sql(forward);assert.equal(security(),beforeSecurity);assert.equal(indexes(),beforeIndexes);
   assert.equal(sql("select to_jsonb(c) from public.bookkeeping_interactive_posting_commands c where operation_id='ordinary-before-migration'"),ordinary);
   assert.throws(()=>sql(`insert into public.bookkeeping_interactive_posting_commands(operation_id,business_id,transaction_ids,selected_qbo_account_id) values('invalid-null-parent','${bid}',array['${id}'::uuid],null)`),/interactive_posting_split_authority_check/);
   sql(`insert into public.bookkeeping_interactive_posting_commands(operation_id,business_id,transaction_ids,selected_qbo_account_id) values('ordinary-parent','${bid}',array['${id}'::uuid],'interest')`);
  });
  await t.test('split Undo is atomic, service-only, tenant-scoped and preserves history and posting fences',()=>{
   const migration=read('supabase/migrations/20261124040000_undo_split_categorization.sql');
   assert.throws(()=>sql(migration.replace("notify pgrst,'reload schema';","select 1/0;notify pgrst,'reload schema';")),/division by zero/);
   assert.equal(sql("select to_regprocedure('public.undo_split_categorization(uuid,uuid,uuid)') is null"),'t');
   sql(migration);
   assert.equal(sql("select has_function_privilege('service_role','public.undo_split_categorization(uuid,uuid,uuid)','execute') and not has_function_privilege('authenticated','public.undo_split_categorization(uuid,uuid,uuid)','execute') and not has_function_privilege('anon','public.undo_split_categorization(uuid,uuid,uuid)','execute')"),'t');
   const {id}=splitFixture();
   const before=sql(`select to_jsonb(s) from public.transaction_splits s where transaction_id='${id}'`);
   assert.throws(()=>sql(`select public.undo_split_categorization('${randomUUID()}','${id}','${actor}')`),/transaction_not_found/);
   assert.throws(()=>sql(`select public.undo_split_categorization('${bid}','${id}',null)`),/undo_actor_required/);
   sql(`update public.transaction_categorizations set meta=meta||'{"ambiguous_provider_outcome":true}' where transaction_id='${id}'`);
   assert.throws(()=>sql(`select public.undo_split_categorization('${bid}','${id}','${actor}')`),/split_undo_requires_posting_reconciliation/);
   assert.equal(sql(`select to_jsonb(s) from public.transaction_splits s where transaction_id='${id}'`),before);
   sql(`update public.transaction_categorizations set meta=meta-'ambiguous_provider_outcome' where transaction_id='${id}'`);
   const result=JSON.parse(sql(`select public.undo_split_categorization('${bid}','${id}','${actor}')`));assert.equal(result.ok,true);
   const after=JSON.parse(sql(`select to_jsonb(s) from public.transaction_splits s where transaction_id='${id}'`));
   assert.equal(after.status,'voided');assert.deepEqual(after.lines,JSON.parse(before).lines);assert.deepEqual(after.meta.approved_material,JSON.parse(before).meta.approved_material);
   assert.equal(sql(`select status||'|'||review_status||'|'||posting_status from public.transaction_categorizations where transaction_id='${id}'`),'needs_review|needs_review|not_scheduled');
   assert.equal(sql(`select state from public.bookkeeping_posting_jobs where transaction_id='${id}'`),'cancelled');
  });
  await t.test('undone split forward recovery migration is atomic and preserves installed contracts',()=>{
   const migration=read('supabase/migrations/20261124050000_reconcile_undone_split_pre_provider.sql'),before=functions(),beforeTriggers=triggers();
   assert.throws(()=>sql(migration.replace("notify pgrst,'reload schema';","select 1/0;notify pgrst,'reload schema';")),/division by zero/);
   assert.deepEqual(functions(),before);assert.equal(triggers(),beforeTriggers);
   sql(migration);for(const f of before)assert.deepEqual(functions().find(x=>x.signature===f.signature),f);assert.equal(triggers(),beforeTriggers);
   const f=functions().find(x=>x.signature.startsWith('reconcile_undone_split_pre_provider('));assert.equal(f.owner,'postgres');assert.equal(f.definer,true);assert.deepEqual(f.config,['search_path=pg_catalog, public']);
   assert.deepEqual(f.acl.sort(),['postgres=X/postgres','service_role=X/postgres'].sort());
  });
  await undoneSplitRecoveryCases({t,sql,fixture:splitFixture,scope:()=>({bid,account,actor})});
  await splitPostingRuntimeCases({t,sql,container,network,fixture:splitFixture,scope:()=>({bid,account,actor})});
 }finally{docker(['rm','-f',container]);docker(['network','rm',network]);}
});
