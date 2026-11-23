import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalPostingEligibility,assertCompiledPostingShape} from '../src/services/bookkeeping/canonicalPostingEligibility.js';
import {guardQboWrites} from '../src/services/bookkeeping/postingExecutionIntegrity.js';
import {formatQboPostingSchedule} from '../src/services/bookkeeping/qboPostingLifecycle.js';

test('canonical decision is scoped and unavailable decisions fail closed',async()=>{
 const calls=[];
 const db={rpc:async(name,args)=>{calls.push({name,args});return {data:{reason:null,entity_type:'Deposit'}};}};
 await canonicalPostingEligibility({db,businessId:'selected-business',transactionId:'selected-transaction',env:'sandbox'});
 assert.deepEqual(calls[0],{name:'canonical_posting_eligibility',args:{p_business_id:'selected-business',p_transaction_id:'selected-transaction',p_env:'sandbox',p_phase:'schedule'}});
 await assert.rejects(canonicalPostingEligibility({db:{rpc:async()=>({error:{code:'missing_migration'}})},businessId:'a',transactionId:'b'}),/unavailable/);
});
test('actual financial write must match compiled source, lines and direction',async()=>{
 const payload={TxnDate:'2026-11-02',PaymentType:'Cash',AccountRef:{value:'10'},Line:[{DetailType:'AccountBasedExpenseLineDetail',Amount:467.55,AccountBasedExpenseLineDetail:{AccountRef:{value:'principal'}}},{DetailType:'AccountBasedExpenseLineDetail',Amount:50,AccountBasedExpenseLineDetail:{AccountRef:{value:'interest'}}}]};
 let writes=0;const qbo=guardQboWrites({createPurchase:async()=>{writes++;}},({method,payload:actual})=>{assert.equal(method,'createPurchase');assertCompiledPostingShape(payload,actual);});
 await qbo.createPurchase({...payload,requestId:'stable',PrivateNote:'diagnostic'});assert.equal(writes,1);
 for(const patch of [{Credit:true},{AccountRef:{value:'other-business'}},{Line:[...payload.Line,payload.Line[0]]},{Line:[{...payload.Line[0],Amount:-467.55},payload.Line[1]]}])await assert.rejects(qbo.createPurchase({...payload,...patch}),/compiled_posting_shape_changed/);
 assert.equal(writes,1);
});
test('persisted future schedule and confirmed split remain scheduled without a job projection',()=>{
 const row={status:'approved',post_after:'2099-01-01T00:00:00Z',meta:{taxonomy_type:'split_transaction',split_transaction_status:'confirmed',split_transaction_id:'confirmed',safe_to_auto_post:true}};
 const badge=formatQboPostingSchedule(row);assert.equal(badge.key,'scheduled');assert.doesNotMatch(badge.label,/Not scheduled/i);
});
