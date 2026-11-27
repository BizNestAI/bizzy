/* global process */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

export async function verifyDistinctChargeWorker({db,businessId,transactionId,postAfter,existingReceipt,first=false}) {
 const directory=fs.mkdtempSync('/private/tmp/bizzi-distinct-worker-'),RealDate=Date,writes=existingReceipt?[structuredClone(existingReceipt)]:[];
 globalThis.__distinctChargeWorker={db,qbo:{
  findAccounts(_criteria,cb){cb(null,{QueryResponse:{Account:[{Id:'source-card',Name:'CREDIT CARD',AccountType:'Credit Card',Active:true},{Id:'entertainment',Name:'Entertainment',AccountType:'Expense',Active:true}]}});},
  findPurchases(_criteria,cb){cb(null,{QueryResponse:{Purchase:writes}});},
  findVendors(_criteria,cb){cb(null,{QueryResponse:{Vendor:[]}});},
  createPurchase(payload,cb){writes.push({Id:first?'2209':'synthetic-second-receipt',SyncToken:'0',...structuredClone(payload)});cb(null,writes.at(-1));},
 }};
 try {
  const stubs={
   'supabaseAdmin.js':'export const supabase=globalThis.__distinctChargeWorker.db;',
   'qboClient.js':'export async function getQBOClient(){return globalThis.__distinctChargeWorker.qbo;}',
   'entitledBusinesses.js':'export async function businessHasPaidEntitlement(){return true;} export async function filterEntitledBusinessIds(ids){return ids;}',
   'operatorRequestSummaryService.js':'export async function refreshOperatorRequestSummaryBestEffort(){}',
   'contractorCfoTriggerService.js':'export async function triggerContractorCfoInsightsBestEffort(){}',
   'taxChangeEvents.js':'export const TAX_CHANGE_TYPES={TRANSACTION_POSTED:"transaction_posted"};export async function emitTaxDataChanged(){}',
  };
  const tokenSource=fs.readFileSync('src/services/quickbooksTokenService.js','utf8');
  stubs['quickbooksTokenService.js']=[...tokenSource.matchAll(/export (?:async )?function (\w+)/g)].map(([,name])=>{
   if(['getLatestQuickBooksTokenRow','getLatestQuickBooksTokenRowEncrypted'].includes(name))return `export async function ${name}(bid){const {data,error}=await globalThis.__distinctChargeWorker.db.from('quickbooks_tokens').select('*').eq('business_id',bid).maybeSingle();if(error)throw error;return data;}`;
   if(name==='consumeQuickBooksRefreshMarker')return `export function ${name}(){return false;}`;
   return `export async function ${name}(){throw Error('Unexpected token operation: ${name}');}`;
  }).join('\n');
  const outfile=path.join(directory,'worker.mjs');
  await build({stdin:{contents:'export {runBooksPostOnce} from "./src/jobs/booksPost.cron.js";',resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',packages:'external',outfile,
   banner:{js:`import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(path.join(process.cwd(),'package.json'))});`},
   plugins:[{name:'local-provider-boundaries',setup(plugin){plugin.onResolve({filter:/\.js$/},args=>{const key=path.basename(args.path);if(key in stubs)return {path:key,namespace:'local'};});plugin.onLoad({filter:/.*/,namespace:'local'},args=>({contents:stubs[args.path]}));}}]});
  fs.symlinkSync(path.join(process.cwd(),'node_modules'),path.join(directory,'node_modules'),'dir');
  const worker=await import(pathToFileURL(outfile));
  const due=Date.parse(postAfter)+1000;
  globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[due]));}static now(){return due;}};
  const result=await worker.runBooksPostOnce({businessId,transactionIds:[transactionId],skipMerchantApprovalOperations:true});
  assert.equal(writes.length,first?1:2,JSON.stringify(result));
  assert.equal(writes.at(-1).PaymentType,'CreditCard');assert.equal(writes.at(-1).TotalAmt,28);
  assert.equal(writes.at(-1).AccountRef.value,'source-card');assert.equal(writes.at(-1).Line[0].AccountBasedExpenseLineDetail.AccountRef.value,'entertainment');
  const receipt=await db.from('qbo_posted_transactions').select('*').eq('business_id',businessId).eq('transaction_id',transactionId);
  assert.equal(receipt.error,null,JSON.stringify(receipt.error));assert.equal(receipt.data.length,1);assert.equal(receipt.data[0].status,'posted');assert.equal(receipt.data[0].qbo_txn_id,first?'2209':'synthetic-second-receipt');
  await worker.runBooksPostOnce({businessId,transactionIds:[transactionId],skipMerchantApprovalOperations:true});assert.equal(writes.length,first?1:2,'Replay cannot write again');
 } finally {globalThis.Date=RealDate;delete globalThis.__distinctChargeWorker;fs.rmSync(directory,{recursive:true,force:true});}
}
