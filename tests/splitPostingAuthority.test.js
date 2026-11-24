import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveBookkeepingActionMatrix} from '../src/services/bookkeeping/bookkeepingPostingActionEligibility.js';
import {createInteractivePostingCommand} from '../src/services/bookkeeping/interactivePostingCommandService.js';
const preflight={preview_ready:true,split:true,split_line_count:2};
test('validated split uses line authority for Post Now without enabling a parent category selector',()=>{
 const row={status:'approved',direction:'OUTFLOW',final_qbo_account_id:null,meta:{taxonomy_type:'split_transaction',split_transaction_status:'confirmed',split_transaction_id:'split',safe_to_auto_post:true},provider_free_preflight:preflight};
 const actions=deriveBookkeepingActionMatrix(row).actions;
 assert.equal(actions.find(a=>a.action_code==='preview_and_post').enabled,true);
 assert.equal(actions.find(a=>a.action_code==='select_gl_account').enabled,false);
 assert.equal(actions.find(a=>a.action_code==='change_gl_account').enabled,false);
 for(const blocker of ['split_line_account_invalid','existing_schedule_binding_required']) {
  assert.equal(deriveBookkeepingActionMatrix({...row,provider_free_preflight:{...preflight,preview_ready:false,blocker_code:blocker}}).actions.find(a=>a.action_code==='preview_and_post').enabled,false);
  assert.equal(deriveBookkeepingActionMatrix({...row,provider_free_preflight:{...preflight,preview_ready:false,blocker_code:blocker}}).actions.find(a=>a.action_code==='select_gl_account').enabled,false);
 }
});
function fixture(){
 const cat={business_id:'business',transaction_id:'transaction',final_qbo_account_id:null,meta:{taxonomy_type:'split_transaction',posting_shape_binding:'approved-shape'}};
 const store={bookkeeping_interactive_posting_commands:[]};
 const db={store,from(){const filters=[];const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},async maybeSingle(){return {data:filters.every(([k,v])=>cat[k]===v)?cat:null};}};return q;},async rpc(_name,args){assert.equal(args.p_business_id,'business');return {data:{split:true,binding:'approved-shape',reason:null,payload:{Line:[{},{}]}}};}};
 return {db,cat,options:{db,businessId:'business',transactionIds:['transaction'],selectedQboAccountId:null,rememberForFuture:false,merchantSnapshot:{requested_action:'post_now'},idempotencyKey:'one-split'}};
}
test('direct split command persists no parent GL, verifies current binding and replays idempotently',async()=>{
 const {options}=fixture();const first=await createInteractivePostingCommand(options);assert.equal(first.command.selected_qbo_account_id,null);assert.equal(first.command.merchant_snapshot.accounting_authority,'confirmed_split');assert.equal(first.command.merchant_snapshot.posting_shape_binding,'approved-shape');
 const replay=await createInteractivePostingCommand(options);assert.equal(replay.reused,true);assert.equal(replay.operation_id,first.operation_id);
});
test('null GL is rejected for ordinary, cross-business, remembered, multiple-row and changed split commands',async()=>{
 for(const change of ['ordinary','foreign','remember','multiple','changed']) {
  const {options,cat}=fixture();
  if(change==='ordinary')cat.meta={};if(change==='foreign')options.businessId='foreign';if(change==='remember')options.rememberForFuture=true;if(change==='multiple')options.transactionIds.push('another');if(change==='changed')cat.meta.posting_shape_binding='changed';
  await assert.rejects(()=>createInteractivePostingCommand(options));
 }
});
