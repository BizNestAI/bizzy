import { withCanonicalDatabase } from "./canonicalRecheckDatabase.js";
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildSplitTransactionQboPayload } from '../../src/services/bookkeeping/splitTransactionWorkflow.js';

export async function canonicalPostingShapeCases({ t, sql, fixture, row, rpc, cat, scope, concurrent, lockIdentity, container, network }) {
 const decision = (id, phase='schedule') => JSON.parse(sql(`select public.canonical_posting_eligibility('${scope().bid}','${id}','production','${phase}')`));
 const approveInflow = ({refund=false,card=false,automatic=false,attested=true,actorId=null}={}) => {
  const {bid}=scope(), id=row({status:'needs_review'}), actor=actorId||randomUUID();
  sql(`update public.bank_transactions set amount=10,direction='INFLOW' where id='${id}';
   update public.qbo_accounts_cache set account_type='${refund?'Expense':'Income'}' where business_id='${bid}' and qbo_account_id='destination';`);
  if(card)sql(`update public.qbo_accounts_cache set account_type='CreditCard' where business_id='${bid}' and qbo_account_id='source'; update public.plaid_qbo_account_mappings set qbo_account_type='CreditCard' where business_id='${bid}';`);
  const approvedAt=new Date().toISOString();
  const meta={final_categorization:{source:automatic?'automatic_rule':'admin_manual',actor_id:actor,approved_at:approvedAt}, incoming_deposit_resolution:{resolution:'categorize_as_new',selected_qbo_account_id:'destination'}, ...(card?{credit_card_inflow_resolution:{resolution_type:'merchant_refund'}}:{})};
  if(refund&&attested)meta.expense_refund_treatment={treatment:'merchant_refund_expense_credit',refund_attested:true,business_id:bid,transaction_id:id,selected_qbo_account_id:'destination',actor_id:actor,original_amount:10,original_direction:'INFLOW',source_account_type:card?'creditcard':'bank',idempotency_key:randomUUID(),confirmed_at:new Date().toISOString()};
  sql(`update public.transaction_categorizations set status='${automatic?'auto_approved':'approved'}',decided_at='${approvedAt}',meta='${JSON.stringify(meta)}' where transaction_id='${id}'`);
  return id;
 };
 await t.test('canonical manual income and attested refunds admit and compile without RPE',()=>{
  for(const opts of [{},{refund:true},{refund:true,card:true}]){
   fixture();const id=approveInflow(opts);const a=decision(id),w=decision(id,'worker');
   assert.equal(a.reason,null);assert.equal(a.entity_type,opts.card?'CreditCardCredit':'Deposit');assert.deepEqual(a.payload,w.payload);
   assert.equal(rpc(',p_enabled=>true').scheduled,1);assert.ok(cat(id).post_after);assert.equal(cat(id).meta.posting_shape_binding,a.binding);
   assert.equal(opts.card?a.payload.Credit:true,true);
   sql(`update public.bank_transactions set amount=11 where id='${id}'`);assert.notEqual(decision(id).reason,null);
  }
 });
 await t.test('unattested, automatic and protected inflows fail closed',()=>{
  for(const opts of [{refund:true,attested:false},{refund:true,automatic:true},{automatic:true}]){fixture();const id=approveInflow(opts);assert.ok(decision(id).reason);assert.equal(rpc(',p_enabled=>true').scheduled,0);}
  for(const tax of ['transfer_internal','owner_draw','owner_contribution','cc_payment','refund']) {fixture();const id=approveInflow();sql(`update public.transaction_categorizations set meta=meta||'{"taxonomy_type":"${tax}"}' where transaction_id='${id}'`);assert.ok(decision(id).reason);}
  fixture();const id=approveInflow();sql(`update public.transaction_categorizations set meta=meta||'{"matched_existing_qbo":true}' where transaction_id='${id}'`);assert.ok(decision(id).reason);
 });
 await t.test('legacy income without an approval identity fails closed without changing its schedule',()=>{
  fixture();const id=approveInflow();rpc(',p_enabled=>true');const schedule=cat(id).post_after;
  sql(`update public.transaction_categorizations set meta=meta-'manual_posting_identity' where transaction_id='${id}'`);
  assert.equal(decision(id,'worker').reason,'manual_approval_identity_changed');assert.equal(cat(id).post_after,schedule);
 });
 await t.test('existing explicit statement-credit workflow retains its supported credit shape',()=>{
  fixture();const id=approveInflow({refund:true,card:true});const {bid}=scope();
  const decisionMeta={resolution_type:'credit_card_statement_credit',qbo_disposition:'categorize_as_new',destination_qbo_account_id:'destination',decision_source:'automated',decided_by:'bizzi',decided_at:new Date().toISOString(),confidence:'deterministic',safety_eligible:true};
  sql(`update public.bank_transactions set name='AUTOMATIC STATEMENT CREDIT' where id='${id}'; update public.transaction_categorizations set status='auto_approved',meta=(meta-'expense_refund_treatment')||'${JSON.stringify({credit_card_inflow_resolution:decisionMeta})}' where transaction_id='${id}'`);
  assert.equal(decision(id).entity_type,'CreditCardCredit');assert.equal(rpc(',p_enabled=>true').scheduled,1);
  sql(`update public.bank_transactions set name='UNEXPLAINED TRANSFER' where id='${id}'`);assert.ok(decision(id,'worker').reason);assert.equal(cat(id).business_id,bid);
 });
 const splitFixture=()=>{
  fixture();const {bid}=scope(),id=row({status:'approved'}),sid=randomUUID(),actor=randomUUID();
  const lines=[{description:'Principal',amount_minor:46755,qbo_account_id:'principal'},{description:'Interest',amount_minor:5000,qbo_account_id:'interest'}];
  sql(`update public.bank_transactions set amount=-517.55 where id='${id}'; insert into public.qbo_accounts_cache(business_id,realm_id,qbo_env,qbo_account_id,name,account_type) values('${bid}','synthetic','production','principal','Car Loan','Long Term Liability'),('${bid}','synthetic','production','interest','Car Loan Interest','Expense');
  insert into public.transaction_splits(id,business_id,transaction_id,total_amount_minor,lines,confirmed_by,confirmed_actor_type) values('${sid}','${bid}','${id}',51755,'${JSON.stringify(lines)}','${actor}','admin');
  update public.transaction_categorizations set final_qbo_account_id=null,final_qbo_account_name=null,decided_at=statement_timestamp(),meta='${JSON.stringify({safe_to_auto_post:true,taxonomy_type:'split_transaction',split_transaction_id:sid,split_transaction_status:'confirmed'})}' where transaction_id='${id}';`);
  return {id,sid,lines};
 };
 const staff=()=>{const actor=randomUUID();sql(`insert into auth.users(id) values('${actor}');insert into public.internal_staff_users(user_id,role,active) values('${actor}','operator',true)`);return actor;};
 const snapshot=sid=>JSON.parse(sql(`select to_jsonb(s) from public.transaction_splits s where id='${sid}'`));
 const existingSchedule=(id,due)=>{
  rpc(',p_enabled=>true');
  sql(`update public.transaction_categorizations set post_after='${due}' where transaction_id='${id}';update public.transaction_categorizations set meta=meta-'posting_shape_binding' where transaction_id='${id}'`);
 };
 const inspect=id=>JSON.parse(sql(`select public.inspect_existing_split_schedule('${scope().bid}','${id}')`));
 const bind=(id,actor,expected=inspect(id),business=scope().bid)=>JSON.parse(sql(`select public.bind_existing_split_schedule('${business}','${id}','${actor}','${expected.binding}','${expected.updated_at}','${randomUUID()}')`));
 await t.test('protected structural workflow INSERT and UPDATE return NEW without ordinary scheduling',()=>{
  for(const key of ['transfer_pair_id','cc_payment_bank_qbo_account_id','qbo_transfer_id']){
   fixture();const id=row({status:'approved',meta:{[key]:'dedicated-workflow',note:'preserve'}});
   assert.equal(cat(id).meta[key],'dedicated-workflow');
   sql(`update public.transaction_categorizations set meta=meta||'{"note":"updated"}' where transaction_id='${id}'`);
   assert.equal(cat(id).meta.note,'updated');assert.equal(cat(id).meta[key],'dedicated-workflow');
   assert.equal(rpc(',p_enabled=>true').scheduled,0);assert.equal(cat(id).post_after,null);
  }
 });
 await t.test('actual split lifecycle snapshots only current confirmation; drafts are not persisted statuses',()=>{
  const {id,sid,lines}=splitFixture();let saved=snapshot(sid);assert.deepEqual(saved.meta.approved_material.lines,lines);
  assert.equal(saved.meta.approved_material.actor,saved.confirmed_by);
  assert.throws(()=>sql(`insert into public.transaction_splits(business_id,transaction_id,total_amount_minor,lines,status) values('${scope().bid}','${id}',51755,'[]','draft')`),/transaction_splits_status_check/);
  // The schema permits voided records, never persisted drafts. Exercise that
  // supported unconfirmed transition with edits, then explicit confirmation.
  sql(`delete from public.transaction_splits where id='${sid}';insert into public.transaction_splits(id,business_id,transaction_id,total_amount_minor,lines,status,meta) values('${sid}','${scope().bid}','${id}',51755,'[]','voided','{"approved_material":{"stale":true}}')`);
  assert.equal(snapshot(sid).meta.approved_material,undefined);
  sql(`update public.transaction_splits set lines='${JSON.stringify(lines)}' where id='${sid}'`);
  assert.equal(snapshot(sid).meta.approved_material,undefined);
  sql(`update public.transaction_splits set status='confirmed',confirmed_by='${saved.confirmed_by}',confirmed_actor_type='admin',confirmed_at=statement_timestamp() where id='${sid}'`);
  saved=snapshot(sid);assert.deepEqual(saved.meta.approved_material.lines,lines);assert.equal(saved.meta.approved_material.at,saved.confirmed_at);
  assert.throws(()=>sql(`update public.transaction_splits set lines='[]' where id='${sid}'`),/split_confirmed_material_immutable/);
  rpc(',p_enabled=>true');assert.throws(()=>sql(`update public.transaction_splits set total_amount_minor=1 where id='${sid}'`),/split_confirmed_material_immutable/);
 });
 await t.test('legacy confirmed splits validate and bind future and overdue jobs with byte-identical schedules and replay',()=>{
  for(const due of ['2099-11-23T22:56:28.607Z','2001-11-23T22:56:28.607Z']){
   const {id,sid}=splitFixture(),actor=staff();
   // Synthetic pre-release legacy fixture only: remove snapshot as if this row
   // predated the new trigger. This never runs against production.
   sql(`alter table public.transaction_splits disable trigger a_serialize_confirmed_split_edit;update public.transaction_splits set meta=meta-'approved_material' where id='${sid}';alter table public.transaction_splits enable trigger a_serialize_confirmed_split_edit`);
   existingSchedule(id,due);const before=cat(id),job=sql(`select to_jsonb(j) from public.bookkeeping_posting_jobs j where transaction_id='${id}'`),expected=inspect(id);
   assert.equal(expected.reason,null);assert.equal(expected.binding_required,true);
   assert.equal(bind(id,actor,expected).outcome,'bound_existing_schedule');assert.equal(cat(id).post_after,before.post_after);
   assert.equal(sql(`select to_jsonb(j) from public.bookkeeping_posting_jobs j where transaction_id='${id}'`),job);
   assert.equal(inspect(id).binding_required,false);assert.equal(bind(id,actor,expected).outcome,'already_valid');
   assert.throws(()=>sql(`update public.transaction_splits set lines='[]' where id='${sid}'`),/split_confirmed_material_immutable/);
  }
 });
 await t.test('existing schedule binding fails closed on stale identity, authority, active attempts, claim and receipt',async()=>{
  for(const bad of ['missing','revoked','posted','unbalanced','processing','attempt','receipt','intent','ambiguous','scope','actor','changed']){
   const {id,sid}=splitFixture(),actor=staff();existingSchedule(id,'2099-01-01');const expected=inspect(id);
   if(bad==='missing')sql(`update public.transaction_categorizations set post_after=null where transaction_id='${id}'`);
   if(bad==='revoked')sql(`update public.transaction_splits set status='voided' where id='${sid}'`);
   if(bad==='posted')sql(`update public.transaction_categorizations set qbo_txn_id='receipt' where transaction_id='${id}'`);
   if(bad==='unbalanced')sql(`update public.bank_transactions set amount=-518 where id='${id}'`);
   if(bad==='processing')sql(`update public.bookkeeping_posting_jobs set state='processing' where transaction_id='${id}'`);
   if(bad==='attempt')sql(`insert into public.bookkeeping_post_attempts(business_id,transaction_id,status) values('${scope().bid}','${id}','attempted')`);
   if(bad==='receipt')sql(`insert into public.qbo_posted_transactions(business_id,transaction_id,qbo_env,qbo_txn_type,status) values('${scope().bid}','${id}','production','Purchase','unknown')`);
   if(bad==='intent')sql(`select public.claim_qbo_posting_intent('${scope().bid}','${id}','synthetic','production','Purchase','binding-test','binding-key')`);
   if(bad==='ambiguous')sql(`update public.transaction_categorizations set meta=meta||'{"ambiguous_provider_outcome":true}' where transaction_id='${id}'`);
   if(bad==='changed')sql(`update public.transaction_categorizations set updated_at=statement_timestamp() where transaction_id='${id}'`);
   const before=cat(id);assert.throws(()=>bind(id,bad==='actor'?randomUUID():actor,expected,bad==='scope'?randomUUID():scope().bid));assert.deepEqual(cat(id),before);
  }
  const {id}=splitFixture(),actor=staff();existingSchedule(id,'2099-01-01');const expected=inspect(id);
  const claim=concurrent(`begin;select 1 from public.bank_transactions where id='${id}' for update;select public.claim_qbo_posting_intent('${scope().bid}','${id}','synthetic','production','Purchase','concurrent-bind-test','concurrent-bind-key');select pg_sleep(0.4);commit;`);
  await new Promise(r=>setTimeout(r,100));
  await assert.rejects(concurrent(`select public.bind_existing_split_schedule('${scope().bid}','${id}','${actor}','${expected.binding}','${expected.updated_at}','${randomUUID()}')`));await claim;
  assert.equal(cat(id).meta.posting_shape_binding,undefined);
 });
 await t.test('genuine Undo renews same actor/category with new immutable audit, exact identity and idempotent replay',()=>{
  for(const actorType of ['admin','user']){
   fixture();const {bid}=scope(),actor=staff(),id=approveInflow({actorId:actor});
   sql(`update public.business_profiles set user_id='${actor}' where id='${bid}';insert into public.bookkeeping_approval_events(business_id,transaction_id,actor_id,actor_type,resolution,idempotency_key) values('${bid}','${id}','${actor}','${actorType}','approve','old-semantic-key');update public.transaction_categorizations set status='needs_review',meta=meta||'{"review_reopen_authorized":true,"review_reopen_reason":"user_undo"}' where transaction_id='${id}'`);
   assert.equal(cat(id).status,'needs_review');assert.ok(cat(id).review_reopened_at);
   const context=(account='destination',who=actor,business=bid)=>JSON.parse(sql(`select public.canonical_approval_renewal_context('${business}','${id}','${account}','${who}','${actorType}')`));
   const ctx=context(),at=new Date().toISOString();assert.notEqual(ctx.key,'old-semantic-key');
   const approval={transaction_id:id,status:'approved',final_qbo_account_id:'destination',final_qbo_account_name:'Synthetic',decided_at:at,updated_at:at,approval_idempotency_key:ctx.key,meta:{manual_renewal_key:ctx.key,manual_review_epoch:ctx.epoch,manual_review_identity:ctx.identity,final_categorization:{source:actorType==='admin'?'admin_manual':'customer_manual',actor_id:actor,approved_at:at},incoming_deposit_resolution:{resolution:'categorize_as_new',selected_qbo_account_id:'destination'}}};
   const commit=(value=approval,who=actor,business=bid)=>sql(`select count(*) from public.approve_bookkeeping_with_admission('${business}','${who}','${actorType}','${JSON.stringify([value])}',true)`);
   assert.throws(()=>commit({...approval,approval_idempotency_key:'old-semantic-key'}),/approval_renewal_identity_changed/);
   assert.throws(()=>commit(approval,randomUUID()));assert.throws(()=>commit(approval,actor,randomUUID()));
   for(const mutation of ["update public.bank_transactions set amount=11", "update public.bank_transactions set date=date+1", "update public.bank_transactions set plaid_account_id='changed'", "update public.plaid_qbo_account_mappings set qbo_account_id='changed'"]){
    const where=mutation.includes('mappings')?`business_id='${bid}'`:`id='${id}'`;
    assert.throws(()=>sql(`begin;${mutation} where ${where};select count(*) from public.approve_bookkeeping_with_admission('${bid}','${actor}','${actorType}','${JSON.stringify([approval])}',true);commit;`));
   }
   assert.throws(()=>commit({...approval,final_qbo_account_id:'source'}),/approval_renewal_identity_changed/);
   commit();assert.equal(cat(id).status,'approved');assert.deepEqual(cat(id).meta.manual_posting_identity,ctx.identity);
   const saved=cat(id);commit();assert.deepEqual(cat(id),saved);
   assert.equal(sql(`select count(*) from public.bookkeeping_approval_events where business_id='${bid}' and transaction_id='${id}'`),'2');
   assert.throws(()=>commit({...approval,approval_idempotency_key:'old-semantic-key'}),/approval_renewal_identity_changed/);
   sql(`update public.bank_transactions set amount=11 where id='${id}'`);assert.throws(()=>commit(),/approval_renewal_identity_changed/);
  }
 });
 await t.test('balanced confirmed loan split schedules with no top-level account and exact payload',()=>{
  const {id,lines}=splitFixture();const a=decision(id);assert.equal(a.reason,null);assert.equal(a.entity_type,'Purchase');assert.equal(rpc(',p_enabled=>true').scheduled,1);assert.equal(cat(id).final_qbo_account_id,null);
  const compiled=buildSplitTransactionQboPayload({transaction:{id,date:'2026-11-01',amount:-517.55,pending:false},split:{lines},mapping:{qbo_account_type:'Bank',qbo_account_id:'source'}});
  assert.deepEqual(a.payload.Line,compiled.Line);assert.deepEqual(a.payload.AccountRef,compiled.AccountRef);assert.equal(a.payload.PaymentType,'Cash');assert.deepEqual(a.payload.Line.map(l=>l.Amount),[467.55,50]);
  assert.equal(decision(id,'worker').binding,cat(id).meta.posting_shape_binding);
 });
 await t.test('split edits, inactive accounts and cross-business authority are rejected',()=>{
  for(const mutation of ["lines=jsonb_set(lines,'{0,amount_minor}','1')","lines=jsonb_set(lines,'{0,qbo_account_id}','\"missing\"')","status='voided'","confirmed_by=null"]){const {id,sid}=splitFixture();if(mutation==="status='voided'"){sql(`update public.transaction_splits set ${mutation} where id='${sid}'`);assert.ok(decision(id).reason);assert.equal(rpc(',p_enabled=>true').scheduled,0);}else{assert.throws(()=>sql(`update public.transaction_splits set ${mutation} where id='${sid}'`),/split_confirmed_material_immutable/);assert.equal(decision(id).reason,null);}}
  const {id}=splitFixture();sql(`update public.qbo_accounts_cache set active=false where business_id='${scope().bid}' and qbo_account_id='interest'`);assert.ok(decision(id).reason);
  const other=randomUUID();assert.equal(JSON.parse(sql(`select public.canonical_posting_eligibility('${other}','${id}')`)).reason,'transaction_not_found');
 });
 await t.test('split mutation serializes with posting ownership and cannot alter claimed content',async()=>{
  const {id,sid}=splitFixture();rpc(',p_enabled=>true');const {bid}=scope();
  const claim=concurrent(`begin; select 1 from public.bank_transactions where id='${id}' for update; update public.transaction_categorizations set meta=meta||'{"posting_in_progress":true}' where transaction_id='${id}'; select pg_sleep(0.3); commit;`);
  await new Promise(r=>setTimeout(r,100));
  await assert.rejects(concurrent(`update public.transaction_splits set lines=jsonb_set(lines,'{0,amount_minor}','1') where id='${sid}'`),/split_posting_in_progress/);await claim;
  assert.equal(cat(id).business_id,bid);
 });
 await t.test('unchanged split passes the actual SQL execution guard; changed binding fails',()=>{
  const {id}=splitFixture();const {bid,account}=scope();rpc(',p_enabled=>true');const lock=lockIdentity(id),owner=randomUUID();
  const claim=JSON.parse(sql(`select public.claim_qbo_posting_intent('${bid}','${id}','synthetic','production','Purchase','split-request','synthetic-key')`));
  sql(`update public.transaction_categorizations set meta=meta||'${JSON.stringify({posting_execution_owner:owner,posting_execution_request_id:'split-request'})}' where transaction_id='${id}'`);
  const context={...lock,business_id:bid,transaction_id:id,env:'production',owner,request_id:'split-request',idempotency_key:'synthetic-key',claimed_at:claim.intent.processing_started_at,lease_expires_at:claim.intent.lease_expires_at,realm_id:'synthetic',final_account_id:null,source_account_id:'source',plaid_account_id:account,date:'2026-11-01',amount:-517.55,manual:false,post_error:null};
  const check=()=>sql(`select coalesce(public.check_auto_post_technical_integrity('${bid}','${id}','production','${JSON.stringify(context)}'),'NONE')`);
  assert.equal(check(),'NONE');
  sql(`update public.transaction_categorizations set meta=jsonb_set(meta,'{posting_shape_binding}','"changed"') where transaction_id='${id}'`);
  assert.equal(check(),'posting_shape_changed');
 });
 await t.test('RPE return-to-review preserves NOT NULL actor and rolls back an invalid update',()=>{
  fixture();const id=row(),{bid}=scope();const before=cat(id);
  assert.equal(sql(`select public.return_posting_to_review('${bid}','${id}','${before.updated_at}','missing_final_qbo_account_unresolved')`),'t');
  assert.equal(cat(id).decided_by,before.decided_by);assert.equal(cat(id).status,'needs_review');
  const snapshot=cat(id);assert.throws(()=>sql(`begin; update public.transaction_categorizations set decided_by=null where transaction_id='${id}'; commit;`));assert.deepEqual(cat(id),snapshot);
 });
 await t.test('controlled existing failed outflow retries keep their lifecycle and compile',()=>{
  fixture();const id=row();rpc(',p_enabled=>true');
  sql(`update public.transaction_categorizations set status='failed',post_error='provider_retry',post_after=null where transaction_id='${id}';
   update public.transaction_categorizations set post_after=statement_timestamp()+interval '24 hours' where transaction_id='${id}'`);
  assert.equal(cat(id).status,'failed');assert.ok(cat(id).post_after);assert.equal(decision(id,'worker').reason,null);
 });
 await t.test('ordinary outflow and private grants remain intact',()=>{
  fixture();const id=row();assert.equal(decision(id).entity_type,'Purchase');assert.equal(rpc(',p_enabled=>true').scheduled,1);
  assert.equal(sql("select has_function_privilege('authenticated','public.canonical_posting_eligibility(uuid,uuid,text,text)','EXECUTE')"),'f');
 });
 await t.test('legitimate Undo and scoped manual approval resolve generic review and schedule idempotently',async()=>{
  await withCanonicalDatabase({container,network},async db=>{
   const {approveBookkeepingTransactions}=await import('../../src/services/bookkeeping/bookkeepingApprovalService.js');
   for(const actorType of ['user','admin']){
    fixture();const {bid}=scope(),actor=staff(),id=row({status:'approved',meta:{protected_review_required:true,protected_review_reason:'personal_or_owner_review'}});
    sql(`update public.business_profiles set user_id='${actor}' where id='${bid}';update public.bank_transactions set amount=-28 where id='${id}';update public.transaction_categorizations set status='needs_review',post_after=null,meta=meta||'{"review_reopen_authorized":true,"review_reopen_reason":"user_undo"}' where transaction_id='${id}'`);
    assert.ok(cat(id).review_reopened_at);assert.equal(decision(id).reason,'transaction_not_handled');rpc(',p_enabled=>true');
    const options={db,businessId:bid,actorId:actor,actorType,requireNeedsReview:true,source:actorType==='admin'?'admin_customer_app':'books_review',items:[{txnId:id,newAccountId:'destination',newAccountName:'Synthetic destination',resolution:'categorize_new',only_this_transaction:true}],validateSelectedAccountsFn:async()=>{
     const {data,error}=await db.from('qbo_accounts_cache').select('qbo_account_id,name,active,account_type').eq('business_id',bid).eq('qbo_account_id','destination').maybeSingle();assert.equal(error,null);return new Map([['destination',{id:data.qbo_account_id,name:data.name,active:data.active,type:data.account_type}]]);
    },evaluateIncomingDepositPostingGuard:async()=>({allowed:true})};
    await approveBookkeepingTransactions(options);const saved=cat(id);assert.ok(saved.post_after);assert.equal(decision(id,'worker').reason,null);assert.equal(saved.meta.protected_review_required,undefined);assert.equal(saved.meta.manual_protection_resolution.actor_id,actor);
    const repeated=await approveBookkeepingTransactions(options);assert.equal(repeated.idempotent,true);assert.equal(cat(id).post_after,saved.post_after);assert.equal(sql(`select count(*) from public.bookkeeping_approval_events where business_id='${bid}' and transaction_id='${id}'`),'1');
   }
  });
 });
 await t.test('real RPE preview/execution agrees with admission and worker; replay is idempotent',async()=>{
  await withCanonicalDatabase({container,network},async db=>{
   const {buildCanonicalPostingPreview}=await import('../../src/services/bookkeeping/canonicalPostingCompiler.js');
   const {previewPostingEligibilityRecheck,executePostingEligibilityRecheck}=await import('../../src/services/bookkeeping/postingEligibilityRecheckService.js');
   const {persistAuthoritativeFinalCategorizations}=await import('../../src/services/bookkeeping/finalCategorizationPersistenceService.js');
   fixture();{
    const {bid}=scope(),id=row({status:'needs_review'}),actor=randomUUID();
    sql(`update public.bank_transactions set amount=10,direction='INFLOW' where id='${id}'; update public.qbo_accounts_cache set account_type='Income' where business_id='${bid}' and qbo_account_id='destination'; update public.business_profiles set auto_post_to_quickbooks=true,auto_post_enabled_at=statement_timestamp() where id='${bid}'`);
    await persistAuthoritativeFinalCategorizations({db,businessId:bid,approvalSource:'admin_manual',actorId:actor,actorType:'admin',requireNeedsReview:true,rows:[{transaction_id:id,status:'approved',final_qbo_account_id:'destination',final_qbo_account_name:'Synthetic destination',decided_by:'admin',meta:{incoming_deposit_resolution:{resolution:'categorize_as_new',selected_qbo_account_id:'destination'}}}]});
    assert.ok(cat(id).post_after,'ordinary approval must schedule without RPE');assert.equal(decision(id,'worker').entity_type,'Deposit');
   }

   for(const split of [false,true]) {
    let id;if(split)({id}=splitFixture());else{fixture();id=approveInflow();}
    const {bid}=scope();sql(`update public.business_profiles set auto_post_to_quickbooks=true,auto_post_enabled_at=statement_timestamp() where id='${bid}'`);
    const options={db,businessId:bid,month:'2026-11',transactionIds:[id]};
    const postingPreview=await buildCanonicalPostingPreview({db,businessId:bid,transactionId:id});
    assert.equal(postingPreview.entity_type,split?'Purchase':'Deposit');
    if(split)assert.deepEqual(postingPreview.line_gl_accounts.map(line=>line.amount),[467.55,50]);
    const preview=await previewPostingEligibilityRecheck(options);
    assert.equal(preview.rows[0].outcome,'eligible_to_schedule',JSON.stringify(preview.rows));
    const args={...options,previewVersion:preview.preview_version,idempotencyKey:randomUUID()};
    const result=await executePostingEligibilityRecheck(args);assert.equal(result.counts.newly_scheduled,1,JSON.stringify(result));
    const schedule=cat(id).post_after;assert.ok(schedule);assert.equal(cat(id).meta.posting_shape_binding,decision(id,'worker').binding);
    await executePostingEligibilityRecheck(args);assert.equal(cat(id).post_after,schedule);
    if(split) {
     sql(`update public.transaction_categorizations set meta=meta-'posting_shape_binding' where transaction_id='${id}'`);
     const actor=randomUUID();sql(`insert into auth.users(id) values('${actor}'); insert into public.internal_staff_users(user_id,role,active) values('${actor}','operator',true)`);options.actorId=actor;
     const legacy=await previewPostingEligibilityRecheck(options);assert.equal(legacy.rows[0].outcome,'bind_existing_schedule',JSON.stringify(legacy.rows));
     await executePostingEligibilityRecheck({...options,previewVersion:legacy.preview_version,idempotencyKey:randomUUID()});
     assert.equal(cat(id).post_after,schedule);assert.equal(cat(id).meta.posting_shape_binding,decision(id,'worker').binding);
    }
   }
  });
 });

}
