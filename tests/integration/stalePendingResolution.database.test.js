/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { guardQboWrites } from "../../src/services/bookkeeping/postingExecutionIntegrity.js";
import { spawnSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stalePendingResolutionDatabaseSchema } from "../helpers/stalePendingResolutionDatabaseSchema.js";

// Synthetic database only. No dotenv, application clients, providers or workers.
const container = `bizzi-stale-pending-${process.pid}`;
function docker(args, input) {
  const r = spawnSync("docker", args, { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
function sql(text,user="postgres") { return docker(["exec", "-i", container, "psql", "-h", "127.0.0.1", "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-Atq"], text); }
function asyncSql(text) {
  const child = spawn("docker", ["exec", "-i", container, "psql", "-h", "127.0.0.1", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-Atq"]);
  let out = "", err = "";
  child.stdout.on("data", x => { out += x; }); child.stderr.on("data", x => { err += x; });
  child.stdin.end(text);
  return new Promise((resolve, reject) => child.on("close", code => code ? reject(new Error(err)) : resolve(out.trim())));
}
const actor = randomUUID();
const migration = fs.readFileSync("scripts/releases/stale-pending/supabase/migrations/20261117230000_stale_pending_admin_resolution.sql", "utf8");
const availability = fs.readFileSync("scripts/releases/stale-pending/supabase/migrations/20261118220000_stale_pending_global_admin_availability.sql", "utf8");
const permanent = fs.readFileSync("scripts/releases/stale-pending/supabase/migrations/20261118230000_stale_pending_permanent_admin_capability.sql", "utf8");
function fixture({ age = 20 } = {}) {
 const business=randomUUID(),physical=randomUUID(),id=randomUUID(),key=randomUUID();
 const realm=`realm-${business}`;
 sql(`insert into public.business_profiles(id,business_name,industry,team_size,state,services_offered,user_id) values('${business}','Synthetic','Synthetic',1,'NC','Synthetic','${actor}');
 insert into public.plaid_physical_accounts(id,business_id) values('${physical}','${business}');
 insert into public.plaid_items(business_id,plaid_item_id,plaid_access_token,plaid_env,status) values('${business}','${key}','synthetic','production','connected');
 insert into public.plaid_accounts(business_id,plaid_item_id,plaid_account_id,physical_account_id,plaid_env,name) values('${business}','${key}','${key}','${physical}','production','Synthetic');
 insert into public.quickbooks_tokens(business_id,access_token,refresh_token,realm_id,qbo_env) values('${business}','synthetic','synthetic','${realm}','production');
 insert into public.qbo_accounts_cache(business_id,realm_id,qbo_env,qbo_account_id,name,account_type) values('${business}','${realm}','production','source','Source','Bank'),('${business}','${realm}','production','meals','Meals','Expense');
 insert into public.plaid_qbo_account_mappings(business_id,plaid_account_id,qbo_account_id,qbo_account_name,qbo_account_type) values('${business}','${key}','source','Source','Bank');
 insert into public.bank_transactions(id,business_id,plaid_item_id,plaid_account_id,physical_account_id,plaid_env,plaid_transaction_id,date,authorized_date,name,merchant_name,amount,signed_amount,direction,pending)
 values('${id}','${business}','${key}','${key}','${physical}','production','pending-${id}',current_date-${age},current_date-${age},'Synthetic Merchant','Synthetic Merchant',-10,-10,'OUTFLOW',true);`);
 return {business,physical,id,key,age,realm};
}
function confirmSql(f,{request=randomUUID(),attested=true,actorId=actor}={}) {
 return `select public.resolve_stale_pending_admin('${f.business}','${f.id}','${actorId}','confirm-settled','${request}',${attested},current_date-1,10,null,null,date_trunc('month',current_date-${f.age})::date);`;
}
function releaseSql(f,{request=randomUUID(),actorId=actor}={}) {
 const row={transaction_id:f.id,status:'approved',final_qbo_account_id:'meals',final_qbo_account_name:'Meals',meta:{approval_source:'admin_manual',final_categorization:{source:'admin_manual',actor_id:actorId},auto_post_admission:{version:2,state:'pending',source:'handled'},posting_generation:randomUUID()}};
 return `select public.release_statement_pending_review('${f.business}','${actorId}','${JSON.stringify(row)}','${request}');`;
}
function counterpartSql(f,{explicit=true,amount=-10,name='Synthetic Merchant',id=randomUUID()}={}) {
 return {id,sql:`insert into public.bank_transactions(id,business_id,plaid_item_id,plaid_account_id,physical_account_id,plaid_env,plaid_transaction_id,pending_transaction_id,date,authorized_date,name,merchant_name,amount,signed_amount,direction,pending)
 select '${id}',business_id,plaid_item_id,plaid_account_id,physical_account_id,plaid_env,'settled-${id}',${explicit?'plaid_transaction_id':'null'},date,authorized_date,'${name}','${name}',${amount},${amount},'OUTFLOW',false from public.bank_transactions where id='${f.id}';`};
}
function state(f){return sql(`select pending_resolution_state from public.bank_transactions where id='${f.id}'`);}
function claim(f){return JSON.parse(sql(`select public.claim_qbo_posting_intent('${f.business}','${f.id}','${f.realm}','production','Purchase','request-${f.id}','key-${f.id}');`));}
function context(f,intent){return {request_id:`request-${f.id}`,idempotency_key:`key-${f.id}`,claimed_at:intent.processing_started_at};}
function checkSql(f,ctx){return `select public.check_statement_pending_posting('${f.business}','${f.id}','${JSON.stringify(ctx)}');`;}
function finish(f){sql(`update public.qbo_posted_transactions set status='posted',qbo_txn_id='receipt-${f.id}' where transaction_id='${f.id}';
 update public.transaction_categorizations set status='posted',qbo_txn_id='receipt-${f.id}',posted_at=now(),post_after=null where transaction_id='${f.id}';`);}

test("statement Pending compatibility, release and posting on PostgreSQL",{timeout:240000},async t=>{
 try{
  docker(["run","--pull=never","--network","none","--name",container,"-e","POSTGRES_USER=supabase_admin","-e","POSTGRES_DB=postgres","-e","POSTGRES_PASSWORD=synthetic","-d","postgres:17"]);
  for(let i=0;i<100;i++){if(spawnSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','supabase_admin']).status===0)break;await new Promise(r=>setTimeout(r,100));}
  sql(stalePendingResolutionDatabaseSchema({includeMigration:false}),"supabase_admin");
  await t.test('operator catalog export is valid read-only SQL on the disposable database',()=>{
   sql(`create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text);
    insert into supabase_migrations.schema_migrations values('20260808174146','remote_schema'),('20261111220000','auto_post_handled_admission');`);
   const report=JSON.parse(sql(fs.readFileSync('scripts/manual/stalePendingProductionCatalog.sql','utf8')));
   assert.equal(report.migration_history.length,2);
   const supplement=JSON.parse(sql(fs.readFileSync('scripts/manual/stalePendingProductionCatalogSupplement.sql','utf8')));
   assert.ok(supplement.columns.some(c=>c.relation==='transaction_categorizations'&&c.name==='meta'&&'acl' in c));
   assert.ok(supplement.roles.some(r=>r.name==='service_role'));
   const productionSupplement=JSON.parse(fs.readFileSync('tests/fixtures/stalePendingProduction/supplement.json','utf8'));
   const fixtureScope=JSON.parse(fs.readFileSync('tests/fixtures/stalePendingProduction/scope.json','utf8'));
   const sorted=rows=>rows.map(row=>({...row,...(row.acl?{acl:[...row.acl].sort()}:{} )})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
   const scopedColumn=x=>fixtureScope.relations.includes(x.relation);
   assert.deepEqual(sorted(supplement.columns.filter(scopedColumn)),sorted(productionSupplement.columns.filter(scopedColumn)),'column ordinals, types, collations and exact ACLs');
   for(const key of ['roles','memberships','schemas','default_acls','external_auth_uid']){
    assert.deepEqual(Array.isArray(supplement[key])?sorted(supplement[key]):supplement[key],Array.isArray(productionSupplement[key])?sorted(productionSupplement[key]):productionSupplement[key],key);
   }
   assert.equal(sql("select rolsuper from pg_roles where rolname=current_user"),'f');
   assert.equal(sql("select has_column_privilege('plaid_residual_hold_executor','public.transaction_categorizations','posting_hold_batch_id','UPDATE')"),'t');
   assert.equal(sql("select has_column_privilege('plaid_residual_hold_executor','public.transaction_categorizations','meta','UPDATE')"),'f');


   assert.ok(report.functions.some(f=>f.signature==='acquire_posting_lock(uuid,uuid,timestamp with time zone,integer,text)'));
   assert.ok(report.triggers.length>0);assert.ok(report.dependencies.length>0);
   const source=JSON.parse(fs.readFileSync('tests/fixtures/stalePendingProduction/catalog.json','utf8'));
   const scope=JSON.parse(fs.readFileSync('tests/fixtures/stalePendingProduction/scope.json','utf8'));
   const ordered=rows=>rows.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
   for(const key of ['columns','constraints','indexes','policies','triggers','relations']){
    const relevant=row=>scope.relations.includes(row.relation||row.tablename||row.name);
    assert.deepEqual(ordered(report[key].filter(relevant)),ordered(source[key].filter(relevant)),key);
   }
  });
  const captured=JSON.parse(fs.readFileSync('tests/fixtures/stalePendingProduction/catalog.json','utf8'));
  await t.test('schema-only fixture contains every scoped production function, security setting and ACL',()=>{
   const scope=JSON.parse(fs.readFileSync('tests/fixtures/stalePendingProduction/scope.json','utf8'));
   for(const f of captured.functions.filter(f=>scope.functions.includes(f.signature))){
    const actual=JSON.parse(sql(`select jsonb_build_object('definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(proowner),'config',proconfig,'acl',proacl) from pg_proc p where oid='public.${f.signature}'::regprocedure`));
    assert.deepEqual(actual,{definition:f.definition,owner:f.owner,config:f.config,acl:f.acl},f.signature);
   }
  });
  const before=sql("select md5(pg_get_functiondef('public.get_bookkeeping_transactions_bounded(uuid,text,text,date,date,integer,integer)'::regprocedure))");
  await t.test('migration failure rolls back DDL, constraints and permissions atomically',()=>{
   assert.throws(()=>sql(migration.replace("notify pgrst, 'reload schema';","select 1/0; notify pgrst, 'reload schema';")),/division by zero/);
   assert.equal(sql("select to_regclass('public.statement_pending_feature') is null"),'t');
   assert.equal(sql("select md5(pg_get_functiondef('public.get_bookkeeping_transactions_bounded(uuid,text,text,date,date,integer,integer)'::regprocedure))"),before);
  });
  const lockSignature='public.acquire_posting_lock(uuid,uuid,timestamptz,integer,text)';
  const lockMetadata=()=>JSON.parse(sql(`select jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,'result',prorettype,'body',prosrc) from pg_proc where oid='${lockSignature}'::regprocedure`));
  const originalLock=lockMetadata();
  await t.test('missing required contracts fail closed and roll back every new object',()=>{
   for(const signature of [lockSignature,'public.approve_bookkeeping_with_admission(uuid,uuid,text,jsonb,boolean)',
    'public.auto_post_technical_block(public.transaction_categorizations,text,jsonb,date)']){
    const rename=`alter function ${signature} rename to missing_release_prerequisite;`;
    assert.throws(()=>sql(`begin;${rename}${migration.replace(/^begin;$/m,'')}`),/required_contract_missing/);
    assert.equal(sql("select to_regclass('public.statement_pending_feature') is null"),'t');
    assert.deepEqual(lockMetadata(),originalLock);
   }
  });
  sql(migration);sql(migration);
  await t.test('actual production timestamptz lock preserves body, owner, ACL, security and configuration',()=>{
   const adapted=lockMetadata();
   adapted.body=adapted.body.replace(/ perform public\.lock_statement_pending_ids\(p_business_id,array\[p_transaction_id\]\);\n/, '');
   // The adapter replaces BEGIN's spelling only; every original statement stays.
   adapted.body=adapted.body.replace(/^begin$/m,'BEGIN');
   assert.deepEqual(adapted,originalLock);
   assert.equal(sql("select to_regprocedure('public.acquire_posting_lock(uuid,uuid,text,integer,text)') is null"),'t');
   assert.equal(sql(`select definition=pg_get_functiondef('${lockSignature}'::regprocedure) from public.statement_pending_installation_snapshot where key='${lockSignature}'`),'f');
  });
  await t.test('historical compatibility schema reruns and legacy permissions remain',()=>{
   assert.equal(sql("select enabled from public.statement_pending_feature where singleton"),'f');
   assert.equal(sql("select has_function_privilege('service_role','public.confirm_pending_transaction_settled(uuid,uuid,uuid,text,date,numeric,text,text,integer)','EXECUTE')"),'t');
   assert.equal(sql("select has_function_privilege('authenticated','public.release_statement_pending_review(uuid,uuid,jsonb,text)','EXECUTE')"),'f');
  });
  await t.test('before-use forward rollback restores prior classification and constraints',()=>{
   sql(fs.readFileSync('supabase/rollback/stale_pending_before_use.sql','utf8'));
   assert.equal(sql("select md5(pg_get_functiondef('public.get_bookkeeping_transactions_bounded(uuid,text,text,date,date,integer,integer)'::regprocedure))"),before);
   assert.equal(sql("select count(*) from pg_trigger where tgname='aaa_statement_pending_fence'"),'0');
   assert.deepEqual(lockMetadata(),originalLock);
   sql(migration);
  });
  sql(`insert into auth.users(id) values('${actor}');`,"supabase_admin");
  sql(`insert into public.user_profiles(id,email) values('${actor}','synthetic@example.invalid');insert into public.internal_staff_users(user_id,role) values('${actor}','owner_admin');`);
  await t.test('availability stage failure rolls back its function rewrite and grants',()=>{
   const before=sql("select pg_get_functiondef('public.statement_pending_feature_enabled(uuid)'::regprocedure)");
   assert.throws(()=>sql(availability.replace("notify pgrst, 'reload schema';","select 1/0; notify pgrst, 'reload schema';")),/division by zero/);
   assert.equal(sql("select pg_get_functiondef('public.statement_pending_feature_enabled(uuid)'::regprocedure)"),before);
  });
  sql(availability);sql(availability);
  await t.test('permanent migration fails atomically; preserves existing containment and RPC ACLs; reruns safely',()=>{
   const existing=fixture();
   sql(`insert into public.pending_transaction_resolution_events(business_id,transaction_id,action,resulting_state,actor_user_id,idempotency_key,evidence)
    values('${existing.business}','${existing.id}','refresh_status','stale_pending_check_required','${actor}','${randomUUID()}','{"existing_audit":true}');`);
   const history=sql(`select md5(to_jsonb(b)::text)||(select count(*) from public.pending_transaction_resolution_events) from public.bank_transactions b where id='${existing.id}'`);
   assert.throws(()=>sql(permanent.replace("notify pgrst, 'reload schema';","select 1/0; notify pgrst, 'reload schema';")),/division by zero/);
   assert.equal(sql("select to_regclass('public.statement_pending_feature') is not null"),'t');
   sql('update public.statement_pending_feature set contained=true');
   const prior=sql("select proacl::text from pg_proc where oid='public.resolve_stale_pending_admin(uuid,uuid,uuid,text,text,boolean,date,numeric,uuid,text,date)'::regprocedure");
   sql(permanent);sql(permanent);
   assert.equal(sql(`select md5(to_jsonb(b)::text)||(select count(*) from public.pending_transaction_resolution_events) from public.bank_transactions b where id='${existing.id}'`),history);
   assert.equal(sql("select contained from public.statement_pending_posting_containment where singleton"),'t');
   assert.equal(sql("select proacl::text from pg_proc where oid='public.resolve_stale_pending_admin(uuid,uuid,uuid,text,text,boolean,date,numeric,uuid,text,date)'::regprocedure"),prior);
   assert.equal(sql("select to_regclass('public.statement_pending_feature') is null and to_regclass('public.statement_pending_business_allowlist') is null"),'t');
   assert.equal(sql("select to_regprocedure('public.statement_pending_capability(uuid)') is null and to_regprocedure('public.statement_pending_feature_enabled(uuid)') is null"),'t');
   // No availability/configuration records are required, even for future businesses.
   sql('delete from public.statement_pending_posting_containment');
  });
  await t.test('before-use rollback revokes mutation RPCs before removing permanent guards',()=>{
   assert.equal(sql("select to_regclass('public.statement_pending_posting_containment') is not null"),'t');
   const rollback=fs.readFileSync('supabase/rollback/stale_pending_before_use.sql','utf8').replace(/^begin;$/m,'').replace(/^commit;$/m,'');
   const result=JSON.parse(sql(`begin;${rollback}
    select jsonb_build_object('can_resolve',has_function_privilege('service_role','public.resolve_stale_pending_admin(uuid,uuid,uuid,text,text,boolean,date,numeric,uuid,text,date)','execute'),
     'can_release',has_function_privilege('service_role','public.release_statement_pending_review(uuid,uuid,jsonb,text)','execute'),
     'guards',(select count(*) from pg_trigger where tgname='aaa_statement_pending_fence'));rollback;`));
   assert.deepEqual(result,{can_resolve:false,can_release:false,guards:0});
   assert.equal(sql("select has_function_privilege('service_role','public.resolve_stale_pending_admin(uuid,uuid,uuid,text,text,boolean,date,numeric,uuid,text,date)','execute')"),'t');
  });
  const scopeCorrection=fs.readFileSync('supabase/migrations/20261120220000_stale_pending_durable_account_scope.sql','utf8');
  function legacyFixture(){const f=fixture();sql(`update public.bank_transactions set physical_account_id=null where id='${f.id}';update public.plaid_accounts set physical_account_id=null where business_id='${f.business}';`);return f;}
  const legacy=legacyFixture(),legacyKey=randomUUID();
  await t.test('observed legacy account-scope 409 leaves bank, GL and audit unchanged',()=>{
   const before=sql(`select to_jsonb(b)::text from public.bank_transactions b where id='${legacy.id}'`);
   assert.throws(()=>sql(confirmSql(legacy,{request:legacyKey})),/pending_account_scope_missing/);
   assert.equal(sql(`select to_jsonb(b)::text from public.bank_transactions b where id='${legacy.id}'`),before);
   assert.equal(sql(`select count(*) from public.pending_transaction_resolution_events where business_id='${legacy.business}'`),'0');
   assert.equal(sql(`select count(*) from public.transaction_categorizations where business_id='${legacy.business}'`),'0');
  });
  await t.test('scope correction is atomic, private and rerunnable',()=>{
   assert.throws(()=>sql(scopeCorrection.replace("notify pgrst,'reload schema';","select 1/0; notify pgrst,'reload schema';")),/division by zero/);
   assert.equal(sql("select to_regprocedure('public.statement_pending_scope_identity(public.bank_transactions,boolean)') is null"),'t');
   sql(scopeCorrection);sql(scopeCorrection);
   assert.equal(sql("select has_function_privilege('authenticated','public.statement_pending_scope_identity(public.bank_transactions,boolean)','EXECUTE')"),'f');
  });
  await t.test('legacy provider account completes the unchanged lifecycle without physical-ID backfill',()=>{
   sql(confirmSql(legacy,{request:legacyKey}));
   assert.match(sql(`select pending_resolution_payload->>'canonical_account_scope' from public.bank_transactions where id='${legacy.id}'`),/^provider:/);
   assert.equal(sql(`select pending||'|'||(physical_account_id is null) from public.bank_transactions where id='${legacy.id}'`),'true|true');
   assert.equal(sql(`select status||'|'||(final_qbo_account_id is null)||'|'||(post_after is null) from public.transaction_categorizations where transaction_id='${legacy.id}'`),'needs_review|true|true');
   assert.throws(()=>claim(legacy),/not_released/);sql(releaseSql(legacy));
   sql(`select public.admit_handled_auto_post(p_business_id=>'${legacy.business}',p_enabled=>true,p_ids=>array['${legacy.id}'::uuid]);`);
   const c=claim(legacy);assert.equal(sql(checkSql(legacy,context(legacy,c.intent))),'');finish(legacy);
   assert.equal(sql(`select physical_account_id is null from public.plaid_accounts where business_id='${legacy.business}'`),'t');
  });
  await t.test('bank scope derives from an existing verified account link; ambiguous or wrong-item links hold',()=>{
   const f=fixture();sql(`update public.bank_transactions set physical_account_id=null where id='${f.id}'`);
   sql(confirmSql(f));assert.equal(sql(`select pending_resolution_payload->>'canonical_account_scope' from public.bank_transactions where id='${f.id}'`),`physical:${f.physical}`);
   for(const status of ['linked_existing_provider_identity','new_physical_account','linked_existing']){sql(`update public.plaid_accounts set relink_status='${status}' where business_id='${f.business}'`);assert.equal(sql(`select public.statement_pending_scope_identity(b,true) from public.bank_transactions b where id='${f.id}'`),`physical:${f.physical}`);}
   const ambiguous=legacyFixture();sql(`update public.plaid_accounts set relink_status='ambiguous' where business_id='${ambiguous.business}'`);
   assert.throws(()=>sql(confirmSql(ambiguous)),/pending_account_scope_missing/);
   assert.equal(sql(`select public.pending_accounting_block('${ambiguous.business}','${ambiguous.id}')`),'pending_account_scope_missing');
   const candidate=legacyFixture();sql(`insert into public.plaid_replacement_account_candidates(business_id,plaid_env,plaid_item_id,plaid_account_id,account_snapshot,status) values('${candidate.business}','production','${candidate.key}','${candidate.key}','{}','pending')`);
   assert.throws(()=>sql(confirmSql(candidate)),/pending_account_scope_missing/);
   const wrong=legacyFixture();sql(`update public.bank_transactions set plaid_item_id='different-item' where id='${wrong.id}'`);
   assert.throws(()=>sql(confirmSql(wrong)),/pending_account_scope_missing/);
  });
  await t.test('legacy provider duplicates and later settlement preserve one accounting identity',()=>{
   const f=legacyFixture();sql(counterpartSql(f,{explicit:false}).sql);assert.throws(()=>sql(confirmSql(f)),/replacement_or_duplicate/);
   const g=legacyFixture();sql(confirmSql(g));sql(releaseSql(g));const r=counterpartSql(g);sql(r.sql);
   assert.equal(sql(`select pending_canonical_transaction_id from public.bank_transactions where id='${r.id}'`),g.id);
   claim(g);finish(g);
  });
  await t.test('legacy provider ingestion and confirmation share the same narrow serialization key',async()=>{
   const f=legacyFixture();const held=asyncSql(`begin;select public.lock_statement_pending_account(b) from public.bank_transactions b where id='${f.id}';select pg_sleep(0.7);commit;`);held.catch(()=>{});
   await new Promise(r=>setTimeout(r,150));
   assert.throws(()=>sql(confirmSql(f)),/account_busy/);
   assert.throws(()=>sql(`select public.write_plaid_bank_rows_serialized('${f.business}','[{"id":"${f.id}","name":"Concurrent sync"}]',true)`),/account_busy/);
   await held;const request=randomUUID();const result=sql(confirmSql(f,{request}));sql(releaseSql(f));
   sql(`update public.plaid_accounts set relink_status='ambiguous' where business_id='${f.business}'`);
   assert.match(sql(checkSql(f,{})),/account_scope_changed/);
   assert.equal(sql(confirmSql(f,{request})),result);
  });
  await t.test('multiple existing and newly created businesses can confirm without configuration records',()=>{
   const first=fixture(),second=fixture();sql(confirmSql(first));sql(confirmSql(second));
   const createdLater=fixture();sql(confirmSql(createdLater));
   for(const f of [first,second,createdLater]) assert.equal(state(f),'statement_review_override');
  });
  await t.test('recent, unattested and cross-business requests fail',()=>{
   assert.throws(()=>sql(confirmSql(fixture({age:2}))),/pending_too_recent/);
   const f=fixture();assert.throws(()=>sql(confirmSql(f,{attested:false})),/statement_confirmation_required/);
   const other=fixture();assert.throws(()=>sql(confirmSql({...f,business:other.business})),/pending_account_scope_missing|transaction_not_found/);
   assert.throws(()=>sql(confirmSql(f,{actorId:randomUUID()})),/internal_admin_required/);
  });
  await t.test('production lease logic retains first idempotency key, busy lease, expiry and posted rejection',()=>{
   const f=fixture();
   sql(`insert into public.transaction_categorizations(business_id,transaction_id,status) values('${f.business}','${f.id}','needs_review');`);
   const lock=(time,key)=>sql(`select public.acquire_posting_lock('${f.business}','${f.id}',${time},600,'${key}');`);
   assert.equal(lock("'2026-11-19T12:00:00Z'::timestamptz",'first'),'t');
   assert.equal(lock("'2026-11-19T12:01:00Z'::timestamptz",'retry'),'f');
   assert.equal(lock("'2026-11-19T12:11:00Z'::timestamptz",'retry'),'t');
   assert.equal(sql(`select meta->>'post_idempotency_key' from public.transaction_categorizations where transaction_id='${f.id}'`),'first');
   sql(`update public.transaction_categorizations set qbo_txn_id='synthetic-receipt' where transaction_id='${f.id}'`);
   assert.equal(lock("'2026-11-19T12:30:00Z'::timestamptz",'third'),'f');
  });
  await t.test('confirmation -> Needs Review -> manual category -> Handled -> normal scheduler -> posted',async()=>{
   const f=fixture();sql(`select public.admit_handled_auto_post(p_business_id=>'${f.business}',p_enabled=>true);`);sql(confirmSql(f));
   assert.equal(state(f),'statement_review_override');
   assert.equal(sql(`select pending from public.bank_transactions where id='${f.id}'`),'t');
   assert.equal(sql(`select status||'|'||(post_after is null)||'|'||(final_qbo_account_id is null) from public.transaction_categorizations where transaction_id='${f.id}'`),'needs_review|true|true');
   assert.throws(()=>claim(f),/not_released/);
   // A legacy lease is not posting authority: no approval/schedule is granted.
   const leaseOnly=sql(`begin;select public.acquire_posting_lock('${f.business}','${f.id}',now(),600,'confirmation-only');select status||'|'||(post_after is null)||'|'||(final_qbo_account_id is null) from public.transaction_categorizations where transaction_id='${f.id}';select public.check_statement_pending_posting('${f.business}','${f.id}','{}');rollback;`);
   assert.match(leaseOnly,/needs_review\|true\|true/);assert.match(leaseOnly,/statement_pending_not_released/);
   sql(releaseSql(f));assert.equal(state(f),'statement_review_released');
   assert.ok(Number(sql(`select count(*) from public.bookkeeping_lifecycle_events where transaction_id='${f.id}' and new_review_status='handled'`))>0);
   assert.equal(sql(`select status||'|'||review_status from public.transaction_categorizations where transaction_id='${f.id}'`),'approved|handled');
   sql(`select public.admit_handled_auto_post(p_business_id=>'${f.business}',p_ids=>array['${f.id}'::uuid],p_source=>'handled');`);
   assert.equal(sql(`select post_after is not null from public.transaction_categorizations where transaction_id='${f.id}'`),'t');
   const c=claim(f),ctx=context(f,c.intent);let writes=0;
   const fake=guardQboWrites({createPurchase:async()=>{writes++;return {Id:'synthetic'};}},async()=>{const reason=sql(checkSql(f,ctx));if(reason)throw new Error(reason);});
   await fake.createPurchase();assert.equal(writes,1);finish(f);
   assert.equal(sql(`select status from public.transaction_categorizations where transaction_id='${f.id}'`),'posted');
   assert.equal(sql(`select pending from public.bank_transactions where id='${f.id}'`),'t');
   assert.throws(()=>sql(releaseSql(f)),/already_posted|not_needs_review/);
  });
  await t.test('release requires a verified GL and a human decision; confirmation cannot schedule',()=>{
   const f=fixture();sql(confirmSql(f));
   assert.throws(()=>sql(`update public.transaction_categorizations set status='auto_approved',final_qbo_account_id='meals',post_after=now() where transaction_id='${f.id}'`),/not_released/);
   assert.throws(()=>sql(releaseSql(f).replace('"admin_manual"','"automatic_rule"')),/manual_category/);
   assert.throws(()=>sql(releaseSql(f).replace('"admin_manual"','null')),/manual_category/);
   assert.throws(()=>sql(releaseSql(f).replace('"approved"','null')),/manual_category/);
   assert.throws(()=>sql(releaseSql(f).replace('"meals"','"foreign-account"')),/final_account_unverified/);
  });
  await t.test('same identity settlement preserves canonical row, release and one posting opportunity',()=>{
   const f=fixture();sql(confirmSql(f));sql(releaseSql(f));
   sql(`select public.write_plaid_bank_rows_serialized('${f.business}','[{"id":"${f.id}","pending":false,"plaid_transaction_id":"settled-${f.id}","pending_transaction_id":"pending-${f.id}"}]',true)`);
   assert.equal(state(f),'statement_review_released');
   assert.equal(sql(`select count(*) from public.bank_transactions where business_id='${f.business}'`),'1');
   assert.equal(sql(`select pending_resolution_payload->>'original_pending' from public.bank_transactions where id='${f.id}'`),'true');
   claim(f);finish(f);
  });
  await t.test('separate verified replacement before approval aliases to canonical identity and permits release',()=>{
   const f=fixture();sql(confirmSql(f));const r=counterpartSql(f);sql(r.sql);
   assert.equal(state(f),'statement_review_settled');
   assert.equal(sql(`select pending_canonical_transaction_id||'|'||is_archived from public.bank_transactions where id='${r.id}'`),`${f.id}|true`);
   sql(releaseSql(f));claim(f);finish(f);
   assert.throws(()=>sql(`select public.claim_qbo_posting_intent('${f.business}','${r.id}','${f.realm}','production','Purchase','alias-request','alias-key')`),/superseded/);
  });
  await t.test('replacement before scheduling, during posting, and after posting never opens a second path',()=>{
   for(const phase of ['before-schedule','during-post','after-post']){
    const f=fixture();sql(confirmSql(f));sql(releaseSql(f));
    const c=phase==='before-schedule'?null:claim(f);if(phase==='after-post')finish(f);
    const r=counterpartSql(f);sql(r.sql);assert.equal(state(f),'statement_review_released');
    if(c&&phase!=='after-post'){assert.equal(sql(checkSql(f,context(f,c.intent))),'');finish(f);}
    assert.equal(sql(`select count(*) from public.bank_transactions where business_id='${f.business}' and not is_archived`),'1');
   }
  });
  await t.test('conflicting material settlement cancels fresh posting, preserves in-flight/posted receipt evidence',async()=>{
   for(const phase of ['before-release','before-schedule','before-boundary','after-post']){
    const f=fixture();sql(confirmSql(f));if(phase!=='before-release')sql(releaseSql(f));
    const c=['before-boundary','after-post'].includes(phase)?claim(f):null;if(phase==='after-post')finish(f);
    sql(counterpartSql(f,{amount:-15}).sql);assert.equal(state(f),'statement_review_conflict');
    if(phase==='before-release')assert.throws(()=>sql(releaseSql(f)),/conflict/);
    if(phase==='before-schedule')assert.throws(()=>sql(`update public.transaction_categorizations set post_after=now() where transaction_id='${f.id}'`),/conflict|not_released/);
    if(phase==='before-boundary'){
     let writes=0;const client=guardQboWrites({createPurchase:()=>{writes++;}},async()=>{const reason=sql(checkSql(f,context(f,c.intent)));if(reason)throw new Error(reason);});
     await assert.rejects(client.createPurchase(),/conflict/);assert.equal(writes,0);
     // An already in-flight response must still be durably recordable.
     finish(f);
    }
    if(phase==='after-post')assert.equal(sql(`select qbo_txn_id from public.qbo_posted_transactions where transaction_id='${f.id}'`),`receipt-${f.id}`);
   }
  });
  await t.test('same account/date alone is not a candidate; ambiguous genuine matches hold both without rewriting approvals',()=>{
   const f=fixture();sql(confirmSql(f));sql(releaseSql(f));
   const unrelated=counterpartSql(f,{explicit:false,name:'Entirely Unrelated',amount:-10});sql(unrelated.sql);
   assert.equal(sql(`select pending_canonical_transaction_id is null from public.bank_transactions where id='${unrelated.id}'`),'t');
   const second=randomUUID();sql(`insert into public.bank_transactions(id,business_id,plaid_item_id,plaid_account_id,physical_account_id,plaid_env,plaid_transaction_id,date,authorized_date,name,merchant_name,amount,direction,pending) select '${second}',business_id,plaid_item_id,plaid_account_id,physical_account_id,plaid_env,'${second}',date,authorized_date,name,merchant_name,amount,direction,true from public.bank_transactions where id='${f.id}';`);
   // Confirm the second before it has a settled candidate.
   sql(confirmSql({...f,id:second}));const r=counterpartSql(f,{explicit:false});sql(r.sql);
   assert.equal(sql(`select pending_resolution_state||'|'||(pending_canonical_transaction_id is null) from public.bank_transactions where id='${r.id}'`),'statement_review_conflict|true');
   assert.equal(sql(`select status from public.transaction_categorizations where transaction_id='${f.id}'`),'approved');
   assert.throws(()=>claim(f),/replacement_conflict/);
  });
  await t.test('archived/removed, matched/excluded/reconciled and independent receipts/attempts fail closed',()=>{
   for(const change of ["is_archived=true","archived_reason='plaid_removed'"]){const f=fixture();sql(confirmSql(f));sql(`update public.bank_transactions set ${change} where id='${f.id}'`);assert.throws(()=>sql(releaseSql(f)),/removed/);}
   for(const change of ["status='excluded'","status='matched_existing_qbo'","reconciled_at=now()"]){const f=fixture();sql(confirmSql(f));sql(`update public.transaction_categorizations set ${change} where transaction_id='${f.id}'`);assert.throws(()=>sql(releaseSql(f)),/accounting_conflict/);}
   const f=fixture();sql(confirmSql(f));sql(releaseSql(f));claim(f);assert.throws(()=>sql(`update public.transaction_categorizations set post_after=now() where transaction_id='${f.id}'`),/prior_posting_evidence/);
  });
  await t.test('stale suggestion cannot undo release; deliberate Undo revokes authority and supports fresh manual approval',()=>{
   const f=fixture();sql(confirmSql(f));sql(releaseSql(f));
   sql(`update public.transaction_categorizations set status='needs_review',final_qbo_account_id=null,final_qbo_account_name=null where transaction_id='${f.id}'`);
   assert.equal(state(f),'statement_review_released');
   assert.equal(sql(`select status from public.transaction_categorizations where transaction_id='${f.id}'`),'approved');
   sql(`update public.transaction_categorizations set status='needs_review',final_qbo_account_id=null,final_qbo_account_name=null,decided_by='user',decided_at=clock_timestamp(),post_error=null where transaction_id='${f.id}'`);
   assert.equal(state(f),'statement_review_override');
   assert.equal(sql(`select status||'|'||(meta->>'statement_pending_review_epoch') from public.transaction_categorizations where transaction_id='${f.id}'`),'needs_review|1');
   sql(releaseSql(f));assert.equal(state(f),'statement_review_released');
   assert.ok(Number(sql(`select count(*) from public.bookkeeping_lifecycle_events where transaction_id='${f.id}' and new_review_status='handled'`))>0);
  });
  await t.test('inactive source rows do not erase persisted receipt conflicts',()=>{
   const f=fixture(),r=counterpartSql(f);
   sql(r.sql);
   sql(`update public.bank_transactions set is_archived=true where id='${r.id}';insert into public.qbo_posted_transactions(business_id,transaction_id,qbo_env,realm_id,qbo_txn_type,status,qbo_txn_id) values('${f.business}','${r.id}','production','${f.realm}','Purchase','posted','historical');`);
   assert.throws(()=>sql(confirmSql(f)),/historical_receipt_conflict/);
  });
  await t.test('verified already-accounted counterpart links without changing it; authorization replay stays archived',()=>{
   const f=fixture(),r=counterpartSql(f);sql(r.sql);
   sql(`insert into public.qbo_posted_transactions(business_id,transaction_id,qbo_env,realm_id,qbo_txn_type,status,qbo_txn_id) values('${f.business}','${r.id}','production','${f.realm}','Purchase','posted','accounted');`);
   sql(`select public.resolve_stale_pending_admin('${f.business}','${f.id}','${actor}','use-posted-replacement','${randomUUID()}',true,null,null,'${r.id}',null,date_trunc('month',current_date-20)::date);`);
   sql(`update public.bank_transactions set is_archived=false,pending=true where id='${f.id}'`);
   assert.equal(sql(`select is_archived||'|'||pending_canonical_transaction_id from public.bank_transactions where id='${f.id}'`),`true|${r.id}`);
   assert.equal(sql(`select qbo_txn_id from public.qbo_posted_transactions where transaction_id='${r.id}'`),'accounted');
  });
  await t.test('production lock ACL forbids authenticated customers, including foreign business calls',()=>{
   const f=fixture();sql(confirmSql(f));sql(releaseSql(f));
   assert.throws(()=>sql(`set role authenticated;set request.jwt.claims='{"role":"authenticated","sub":"${randomUUID()}"}';select public.acquire_posting_lock('${f.business}','${f.id}',now(),600,'foreign');`),/permission denied/);
  });
  await t.test('old backend RPC and old feed contracts remain available while the new feature is off',()=>{
   const f=fixture();
   const result=JSON.parse(sql(`select public.confirm_pending_transaction_settled('${f.business}','${f.id}','${actor}','synthetic',current_date-1,10,null,'${randomUUID()}',1)`));
   assert.equal(result.state,'promoted_to_settled');
   assert.equal(sql(`select public.count_bookkeeping_transactions_bounded('${f.business}','needs_review')`),'1');
  });
  await t.test('completed confirmation/release replays precede mutable eligibility without feature configuration',()=>{
   const f=fixture(),key=randomUUID(),rkey=randomUUID();const first=sql(confirmSql(f,{request:key}));const released=sql(releaseSql(f,{request:rkey}));
   sql(`update public.bank_transactions set is_archived=true where id='${f.id}'`);
   assert.equal(sql(confirmSql(f,{request:key})),first);
   assert.equal(sql(releaseSql(f,{request:rkey})),released);
   assert.throws(()=>sql(releaseSql(f,{request:rkey}).replace('"meals"','"foreign"')),/idempotency_key_reused/);
  });
  await t.test('concurrent resolution and sync use account fence; unrelated accounts do not wait; same key retries once',async()=>{
   const f=fixture();const held=asyncSql(`begin;select public.lock_statement_pending_account(b) from public.bank_transactions b where id='${f.id}';select pg_sleep(0.7);commit;`);held.catch(()=>{});
   await new Promise(r=>setTimeout(r,150));
   assert.throws(()=>sql(confirmSql(f)),/account_busy/);
   assert.throws(()=>sql(`select public.write_plaid_bank_rows_serialized('${f.business}','[{"id":"${f.id}","name":"Sync"}]',true)`),/account_busy/);
   const other=fixture();sql(confirmSql(other));await held;sql(confirmSql(f));
   const request=randomUUID(),g=fixture();const [a,b]=await Promise.allSettled([asyncSql(confirmSql(g,{request})),asyncSql(confirmSql(g,{request}))]);
   assert.ok(a.status==='fulfilled'||b.status==='fulfilled');
   assert.equal(JSON.parse(sql(confirmSql(g,{request}))).state,'statement_review_override');
   assert.equal(sql(`select count(*) from public.pending_transaction_resolution_events where business_id='${g.business}'`),'1');
  });
  await t.test('bounded row lock timeout aborts and stable-key retry succeeds',async()=>{
   const f=fixture(),key=randomUUID();
   const held=asyncSql(`begin;select 1 from public.bank_transactions where id='${f.id}' for update;select pg_sleep(2.6);commit;`);held.catch(()=>{});
   await new Promise(r=>setTimeout(r,150));assert.throws(()=>sql(`set lock_timeout='100ms';${confirmSql(f,{request:key})}`),/lock timeout|account_busy/);
   await held;sql(confirmSql(f,{request:key}));
  });
  await t.test('production vehicle lock composes with account fencing: bounded timeout and stable-key retry',async()=>{
   const f=fixture(),request=randomUUID();
   const held=asyncSql(`begin;select pg_advisory_xact_lock(hashtextextended('${f.business}:vehicle-election',0));select pg_sleep(2.6);commit;`);held.catch(()=>{});
   await new Promise(r=>setTimeout(r,180));
   assert.throws(()=>sql(confirmSql(f,{request})),/lock timeout/);
   assert.equal(sql(`select count(*) from public.pending_transaction_resolution_events where business_id='${f.business}'`),'0');
   await held;sql(confirmSql(f,{request}));
   assert.equal(sql(`select count(*) from public.pending_transaction_resolution_events where business_id='${f.business}'`),'1');
  });
  await t.test('inverse legacy vehicle/account order fails immediately instead of deadlocking',async()=>{
   const f=fixture();
   const held=asyncSql(`begin;select public.lock_statement_pending_account(b) from public.bank_transactions b where id='${f.id}';select pg_sleep(0.7);commit;`);held.catch(()=>{});
   await new Promise(r=>setTimeout(r,180));
   assert.throws(()=>sql(`begin;select pg_advisory_xact_lock(hashtextextended('${f.business}:vehicle-election',0));update public.bank_transactions set name='Legacy edit' where id='${f.id}';commit;`),/account_busy/);
   await held;sql(confirmSql(f));
  });
  await t.test('financial containment preserves posting protections without becoming a confirmation availability gate',()=>{
   const f=fixture();sql(confirmSql(f));sql(releaseSql(f));
   const c=claim(f);assert.equal(sql(checkSql(f,context(f,c.intent))),'');
   assert.equal(sql('select count(*) from public.statement_pending_posting_containment'),'0');
   sql(fs.readFileSync('supabase/rollback/stale_pending_containment.sql','utf8'));
   assert.equal(sql(checkSql(f,context(f,c.intent))),'statement_pending_contained');finish(f);
   const review=fixture();sql(confirmSql(review));assert.equal(state(review),'statement_review_override');
   assert.throws(()=>sql(releaseSql(review)),/statement_pending_contained/);
   assert.throws(()=>sql(fs.readFileSync('supabase/rollback/stale_pending_before_use.sql','utf8')),/use_containment/);
  });
 }finally{docker(['rm','-f',container]);}
});
