/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
process.env.SUPABASE_URL||='http://127.0.0.1:1';process.env.SUPABASE_SERVICE_ROLE_KEY||='synthetic';
test('scheduled distinct-charge authority applies only to the reviewed other identity and never deterministic evidence',async()=>{
 const {isRejectedSoftDuplicateCandidate}=await import('../src/jobs/booksPost.cron.js');
 const item={business_id:'business',transaction_id:'current',final_qbo_account_id:'entertainment',meta:{distinct_charge_schedule:{fingerprint:'server-bound',qbo_txn_id:'2209'},duplicate_override_decision:{decision_version:4,source:'posting_eligibility_distinct_charge',business_id:'business',transaction_id:'current',selected_qbo_account_id:'entertainment',reviewed_candidates:[{qbo_txn_id:'2209',qbo_txn_type:'CreditCardCharge',consumed_by_another_transaction:true}]}}};
 const candidate={qbo_txn_id:'2209',qbo_txn_type:'Purchase'};
 assert.equal(isRejectedSoftDuplicateCandidate(item,candidate),true);
 for(const change of [{qbo_txn_id:'another'},{deterministic:true},{qbo_txn_type:'Deposit'}])assert.equal(isRejectedSoftDuplicateCandidate(item,{...candidate,...change}),false);
 for(const change of [{business_id:'foreign'},{transaction_id:'foreign'},{final_qbo_account_id:'different'}])assert.equal(isRejectedSoftDuplicateCandidate({...item,...change},candidate),false);
 assert.equal(isRejectedSoftDuplicateCandidate({...item,meta:{...item.meta,distinct_charge_schedule:null}},candidate),false);
});
test('Recheck shows a per-row conflict and requires explicit confirmation, while keeping the bulk scheduling choice',()=>{
 const page=fs.readFileSync('src/pages/Admin/MonthlyReviewConsole.jsx','utf8'),route=fs.readFileSync('src/api/admin/monthlyReview.routes.js','utf8');
 for(const pattern of [/Conflicting QuickBooks expense/,/I verified two separate purchases/,/distinctSelections\[row.transaction_id\]/,/row_version: row.row_version/,/fingerprint: row.distinct_charge_review.fingerprint/,/distinct_charge_confirmations: distinctChargeConfirmations/,/Schedule automatically eligible transactions/])assert.match(page,pattern);
 assert.match(route,/invalid_distinct_charge_confirmations/);assert.match(route,/admin_view_business_mismatch/);
 const service=fs.readFileSync('src/services/bookkeeping/postingEligibilityRecheckService.js','utf8');
 assert.match(service,/distinctRequest.confirmed !== true/);assert.match(service,/distinctRequest.fingerprint !== row.distinct_charge_review\?\.fingerprint/);
 assert.match(service,/schedule_reviewed_distinct_charge/);assert.match(service,/expectedVersion !== preview.preview_version/);
});
