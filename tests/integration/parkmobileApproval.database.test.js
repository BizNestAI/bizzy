/* global process */
import test from 'node:test';
import {verifyParkmobileWorker} from '../helpers/parkmobilePostingWorkerCase.js';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {stalePendingResolutionDatabaseSchema} from '../helpers/stalePendingResolutionDatabaseSchema.js';
import {withCanonicalDatabase} from '../helpers/canonicalRecheckDatabase.js';
const container=`bizzi-parkmobile-${process.pid}`,network=`${container}-net`,business=randomUUID();
function docker(args,input){const r=spawnSync('docker',args,{input,encoding:'utf8',maxBuffer:32e6});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
let ready=false;
function sql(text){return docker(['exec','-i',container,'psql','-U',ready?'postgres':'supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1','-Atq'],text);}
function seedAuthUser(id){docker(['exec','-i',container,'psql','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1'],`insert into auth.users(id) values('${id}');`);}
async function ok(query){const r=await query;assert.equal(r.error,null,JSON.stringify(r.error));return r.data;}
test('Parkmobile normal import, categorization and approval with real PostgreSQL; no external providers',{timeout:90000},async t=>{
 try{
  docker(['network','create','--internal',network]);
  docker(['run','--pull=never','--name',container,'--network',network,'-e','POSTGRES_USER=supabase_admin','-e','POSTGRES_PASSWORD=local-only','-d','postgres:17']);
  for(let i=0;i<100;i++){if(spawnSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','supabase_admin']).status===0)break;await new Promise(r=>setTimeout(r,100));}
  const directory=`/private/tmp/${container}-catalog`;fs.mkdirSync(directory,{recursive:true});
  for(const file of ['catalog.json','supplement.json','scope-roots.json'])fs.copyFileSync(`tests/fixtures/stalePendingProduction/${file}`,`${directory}/${file}`);
  const roots=JSON.parse(fs.readFileSync(`${directory}/scope-roots.json`));roots.relations=[...new Set([...roots.relations,'vendor_rules','transaction_splits','bookkeeping_posting_eligibility_rechecks'])];
  fs.writeFileSync(`${directory}/scope-roots.json`,JSON.stringify(roots));
  const build=spawnSync(process.execPath,['scripts/buildStalePendingCatalogFixture.js',directory],{encoding:'utf8'});assert.equal(build.status,0,build.stderr);
  const original=fs.readFileSync('tests/fixtures/stalePendingProduction/prerequisites.sql','utf8');
  const transitions=stalePendingResolutionDatabaseSchema({includeScopeCorrection:true}).slice(original.length);
  sql(fs.readFileSync(`${directory}/prerequisites.sql`,'utf8')+transitions);ready=true;
  for(const file of ['20261120233000_handled_exclusion_posting_safety.sql','20261123230000_canonical_posting_shape_authority.sql','20261124000000_restore_posting_execution_taxonomy_guard.sql','20261124020000_pre_provider_posting_failure_lifecycle.sql'])sql(fs.readFileSync(`supabase/migrations/${file}`,'utf8'));
  const identityMigration=fs.readFileSync('supabase/migrations/20261125000000_admin_plaid_identity_review_approval.sql','utf8');
  const existingAdapter=sql("select md5(pg_get_functiondef('public.approve_bookkeeping_with_admission(uuid,uuid,text,jsonb,boolean)'::regprocedure))");
  assert.throws(()=>sql(identityMigration.replace("notify pgrst,'reload schema';","select 1/0;notify pgrst,'reload schema';")),/division by zero/);
  assert.equal(sql("select to_regprocedure('public.approve_bookkeeping_with_identity_review(uuid,uuid,text,jsonb,boolean)') is null"),'t');
  sql(identityMigration);
  assert.equal(sql("select md5(pg_get_functiondef('public.approve_bookkeeping_with_admission(uuid,uuid,text,jsonb,boolean)'::regprocedure))"),existingAdapter);
  assert.equal(sql("select pg_get_userbyid(proowner)||'|'||prosecdef||'|'||array_to_string(proconfig,',') from pg_proc where oid='public.approve_bookkeeping_with_identity_review(uuid,uuid,text,jsonb,boolean)'::regprocedure"),'postgres|true|search_path=pg_catalog, public');
  assert.equal(sql("select has_function_privilege('service_role','public.approve_bookkeeping_with_identity_review(uuid,uuid,text,jsonb,boolean)','execute') and not has_function_privilege('authenticated','public.approve_bookkeeping_with_identity_review(uuid,uuid,text,jsonb,boolean)','execute') and not has_function_privilege('anon','public.approve_bookkeeping_with_identity_review(uuid,uuid,text,jsonb,boolean)','execute')"),'t');

  sql("alter role postgres password 'local-only';");
  await withCanonicalDatabase({container,network},async db=>{
   // Only synthetic local endpoints/credentials; helper forbids all external fetches.
   process.env.SUPABASE_URL=db.supabaseUrl;process.env.SUPABASE_SERVICE_ROLE_KEY=db.supabaseKey;
   process.env.PLAID_CLIENT_ID='synthetic';process.env.PLAID_SECRET='synthetic';process.env.PLAID_ENV='production';process.env.QB_ENVIRONMENT='production';process.env.NODE_ENV='test';
   const {runSyncForItem}=await import('../../src/services/plaid/plaidSyncService.js');
   const get=table=>db.from(table).select('*').eq('business_id',business);
   await ok(db.from('business_profiles').insert({id:business,business_name:'Synthetic',industry:'Synthetic',team_size:1,state:'NC',services_offered:'Synthetic'}));
   async function fixture(){const key=randomUUID();const [item]=await ok(db.from('plaid_items').insert({business_id:business,plaid_item_id:key,plaid_env:'production',plaid_access_token:'synthetic',status:'connected',cursor:'old'}).select());await ok(db.from('plaid_accounts').insert({business_id:business,plaid_item_id:key,plaid_account_id:key,plaid_env:'production',name:'CREDIT CARD'}));return {key,item};}
   function event(f,id,more={}){return {account_id:f.key,transaction_id:id,date:'2026-11-23',name:'Synthetic',amount:10,pending:false,...more};}
   async function sync(f,payload){const [item]=await ok(get('plaid_items').eq('id',f.item.id));return runSyncForItem({transactionsSync:async()=>({data:{added:[],modified:[],removed:[],next_cursor:'next',has_more:false,...payload}})},business,item,{db,resolveToken:async()=>'synthetic'});}
    await t.test("Parkmobile batch settlements consume pending identities once, reuse Parking, and honor manual learning", async () => {
      const f=await fixture(),physical=randomUUID(),actor=randomUUID();seedAuthUser(actor);
      sql(`insert into public.plaid_physical_accounts(id,business_id) values('${physical}','${business}');
       update public.plaid_accounts set physical_account_id='${physical}' where business_id='${business}' and plaid_account_id='${f.key}';
       insert into public.user_profiles(id,email) values('${actor}','parkmobile@example.invalid');
       insert into public.user_business_link(user_id,business_id) values('${actor}','${business}');
       update public.business_profiles set auto_post_to_quickbooks=true,bookkeeping_start_date='2026-01-01' where id='${business}';
       insert into public.quickbooks_tokens(business_id,access_token,refresh_token,realm_id,qbo_env) values('${business}','synthetic','synthetic','parkmobile-realm','production');
       insert into public.qbo_accounts_cache(business_id,realm_id,qbo_env,qbo_account_id,name,account_type) values
       ('${business}','parkmobile-realm','production','source-card','CREDIT CARD','Credit Card'),('${business}','parkmobile-realm','production','parking','Parking','Expense'),('${business}','parkmobile-realm','production','travel','Travel','Expense');
       insert into public.plaid_qbo_account_mappings(business_id,plaid_account_id,qbo_account_id,qbo_account_name,qbo_account_type) values('${business}','${f.key}','source-card','CREDIT CARD','CreditCard');`);
      const merchant={name:'PARK MOBILE CDOT PAY',merchant_name:'Parkmobile',merchant_entity_id:'synthetic-parkmobile',date:'2026-11-23',authorized_date:'2026-11-21'};
      const first=event(f,'park-pending-small',{...merchant,amount:0.87,pending:true});
      const second=event(f,'park-pending-large',{...merchant,authorized_date:'2026-11-23',amount:3.12,pending:true});
      await sync(f,{added:[first,second]});
      const pending=await ok(get('bank_transactions').eq('plaid_item_id',f.key));
      const small=pending.find(r=>r.plaid_transaction_id===first.transaction_id),large=pending.find(r=>r.plaid_transaction_id===second.transaction_id);
      const {learnVendorRuleFromTransaction}=await import('../../src/services/bookkeeping/vendorRuleLearner.js');
      const learned=await learnVendorRuleFromTransaction({db,businessId:business,bankTxn:large,finalAccountId:'parking',finalAccountName:'Parking',options:{actor:{id:actor,role:'user'}}});assert.equal(learned.ok,true,JSON.stringify(learned));
      const {reconsiderNeedsReviewTransactions}=await import('../../src/services/bookkeeping/routineExpenseReconsiderationService.js');
      const dependencies={getQBOClient:async()=>({findAccounts:(_q,cb)=>cb(null,{QueryResponse:{Account:[{Id:'parking',Name:'Parking',AccountType:'Expense',Active:true},{Id:'travel',Name:'Travel',AccountType:'Expense',Active:true}]}})})};
      const reconsider=ids=>reconsiderNeedsReviewTransactions(business,{db,transactionIds:ids,dependencies});
      await reconsider([large.id]);
      assert.equal((await ok(get('transaction_categorizations').eq('transaction_id',large.id)))[0].status,'needs_review','pending cannot auto-approve');
      const payload={added:[event(f,'park-settled-small',{...merchant,amount:0.87,pending_transaction_id:first.transaction_id}),event(f,'park-settled-large',{...merchant,amount:3.12})]};
      await sync(f,payload);
      const settled=await ok(get('bank_transactions').eq('plaid_item_id',f.key));
      assert.equal(settled.length,2,'no false duplicate row');
      assert.equal(settled.find(r=>r.plaid_transaction_id==='park-settled-small').id,small.id);
      const row=settled.find(r=>r.plaid_transaction_id==='park-settled-large');assert.equal(row.id,large.id);assert.equal(row.pending,false);assert.equal(row.accounting_review_required,false);
      await reconsider([row.id]);
      const category=()=>get('transaction_categorizations').eq('transaction_id',row.id);
      let cat=(await ok(category()))[0];assert.equal(cat.final_qbo_account_id,'parking');assert.equal(cat.status,'auto_approved');assert.ok(cat.post_after,JSON.stringify(cat));
      const jobs=()=>get('bookkeeping_posting_jobs').eq('transaction_id',row.id);
      assert.equal((await ok(jobs())).length,1);
      const deadline=cat.post_after;await sync(f,payload);await reconsider([row.id]);
      assert.equal((await ok(category()))[0].post_after,deadline);assert.equal((await ok(jobs())).length,1);
      const {approveBookkeepingTransactions}=await import('../../src/services/bookkeeping/bookkeepingApprovalService.js');
      // A separate imported, settled row exercises the normal Needs Review manual decision.
      await sync(f,{added:[event(f,'park-manual',{...merchant,date:'2026-11-25',authorized_date:'2026-11-25',amount:4.12})]});
      const manual=(await ok(get('bank_transactions').eq('plaid_transaction_id','park-manual')))[0];
      const args={db,businessId:business,actorId:actor,actorType:'user',requireNeedsReview:true,
       items:[{transaction_id:manual.id,newAccountId:'travel',newAccountName:'Travel',learn_reusable_rule:true}],
       validateSelectedAccountsFn:async()=>new Map([['travel',{id:'travel',name:'Travel',type:'Expense',active:true}]])};
      const approval=await approveBookkeepingTransactions(args);assert.equal(approval.updated,1);
      cat=(await ok(get('transaction_categorizations').eq('transaction_id',manual.id)))[0];assert.equal(cat.final_qbo_account_id,'travel');assert.ok(cat.post_after,JSON.stringify(cat));
      assert.equal((await approveBookkeepingTransactions(args)).idempotent,true);
      assert.equal((await ok(get('bookkeeping_posting_jobs').eq('transaction_id',manual.id))).length,1);
      const {getVendorRuleForTransaction}=await import('../../src/services/bookkeeping/vendorRuleMatcher.js');
      assert.equal((await getVendorRuleForTransaction({db,businessId:business,bankTransaction:manual})).default_qbo_account_id,'travel');
      await sync(f,{added:[event(f,'park-future',{...merchant,date:'2026-11-26',authorized_date:'2026-11-26',amount:5.12})]});
      const future=(await ok(get('bank_transactions').eq('plaid_transaction_id','park-future')))[0];await reconsider([future.id]);
      assert.equal((await ok(get('transaction_categorizations').eq('transaction_id',future.id)))[0].final_qbo_account_id,'travel');
      assert.equal((await ok(get('bookkeeping_posting_jobs').eq('transaction_id',future.id))).length,1);
      // A real identity-review flag still blocks both paths, including explicit GL changes.
      await sync(f,{added:[event(f,'park-review',{...merchant,date:'2026-11-27',authorized_date:'2026-11-27',amount:3.12})]});
      const review=(await ok(get('bank_transactions').eq('plaid_transaction_id','park-review')))[0];
      await ok(db.from('bank_transactions').update({accounting_review_required:true,accounting_review_reason:'plaid_relink_duplicate_review_required'}).eq('id',review.id));
      const reviewed=await reconsider([review.id]);assert.equal(reviewed.promoted,0);
      await assert.rejects(approveBookkeepingTransactions({...args,items:[{...args.items[0],transaction_id:review.id}]}),error=>error.message==='plaid_accounting_review_required' && error.status===400);
      assert.equal((await ok(get('bookkeeping_posting_jobs').eq('transaction_id',review.id).eq('state','scheduled'))).length,0);
      // Verified internal decision resolves only this settled row; pending copy is untouched.
      sql(`insert into public.internal_staff_users(user_id,role,active) values('${actor}','owner_admin',true);`);
      await sync(f,{added:[event(f,'park-review-pending',{...merchant,date:'2026-11-27',authorized_date:'2026-11-27',amount:3.12,pending:true})]});
      const candidate=(await ok(get('bank_transactions').eq('plaid_transaction_id','park-review-pending')))[0];
      // This fixture represents the already-imported, reviewed pair, not an import claim.
      await ok(db.from('bank_transactions').update({accounting_review_required:false,accounting_review_reason:null}).eq('id',candidate.id));
      const candidateBefore=(await ok(get('bank_transactions').eq('id',candidate.id)))[0];
      await ok(db.from('bank_transactions').update({accounting_review_payload:{candidate_transaction_ids:[candidate.id]}}).eq('id',review.id));
      const storedReview=(await ok(get('transaction_categorizations').eq('transaction_id',review.id)))[0];
      await ok(db.from('transaction_categorizations').update({post_error:'plaid_accounting_review_required',accounting_review_required:true,accounting_review_reason:'plaid_relink_duplicate_review_required',
       meta:{...storedReview.meta,plaid_duplicate_review_required:true,plaid_duplicate_review_payload:{candidate_transaction_ids:[candidate.id]},post_block_reason:'plaid_relink_duplicate_review_required'}}).eq('id',storedReview.id));
      const approveReview=()=>approveBookkeepingTransactions({...args,actorType:'admin',verifiedDistinctPurchase:true,verifiedPurchaseSnapshot:{transaction_id:review.id,date:review.date,amount:review.amount,direction:review.direction,plaid_account_id:review.plaid_account_id},items:[{...args.items[0],transaction_id:review.id,newAccountId:'parking',newAccountName:'Parking'}],validateSelectedAccountsFn:async()=>new Map([['parking',{id:'parking',name:'Parking',type:'Expense',active:true}]])});
      await assert.rejects(approveBookkeepingTransactions({...args,verifiedDistinctPurchase:true,items:[{...args.items[0],transaction_id:review.id}]}),error=>error.status===403);
      const before=(await ok(get('bank_transactions').eq('id',review.id)))[0];
      // Any existing intent, even an unconfirmed/failed one, requires reconciliation first.
      const [intent]=await ok(db.from('qbo_posted_transactions').insert({business_id:business,transaction_id:review.id,qbo_txn_type:'Purchase',status:'unknown',qbo_env:'production',realm_id:'parkmobile-realm'}).select());
      await assert.rejects(approveReview(),error=>error.error==='identity_review_posting_evidence_requires_reconciliation');
      assert.deepEqual((await ok(get('bank_transactions').eq('id',review.id)))[0],before,'failure rolls back review clearing');
      await ok(db.from('qbo_posted_transactions').delete().eq('id',intent.id));
      const reviewCat=(await ok(get('transaction_categorizations').eq('transaction_id',review.id)))[0];
      await ok(db.from('transaction_categorizations').update({meta:{...reviewCat.meta,ambiguous_provider_outcome:true}}).eq('id',reviewCat.id));
      await assert.rejects(approveReview());
      assert.equal((await ok(get('bank_transactions').eq('id',review.id)))[0].accounting_review_required,true);
      await ok(db.from('transaction_categorizations').update({meta:reviewCat.meta}).eq('id',reviewCat.id));
      const reviewJob=(await ok(get('bookkeeping_posting_jobs').eq('transaction_id',review.id)))[0];
      await ok(db.from('bookkeeping_posting_jobs').update({state:'processing',lease_owner:'synthetic-active-worker',lease_expires_at:new Date(Date.now()+60000).toISOString()}).eq('id',reviewJob.id));
      await assert.rejects(approveReview());
      assert.equal((await ok(get('bank_transactions').eq('id',review.id)))[0].accounting_review_required,true);
      await ok(db.from('bookkeeping_posting_jobs').update({state:reviewJob.state,lease_owner:reviewJob.lease_owner,lease_expires_at:reviewJob.lease_expires_at}).eq('id',reviewJob.id));

      await ok(db.from('bank_transactions').update({pending:true}).eq('id',review.id));
      await assert.rejects(approveReview(),error=>error.error==='pending_transaction_not_postable');
      await ok(db.from('bank_transactions').update({pending:false}).eq('id',review.id));
      await ok(db.from('bank_transactions').update({accounting_review_reason:'plaid_modified_after_qbo_post'}).eq('id',review.id));
      await assert.rejects(approveReview(),error=>error.error==='identity_review_not_eligible');
      await ok(db.from('bank_transactions').update({accounting_review_reason:'plaid_relink_duplicate_review_required'}).eq('id',review.id));
      await ok(db.from('internal_staff_users').update({active:false}).eq('user_id',actor));
      await assert.rejects(approveReview());
      assert.equal((await ok(get('bank_transactions').eq('id',review.id)))[0].accounting_review_required,true);
      await ok(db.from('internal_staff_users').update({active:true}).eq('user_id',actor));
      await assert.rejects(approveBookkeepingTransactions({...args,businessId:randomUUID(),actorType:'admin',verifiedDistinctPurchase:true,items:[{...args.items[0],transaction_id:review.id}]}));
      const saved=await approveReview();assert.equal(saved.updated,1);
      const approved=(await ok(get('transaction_categorizations').eq('transaction_id',review.id)))[0];
      assert.equal(approved.final_qbo_account_id,'parking');assert.equal(approved.status,'approved');assert.ok(approved.post_after);assert.equal(approved.review_status,'handled');
      assert.equal(approved.meta.plaid_identity_review.actor_id,actor);assert.equal(approved.meta.plaid_identity_review.decision,'verified_distinct_purchase');
      assert.equal((await ok(get('bank_transactions').eq('id',review.id)))[0].accounting_review_required,false);
      assert.deepEqual((await ok(get('bank_transactions').eq('id',candidate.id)))[0],candidateBefore);
      assert.equal((await ok(get('bookkeeping_posting_jobs').eq('transaction_id',review.id).eq('state','scheduled'))).length,1);
      const repeated=await approveReview();assert.equal(repeated.idempotent,true);
      const rawReplay=await db.rpc('approve_bookkeeping_with_identity_review',{p_business_id:business,p_actor_id:actor,p_actor_type:'admin',p_require_needs_review:true,
       p_approvals:[{...approved,approval_idempotency_key:approved.meta.approval_idempotency_key,plaid_identity_review:{verified_distinct_purchase:true,expected_updated_at:before.updated_at}}]});
      assert.equal(rawReplay.error,null,JSON.stringify(rawReplay.error));
      const auditEvent=(await ok(get('bookkeeping_approval_events').eq('transaction_id',review.id)))[0];
      assert.equal(auditEvent.metadata.plaid_identity_review.prior_review.reason,'plaid_relink_duplicate_review_required');
      assert.deepEqual(auditEvent.metadata.plaid_identity_review.candidate_ids,[candidate.id]);

      assert.equal((await ok(get('bookkeeping_approval_events').eq('transaction_id',review.id))).length,1);
      assert.equal((await ok(get('bookkeeping_posting_jobs').eq('transaction_id',review.id))).length,1);
      await verifyParkmobileWorker({db,businessId:business,transactionId:review.id,postAfter:approved.post_after});
      // Represented receipts remain authoritative on import replay; never create another job.
      await ok(db.from('transaction_categorizations').update({status:'posted',qbo_txn_id:'synthetic-receipt',posted_at:new Date().toISOString()}).eq('transaction_id',row.id));
      await sync(f,payload);await reconsider([row.id]);
      assert.equal((await ok(category()))[0].qbo_txn_id,'synthetic-receipt');assert.equal((await ok(jobs())).length,1);

    });

  });
 }finally{spawnSync('docker',['rm','-f',container]);spawnSync('docker',['network','rm',network]);}
});
