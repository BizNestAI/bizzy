/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {withCanonicalDatabase} from '../helpers/canonicalRecheckDatabase.js';
import {stalePendingResolutionDatabaseSchema} from '../helpers/stalePendingResolutionDatabaseSchema.js';
const container=`bizzi-pending-summary-${process.pid}`,network=`${container}-net`;
function docker(args,input){const r=spawnSync('docker',args,{input,encoding:'utf8',maxBuffer:32e6});if(r.status)throw Error(r.stderr);return r.stdout.trim();}
const sql=(text,user='postgres')=>docker(['exec','-i',container,'psql','-h','127.0.0.1','-U',user,'-d','postgres','-X','-Atq','-v','ON_ERROR_STOP=1'],text);
const migration=fs.readFileSync('supabase/migrations/20261124010000_bound_monthly_pending_summary_candidates.sql','utf8');
test('scoped November MRP summary preserves counts and loads below the unchanged eight-second timeout',{timeout:180000},async t=>{
 try{
  docker(['network','create','--internal',network]);
  docker(['run','--pull=never','--network',network,'--name',container,'-e','POSTGRES_USER=supabase_admin','-e','POSTGRES_DB=postgres','-e','POSTGRES_PASSWORD=synthetic','-d','postgres:17']);
  for(let i=0;i<100;i++){if(spawnSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','supabase_admin']).status===0)break;await new Promise(r=>setTimeout(r,100));}
  sql(stalePendingResolutionDatabaseSchema({includeMigration:false}),'supabase_admin');
  sql("alter role postgres login password 'local-only';",'supabase_admin');
  for(const file of ['20261117230000_stale_pending_admin_resolution.sql','20261118220000_stale_pending_global_admin_availability.sql','20261118230000_stale_pending_permanent_admin_capability.sql'])sql(fs.readFileSync(`scripts/releases/stale-pending/supabase/migrations/${file}`,'utf8'));
  sql(fs.readFileSync('supabase/migrations/20261120220000_stale_pending_durable_account_scope.sql','utf8'));
  const actor=randomUUID(),business=randomUUID(),foreign=randomUUID(),physical=randomUUID(),otherPhysical=randomUUID();
  sql(`insert into auth.users(id) values('${actor}')`,'supabase_admin');
  sql(`insert into public.user_profiles(id,email) values('${actor}','synthetic@example.invalid');
   insert into public.business_profiles(id,user_id,business_name,industry,team_size,state,services_offered,bookkeeping_start_date) values('${business}','${actor}','Synthetic', 'Synthetic',1,'NC','Synthetic','2026-11-02'),('${foreign}','${actor}','Other','Synthetic',1,'NC','Synthetic','2026-01-01');
   insert into public.plaid_physical_accounts(id,business_id) values('${physical}','${business}'),('${otherPhysical}','${foreign}');
   insert into public.plaid_items(business_id,plaid_item_id,plaid_access_token,plaid_env,status) values('${business}','main-item','synthetic','production','connected'),('${foreign}','other-item','synthetic','production','connected');
   insert into public.plaid_accounts(business_id,plaid_item_id,plaid_account_id,physical_account_id,plaid_env,name) values('${business}','main-item','main-account','${physical}','production','Synthetic'),('${foreign}','other-item','other-account','${otherPhysical}','production','Other');
   insert into public.bank_transactions(id,business_id,plaid_item_id,plaid_account_id,physical_account_id,plaid_env,plaid_transaction_id,date,authorized_date,name,merchant_name,amount,direction,pending)
   select gen_random_uuid(),'${business}','main-item','main-account','${physical}','production','nov-'||n,'2026-11-10','2026-11-10',case when n<=14 then 'Pending Merchant '||n else 'Synthetic' end,case when n<=14 then 'Pending Merchant '||n else 'Synthetic' end,case when n<=14 then -28 else -19 end,'OUTFLOW',n<=14 from generate_series(1,115) n;
   insert into public.transaction_categorizations(business_id,transaction_id,status,meta,qbo_txn_id,posted_at)
   select business_id,id,case when substring(plaid_transaction_id from 5)::int<=23 then 'approved' when substring(plaid_transaction_id from 5)::int<=107 then 'posted' else 'matched_existing_qbo' end,'{}',case when substring(plaid_transaction_id from 5)::int between 24 and 107 then 'synthetic-receipt-'||plaid_transaction_id end,case when substring(plaid_transaction_id from 5)::int between 24 and 107 then now() end
   from public.bank_transactions where business_id='${business}' and not pending;
   insert into public.bank_transactions(business_id,plaid_item_id,plaid_account_id,physical_account_id,plaid_env,plaid_transaction_id,date,name,amount,direction,pending) values('${business}','main-item','main-account','${physical}','production','before-cutoff','2026-11-01','Excluded by active scope',-19,'OUTFLOW',false);
   insert into public.bank_transactions(business_id,plaid_item_id,plaid_account_id,physical_account_id,plaid_env,plaid_transaction_id,date,name,amount,direction,pending)
   select '${business}','main-item','main-account','${physical}','production','history-'||n,'2025-10-01','Older history',-99,'OUTFLOW',false from generate_series(1,880) n;
   insert into public.bank_transactions(business_id,plaid_item_id,plaid_account_id,physical_account_id,plaid_env,plaid_transaction_id,date,name,merchant_name,amount,direction,pending)
   select '${foreign}','other-item','other-account','${otherPhysical}','production','foreign-'||n,'2026-11-12','Pending Merchant 4','Pending Merchant 4',-28,'OUTFLOW',false from generate_series(1,3000) n;
   update public.bank_transactions set amount=-28,name='Pending Merchant '||(substring(plaid_transaction_id from 5)::int-23),merchant_name='Pending Merchant '||(substring(plaid_transaction_id from 5)::int-23),date='2026-11-12',authorized_date='2026-11-12' where business_id='${business}' and plaid_transaction_id in ('nov-24','nov-25','nov-26');`);
  const signature="'public.monthly_pending_resolution_summary(uuid,text,date,date)'::regprocedure";
  const properties=()=>sql(`select to_jsonb(p)-'prosrc' from pg_proc p where p.oid=${signature}`);
  const before=properties(),originalBody=sql(`select prosrc from pg_proc where oid=${signature}`);
  const releaseBaseline=sql(fs.readFileSync('scripts/releases/monthly-pending-summary/capture-properties.sql','utf8'));
  const summary=`select public.monthly_pending_resolution_summary('${business}',null,'2026-11-01','2026-12-01')`;
  await t.test('baseline unbounded summary diagnosis is measured without raising its timeout',()=>{
   const start=performance.now();let timedOut=false;try{sql(`begin read only;set local statement_timeout='8s';${summary};rollback;`);}catch(e){assert.match(e.message,/statement timeout/);timedOut=true;}
   console.log('SUMMARY_BASELINE',JSON.stringify({selected_month_raw:116,business_total:996,foreign_rows:3000,elapsed_ms:Math.round(performance.now()-start),timed_out:timedOut}));
  });
  await t.test('forward correction preserves properties, is idempotent, and rolls back atomically',()=>{
   assert.throws(()=>sql(migration.replace("notify pgrst, 'reload schema';","select 1/0;\nnotify pgrst, 'reload schema';")),/division by zero/);assert.equal(properties(),before);assert.equal(sql(`select prosrc from pg_proc where oid=${signature}`),originalBody);
   sql(migration);assert.equal(properties(),before);const applied=sql(`select prosrc from pg_proc where oid=${signature}`);sql(migration);assert.equal(sql(`select prosrc from pg_proc where oid=${signature}`),applied);
  });
  await t.test('all six populations and pending replacement summary load under eight seconds with exact scope',()=>{
   const start=performance.now();const result=JSON.parse(sql(`begin read only;set local statement_timeout='8s';select jsonb_build_object('summary',public.monthly_pending_resolution_summary('${business}',null,'2026-11-01','2026-12-01'),'counts',(select jsonb_object_agg(s,public.count_bookkeeping_transactions_bounded('${business}',s,null,'2026-11-01','2026-12-01')) from unnest(array['needs_review','handled','posted','matched','pending','excluded']) s));rollback;`));
   const elapsed=performance.now()-start;console.log('SUMMARY_FIXED',JSON.stringify({elapsed_ms:Math.round(elapsed),...result}));assert.ok(elapsed<8000);assert.deepEqual(result.counts,{needs_review:0,handled:9,posted:84,matched:8,pending:14,excluded:0});assert.deepEqual(result.summary,{recent_pending:0,stale_pending:11,replacement_found:3,operator_action_required:14});
   assert.deepEqual(JSON.parse(sql(`select public.monthly_pending_resolution_summary('${business}','not-this-account','2026-11-01','2026-12-01')`)),{recent_pending:0,stale_pending:0,replacement_found:0,operator_action_required:0});
  });
  await t.test('Posting Review uses the same nine unposted Handled rows without cross-business leakage',async()=>{
   process.env.SUPABASE_URL='http://127.0.0.1:1';process.env.SUPABASE_SERVICE_ROLE_KEY='synthetic-local-test-only';
   await withCanonicalDatabase({container,network},async db=>{
    const {getCanonicalPostingBacklogSummary}=await import('../../src/services/bookkeeping/autoPostControl.js');
    const result=await getCanonicalPostingBacklogSummary({db,businessId:business,rangeStart:'2026-11-01',rangeEnd:'2026-12-01',effectiveDate:'2026-11-01'});
    assert.equal(result.headline_count,9);assert.equal(result.bucket_total,9);assert.equal(result.rows.length,9);
    const other=await getCanonicalPostingBacklogSummary({db,businessId:foreign,rangeStart:'2026-11-01',rangeEnd:'2026-12-01'});assert.equal(other.headline_count,0);
   });
  });
  await t.test('explicit replacement lineage remains valid across month and amount differences',()=>{
   sql(`insert into public.bank_transactions(business_id,plaid_item_id,plaid_account_id,physical_account_id,plaid_env,plaid_transaction_id,pending_transaction_id,date,name,amount,direction,pending)
    values('${business}','main-item','main-account','${physical}','production','late-replacement','nov-4','2026-12-10','Different settled descriptor',-29,'OUTFLOW',false);`);
   // Existing summary eligibility excludes explicit supersessions even outside
   // the review month; the independent replacement authority remains unchanged.
   assert.equal(sql(`select public.pending_replacement_candidate(a,b) from public.bank_transactions a join public.bank_transactions b on b.business_id=a.business_id where a.business_id='${business}' and a.plaid_transaction_id='nov-4' and b.plaid_transaction_id='late-replacement'`),'t');
   assert.deepEqual(JSON.parse(sql(summary)),{recent_pending:0,stale_pending:10,replacement_found:3,operator_action_required:13});
  });
  await t.test('packaged read-only verification validates ledger, unchanged properties, bounds, authority and timed populations',()=>{
   const ledger=JSON.parse(fs.readFileSync('scripts/releases/monthly-pending-summary/ledger.json'));
   sql(`create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text);grant usage on schema supabase_migrations to postgres;grant select on supabase_migrations.schema_migrations to postgres;${[...ledger.migration_history,{version:'20261124010000',name:'bound_monthly_pending_summary_candidates'}].map(r=>`insert into supabase_migrations.schema_migrations values('${r.version}','${r.name}');`).join('')}`,'supabase_admin');
   const verification=fs.readFileSync('scripts/releases/monthly-pending-summary/verify.sql','utf8').replaceAll('cffc2183-e77c-4148-a206-d5192e090925',business).replace(":'expected_properties'",`'${releaseBaseline.replaceAll("'","''")}'`);
   const result=sql(verification);assert.match(result,/^t\|t\|t\|t\|t\|t\|/m);assert.match(result,/\|t\|t$/m);
   assert.equal(sql(`select count(*) from supabase_migrations.schema_migrations`),'10');
   assert.equal(properties(),before);
   assert.match(sql(verification.replace(releaseBaseline.replaceAll("'","''"),JSON.stringify({...JSON.parse(releaseBaseline),owner:'unexpected_owner'}).replaceAll("'","''"))),/^t\|t\|f\|/m);
  });
 }finally{docker(['rm','-f',container]);docker(['network','rm',network]);}
});
