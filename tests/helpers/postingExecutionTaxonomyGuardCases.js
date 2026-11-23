import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// All claims below belong to disposable PostgreSQL fixtures; no provider calls.
export async function postingExecutionTaxonomyGuardCases({t,sql,fixture,row,rpc,cat,scope,lockIdentity}) {
 const claimed=()=>{
  fixture();const id=row();rpc(',p_enabled=>true');const {bid,account}=scope();
  const lock=lockIdentity(id),owner=randomUUID(),request=randomUUID();
  const claim=JSON.parse(sql(`select public.claim_qbo_posting_intent('${bid}','${id}','synthetic','production','Purchase','${request}','synthetic-key')`));
  assert.equal(claim.claimed,true);
  sql(`update public.transaction_categorizations set meta=meta||'${JSON.stringify({posting_execution_owner:owner,posting_execution_request_id:request})}' where transaction_id='${id}'`);
  const context={...lock,business_id:bid,transaction_id:id,env:'production',owner,request_id:request,idempotency_key:'synthetic-key',claimed_at:claim.intent.processing_started_at,lease_expires_at:claim.intent.lease_expires_at,realm_id:'synthetic',final_account_id:'destination',source_account_id:'source',plaid_account_id:account,date:'2026-11-01',amount:-10,manual:false,post_error:null};
  const check=()=>sql(`select coalesce(public.check_auto_post_technical_integrity('${bid}','${id}','production','${JSON.stringify(context)}'),'NONE')`);
  assert.equal(check(),'NONE','the worker context is valid before the tested mutation');
  return {id,bid,context,check};
 };
 await t.test('valid claimed worker context rejects unsupported noncanonical taxonomies',()=>{
  for(const taxonomy of ['unknown_workflow','transfer_internal','bank_transfer','owner_draw','owner_contribution','refund','payroll']){
   const {id,check}=claimed();sql(`update public.transaction_categorizations set meta=meta||'{"taxonomy_type":"${taxonomy}"}' where transaction_id='${id}'`);
   assert.equal(check(),'unsupported_transaction_type',taxonomy);
  }
 });
 await t.test('dedicated worker taxonomies retain their previous guarded path, never canonical authority',()=>{
  for(const taxonomy of ['loan_payment','statement_credit','cc_payment']){
   const {id,bid,context,check}=claimed();sql(`update public.transaction_categorizations set meta=meta||'{"taxonomy_type":"${taxonomy}"}' where transaction_id='${id}'`);
   assert.equal(check(),'NONE',taxonomy);
   assert.equal(JSON.parse(sql(`select public.canonical_posting_eligibility('${bid}','${id}','production','worker')`)).reason,'special_workflow_protected');
   assert.equal(sql(`select coalesce(public.auto_post_technical_block(jsonb_populate_record(c,'{"final_qbo_account_id":null}'),'production','${JSON.stringify({...context,final_account_id:null})}',null),'NONE') from public.transaction_categorizations c where transaction_id='${id}'`),'invalid_final_qbo_account');
   assert.equal(sql(`select public.auto_post_technical_block(c,'production',null,null) from public.transaction_categorizations c where transaction_id='${id}'`),'unsupported_transaction_type');
  }
 });
 await t.test('canonical and dedicated worker paths reject UNKNOWN and null directions',()=>{
  for(const taxonomy of ['', 'loan_payment','statement_credit','cc_payment'])for(const direction of ["'UNKNOWN'",'null']){
   const {id,check}=claimed();
   sql(`update public.transaction_categorizations set meta=meta||'{"taxonomy_type":"${taxonomy}"}' where transaction_id='${id}';update public.bank_transactions set direction=${direction} where id='${id}'`);
   assert.equal(check(),taxonomy?'unsupported_transaction_type':'invalid_amount_or_direction',`${taxonomy}/${direction}`);
  }
 });
 await t.test('canonical ordinary authority and existing matching, exclusion and pending fences remain effective',()=>{
  {
   const {id,check}=claimed();assert.ok(cat(id).meta.posting_shape_binding);
   sql(`update public.transaction_categorizations set meta=jsonb_set(meta,'{posting_shape_binding}','"changed"') where transaction_id='${id}'`);
   assert.equal(check(),'posting_shape_changed');
  }
  for(const [mutation,expected] of [
   [id=>`update public.transaction_categorizations set meta=meta||'{"transfer_pair_id":"dedicated-transfer"}' where transaction_id='${id}'`,'special_workflow_protected'],
   [id=>`update public.transaction_categorizations set meta=meta||'{"matched_existing_qbo":true}' where transaction_id='${id}'`,'matched_transaction'],
   [id=>`update public.transaction_categorizations set excluded_at=statement_timestamp() where transaction_id='${id}'`,'excluded_or_archived'],
   [id=>`update public.bank_transactions set pending=true where id='${id}'`,'pending_transaction_not_postable'],
  ]){const {id,check}=claimed();sql(mutation(id));assert.equal(check(),expected);}
 });
}
