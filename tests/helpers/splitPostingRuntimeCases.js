/* global process */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import express from 'express';
import {withCanonicalDatabase} from './canonicalRecheckDatabase.js';

export async function splitPostingRuntimeCases({t,sql,container,network,fixture,scope}) {
 await t.test('actual customer and Admin split save routes schedule and auto-post exactly one two-line Purchase',async()=>{
  const nativeFetch=globalThis.fetch,RealDate=Date;
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bizzi-split-runtime-'));
  let server;
  try {
   await withCanonicalDatabase({container,network},async db=>{
    process.env.NODE_ENV='test';process.env.DISABLE_BACKGROUND_WORKERS='true';process.env.DISABLE_BOOKS_POST_CRON='true';
    process.env.SUPABASE_URL='http://127.0.0.1:1';process.env.SUPABASE_SERVICE_ROLE_KEY='synthetic-local-test-only';
    process.env.QB_ENVIRONMENT='production';
    const writes=[];
    const fakeQbo={
     findAccounts(_criteria,cb){cb(null,{QueryResponse:{Account:[{Id:'source',Name:'Checking',AccountType:'Bank',Active:true},{Id:'principal',Name:'Car Loan',AccountType:'Long Term Liability',Active:true},{Id:'interest',Name:'Car Loan Interest',AccountType:'Expense',Active:true}]}});},
     findPurchases(_criteria,cb){cb(null,{QueryResponse:{Purchase:[]}});},
     createPurchase(payload,cb){writes.push(structuredClone(payload));cb(null,{Id:`synthetic-receipt-${writes.length}`,SyncToken:'0',...payload});},
    };
    globalThis.__splitRuntime={db,qbo:fakeQbo,actor:null};
    const stubs={
     'supabaseAdmin.js':'export const supabase=globalThis.__splitRuntime.db;',
     'qboClient.js':'export async function getQBOClient(){return globalThis.__splitRuntime.qbo;}',
     'requireAuth.js':'export function requireAuth(req,res,next){if(!req.user?.id)return res.sendStatus(401);next();}',
     'entitledBusinesses.js':'export async function businessHasPaidEntitlement(){return true;} export async function filterEntitledBusinessIds(ids){return ids;}',
     'operatorRequestSummaryService.js':'export async function refreshOperatorRequestSummaryBestEffort(){}',
     'contractorCfoTriggerService.js':'export async function triggerContractorCfoInsightsBestEffort(){}',
     'taxChangeEvents.js':'export const TAX_CHANGE_TYPES={TRANSACTION_POSTED:"transaction_posted"};export async function emitTaxDataChanged(){}',
    };
    const tokenModule=fs.readFileSync('src/services/quickbooksTokenService.js','utf8');
    const tokenNames=[...tokenModule.matchAll(/export (?:async )?function (\w+)/g)].map(m=>m[1]);
    stubs['quickbooksTokenService.js']=tokenNames.map(name=>{
     if(['getLatestQuickBooksTokenRow','getLatestQuickBooksTokenRowEncrypted'].includes(name))return `export async function ${name}(bid){const {data,error}=await globalThis.__splitRuntime.db.from('quickbooks_tokens').select('*').eq('business_id',bid).maybeSingle();if(error)throw error;return data;}`;
     if(name==='consumeQuickBooksRefreshMarker')return `export function ${name}(){return false;}`;
     return `export async function ${name}(){throw Error('Unexpected token operation in isolated split test: ${name}');}`;
    }).join('\n');
    const outfile=path.join(directory,'runtime.mjs');
    await build({stdin:{contents:'export {default as approvals} from "./src/api/bookkeeping/routes/bookkeeping.approvals.routes.js";export {runBooksPostOnce,handleItem,postSingleBookkeepingTransactionNow} from "./src/jobs/booksPost.cron.js";export {previewPostingEligibilityRecheck} from "./src/services/bookkeeping/postingEligibilityRecheckService.js";export {createInteractivePostingCommand,requestInteractiveTransactionPosting,processInteractivePostingCommand} from "./src/services/bookkeeping/interactivePostingCommandService.js";',resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',packages:'external',outfile,
     banner:{js:`import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(path.join(process.cwd(),'package.json'))});`},
     plugins:[{name:'local-only-boundaries',setup(plugin){plugin.onResolve({filter:/\.js$/},args=>{const key=path.basename(args.path);if(key in stubs)return {path:key,namespace:'test-boundary'};});plugin.onLoad({filter:/.*/,namespace:'test-boundary'},args=>({contents:stubs[args.path]}));}}]});
    // External npm packages resolve from the repository, not the temporary dir.
    fs.symlinkSync(path.join(process.cwd(),'node_modules'),path.join(directory,'node_modules'),'dir');
    const runtime=await import(pathToFileURL(outfile));
    let current;
    const app=express();app.use(express.json());app.use((req,_res,next)=>{req.business={id:current.bid};req.user={id:current.actor};req.auth={userId:current.actor};req.tenantContext={businessId:current.bid,mode:current.mode};next();});app.use(runtime.approvals);
    server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    const origin=`http://127.0.0.1:${server.address().port}`;
    for(const scenario of ['customer','admin_view','admin_view_recovery','admin_view_undo_recovery','customer_undo_recovery','manual_command']) {
     const mode=scenario.startsWith('customer')?'customer':'admin_view';
     const {id}=fixture();current={...scope(),mode};const {bid}=current;
     const recovering=scenario.includes('recovery');let priorSplit=null,priorRequest=null;
     // Disposable legacy fixture: this snapshot predates the installed trigger.
     if(recovering)sql(`alter table public.transaction_splits disable trigger a_serialize_confirmed_split_edit;update public.transaction_splits set meta=meta-'approved_material' where business_id='${bid}' and transaction_id='${id}';alter table public.transaction_splits enable trigger a_serialize_confirmed_split_edit;`);
     if(!recovering)sql(`delete from public.transaction_categorizations where business_id='${bid}' and transaction_id='${id}';delete from public.transaction_splits where business_id='${bid}' and transaction_id='${id}';insert into public.transaction_categorizations(business_id,transaction_id,status,meta) values('${bid}','${id}','needs_review','{}');`);
     sql('grant select on public.quickbooks_tokens,public.qbo_accounts_cache,public.plaid_qbo_account_mappings,public.plaid_accounts,public.plaid_items to service_role;');
     sql(`select public.admit_handled_auto_post(p_business_id=>'${bid}',p_enabled=>true)`);
     if(recovering){
      priorSplit=JSON.parse(sql(`select to_jsonb(s) from public.transaction_splits s where business_id='${bid}' and transaction_id='${id}'`));
      const key=createHash('sha256').update(`${bid}|${id}|-517.55|2026-11-01`).digest('hex'),owner=randomUUID();priorRequest=`bizzi_${randomUUID().replaceAll('-','')}`;
      sql(`select public.acquire_posting_lock('${bid}','${id}',statement_timestamp(),600,'${key}');select public.claim_qbo_posting_intent('${bid}','${id}','${bid}','production','Purchase','${priorRequest}','${key}');
       update public.transaction_categorizations set status='failed',post_error='posting_shape_changed',post_after=null,meta=(meta-'posting_shape_binding')||'{"posting_execution_owner":"${owner}","posting_execution_request_id":"${priorRequest}","posting_in_progress":false}' where transaction_id='${id}';
       insert into public.bookkeeping_post_attempts(business_id,transaction_id,status,error_message) values('${bid}','${id}','failed','posting_shape_changed');
       update public.qbo_posted_transactions set lease_expires_at=statement_timestamp()-interval '1 second' where transaction_id='${id}';
       update public.bookkeeping_posting_jobs j set lease_expires_at=i.lease_expires_at from public.qbo_posted_transactions i where j.business_id=i.business_id and j.transaction_id=i.transaction_id and j.transaction_id='${id}';`);
      const intent=JSON.parse(sql(`select to_jsonb(i) from public.qbo_posted_transactions i where transaction_id='${id}'`));
      const meta=JSON.parse(sql(`select meta from public.transaction_categorizations where transaction_id='${id}'`));
      const blockedPreview=await runtime.previewPostingEligibilityRecheck({db,businessId:bid,month:'2026-11',transactionIds:[id]});
      assert.equal(blockedPreview.rows[0].reason,'failed_requires_existing_retry_workflow');assert.equal(blockedPreview.rows[0].outcome,'blocked');assert.match(blockedPreview.rows[0].selected_gl_account,/Split transaction.*2 line accounts/);
      if(scenario.includes('undo_recovery')){
       // Undo is permitted only after the old pre-provider claim is reconciled.
       const finalized=await db.rpc('reject_posting_before_provider',{p_business_id:bid,p_transaction_id:id,p_env:'production',p_context:{business_id:bid,transaction_id:id,env:'production',owner,request_id:priorRequest,idempotency_key:key,generation:meta.posting_generation,claimed_at:intent.processing_started_at,lease_expires_at:intent.lease_expires_at},p_reason:'posting_shape_changed'});
       assert.equal(finalized.error,null);
       const undo=await nativeFetch(`${origin}/undo`,{method:'POST',headers:{'content-type':'application/json',connection:'close'},body:JSON.stringify({txnId:id})});
       assert.equal(undo.status,200,JSON.stringify(await undo.json()));
       assert.equal(sql(`select status from public.transaction_categorizations where transaction_id='${id}'`),'needs_review');
       assert.equal(sql(`select status from public.transaction_splits where id='${priorSplit.id}'`),'voided');
       const reopened=JSON.parse(sql(`select meta from public.transaction_categorizations where transaction_id='${id}'`));
       assert.equal(reopened.taxonomy_type,undefined);assert.equal(reopened.posting_shape_binding,undefined);assert.equal(reopened.split_undo_audit.actor_id,current.actor);
       const again=await nativeFetch(`${origin}/undo`,{method:'POST',headers:{'content-type':'application/json',connection:'close'},body:JSON.stringify({txnId:id})});assert.equal(again.status,200);assert.equal((await again.json()).idempotent,true);
      }else{
       const repair=await db.rpc('reject_posting_before_provider',{p_business_id:bid,p_transaction_id:id,p_env:'production',p_context:{business_id:bid,transaction_id:id,env:'production',owner,request_id:priorRequest,idempotency_key:key,generation:meta.posting_generation,claimed_at:intent.processing_started_at,lease_expires_at:intent.lease_expires_at},p_reason:'posting_shape_changed'});
       assert.equal(repair.error,null);assert.equal(repair.data.ok,true);
       assert.equal(sql(`select state from public.bookkeeping_posting_jobs where transaction_id='${id}'`),'failed');
      }
      assert.equal(sql(`select post_after is null from public.transaction_categorizations where transaction_id='${id}'`),'t');
     }
     const principal=scenario.includes('undo_recovery')?46000:46755,interest=51755-principal;
     const lines=[{description:'Principal',amount_minor:principal,qbo_account_id:'principal'},{description:'Interest',amount_minor:interest,qbo_account_id:'interest'}];
     const response=await nativeFetch(`${origin}/transactions/${id}/confirm-split`,{method:'POST',headers:{'content-type':'application/json',connection:'close'},body:JSON.stringify({resolution:'split_transaction',split:{lines}})});
     const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
     const readCat=()=>JSON.parse(sql(`select to_jsonb(c) from public.transaction_categorizations c where business_id='${bid}' and transaction_id='${id}'`));
     const saved=readCat();assert.equal(saved.status,'approved');assert.equal(saved.review_status,'handled');assert.equal(saved.final_qbo_account_id,null);assert.ok(saved.meta.posting_shape_binding);assert.ok(Date.parse(saved.post_after)>RealDate.now()+23*3600000);
     const savedSplit=JSON.parse(sql(`select to_jsonb(s) from public.transaction_splits s where business_id='${bid}' and transaction_id='${id}' and status='confirmed'`));
     assert.deepEqual(savedSplit.lines.map(l=>[l.amount_minor,l.qbo_account_id]),[[principal,'principal'],[interest,'interest']]);
     if(priorSplit){if(scenario.includes('undo_recovery')){assert.notEqual(savedSplit.id,priorSplit.id);assert.notDeepEqual(savedSplit.lines.map(l=>l.id),priorSplit.lines.map(l=>l.id));}else{assert.equal(savedSplit.id,priorSplit.id);assert.deepEqual(savedSplit.lines,priorSplit.lines);}}
     assert.equal(savedSplit.confirmed_actor_type,mode==='admin_view'?'admin':'user');
     const preview=await runtime.previewPostingEligibilityRecheck({db,businessId:bid,month:'2026-11',transactionIds:[id]});assert.match(preview.rows[0].selected_gl_account,/Split transaction.*2 line accounts/);assert.equal(preview.rows[0].missing_final_repair_required,false);
     const command=scenario==='manual_command'
      ? await runtime.requestInteractiveTransactionPosting({db,businessId:bid,transactionId:id,actorId:current.actor,idempotencyKey:`split-${id}`})
      : await runtime.createInteractivePostingCommand({db,businessId:bid,actorId:current.actor,transactionIds:[id],selectedQboAccountId:null,rememberForFuture:false,merchantSnapshot:{requested_action:'post_now'},idempotencyKey:`split-${id}`});
     assert.ok(command.operation_id);const storedCommand=await db.from('bookkeeping_interactive_posting_commands').select('selected_qbo_account_id,merchant_snapshot').eq('operation_id',command.operation_id).single();assert.equal(storedCommand.error,null);assert.equal(storedCommand.data.selected_qbo_account_id,null);assert.equal(storedCommand.data.merchant_snapshot.posting_shape_binding,saved.meta.posting_shape_binding);
     const due=Date.parse(saved.post_after)+1000;
     globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[due]));}static now(){return due;}};
     const start=writes.length;
     const summary=scenario==='manual_command'
      ? await runtime.processInteractivePostingCommand({db,operationId:command.operation_id,postTransactionNow:runtime.postSingleBookkeepingTransactionNow})
      : await runtime.runBooksPostOnce({businessId:bid,transactionIds:[id],skipMerchantApprovalOperations:true});
     globalThis.Date=RealDate;
     if(scenario==='manual_command')assert.equal(summary.ok,true,JSON.stringify(summary));else assert.equal(summary.failed,0,JSON.stringify(summary));assert.equal(writes.length,start+1,JSON.stringify({summary,row:readCat()}));
     const payload=writes.at(-1);assert.equal(payload.AccountRef.value,'source');assert.deepEqual(payload.Line.map(l=>[l.Amount,l.AccountBasedExpenseLineDetail.AccountRef.value]),[[principal/100,'principal'],[interest/100,'interest']]);
     assert.equal(readCat().qbo_txn_id,`synthetic-receipt-${writes.length}`);assert.equal(readCat().status,'posted');
     assert.equal(readCat().final_qbo_account_id,null);
     assert.equal(sql(`select state from public.bookkeeping_posting_jobs where business_id='${bid}' and transaction_id='${id}'`),'posted');
     const postedSplit=JSON.parse(sql(`select to_jsonb(s) from public.transaction_splits s where business_id='${bid}' and transaction_id='${id}' and id='${savedSplit.id}'`));
     assert.equal(postedSplit.status,'posted');assert.equal(postedSplit.posted_qbo_txn_id,readCat().qbo_txn_id);assert.deepEqual(postedSplit.lines,savedSplit.lines);
     assert.equal(Number(sql(`select amount from public.bank_transactions where business_id='${bid}' and id='${id}'`)),-517.55);
     const intent=JSON.parse(sql(`select to_jsonb(i) from public.qbo_posted_transactions i where business_id='${bid}' and transaction_id='${id}'`));assert.equal(intent.status,'posted');assert.equal(intent.qbo_txn_id,readCat().qbo_txn_id);
     if(priorRequest)assert.equal(intent.request_id,priorRequest,'recovery retains original provider idempotency identity');
     await runtime.handleItem(readCat());assert.equal(writes.length,start+1,'receipt replay cannot create another QBO transaction');
     if(scenario==='manual_command'){await runtime.processInteractivePostingCommand({db,operationId:command.operation_id,postTransactionNow:runtime.postSingleBookkeepingTransactionNow});assert.equal(writes.length,start+1);}
    }
   });
  } finally {globalThis.Date=RealDate;if(server)await new Promise(resolve=>server.close(resolve));delete globalThis.__splitRuntime;fs.rmSync(directory,{recursive:true,force:true});}
 });
}
