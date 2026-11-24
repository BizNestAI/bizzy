/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.SUPABASE_URL='http://127.0.0.1:1';process.env.SUPABASE_SERVICE_ROLE_KEY='synthetic-local-test-only';
const {fetchBookkeepingTransactions}=await import('../src/services/bookkeeping/bookkeepingTransactionFeedService.js');
for(const [feed,extra,expected] of [
 ['posted',{cat_status:'approved',qbo_txn_id:'receipt',posted_at:'2026-11-10T00:00:00Z'},0],
 ['matched',{cat_status:'approved',cat_meta:{matched_existing_qbo:true}},0],
 ['pending',{cat_status:'approved',pending:true},0],
 ['needs_review',{cat_status:'needs_review'},0],
 ['handled',{cat_status:'approved'},1],
])test(`${feed} feed evaluates canonical eligibility only for unposted Handled candidates`,async()=>{
 const calls=[];const db={rpc:async(name,args)=>{calls.push({name,args});if(name==='canonical_posting_eligibility')return {data:{reason:null,entity_type:'Purchase'},error:null};return {data:[{id:'transaction',date:'2026-11-10',name:'Synthetic',amount:-28,direction:'OUTFLOW',pending:false,total_count:1,cat_meta:{},...extra}],error:null};},from(){const q={select(){return q;},eq(){return q;},in(){return q;},not(){return q;},order(){return q;},limit(){return q;},maybeSingle:async()=>({data:null,error:null}),then(resolve){return Promise.resolve({data:[],error:null}).then(resolve);}};return q;}};
 const result=await fetchBookkeepingTransactions({db,businessId:'selected-business',statusFilter:feed,rangeStart:'2026-11-01',rangeEnd:'2026-12-01'});
 assert.equal(result.rows.length,1);assert.equal(result.totalCount,1);assert.equal(calls.filter(c=>c.name==='canonical_posting_eligibility').length,expected);
 assert.equal(calls[0].args.p_business_id,'selected-business');assert.equal(calls[0].args.p_range_start,'2026-11-01');assert.equal(calls[0].args.p_range_end,'2026-12-01');
});
