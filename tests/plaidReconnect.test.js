/* global process */
import test from "node:test";
import assert from "node:assert/strict";
process.env.SUPABASE_URL ||= "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "synthetic";
const { classifyRecoveryTransaction, collectBoundedPlaidHistory } = await import("../src/services/plaid/plaidReplacementRecoveryService.js");
const { projectPlaidAccountRecoveryStatus } = await import("../src/services/plaid/plaidAccountRecoveryStatus.js");
const { isPlaidItemEligibleForScheduledSync } = await import("../src/services/plaid/plaidSyncService.js");

const row={transaction_id:"provider",account_id:"account",physical_account_id:"physical",name:"SYNTHETIC MERCHANT",date:"2026-10-17",amount:10};
const classify=(more={})=>classifyRecoveryTransaction({transaction:row,cutoffDate:"2026-10-14",confirmedAccountIds:["account"],...more});

test("shared classifier protects manual/CSV overlap, pending identity and existing QBO representation",()=>{
  const existing={id:"local",physical_account_id:"physical",plaid_account_id:"account",name:row.name,date:row.date,amount:-10,signed_amount:-10};
  for(const source of ["manual","csv"]) assert.equal(classify({existingRows:[{...existing,canonical_source:source}]}).disposition,"probable_duplicate");
  assert.equal(classify({transaction:{...row,pending:true}}).disposition,"ambiguous");
  assert.equal(classify({transaction:{...row,pending_transaction_id:"authorization"},existingRows:[{...existing,plaid_transaction_id:"authorization",pending:true}]}).disposition,"pending_replacement");
  assert.equal(classify({existingRows:[{...existing,plaid_transaction_id:"provider"}],representedTransactionIds:["local"]}).disposition,"represented");
  assert.equal(classify().disposition,"new_after_cutoff");
});

test("bounded collector uses explicit account/range, paginates and never requests a sync cursor",async()=>{
  const requests=[];
  const collected=await collectBoundedPlaidHistory({accountId:"account",accessToken:"fake",startDate:"2026-10-15",endDate:"2026-10-20",
    plaid:{transactionsGet:async args=>{requests.push(args);return {data:{total_transactions:2,transactions:[{...row,transaction_id:String(requests.length)}]}};}}});
  assert.equal(collected.transactions.length,2);assert.equal(requests[1].options.offset,1);
  assert.equal(requests[0].cursor,undefined);assert.deepEqual(requests[0].options.account_ids,["account"]);
});

test("bounded collector rejects invented/invalid ranges, changed populations and wrong account evidence",async()=>{
  for(const [startDate,endDate] of [[undefined,"2026-10-20"],["2026-02-30","2026-10-20"],["2024-01-01","2026-10-20"],["2026-10-20","2026-10-15"]]) {
    await assert.rejects(collectBoundedPlaidHistory({startDate,endDate,accountId:"account",plaid:{transactionsGet:()=>{throw new Error("Must not call provider");}}}),/exact range/i);
  }
  await assert.rejects(collectBoundedPlaidHistory({startDate:"2026-10-15",endDate:"2026-10-20",accountId:"account",
    plaid:{transactionsGet:async()=>({data:{total_transactions:1,transactions:[{...row,account_id:"other"}]}})}}),/population requires review/i);
  let calls=0;
  await assert.rejects(collectBoundedPlaidHistory({startDate:"2026-10-15",endDate:"2026-10-20",accountId:"account",
    plaid:{transactionsGet:async()=>({data:{total_transactions:++calls===1?2:3,transactions:[{...row,transaction_id:String(calls)}]}})}}),/Refresh the bounded preview/);
});

function facts(state){const success="2026-11-09T00:00:00Z";return {account:{id:"account",is_active:true,connection_state:"connected",last_sync_at:success},
  item:{status:"connected",is_active:true,last_success_at:success,reconnect_state:{state,actor_id:"private"}},
  latest_run:{status:"completed",started_at:success,finished_at:success},last_checkpoint:{finished_at:success},auto_post_enabled:false,
  metrics:{active_count:1,missing_categorization:0,required_processing_admission_missing:0,missing_both:0,processing_count:0,
    review_count:0,automation_failed_count:0,active_lease_count:0,dead_letter_count:0,posting_hold_count:0,receipt_reconciliation_count:0,posting_failed_count:0}};}

test("reconnect dimensions never confuse verified Link with completed replay or posting activation",()=>{
  const f=facts("waiting_for_replay");
  let status=projectPlaidAccountRecoveryStatus(f,{observedAt:"2026-11-09T01:00:00Z"});
  assert.equal(status.bank_connection.state,"reconnect_in_progress");assert.equal(status.transaction_import.state,"waiting_for_replay");
  assert.equal(status.quickbooks_posting.state,"held");assert.equal(status.categorization_automation.state,"active");
  f.item.reconnect_state.state="identity_review_required";
  status=projectPlaidAccountRecoveryStatus(f);assert.equal(status.bank_connection.recommended_action,"review_account_identity");
  f.item.reconnect_state.state="completed";f.metrics.recovery_gap_review_count=1;
  status=projectPlaidAccountRecoveryStatus(f);assert.equal(status.transaction_import.recommended_action,"review_possible_gap");
  assert.doesNotMatch(JSON.stringify(status),/private|actor_id/);
  f.account.connection_state="disconnected";status=projectPlaidAccountRecoveryStatus(f);assert.equal(status.bank_connection.state,"disconnected");
});

test("scheduled retries may resume verified reauthentication but cannot bypass unresolved identity",()=>{
  assert.equal(isPlaidItemEligibleForScheduledSync({status:"reauth_required",reconnect_state:{state:"waiting_for_replay"}}),true);
  assert.equal(isPlaidItemEligibleForScheduledSync({status:"connected",reconnect_state:{state:"identity_review_required"}}),false);
  assert.equal(isPlaidItemEligibleForScheduledSync({status:"reauth_required"}),false);
});
