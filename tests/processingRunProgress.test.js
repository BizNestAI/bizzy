import test from 'node:test';
import assert from 'node:assert/strict';
import { projectProcessingRun, getProcessingRunProgress } from '../src/services/bookkeeping/processingRunProgress.js';
import { createProcessingProgressCache } from '../src/services/bookkeeping/processingProgressCache.js';
import { createProcessingProgressHandler } from '../src/api/bookkeeping/processingProgress.controller.js';
const now=new Date('2027-01-01T12:00:00Z');
function fixture(n=20,account='account-a',runId='11111111-1111-4111-8111-111111111111'){
 const cohort=Array.from({length:n},(_,i)=>({transaction_id:`tx-${i}`,account_id:account,request_id:`request-${i}`,generation:runId,source:'plaid_sync',initial_status:'pending'}));
 return {accountId:account,now,run:{id:runId,plaid_item_id:'item-a',started_at:now.toISOString(),finished_at:now.toISOString()},cohort,
 requests:cohort.map(c=>({id:c.request_id,transaction_id:c.transaction_id,status:'pending',metadata:{plaid_sync_input_cursor_sha256:runId,source:'plaid_sync'},updated_at:now.toISOString()})),
 categories:cohort.map(c=>({transaction_id:c.transaction_id,status:'needs_review'}))};
}
test('immutable cohort starts at zero and advances durable outcomes to 17 auto + 3 review',()=>{
 const f=fixture();let r=projectProcessingRun(f);assert.equal(r.total_count,20);assert.equal(r.processed_count,0);assert.equal(r.state,'queued');
 for(let i=0;i<11;i++){f.requests[i].status='completed';f.categories[i].status=i<9?'auto_approved':'needs_review';}
 r=projectProcessingRun(f);assert.equal(r.processed_count,11);assert.equal(r.automatically_categorized_count,9);assert.equal(r.needs_review_count,2);
 f.requests.forEach(r=>r.status='completed');f.categories.forEach((c,i)=>c.status=i<17?'auto_approved':'needs_review');
 r=projectProcessingRun(f);assert.equal(r.state,'completed');assert.equal(r.processed_count,20);assert.equal(r.automatically_categorized_count,17);assert.equal(r.needs_review_count,3);
});
test('account cohorts and concurrent generations never combine',()=>{
 const f=fixture(2);f.cohort.push({...f.cohort[0],transaction_id:'foreign',account_id:'other'});f.requests.push({transaction_id:'unrelated',status:'completed'});
 assert.equal(projectProcessingRun(f).total_count,2);
 f.requests[0].metadata.plaid_sync_input_cursor_sha256='newer';f.requests[0].status='completed';
 const r=projectProcessingRun(f);assert.equal(r.processed_count,0);assert.equal(r.state,'queued');assert.equal(r.failed_blocked_count,0);assert.equal(r.unknown_attribution_count,1);
});
test('terminal-at-admission evidence remains stable even if a queue request is reused',()=>{const f=fixture(1);f.cohort[0].initial_status='completed';f.cohort[0].initial_categorization={status:'auto_approved'};f.requests=[];assert.equal(projectProcessingRun(f).automatically_categorized_count,1);});
test('zero-work run completes without fabricated outcomes',()=>{const r=projectProcessingRun(fixture(0));assert.equal(r.total_count,0);assert.equal(r.state,'completed');});
test('partial failure remains visible, automatic retry is separate from dead-letter block',()=>{const f=fixture(3);f.requests[0].status='completed';f.categories[0].status='auto_approved';f.requests[1].status='dead_letter';let r=projectProcessingRun(f);assert.equal(r.processed_count,1);assert.equal(r.remaining_count,2);assert.equal(r.state,'blocked');f.requests[1]={...f.requests[1],status:'failed',attempt_count:1,max_attempts:5,process_after:'2027-01-01T13:00:00Z'};r=projectProcessingRun(f);assert.equal(r.state,'retrying');assert.equal(r.automatic_retry,true);});
test('matched and excluded terminal outcomes are not called automatic categories',()=>{const f=fixture(2);f.requests.forEach(r=>r.status='completed');f.categories[0].status='matched_existing_qbo';f.categories[1].status='excluded';const r=projectProcessingRun(f);assert.equal(r.matched_count,1);assert.equal(r.excluded_count,1);assert.equal(r.automatically_categorized_count,0);});
function database(){
 const a=fixture(2);const store={plaid_accounts:[{business_id:'biz-a',plaid_item_id:'item-a',plaid_account_id:'account-a'},{business_id:'biz-b',plaid_item_id:'item-b',plaid_account_id:'account-b'}],bank_sync_runs:[{...a.run,business_id:'biz-a',plaid_item_id:'item-a',meta:{processing_cohort_version:1,processing_accounts:['account-a'],processing_cohort:a.cohort}},{...a.run,id:'22222222-2222-4222-8222-222222222222',business_id:'biz-b',plaid_item_id:'item-b',meta:{processing_cohort_version:1,processing_accounts:['account-b'],processing_cohort:[]}}],bookkeeping_processing_requests:a.requests.map(r=>({...r,business_id:'biz-a'})),transaction_categorizations:a.categories.map(c=>({...c,business_id:'biz-a'})),plaid_recovery_batch_rows:[],plaid_recovery_batches:[],bank_transactions:[],qbo_posted_transactions:[],bookkeeping_posting_jobs:[]};
 const calls=[],queries=[],idListSizes=[];
 return {store,calls,queries,idListSizes,from(table){const predicates=[],orders=[];let start=0,end=Infinity;const q={select(){return q;},eq(k,v){predicates.push(r=>r[k]===v);calls.push([table,k,v]);return q;},in(k,v){if(['id','transaction_id'].includes(k))idListSizes.push(v.length);predicates.push(r=>v.includes(r[k]));return q;},not(k,_op,v){predicates.push(r=>r[k]!==v);return q;},contains(k,v){predicates.push(r=>r[k]?.processing_cohort_version===v.processing_cohort_version&&v.processing_accounts.every(x=>r[k]?.processing_accounts?.includes(x)));return q;},order(k,o={}){orders.push([k,o.ascending!==false]);return q;},limit(n){end=n-1;return q;},range(a,b){start=a;end=b;return q;},then(resolve,reject){queries.push(table);let data=store[table].filter(r=>predicates.every(p=>p(r)));data.sort((a,b)=>{for(const[k,asc]of orders){const x=String(a[k]||'').localeCompare(String(b[k]||''));if(x)return asc?x:-x;}return 0;});return Promise.resolve({data:data.slice(start,end+1),error:null}).then(resolve,reject);}};return q;}};
}
test('direct navigation, browser refresh and recently completed discovery use durable account scope',async()=>{const db=database();db.store.bookkeeping_processing_requests.forEach(r=>r.status='completed');db.store.bank_sync_runs[0].meta.processing_outcomes=Object.fromEntries(db.store.transaction_categorizations.map(c=>[c.transaction_id,{request_status:'completed',category:c,processed_at:now.toISOString()}]));const before=JSON.stringify(db.store);for(let i=0;i<2;i++){const r=await getProcessingRunProgress({db,businessId:'biz-a',accountId:'account-a',now});assert.equal(r.run.state,'completed');assert.equal(r.run.total_count,2);}assert.equal(JSON.stringify(db.store),before);assert.ok(db.calls.filter(c=>c[1]==='business_id').every(c=>c[2]==='biz-a'));});
test('foreign account and run are unavailable, even if their IDs are known',async()=>{const db=database();await assert.rejects(getProcessingRunProgress({db,businessId:'biz-a',accountId:'account-b',now}),e=>e.status===404);const r=await getProcessingRunProgress({db,businessId:'biz-a',accountId:'account-a',runId:'22222222-2222-4222-8222-222222222222',now});assert.equal(r.run,null);});
test('run discovery deterministically picks latest account run and honors a pinned identity',async()=>{const db=database();const old=db.store.bank_sync_runs[0];old.meta.processing_cohort=old.meta.processing_cohort.map(m=>({...m,initial_status:'completed',initial_categorization:{status:'needs_review'}}));db.store.bank_sync_runs.push({...old,id:'33333333-3333-4333-8333-333333333333',started_at:'2027-01-01T12:01:00Z',meta:{...old.meta,processing_cohort:[]}});let r=await getProcessingRunProgress({db,businessId:'biz-a',accountId:'account-a',now});assert.equal(r.run.run_id,'33333333-3333-4333-8333-333333333333');r=await getProcessingRunProgress({db,businessId:'biz-a',accountId:'account-a',runId:old.id,now});assert.equal(r.run.run_id,old.id);assert.equal(r.run.total_count,2);});
function response(){return {code:200,headers:{},status(n){this.code=n;return this;},set(k,v){this.headers[k]=v;return this;},json(body){this.body=body;return this;}};}
test('authorization requires trusted resolved business; hostile headers/query cannot replace it',async()=>{const db=database();const handler=createProcessingProgressHandler({getDb:async()=>db});let res=response();await handler({query:{account_id:'account-a',business_id:'biz-a'},headers:{'x-business-id':'biz-a'}},res);assert.equal(res.code,401);res=response();await handler({business:{id:'biz-a'},query:{account_id:'account-b',business_id:'biz-b'},headers:{'x-business-id':'biz-b'}},res);assert.equal(res.code,404);});
test('status errors are redacted and do not expose provider/database errors',async()=>{const handler=createProcessingProgressHandler({getDb:async()=>{throw new Error('RAW_TOKEN DESCRIPTION CURSOR');}});const res=response();await handler({business:{id:'biz-a'},query:{account_id:'account-a'}},res);assert.equal(res.code,503);assert.doesNotMatch(JSON.stringify(res.body),/RAW_TOKEN|DESCRIPTION|CURSOR/);});

test('append-only saved outcomes survive later queue generations and user category decisions',()=>{const f=fixture(1);f.run.meta={processing_cohort_version:1,processing_outcomes:{'tx-0':{request_status:'completed',category:{status:'auto_approved'},processed_at:now.toISOString()}}};f.requests[0].metadata.source='later_manual_pass';f.categories[0].status='needs_review';const r=projectProcessingRun(f);assert.equal(r.state,'completed');assert.equal(r.automatically_categorized_count,1);assert.equal(r.needs_review_count,0);});

test('a newer zero-work checkpoint cannot hide an older active cohort',async()=>{const db=database();const old=db.store.bank_sync_runs[0];db.store.bank_sync_runs.push({...old,id:'33333333-3333-4333-8333-333333333333',started_at:'2027-01-01T12:01:00Z',meta:{...old.meta,processing_cohort:[]}});const result=await getProcessingRunProgress({db,businessId:'biz-a',accountId:'account-a',now});assert.equal(result.run.run_id,old.id);assert.equal(result.run.total_count,2);});

test('reviewed recovery uses its admitted rows and supports a pinned batch without navigation state',async()=>{const db=database();db.store.bank_sync_runs=[];const id='44444444-4444-4444-8444-444444444444';db.store.plaid_recovery_batch_rows=[{id:'row',business_id:'biz-a',plaid_item_id:'item-a',batch_id:id,plaid_account_id:'account-a',admitted_transaction_id:'tx-0'}];db.store.plaid_recovery_batches=[{business_id:'biz-a',plaid_item_id:'item-a',id,status:'imported_held',summary:{admitted_at:now.toISOString()},created_at:'2026-01-01T00:00:00Z',updated_at:now.toISOString()}];db.store.bookkeeping_processing_requests[0].metadata={source:'plaid_reviewed_recovery',recovery_batch_id:id};for(const runId of [undefined,id]){const r=await getProcessingRunProgress({db,businessId:'biz-a',accountId:'account-a',runId,now,cache:false});assert.equal(r.run.run_id,id);assert.equal(r.run.total_count,1);assert.equal(r.run.started_at,now.toISOString());}});
test('a due automatic retry remains retriable rather than being declared blocked by elapsed time',()=>{const f=fixture(1);f.requests[0]={...f.requests[0],status:'failed',process_after:'2026-01-01T00:00:00Z',attempt_count:1,max_attempts:5};const r=projectProcessingRun(f);assert.equal(r.state,'retrying');assert.equal(r.automatic_retry,true);});

function legacyRecovery(n=114) {
 const db=database(), f=fixture(n), id='44444444-4444-4444-8444-444444444444';
 db.store.bank_sync_runs=[];
 db.store.bookkeeping_processing_requests=f.requests.map(r=>({...r,business_id:'biz-a',plaid_item_id:'item-a',status:'completed',metadata:{source:'bookkeeping_catchup'}}));
 db.store.transaction_categorizations=f.categories.map((c,i)=>({...c,business_id:'biz-a',plaid_item_id:'item-a',status:i===n-1?'matched_existing_qbo':'posted',review_status:i===n-1?'matched':'handled'}));
 db.store.bank_transactions=f.cohort.map(m=>({id:m.transaction_id,business_id:'biz-a',plaid_item_id:'item-a',plaid_account_id:'account-a',pending:false}));
 db.store.plaid_recovery_batch_rows=f.cohort.map((m,i)=>({id:`row-${i}`,business_id:'biz-a',plaid_item_id:'item-a',batch_id:id,plaid_account_id:'account-a',admitted_transaction_id:m.transaction_id}));
 db.store.plaid_recovery_batches=[{id,business_id:'biz-a',plaid_item_id:'item-a',status:'released',created_at:'2026-10-08T03:06:26Z',updated_at:'2026-10-09T18:19:21Z',summary:{admitted_at:'2026-10-08T17:08:06Z',pending_replacements:4}}];
 return {db,id};
}
const discover=(db,runId)=>getProcessingRunProgress({db,businessId:'biz-a',accountId:'account-a',runId,now,cache:false});
test('released legacy 113 posted + one matched disappears for discovery and pinned reads at any age',async()=>{
 const {db,id}=legacyRecovery(); const before=JSON.stringify(db.store);
 for(const runId of [undefined,id]) {const r=await discover(db,runId);assert.equal(r.run,null);assert.equal(r.resolved_run_id,id);}
 assert.equal((await getProcessingRunProgress({db,businessId:'biz-a',accountId:'account-a',now:new Date('2026-10-09T19:00:00Z')})).run,null);
 assert.equal(JSON.stringify(db.store),before);
});
test('later normal and versioned zero-work syncs cannot resurrect a resolved recovery',async()=>{
 const {db,id}=legacyRecovery();db.store.bank_sync_runs.push({id:'later',business_id:'biz-a',plaid_item_id:'item-a',started_at:now.toISOString(),meta:{admitted_count:0}});
 assert.equal((await discover(db)).run,null);
 db.store.bank_sync_runs.push({id:'zero',business_id:'biz-a',plaid_item_id:'item-a',started_at:now.toISOString(),meta:{processing_cohort_version:1,processing_accounts:['account-a'],processing_cohort:[]}});
 assert.equal((await discover(db)).run.run_id,'zero');assert.equal((await discover(db,id)).run,null);
});
test('released legacy recovery credits completed members and preserves genuine dead letters and active work',async()=>{
 const {db}=legacyRecovery(4);db.store.transaction_categorizations[1].status='needs_review';db.store.transaction_categorizations[1].review_status='needs_review';
 db.store.bookkeeping_processing_requests[1].status='dead_letter';
 db.store.transaction_categorizations[2].status='needs_review';db.store.transaction_categorizations[2].review_status='needs_review';db.store.bookkeeping_processing_requests[2].status='processing';
 const r=(await discover(db)).run;assert.equal(r.processed_count,2);assert.equal(r.failed_blocked_count,1);assert.equal(r.processing_count,1);assert.equal(r.unknown_attribution_count,4);assert.equal(r.state,'blocked');
});
test('unknown recovery attribution with unresolved outcomes is neutral, not completion or failure',async()=>{
 const {db}=legacyRecovery(1);db.store.transaction_categorizations[0].status='needs_review';db.store.transaction_categorizations[0].review_status='needs_review';
 const r=(await discover(db)).run;assert.equal(r.processed_count,0);assert.equal(r.failed_blocked_count,0);assert.equal(r.evidence_unavailable_count,1);assert.equal(r.state,'evidence_unavailable');
 db.store.bookkeeping_processing_requests[0].status='pending';assert.equal((await discover(db)).run.state,'queued');
 db.store.bookkeeping_processing_requests[0].status='failed';assert.equal((await discover(db)).run.failed_blocked_count,1);
});
test('receipts and posted jobs resolve exact members; bank pending prevents false completion',async()=>{
 const {db}=legacyRecovery(2);db.store.transaction_categorizations=[];
 db.store.qbo_posted_transactions=[{business_id:'biz-a',plaid_item_id:'item-a',transaction_id:'tx-0',status:'posted'}];db.store.bookkeeping_posting_jobs=[{business_id:'biz-a',plaid_item_id:'item-a',transaction_id:'tx-1',state:'posted'}];
 assert.equal((await discover(db)).run,null);
 db.store.bank_transactions[0].pending=true;const r=(await discover(db)).run;assert.equal(r.processed_count,1);assert.equal(r.evidence_unavailable_count,1);
});
test('historical pending summary and stale cursor/Item metadata do not add members or reset progress',async()=>{
 const {db}=legacyRecovery();db.store.plaid_recovery_batches[0].cursor_commit={committed:false};db.store.plaid_items=[{replacement_recovery_status:'imported_held'}];
 for(let i=0;i<4;i++)db.store.plaid_recovery_batch_rows.push({id:`historical-${i}`,business_id:'biz-a',plaid_item_id:'item-a',batch_id:db.store.plaid_recovery_batches[0].id,plaid_account_id:'account-a',admitted_transaction_id:null,disposition:'pending_replacement'});
 assert.equal((await discover(db)).run,null);
});
test('ordinary missing snapshots and missing requests never fabricate failure counts',()=>{
 const f=fixture(1);f.run.meta={processing_cohort_version:1};f.requests[0].status='completed';let r=projectProcessingRun(f);assert.equal(r.state,'completed');assert.equal(r.processed_count,1);assert.equal(r.needs_review_count,1);assert.equal(r.outcome_basis,'attributed_request_current_outcome');assert.equal(r.failed_blocked_count,0);
 f.requests=[];r=projectProcessingRun(f);assert.equal(r.processed_count,0);assert.equal(r.failed_blocked_count,0);
});
test('completed queue race re-reads the immutable ordinary-run outcome before projection',async()=>{
 const db=database(),from=db.from.bind(db);let injected=false;
 db.from=table=>{if(table==='bookkeeping_processing_requests'&&!injected){injected=true;db.store.bookkeeping_processing_requests.forEach(r=>r.status='completed');db.store.bank_sync_runs[0].meta.processing_outcomes=Object.fromEntries(db.store.transaction_categorizations.map(c=>[c.transaction_id,{request_status:'completed',category:c,processed_at:now.toISOString()}]));}return from(table);};
 assert.equal((await discover(db)).run.state,'completed');
});
test('a resolved newer recovery cannot hide an older recovery with real unresolved failure',async()=>{
 const {db}=legacyRecovery(1),old='55555555-5555-4555-8555-555555555555';
 db.store.plaid_recovery_batches.push({...db.store.plaid_recovery_batches[0],id:old,summary:{admitted_at:'2026-10-01T00:00:00Z'}});
 db.store.plaid_recovery_batch_rows.push({id:'old',business_id:'biz-a',plaid_item_id:'item-a',batch_id:old,plaid_account_id:'account-a',admitted_transaction_id:'old-tx'});
 db.store.bookkeeping_processing_requests.push({id:'old-request',business_id:'biz-a',plaid_item_id:'item-a',transaction_id:'old-tx',status:'dead_letter'});
 const r=(await discover(db)).run;assert.equal(r.run_id,old);assert.equal(r.failed_blocked_count,1);
});

test('legacy handled and excluded decisions resolve without attributing them to an old queue generation',async()=>{
 const {db}=legacyRecovery(2);db.store.transaction_categorizations[0].status='auto_approved';db.store.transaction_categorizations[1].status='excluded';
 const r=await discover(db);assert.equal(r.run,null);
});
test('newer completed ordinary checkpoint does not hide unresolved released recovery',async()=>{
 const {db}=legacyRecovery(1);db.store.transaction_categorizations=[];db.store.bookkeeping_processing_requests[0].status='dead_letter';
 db.store.bank_sync_runs.push({id:'zero',business_id:'biz-a',plaid_item_id:'item-a',started_at:now.toISOString(),meta:{processing_cohort_version:1,processing_accounts:['account-a'],processing_cohort:[]}});
 assert.equal((await discover(db)).run.failed_blocked_count,1);assert.equal((await discover(db,'zero')).run.run_id,'zero');
});

const categoryCases = [
 ['handled',{status:'approved',review_status:'handled'},'other_processed_count'],
 ['needs_review',{status:'needs_review'},'needs_review_count'],
 ['posted',{status:'posted',posting_status:'posted'},'other_processed_count'],
 ['matched',{status:'matched_existing_qbo'},'matched_count'],
 ['excluded',{status:'excluded'},'excluded_count'],
];
const requestCases = [
 ['pending',{status:'pending'},'queued'],['queued',{status:'queued'},'queued'],
 ['processing',{status:'processing'},'processing'],['failed',{status:'failed'},'blocked'],
 ['blocked',{status:'blocked'},'blocked'],['dead_letter',{status:'dead_letter'},'blocked'],
 ['entitlement',{status:'pending',blocked_reason:'paid_entitlement_required'},'blocked'],
 ['completed',{status:'completed'},'completed'],['skipped',{status:'skipped'},'completed'],
];
for (const {mode,attributed,recovery} of [{mode:'ordinary',attributed:true,recovery:false},{mode:'attributed',attributed:true,recovery:true},{mode:'legacy',attributed:false,recovery:true}]) for (const [requestName,request,expected] of requestCases) for (const [categoryName,category,bucket] of categoryCases) {
 test(`${mode} processing ${requestName} takes precedence over ${categoryName}`,()=>{
  const f=fixture(1);if(recovery){f.cohort[0].recovery_batch_id=f.run.id;f.run.status='released';}else f.run.meta={processing_cohort_version:1};
  f.requests[0]={...f.requests[0],...request,metadata:!recovery?f.requests[0].metadata:attributed?{recovery_batch_id:f.run.id}:{source:'legacy'}};
  f.categories[0]={transaction_id:'tx-0',...category};f.bankTransactions=[{id:'tx-0',pending:false}];
  const r=projectProcessingRun(f),uncertain=!attributed&&expected==='completed'&&categoryName==='needs_review';
  assert.equal(r.state,uncertain?'evidence_unavailable':expected);
  assert.equal(r.processed_count,expected==='completed'&&!uncertain?1:0);
  assert.equal(r.failed_blocked_count,expected==='blocked'?1:0);
  if(expected==='completed'&&!uncertain)assert.equal(r[bucket],1);
  assert.equal(r.unknown_attribution_count,attributed?0:1);
 });
}
test('completed attributed needs-review recovery is processed and remains review work, never failure',async()=>{
 const {db,id}=legacyRecovery(1);db.store.plaid_recovery_batches[0].status='imported_held';
 db.store.bookkeeping_processing_requests[0].metadata={recovery_batch_id:id};db.store.transaction_categorizations[0]={business_id:'biz-a',transaction_id:'tx-0',status:'needs_review'};
 const r=(await discover(db,id)).run;assert.equal(r.state,'completed');assert.equal(r.processed_count,1);assert.equal(r.needs_review_count,1);assert.equal(r.failed_blocked_count,0);assert.equal(r.evidence_unavailable_count,0);
});
for(const [n,initial,steady] of [[1,7,6],[114,10,9],[1000,36,33],[1001,39,36]])test(`production-shaped ${n}-member bulk budget, coalescing, mutable outcomes and membership reuse`,async()=>{
 const {db,id}=legacyRecovery(n);
 // Production-sized UUID keys and durable receipt/posting fields, never live rows.
 const uuid=id=>'00000000-0000-4000-8000-'+String(Number(id.slice(3))+1).padStart(12,'0');
 for(const row of db.store.plaid_recovery_batch_rows)row.admitted_transaction_id=uuid(row.admitted_transaction_id);
 for(const row of db.store.bank_transactions)row.id=uuid(row.id);
 for(const table of ['bookkeeping_processing_requests','transaction_categorizations'])for(const row of db.store[table])row.transaction_id=uuid(row.transaction_id);
 for(const row of db.store.transaction_categorizations)if(row.status==='posted'){row.posted_at='2026-10-11T18:00:00Z';row.posting_status='posted';row.qbo_txn_id='receipt-'+row.transaction_id;}
 let time=0;const cache=createProcessingProgressCache({now:()=>time});
 db.store.bookkeeping_processing_requests.forEach(r=>{r.status='pending';r.metadata={recovery_batch_id:id};});
 const read=runId=>getProcessingRunProgress({db,businessId:'biz-a',accountId:'account-a',runId,now,cache});
 const [a,b]=await Promise.all([read(),read()]);assert.equal(a.run.queued_count,n);assert.deepEqual(a,b);assert.equal(db.queries.length,initial);
 a.run.processed_count=999999;assert.equal((await read()).run.processed_count,0);assert.equal(db.queries.length,initial);
 time=5000;await read(id);assert.equal(db.queries.length,initial+steady);
 time=15000;await read(id);time=35000;await read(id);assert.equal(db.queries.length,initial+3*steady);
 time=65000;db.store.bookkeeping_processing_requests[0].status='completed';const changed=await read(id);
 assert.equal(changed.run?.processed_count??n,1);assert.equal(db.queries.filter(t=>t==='plaid_recovery_batch_rows').length,Math.floor(n/500)+1);
 assert.ok(db.idListSizes.length>0);assert.ok(db.idListSizes.every(size=>size<=100));
 console.log('QUERY_BUDGET',JSON.stringify({members:n,initial,steady,firstMinute:initial+3*steady,idlePerMinute:2*steady,maxIdsPerOutcomeQuery:Math.max(...db.idListSizes)}));
});
test('progress cache scopes, TTL, error eviction, size bounds and mutable membership safety',async()=>{
 let time=0,loads=0;const cache=createProcessingProgressCache({now:()=>time,maxEntries:2,maxMembers:2,membershipTtlMs:100});const db={};
 const read=scope=>cache.result(db,scope,async()=>({load:++loads}));
 await Promise.all([read(['b','a','run']),read(['b','a','run'])]);assert.equal(loads,1);
 await read(['other-business','a','run']);await read(['b','other-account','run']);assert.equal(loads,3);
 await read(['b','a','run']);assert.equal(loads,4);await read(['b','a','other-run']);assert.equal(loads,5);
 time=2001;await read(['b','a','other-run']);assert.equal(loads,6);
 let errors=0;for(let i=0;i<2;i++)await assert.rejects(cache.result(db,['error'],async()=>{errors++;throw Error('unavailable');}));assert.equal(errors,2);
 let memberships=0;const membership=()=>cache.membership(db,['b','a','batch'],async()=>{memberships++;return [1,2,3];});await membership();await membership();assert.equal(memberships,2);
 const {db:live,id}=legacyRecovery(1);live.store.plaid_recovery_batches[0].status='imported_held';
 await getProcessingRunProgress({db:live,businessId:'biz-a',accountId:'account-a',runId:id,cache,now});time+=2001;
 await getProcessingRunProgress({db:live,businessId:'biz-a',accountId:'account-a',runId:id,cache,now});assert.equal(live.queries.filter(t=>t==='plaid_recovery_batch_rows').length,2);
});
test('membership cache expires and invalidates when released batch version changes',async()=>{
 const {db,id}=legacyRecovery(1);let time=0;const cache=createProcessingProgressCache({now:()=>time,membershipTtlMs:10000});
 const read=()=>getProcessingRunProgress({db,businessId:'biz-a',accountId:'account-a',runId:id,cache,now});
 await read();time=3000;await read();assert.equal(db.queries.filter(t=>t==='plaid_recovery_batch_rows').length,1);
 db.store.plaid_recovery_batches[0].updated_at='2027-01-01T00:00:00Z';time=6000;await read();assert.equal(db.queries.filter(t=>t==='plaid_recovery_batch_rows').length,2);
 time=17000;await read();assert.equal(db.queries.filter(t=>t==='plaid_recovery_batch_rows').length,3);
});
test('same-business foreign Item batch and foreign account membership cannot suppress an account',async()=>{
 const {db,id}=legacyRecovery(1);db.store.plaid_recovery_batches[0].plaid_item_id='other-item';
 assert.equal((await discover(db,id)).resolved_run_id,undefined);
 db.store.plaid_recovery_batches[0].plaid_item_id='item-a';db.store.plaid_recovery_batch_rows[0].plaid_account_id='other-account';
 assert.equal((await discover(db,id)).resolved_run_id,undefined);
});

test('coalescing entries cannot pin hung loads forever or share database clients',async()=>{
 let time=0,loads=0;const cache=createProcessingProgressCache({now:()=>time}),a={},b={};
 const first=cache.result(a,['business','account','run'],()=>new Promise(()=>{}));void first;
 await Promise.resolve();await cache.result(b,['business','account','run'],async()=>++loads);assert.equal(loads,1);
 time=10001;assert.equal(await cache.result(a,['business','account','run'],async()=>++loads),2);
});

test('completed categorization stays processed when downstream posting fails',async()=>{
 const f=fixture(1);f.cohort[0].recovery_batch_id=f.run.id;f.requests[0].status='completed';f.requests[0].metadata={recovery_batch_id:f.run.id};
 f.categories[0]={transaction_id:'tx-0',status:'failed_post',review_status:'handled',posting_status:'posting_failed'};
 f.bankTransactions=[{id:'tx-0',pending:false}];
 const r=projectProcessingRun(f);assert.equal(r.state,'completed');assert.equal(r.processed_count,1);assert.equal(r.failed_blocked_count,0);
 const {db}=legacyRecovery(1);db.store.transaction_categorizations[0]={business_id:'biz-a',transaction_id:'tx-0',status:'failed_post',review_status:'handled',posting_status:'posting_failed'};
 assert.equal((await discover(db)).run,null);
});

test('an attributed active request takes precedence even over an older saved outcome',()=>{
 const f=fixture(1);f.run.meta={processing_cohort_version:1,processing_outcomes:{'tx-0':{request_status:'completed',category:{status:'auto_approved'},processed_at:now.toISOString()}}};
 const r=projectProcessingRun(f);assert.equal(r.state,'queued');assert.equal(r.processed_count,0);assert.equal(r.queued_count,1);
});
test('completion between queue and run re-read refreshes the exact stale queue members',async()=>{
 const db=database(),from=db.from.bind(db);let first=true;
 db.from=table=>{const q=from(table);if(table==='bookkeeping_processing_requests'&&first){const then=q.then.bind(q);q.then=(resolve,reject)=>then(result=>{
   const stale=structuredClone(result);first=false;
   db.store.bookkeeping_processing_requests.forEach(r=>r.status='completed');
   db.store.bank_sync_runs[0].meta.processing_outcomes=Object.fromEntries(db.store.transaction_categorizations.map(c=>[c.transaction_id,{request_status:'completed',category:c,processed_at:now.toISOString()}]));
   return resolve(stale);
 },reject);}return q;};
 assert.equal((await discover(db)).run.state,'completed');assert.equal(db.queries.filter(t=>t==='bookkeeping_processing_requests').length,2);
});

test('attributed completion cannot suppress an account using a foreign-account bank row',async()=>{
 const {db,id}=legacyRecovery(1);db.store.bookkeeping_processing_requests[0].metadata={recovery_batch_id:id};db.store.bank_transactions[0].plaid_account_id='other-account';
 const r=(await discover(db,id)).run;assert.equal(r.state,'evidence_unavailable');assert.equal(r.processed_count,0);
});
