import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {isTransactionInActiveBookkeepingScope} from '../src/services/bookkeeping/bookkeepingScope.js';

// Execute the actual route handler and month assertion against a bounded local
// query double. Stop at the approval boundary; real persistence/worker run in PG.
const source=fs.readFileSync('src/api/admin/monthlyReview.routes.js','utf8');
const start=source.indexOf('router.post(["/runs/:runId/transactions/:transactionId/approve"');
const bodyStart=source.indexOf('async (req, res) => {',start)+'async (req, res) => {'.length;
const end=source.indexOf('\n});\n\nrouter.post("/runs/:runId/bookkeeping/recover-handled-posting-dispositions"',bodyStart);
assert.ok(start>=0&&end>bodyStart);
const helperStart=source.indexOf('async function assertRunTransactionInSelectedMonth(');
const helperEnd=source.indexOf('\nrouter.',helperStart);
const monthStart=source.indexOf('function monthBounds(month)');
const monthEnd=source.indexOf('\nfunction previousMonthBounds',monthStart);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
class ApprovalStop extends Error{constructor(){super('captured');this.status=409;this.error='captured';}}

async function scenario({mode='admin',requestedMonth='2026-11',bankBusiness,bankDate='2026-11-23',sessionBusiness}={}){
 const business=randomUUID(),txn=randomUUID(),actor=randomUUID(),november={id:randomUUID(),business_id:business,review_month:'2026-11-01'},september={id:randomUUID(),business_id:business,review_month:'2026-09-01'};
 const state={monthly_review_runs:[november,september],bank_transactions:[{id:txn,business_id:bankBusiness||business,date:bankDate,pending:false,is_archived:false}],transaction_categorizations:[{business_id:business,transaction_id:txn,status:'needs_review',meta:{}}]};
 const supabase={from(table){let rows=state[table]||[];const q={select(){return q;},eq(k,v){rows=rows.filter(r=>r[k]===v);return q;},gte(k,v){rows=rows.filter(r=>r[k]>=v);return q;},lt(k,v){rows=rows.filter(r=>r[k]<v);return q;},async maybeSingle(){return {data:rows[0]||null,error:null};}};return q;}};
 let captured=null;const res={statusCode:200,status(n){this.statusCode=n;return this;},json(value){this.body=value;return this;}};
 const dependencies={supabase,UUID_RE:/^[a-f0-9-]{36}$/i,normalizeMonth:v=>`${v}-01`,fetchRun:async id=>state.monthly_review_runs.find(r=>r.id===id),getBookkeepingStartDate:async()=>null,isTransactionInActiveBookkeepingScope,
  BookkeepingApprovalError:ApprovalStop,monthlyReviewApprovalErrorMessage:e=>e.message,crypto:{randomUUID},console:{error(){}},
  approveBookkeepingTransactions:async args=>{captured=args;throw new ApprovalStop();}};
 const handler=new AsyncFunction(...Object.keys(dependencies),'req','res',source.slice(helperStart,helperEnd)+source.slice(monthStart,monthEnd)+source.slice(bodyStart,end));
 await handler(...Object.values(dependencies),{params:{businessId:business,transactionId:txn},body:{month:requestedMonth,final_qbo_account_id:'parking',verified_distinct_purchase:true},user:{id:actor},tenantContext:mode==='admin_view'?{mode,businessId:sessionBusiness||business}:null,get(){return 'synthetic-request';}},res);
 return {captured,res,business,actor,november,september};
}
test('admin approval resolves the selected business/November run, independently of stale September detail',async()=>{
 const x=await scenario();assert.equal(x.res.body.error,'captured');assert.equal(x.captured.businessId,x.business);assert.equal(x.captured.actorId,x.actor);assert.equal(x.captured.verifiedDistinctPurchase,true);assert.equal(x.captured.requireNeedsReview,true);
});
test('month, tenant and fixed Admin View scope cannot be bypassed',async()=>{
 for(const options of [{requestedMonth:'2026-09'},{bankBusiness:randomUUID()},{mode:'admin_view',sessionBusiness:randomUUID()}]){
  const x=await scenario(options);assert.equal(x.captured,null);assert.ok([403,409].includes(x.res.statusCode));
 }
});
