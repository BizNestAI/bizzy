import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {__taxWorkspaceProjectionTestInternals as projection} from '../src/services/tax/taxWorkspaceProjection.service.js';
const businessId='business';
function build(rows=[],vehicles=[]) {
 return projection.buildPayload({businessId,taxYear:2026,sourceFingerprint:'f',generatedAt:'2026-11-03',overview:{},vehicleDeductions:{taxYear:2026,vehicles,rates:[{effectiveStart:'2026-01-01',effectiveEnd:'2026-06-30'},{effectiveStart:'2026-07-01',effectiveEnd:'2026-12-31'}]},lifecycle:{entries:rows.map(row=>({id:row.transactionId,row:{...row,taxScopeDisposition:'expense_cogs_in_matrix'},outcome:'customer_input_required'})),activeDecisionGroups:[]}});
}
test('Gas context uses the full authoritative matrix population and rate boundaries, regardless of protection',()=>{
 const fixture=JSON.parse(readFileSync(new URL('../reports/vehicle-deduction/election-label-audit.json',import.meta.url)));
 const rows=fixture.classifications.map(r=>({transactionId:r.transaction_id,date:r.transaction_date,signedAmount:r.book_amount,taxCategory:'vehicle_expense',qboAccountName:r.source_qbo_account_name,userOverride:r.user_override}));
 const p=build(rows);assert.equal(p.gasContext.total.transactionCount,96);assert.equal(p.gasContext.total.grossExpenseAmount,3934.47);
 assert.deepEqual(p.gasContext.periods.map(x=>x.transactionCount),[32,64]);
 assert.equal(p.gasContext.periods.reduce((s,x)=>s+x.grossExpenseCents,0),p.gasContext.total.grossExpenseCents);
 assert.deepEqual(p.gasContext.total.transactionIds.sort(),p.identityEvidence.matrixIncluded.sort());
});
test('saved monthly mileage is a dedicated matrix adjustment counted once without fake transactions',()=>{
 const p=build([],[{id:'v',election:{method:'standard_mileage'},mileage:{businessMiles:13000,deductionAmount:9845,monthlyAllocation:{status:'complete',months:{'2026-01':{businessMiles:1000,deductionAmount:725},'2026-07':{businessMiles:12000,deductionAmount:9120}},allocatedDeductionAmount:9845,unallocatedDeductionAmount:0}}}]);
 assert.equal(p.matrix[0].months['2026-01'].mileageDeductionAmount,725);assert.equal(p.matrix[0].transactionCount,0);
 assert.equal(p.postedTransactionDeductionAmount,0);assert.equal(p.vehicleMileageDeductionAmount,9845);assert.equal(p.estimatedDeductibleAmount,9845);
 assert.equal(p.matrixIncludedCount,0);assert.equal(p.matrix[0].identityManifest.length,0);
});
test('mileage UX removes standalone treatment row and manual preview button',()=>{
 const source=readFileSync(new URL('../src/pages/Tax/TaxDashboard.jsx',import.meta.url),'utf8');
 assert.doesNotMatch(source,/\{vehicle.displayName\} · \{year\} vehicle treatment/);
 const editor=readFileSync(new URL('../src/components/Tax/BusinessMileagePanel.jsx',import.meta.url),'utf8');
 assert.doesNotMatch(editor,/Preview deduction|active mileage periods|saving replaces the entire/i);
 assert.match(editor,/Change vehicle method/);
});

test('monthly amount rounding, rate boundaries, and unallocated period totals do not depend on Gas amounts', async()=>{
 const {calculateVehicleMileagePeriods}=await import('../src/services/tax/vehicleMileageRates.js');
 const {monthlyMileageAllocation}=await import('../src/services/tax/taxVehicleMileagePresentation.js');
 const periods=calculateVehicleMileagePeriods({entries:[{periodStart:'2026-01-01',periodEnd:'2026-01-31',businessMiles:1000},{periodStart:'2026-07-01',periodEnd:'2026-07-31',businessMiles:12000}]});
 assert.equal(periods.totalDeduction,9845);assert.deepEqual(periods.periods.map(p=>p.amount),[725,9120]);
 const allocation=monthlyMileageAllocation(periods.periods);assert.equal(allocation.status,'complete');assert.equal(allocation.allocatedDeductionAmount,9845);
 const half=calculateVehicleMileagePeriods({entries:[{periodStart:'2026-01-01',periodEnd:'2026-06-30',businessMiles:1000},{periodStart:'2026-07-01',periodEnd:'2026-12-31',businessMiles:12000}]});
 const none=monthlyMileageAllocation(half.periods);assert.equal(none.status,'unavailable');assert.deepEqual(none.months,{});assert.equal(none.unallocatedDeductionAmount,9845);
 const p=build([],[{id:'v',election:{method:'standard_mileage'},mileage:{businessMiles:13000,deductionAmount:9845,monthlyAllocation:none}}]);
 assert.equal(p.vehicleMileageDeductionAmount,9845);assert.equal(Object.keys(p.matrix[0].months).length,0);
 for(const miles of ['-1','1.001','1e3','1,000','NaN','Infinity','1000000.01','9007199254740993','',null])assert.throws(()=>calculateVehicleMileagePeriods({entries:[{periodStart:'2026-01-01',periodEnd:'2026-01-31',businessMiles:miles}]}));
 const pennies=calculateVehicleMileagePeriods({entries:[{periodStart:'2026-01-01',periodEnd:'2026-01-31',businessMiles:'0.2'},{periodStart:'2026-02-01',periodEnd:'2026-02-28',businessMiles:'0.2'}]});
 assert.equal(pennies.totalBusinessMiles,0.4);assert.equal(pennies.totalDeduction,0.3,'sum rounded monthly amounts rather than round aggregated half-year miles');
});

test('matrix validates mileage composition separately from expense identities and cannot double count the headline',()=>{
 const period={periodStart:'2026-01-01',periodEnd:'2026-01-31',businessMiles:1000,deductionAmount:725};
 const p=build([{transactionId:'gas',date:'2026-01-15',qboAccountName:'Gas',taxCategory:'vehicle_expense',signedAmount:-100}], [{id:'v',election:{method:'standard_mileage'},mileage:{entryCount:1,businessMiles:1000,deductionAmount:725,monthlyAllocation:{status:'complete',months:{'2026-01':{businessMiles:1000,deductionAmount:725}},allocatedDeductionAmount:725,unallocatedDeductionAmount:0},periods:[period]}}]);
 assert.equal(p.matrix[0].transactionCount,1);assert.equal(p.matrix[0].months['2026-01'].needsInputGrossExpense,100);assert.equal(p.postedTransactionDeductionAmount,0);assert.equal(p.estimatedDeductibleAmount,725);
 projection.validatePayload(p);
 const changed=structuredClone(p);changed.matrix[0].months['2026-01'].mileageDeductionAmount=726;
 assert.throws(()=>projection.validatePayload(changed),e=>e.code==='tax_workspace_mileage_reconciliation_failed');
});
