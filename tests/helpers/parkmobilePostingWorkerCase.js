/* global process */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

export async function verifyParkmobileWorker({db,businessId,transactionId,postAfter}) {
 const directory=fs.mkdtempSync('/private/tmp/bizzi-parkmobile-worker-'),RealDate=Date,writes=[];
 globalThis.__parkmobileWorker={db,qbo:{
  findAccounts(_criteria,cb){cb(null,{QueryResponse:{Account:[{Id:'source-card',Name:'CREDIT CARD',AccountType:'Credit Card',Active:true},{Id:'parking',Name:'Parking',AccountType:'Expense',Active:true}]}});},
  findPurchases(_criteria,cb){cb(null,{QueryResponse:{Purchase:[]}});},
  findVendors(_criteria,cb){cb(null,{QueryResponse:{Vendor:[]}});},
  createPurchase(payload,cb){writes.push(structuredClone(payload));cb(null,{Id:'synthetic-parkmobile-receipt',SyncToken:'0',...payload});},
 }};
 try {
  const stubs={
   'supabaseAdmin.js':'export const supabase=globalThis.__parkmobileWorker.db;',
   'qboClient.js':'export async function getQBOClient(){return globalThis.__parkmobileWorker.qbo;}',
   'entitledBusinesses.js':'export async function businessHasPaidEntitlement(){return true;} export async function filterEntitledBusinessIds(ids){return ids;}',
   'operatorRequestSummaryService.js':'export async function refreshOperatorRequestSummaryBestEffort(){}',
   'contractorCfoTriggerService.js':'export async function triggerContractorCfoInsightsBestEffort(){}',
   'taxChangeEvents.js':'export const TAX_CHANGE_TYPES={TRANSACTION_POSTED:"transaction_posted"};export async function emitTaxDataChanged(){}',
  };
  const tokenSource=fs.readFileSync('src/services/quickbooksTokenService.js','utf8');
  stubs['quickbooksTokenService.js']=[...tokenSource.matchAll(/export (?:async )?function (\w+)/g)].map(([,name])=>{
   if(['getLatestQuickBooksTokenRow','getLatestQuickBooksTokenRowEncrypted'].includes(name))return `export async function ${name}(bid){const {data,error}=await globalThis.__parkmobileWorker.db.from('quickbooks_tokens').select('*').eq('business_id',bid).maybeSingle();if(error)throw error;return data;}`;
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
  assert.equal(writes.length,1,JSON.stringify(result));
  assert.equal(writes[0].PaymentType,'CreditCard');assert.equal(writes[0].TotalAmt,3.12);
  assert.equal(writes[0].AccountRef.value,'source-card');assert.equal(writes[0].Line[0].AccountBasedExpenseLineDetail.AccountRef.value,'parking');
  const receipt=await db.from('qbo_posted_transactions').select('*').eq('business_id',businessId).eq('transaction_id',transactionId);
  assert.equal(receipt.error,null,JSON.stringify(receipt.error));assert.equal(receipt.data.length,1);assert.equal(receipt.data[0].status,'posted');assert.equal(receipt.data[0].qbo_txn_id,'synthetic-parkmobile-receipt');
  await worker.runBooksPostOnce({businessId,transactionIds:[transactionId],skipMerchantApprovalOperations:true});assert.equal(writes.length,1,'Replay cannot write again');
 } finally {globalThis.Date=RealDate;delete globalThis.__parkmobileWorker;fs.rmSync(directory,{recursive:true,force:true});}
}
