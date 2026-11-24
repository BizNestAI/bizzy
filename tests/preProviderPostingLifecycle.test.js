/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {checkInitialPostingExecution} from '../src/services/bookkeeping/postingExecutionIntegrity.js';
import {deriveQboPostingLifecycle,formatQboPostingSchedule} from '../src/services/bookkeeping/qboPostingLifecycle.js';
const nowMs=Date.parse('2026-11-24T01:00:00Z');
test('shared customer/Admin feed returns failure instead of a stale processing job or preview blocker',async()=>{
 process.env.SUPABASE_URL='http://127.0.0.1:1';process.env.SUPABASE_SERVICE_ROLE_KEY='synthetic-local-only';
 const {fetchBookkeepingTransactions}=await import('../src/services/bookkeeping/bookkeepingTransactionFeedService.js');
 const db={rpc:async(name,args)=>{
  assert.equal(args.p_business_id,'selected-business');
  return {data:name==='canonical_posting_eligibility'?{reason:'posting_shape_changed'}:[{id:'transaction',date:'2026-11-02',amount:-517.55,direction:'OUTFLOW',pending:false,cat_status:'failed',post_error:'posting_shape_changed',last_post_attempt_at:'2026-11-23T23:00:17Z',cat_meta:{posting_in_progress:false}}]};
 },from(table){const q={select(){return q;},eq(){return q;},in(){return q;},not(){return q;},order(){return q;},limit(){return q;},maybeSingle:async()=>({data:null}),then(resolve){return Promise.resolve({data:table==='bookkeeping_posting_jobs'?[{transaction_id:'transaction',state:'processing',last_error_code:'pending_transaction_not_postable',lease_expires_at:'2026-11-23T23:10:16Z'}]:[]}).then(resolve);}};return q;}};
 const result=await fetchBookkeepingTransactions({db,businessId:'selected-business',statusFilter:'handled',rangeStart:'2026-11-01',rangeEnd:'2026-12-01',nowMs});
 assert.equal(result.rows[0].qbo_posting_lifecycle.key,'failed');assert.equal(result.rows[0].qbo_posting_lifecycle.code,'posting_shape_changed');
});
test('failed categorization outranks stale processing projection and stale error code',()=>{
 const row={status:'failed',posting_status:'posting_failed',post_error:'posting_shape_changed',last_post_attempt_at:'2026-11-23T23:00:17Z',meta:{posting_in_progress:false},posting_job:{state:'processing',last_error_code:'pending_transaction_not_postable',lease_expires_at:'2026-11-23T23:10:16.523Z'}};
 assert.equal(deriveQboPostingLifecycle(row,{nowMs}).key,'failed');assert.equal(formatQboPostingSchedule(row,{nowMs}).code,'posting_shape_changed');
});
test('expired processing becomes attention; live processing, receipts, matches and reconciliation retain authority',()=>{
 const row={status:'approved',posting_job:{state:'processing',lease_expires_at:'2026-11-23T23:10:16Z'}};
 assert.equal(formatQboPostingSchedule(row,{nowMs}).key,'posting_attention');
 assert.equal(deriveQboPostingLifecycle({...row,posting_job:{...row.posting_job,lease_expires_at:'2099-01-01'}},{nowMs}).key,'posting');
 assert.equal(deriveQboPostingLifecycle({...row,qbo_txn_id:'receipt'},{nowMs}).key,'posted');
 assert.equal(deriveQboPostingLifecycle({...row,status:'matched_existing_qbo'},{nowMs}).key,'matched_existing_qbo');
 assert.equal(deriveQboPostingLifecycle({...row,posting_job:{state:'reconciling'}},{nowMs}).key,'reconciling');
 assert.equal(deriveQboPostingLifecycle({...row,meta:{ambiguous_provider_outcome:true}},{nowMs}).key,'reconciling');
});
test('initial technical rejection uses one atomic RPC and never reaches provider work',async()=>{
 const failure=Object.assign(new Error('technical guard'),{code:'posting_shape_changed',qbo_write_may_have_occurred:false});let writes=0,calls=0;
 const db={rpc:async(name,args)=>{calls++;assert.equal(name,'reject_posting_before_provider');assert.equal(args.p_business_id,'business');assert.equal(args.p_context.owner,'owner');return {data:{ok:true}};}};
 await assert.rejects(async()=>{await checkInitialPostingExecution({db,businessId:'business',transactionId:'transaction',env:'production',context:{owner:'owner'},check:async()=>{throw failure;}});writes++;});
 assert.equal(writes,0);assert.equal(calls,1);assert.equal(failure.posting_failure_finalized,true);
});
test('unavailable finalization fails closed without separate lifecycle writes',async()=>{
 const error=Object.assign(new Error('guard'),{code:'posting_shape_changed',qbo_write_may_have_occurred:false});
 await assert.rejects(()=>checkInitialPostingExecution({db:{rpc:async()=>({error:{code:'offline'}})},context:{},check:async()=>{throw error;}}));
 assert.equal(error.pre_provider_failure_pending,true);assert.equal(error.posting_failure_finalized,undefined);
 const source=fs.readFileSync('src/jobs/booksPost.cron.js','utf8');assert.match(source,/if \(message\?\.posting_failure_finalized \|\| message\?\.pre_provider_failure_pending\) return/);
 assert.ok(source.indexOf('await checkInitialPostingExecution(')<source.indexOf('qbo = await timePostingStage(timing, "qbo_auth_ms", () => getQBOClient',source.indexOf('await checkInitialPostingExecution(')));
});
