import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {buildTaxDeductionsLifecycleProjection} from '../src/services/tax/taxDeductionsLifecycleProjection.js';import {mapDeductionTransactionRow} from '../src/components/Tax/Deductions/deductionsWorkspaceViewModel.js';import {buildClassificationOverrideBatchItems} from '../src/services/tax/taxClassificationOverride.service.js';
const raw=JSON.parse(readFileSync(new URL('./fixtures/categoryResolutionRows.json',import.meta.url)));
const mapped=rows=>rows.map(r=>mapDeductionTransactionRow({...r,taxScopeDisposition:'expense_cogs_in_matrix'}));
test('Rent and every unresolved expense have questions rather than disappearing',()=>{const p=buildTaxDeductionsLifecycleProjection({rows:mapped(raw),businessId:raw[0].business_id,taxYear:2026});assert.equal(p.activeDecisionGroups.filter(g=>g.decisionType==='rent_treatment').reduce((s,g)=>s+g.actionableTransactionCount,0),5);assert.equal(p.activeDecisionGroups.reduce((s,g)=>s+g.actionableTransactionCount,0),55);});
test('four May Supplies suggestions create a separate Supplies group without finalizing Unresolved',()=>{const may=raw.filter(r=>r.tax_category==='unclassified'&&r.transaction_date.startsWith('2026-05')).map(r=>({...r,metadata:{tax_category_suggestion:{taxCategory:'supplies',confidence:95}}}));const p=buildTaxDeductionsLifecycleProjection({rows:mapped([...may,{...may[0],transaction_id:'other',metadata:{tax_category_suggestion:{taxCategory:'bank_fees',confidence:95}}}]),businessId:raw[0].business_id,taxYear:2026});assert.equal(p.activeDecisionGroups.length,2);assert.equal(p.activeDecisionGroups.find(g=>g.resolutionFacts?.suggestedCategory==='supplies').actionableTransactionCount,4);assert.ok(p.entries.every(e=>e.row.taxCategory==='unresolved'));});
test('Unresolved cannot be finalized through a manual batch override',()=>assert.throws(()=>buildClassificationOverrideBatchItems({transactionIds:[raw[0].transaction_id],currentRows:[raw[0]],taxYear:2026,actor:{userId:'owner',source:'user',role:'user'},input:{taxCategory:'unresolved',deductibilityStatus:'nondeductible',deductiblePercent:0,taxTreatment:'ordinary_expense',reason:'confirm'}}),e=>e.code==='temporary_tax_category'));

test('unknown classifications use generic questions and exact pending membership reconciles with the counter', async()=>{
 const {__taxWorkspaceProjectionTestInternals:workspace}=await import('../src/services/tax/taxWorkspaceProjection.service.js');
 const lifecycle=buildTaxDeductionsLifecycleProjection({rows:mapped(raw),businessId:raw[0].business_id,taxYear:2026});
 const p=workspace.buildPayload({overview:{},lifecycle,businessId:raw[0].business_id,taxYear:2026,sourceFingerprint:'audit',generatedAt:'2026-11-03'});
 assert.equal(p.questionGroupCount,p.questionGroups.length);
 assert.equal(p.questionGroupCount,11);
 assert.equal(p.questionGroups.filter(g=>g.resolutionTitle==='Choose a tax category').length,10);
 const questionIds=Object.values(p.identityEvidence.questionGroups).flat();
 assert.equal(new Set(questionIds).size,55);
 assert.equal(p.treatmentCounts.needs_input,55);
 assert.equal(p.resolutionWorkflows.transactionCount,0);
 workspace.validatePayload(p);
});
test('different review reasons split suggestions and missing tax suggestions never inherit bookkeeping suggestions',()=>{
 const rows=raw.slice(0,2).map((r,i)=>({...r,source_qbo_account_id:'same',tax_category:'unclassified',metadata:{suggested_category:'Supplies',review_reason_code:i?'different':'missing'}}));
 const p=buildTaxDeductionsLifecycleProjection({rows:mapped(rows),businessId:raw[0].business_id,taxYear:2026});
 assert.equal(p.activeDecisionGroups.length,2);assert.ok(p.activeDecisionGroups.every(g=>g.resolutionTitle==='Choose a tax category'));
});
test('rent needs explicit supported use and current-year facts; uncertainty and temporary categories cannot finalize',async()=>{
 const {categoryTreatmentForAnswer}=await import('../src/services/tax/taxCategoryResolution.js');
 assert.throws(()=>categoryTreatmentForAnswer({taxCategory:'rent_lease',businessPurposeConfirmed:true,rentUse:'not_sure'},'rent_treatment'),e=>e.code==='rent_clarification_required');
 assert.throws(()=>categoryTreatmentForAnswer({taxCategory:'unresolved',businessPurposeConfirmed:true},'category_confirmation'),e=>e.code==='temporary_tax_category');
 assert.equal(categoryTreatmentForAnswer({taxCategory:'equipment_rental',businessPurposeConfirmed:true,rentUse:'equipment_rental',currentYearConfirmed:true},'rent_treatment').deductiblePercent,100);
});
test('counter and alternate-workflow count cannot drift from the exact pending identities',async()=>{
 const {__taxWorkspaceProjectionTestInternals:workspace}=await import('../src/services/tax/taxWorkspaceProjection.service.js');
 const source=mapped(raw);source[0].raw.user_override=true;source[0].userOverride=true;
 const lifecycle=buildTaxDeductionsLifecycleProjection({rows:source,businessId:raw[0].business_id,taxYear:2026});
 const p=workspace.buildPayload({overview:{},lifecycle,businessId:raw[0].business_id,taxYear:2026,sourceFingerprint:'audit',generatedAt:'2026-11-03'});
 assert.equal(p.resolutionWorkflows.transactionCount,1);workspace.validatePayload(p);
 assert.throws(()=>workspace.validatePayload({...p,questionGroupCount:p.questionGroupCount+1}),e=>e.code==='tax_workspace_question_membership_mismatch');
 assert.throws(()=>workspace.validatePayload({...p,resolutionWorkflows:{...p.resolutionWorkflows,transactionCount:0}}),e=>e.code==='tax_workspace_resolution_path_mismatch');
});
