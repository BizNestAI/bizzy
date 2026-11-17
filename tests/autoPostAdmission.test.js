/* global Buffer, process */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { admitHandledAutoPost, continueAutoPostAdmissions, prepareHandledAdmissionRow, boundedAdmissionMeta, registerSettledHandledAdmissions } from "../src/services/bookkeeping/autoPostAdmission.js";
import { guardQboWrites, assertPostingExecutionIntegrity, postingAttemptEvidence } from "../src/services/bookkeeping/postingExecutionIntegrity.js";
import { booksPostingStartupDecision } from "../src/jobs/backgroundWorkerStartup.js";
import { admissionNotice, shouldRefreshAdmission, admissionRefreshDelay, ADMISSION_REFRESH_LIMIT } from "../src/utils/autoPostAdmissionView.js";
import { matchAdminBookkeepingWrite } from "../src/services/adminBookkeepingAccess.js";
import { persistAuthoritativeFinalCategorizations } from "../src/services/bookkeeping/finalCategorizationPersistenceService.js";
const read=f=>fs.readFileSync(f,'utf8');
function chain(data,error=null){const q={then:resolve=>Promise.resolve(resolve({data,error})),select:()=>q,eq:()=>q,in:()=>q,is:()=>q,order:()=>q,limit:()=>q,maybeSingle:()=>q};return q;}
test('provider-free bounded RPC returns all counts, business identity and exact manifest',async()=>{
 const result=await admitHandledAutoPost({businessId:'business',enabled:true,transactionIds:['id'],previewHash:'hash',previewAt:'time',db:{rpc:async(name,args)=>{
  assert.equal(name,'admit_handled_auto_post');assert.equal(args.p_business_id,'business');assert.equal(args.p_limit,2000);assert.equal(args.p_enabled,true);assert.equal(args.p_grace_hours,24);assert.equal(args.p_preview_hash,'hash');assert.deepEqual(args.p_ids,['id']);
  return {data:{ok:true,scheduled:12,technically_blocked:3,reason_counts:{pending:3}}};}}});
 assert.equal(result.scheduled,12);assert.equal(result.technically_blocked,3);assert.deepEqual(result.reason_counts,{pending:3});
});
test('failure returns actual policy and redacts raw errors, without fallback mutation',async()=>{
 const result=await admitHandledAutoPost({businessId:'business',db:{rpc:async()=>({error:{code:'23514',message:'private transaction description'}}),from:name=>{assert.equal(name,'business_profiles');return chain({auto_post_to_quickbooks:true});}}});
 assert.equal(result.auto_post_to_quickbooks,true);assert.equal(result.state,'retry');assert.equal(result.sqlstate,'23514');assert.ok(!JSON.stringify(result).includes('private'));
});
test('only scoped serialization/deadlock RPC errors retry; no universal writer retry',async()=>{
 let calls=0;const result=await admitHandledAutoPost({db:{rpc:async()=>++calls<3?{error:{code:calls===1?'40001':'40P01'}}:{data:{ok:true}}}});assert.equal(calls,3);assert.equal(result.ok,true);
});
test('canonical approval retries only known-aborted transactions and keeps failed rows out of admission',async()=>{
 let calls=0;
 await persistAuthoritativeFinalCategorizations({businessId:'business',approvalSource:'customer_manual',rows:[{transaction_id:'id',status:'failed',final_qbo_account_id:'account',final_qbo_account_name:'Name'}],db:{rpc:async(name)=>{
   assert.equal(name,'approve_bookkeeping_with_admission');calls++;return calls<3?{error:{code:calls===1?'40P01':'40001'}}:{data:[]};
 }}});
 assert.equal(calls,3);
});
for(const status of ['approved','auto_approved','handled'])test(`canonical ${status} enrolls with false confidence`,()=>{
 const row=prepareHandledAdmissionRow({status,final_qbo_account_id:'account',post_after:'2099-01-01',meta:{safe_to_auto_post:false,user_decision:'keep'}});
 assert.equal(row.meta.auto_post_admission.state,'pending');assert.equal(row.post_after,null);assert.equal(row.meta.user_decision,'keep');
});
for(const status of ['failed','needs_review','uncategorized'])test(`canonical ${status} does not enroll`,()=>{
 const row={status,final_qbo_account_id:'account'};assert.equal(prepareHandledAdmissionRow(row),row);
});
test('canonical existing deadline and specialized workflows unchanged',()=>{
 for(const extra of [{qbo_txn_id:'receipt'},{meta:{taxonomy_type:'cc_payment'}}]){const row={status:'approved',final_qbo_account_id:'account',...extra};assert.equal(prepareHandledAdmissionRow(row),row);}
});
test('bounded retry evidence has finite byte/count impact after 150 failures',()=>{
 let meta={unrelated:{keep:true}};for(let i=0;i<150;i++)meta=boundedAdmissionMeta(meta,{state:'retry',source:'handled',at:new Date().toISOString(),reason:'technical_recheck_unavailable'});
 assert.equal(meta.auto_post_admission.recent.length,4);assert.equal(meta.auto_post_admission.total,150);assert.equal(meta.auto_post_admission.older_compacted,146);assert.ok(Buffer.byteLength(JSON.stringify(meta.auto_post_admission))<=4096);assert.deepEqual(meta.unrelated,{keep:true});
});
test('periodic fallback scans only new enrolled rows, bounded businesses and IDs',async()=>{
 const predicates=[];const q=chain([{transaction_id:'a',business_id:'b',meta:{auto_post_admission:{version:2,state:'pending'}}},{transaction_id:'old',business_id:'b',meta:{}}]);q.eq=(...args)=>{predicates.push(args);return q;};q.in=(...args)=>{predicates.push(args);return q;};q.limit=n=>{assert.equal(n,100);return q;};
 const result=await continueAutoPostAdmissions({from:name=>{assert.equal(name,'transaction_categorizations');return q;},rpc:async(name,args)=>{assert.deepEqual(args.p_ids,['a']);assert.equal(args.p_source,'handled');return {data:{ok:true,scheduled:1}};}});
 assert.equal(result[0].scheduled,1);assert.equal(predicates[0][0],'business_profiles.auto_post_to_quickbooks');
});
test('pending transition registers only explicit approved settlement identities and preserves metadata',async()=>{
 const updates=[];const q=chain([{transaction_id:'id',status:'approved',final_qbo_account_id:'account',meta:{user_decision:'keep'},updated_at:'time'}]);q.update=value=>{updates.push(value);return chain([]);};
 await registerSettledHandledAdmissions({db:{from:()=>q},businessId:'business',transactionIds:['id']});assert.equal(updates.length,1);assert.equal(updates[0].meta.user_decision,'keep');assert.equal(updates[0].meta.auto_post_admission.state,'pending');
});
test('canonical startup disable wins over all overrides; nonproduction default off',()=>{
 assert.equal(booksPostingStartupDecision({}).enabled,false);assert.equal(booksPostingStartupDecision({BACKGROUND_WORKERS_OVERRIDE:'true'}).enabled,true);
 assert.equal(booksPostingStartupDecision({DISABLE_BACKGROUND_WORKERS:'true',BACKGROUND_WORKERS_OVERRIDE:'true'}).enabled,false);
 assert.equal(booksPostingStartupDecision({DISABLE_BOOKS_POST_CRON:'TRUE',BACKGROUND_WORKERS_OVERRIDE:'true'}).enabled,false);
 const worker=read('src/jobs/booksPost.cron.js');const wake=worker.slice(worker.indexOf('export function signalBooksPostingWakeup'));
 assert.match(wake,/booksPostingStartupDecision/);
});
test('every provider mutator revalidates; rejected callback and Promise calls never reach provider',async()=>{
 let blocked=false,checks=0,writes=0;const qbo=guardQboWrites({createPurchase:async()=>{writes++;return 'ok';},createVendor:(_p,cb)=>{writes++;cb(null,'vendor');},findAccounts:()=>['read'],transfer:{create:async()=>{writes++;}}},async()=>{checks++;if(blocked)throw new Error('blocked');});
 assert.deepEqual(qbo.findAccounts(),['read']);assert.equal(checks,0);assert.equal(await qbo.createPurchase({}),'ok');blocked=true;
 await assert.rejects(qbo.createPurchase({}),/blocked/);await assert.rejects(qbo.transfer.create({}),/blocked/);
 await new Promise(resolve=>qbo.createVendor({},error=>{assert.match(error.message,/blocked/);resolve();}));assert.equal(writes,1);assert.equal(checks,4);
});
test('execution check fails closed on unavailable RPC, foreign lease and current blocker',async()=>{
 for(const result of [{error:{}},{data:'foreign_or_stale_posting_lease'},{data:'accounting_period_locked'}])await assert.rejects(assertPostingExecutionIntegrity({db:{rpc:async()=>result},context:{owner:'worker'}}),/technical integrity/);
 await assertPostingExecutionIntegrity({db:{rpc:async()=>({data:null})},context:{owner:'worker'}});
 const worker=read('src/jobs/booksPost.cron.js');assert.equal((worker.match(/guardQboWrites\(qbo,/g)||[]).length,2);
});
test('client preserves complete partial admission response; old frontend omits activation flag',async()=>{
 const source=read('src/services/bookkeeping/bookkeepingClient.js');const snippet=source.slice(source.indexOf('export async function getAutoPostStatus'),source.indexOf('export async function previewAutoPostBacklogScope')).replaceAll('export ','');
 const calls=[];const partial={ok:false,auto_post_to_quickbooks:true,state:'retry',retryable_failure_count:1,reason_counts:{hold:2}};
 const client=new Function('safeFetch','apiUrl','withBizHeaders',`${snippet};return {getAutoPostStatus,updateAutoPostStatus};`)(async(url,args)=>{calls.push({url,args});return partial;},x=>x,()=>({}));
 assert.deepEqual(await client.updateAutoPostStatus('b',{enabled:true,handledAdmissionVersion:2}),partial);
 await assert.rejects(client.updateAutoPostStatus('b',{enabled:true}));assert.equal(JSON.parse(calls[1].args.body).handled_admission_version,undefined);
 await client.getAutoPostStatus('b');assert.equal(calls[2].url,'/api/bookkeeping/posting/auto-post');
});
test('client also retains a complete partial response from a non-2xx transport error',async()=>{
 const source=read('src/services/bookkeeping/bookkeepingClient.js');const snippet=source.slice(source.indexOf('export async function getAutoPostStatus'),source.indexOf('export async function previewAutoPostBacklogScope')).replaceAll('export ','');
 const body={ok:false,auto_post_to_quickbooks:true,state:'retry',scheduled:0};
 const update=new Function('safeFetch','apiUrl','withBizHeaders',`${snippet};return updateAutoPostStatus;`)(async()=>{throw {status:503,body};},x=>x,()=>({}));
 assert.deepEqual(await update('b',{enabled:true,handledAdmissionVersion:2}),body);
});
test('UI retry state follows actual toggle, bounded hidden-aware polling stops on completion and terminal',()=>{
 const retry={auto_post_to_quickbooks:true,state:'retry'};assert.equal(admissionNotice(retry),'Scheduling needs retry');assert.equal(shouldRefreshAdmission(retry),true);
 for(const state of ['complete','terminal'])assert.equal(shouldRefreshAdmission({...retry,state}),false);
 assert.equal(shouldRefreshAdmission({...retry,worker:{enabled:false}}),false);assert.equal(shouldRefreshAdmission({...retry,auto_post_to_quickbooks:false}),false);
 assert.equal(ADMISSION_REFRESH_LIMIT,6);assert.equal(admissionRefreshDelay(10),30000);
 const ui=read('src/pages/accounting/BookkeepingCleanup.jsx');assert.match(ui,/visibilityState==="hidden"/);assert.match(ui,/setAutoPostStatus\(res/);assert.match(ui,/admissionNotice\(autoPostStatus\)/);
});
test('Admin View explicitly allowlists read-only preview and write repair, staff authorization remains mounted',()=>{
 const preview=matchAdminBookkeepingWrite({method:'POST',originalUrl:'/api/bookkeeping/posting/auto-post/admission-preview'});assert.equal(preview.readOnly,true);
 const repair=matchAdminBookkeepingWrite({method:'POST',originalUrl:'/api/bookkeeping/posting/auto-post/admission-repair'});assert.equal(repair.readOnly,false);
 const routes=read('src/api/bookkeeping/routes/bookkeeping.posting.routes.js');for(const endpoint of ['admission-preview','admission-repair'])assert.match(routes,new RegExp(endpoint+'", requireAuth, requireInternalRole\\(MONTHLY_REVIEW_STAFF_ROLES\\)'));
 assert.match(read('src/api/_shared/adminBookkeepingAudit.js'),/readOnly/);assert.match(read('src/api/_shared/tenantAuth.js'),/readOnly/);
});
test('replacement migration is dormant and has only five functions, zero new columns/triggers/fences',()=>{
 const sql=read('supabase/migrations/20261111220000_auto_post_handled_admission.sql');assert.equal((sql.match(/create or replace function/g)||[]).length,5);assert.doesNotMatch(sql,/create trigger|add column|pg_advisory/i);assert.match(sql,/admission_snapshot_changed/);assert.match(sql,/failed_requires_existing_retry_workflow/);assert.doesNotMatch(sql,/bookkeeping_lifecycle_events|previous_legacy_status/);
});

test('current-attempt evidence preserves exact claim time and binds owner, request and generation',()=>{
 const context={claimed_at:'2026-11-16T12:00:00.123456+00:00',owner:'worker',request_id:'request',generation:'generation'};
 const attempt=postingAttemptEvidence(context,Date.parse(context.claimed_at));assert.equal(attempt.attemptedAt,context.claimed_at);
 assert.deepEqual(attempt.payloadSummary,{posting_execution_owner:'worker',posting_request_id:'request',posting_claimed_at:context.claimed_at,posting_generation:'generation'});
 assert.throws(()=>postingAttemptEvidence({claimed_at:'invalid'}),/posting_claim_timestamp_required/);
});

test('effective-date client sends the retained exact manifest without a second scope commit',async()=>{
 const source=read('src/services/bookkeeping/bookkeepingClient.js');
 const snippet=source.slice(source.indexOf('export async function getAutoPostStatus'),source.indexOf('export async function previewAutoPostBacklogScope')).replaceAll('export ','');
 const calls=[];const preview={ok:true,preview_hash:'exact-hash',preview_at:'exact-time'};
 const client=new Function('safeFetch','apiUrl','withBizHeaders',`${snippet};return {previewAutoPostAdmissionScope,updateAutoPostStatus};`)(async(url,args)=>{calls.push({url,args});return calls.length===1?preview:{ok:false,auto_post_to_quickbooks:true,state:'retry'};},x=>x,()=>({}));
 const manifest=await client.previewAutoPostAdmissionScope('b',{effectiveDate:'2026-11-01'});
 const result=await client.updateAutoPostStatus('b',{enabled:true,scopeMode:'effective_date',effectiveDate:'2026-11-01',handledAdmissionVersion:2,admissionPreview:manifest});
 assert.equal(calls.length,2);assert.match(calls[0].url,/scope-preview\?effective_date=2026-11-01/);
 assert.deepEqual(JSON.parse(calls[1].args.body).admission_preview,preview);assert.equal(result.state,'retry');
});

test('mounted Admin View and staff checks reject customers/inactive staff; preview passes without write capability',async()=>{
 // No credentials are loaded and no network methods are used by these doubles.
 process.env.SUPABASE_URL='http://127.0.0.1:1';process.env.SUPABASE_SERVICE_ROLE_KEY='synthetic-local-test';
 const {rejectAdminViewWrites}=await import('../src/api/_shared/tenantAuth.js');
 const {requireInternalRole,MONTHLY_REVIEW_STAFF_ROLES}=await import('../src/api/_shared/internalStaffAuth.js');
 const {requirePaidMutation}=await import('../src/api/_shared/entitlementAuth.js');
 const response=()=>({statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}});
 const request=endpoint=>({method:'POST',originalUrl:`/api/bookkeeping/posting/auto-post/${endpoint}`,auth:{userId:'staff'},tenantContext:{mode:'admin_view',businessId:'business',staffUserId:'staff',capabilities:[]}});
 const preview=request('admission-preview');let passed=false;await rejectAdminViewWrites()(preview,response(),()=>{passed=true;});assert.equal(passed,true);assert.equal(preview.adminBookkeepingAccess.readOnly,true);
 let paidPassed=false;requirePaidMutation({supabase:{from(){throw new Error('preview must not write/read entitlement');}}})(preview,response(),()=>{paidPassed=true;});assert.equal(paidPassed,true);
 const repair=request('admission-repair'),denied=response();await rejectAdminViewWrites()(repair,denied,()=>assert.fail('missing write capability'));assert.equal(denied.statusCode,403);
 for(const staff of [null,{user_id:'staff',role:'operator',active:false},{user_id:'staff',role:'customer',active:true}]){
  const res=response();await requireInternalRole(MONTHLY_REVIEW_STAFF_ROLES,{supabase:{from:()=>chain(staff)}})(preview,res,()=>assert.fail('customer/inactive allowed'));assert.equal(res.statusCode,403);
 }
 let staffPassed=false;await requireInternalRole(MONTHLY_REVIEW_STAFF_ROLES,{supabase:{from:()=>chain({user_id:'staff',role:'operator',active:true})}})(preview,response(),()=>{staffPassed=true;});assert.equal(staffPassed,true);
});
