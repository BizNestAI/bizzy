import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapDeductionTransactionRow } from '../src/components/Tax/Deductions/deductionsWorkspaceViewModel.js';
import { buildTaxDeductionsLifecycleProjection } from '../src/services/tax/taxDeductionsLifecycleProjection.js';
import { attachVehicleElectionEvidence, hasConfirmedVehicleElection, vehicleTreatmentProvenanceLabel } from '../src/services/tax/taxVehicleAuthority.js';
import { __taxWorkspaceProjectionTestInternals as projection } from '../src/services/tax/taxWorkspaceProjection.service.js';
const rows = JSON.parse(readFileSync(new URL('./fixtures/vehicleElectionLabelRows.json', import.meta.url)));
const mapped = rows.map(row => mapDeductionTransactionRow({...row, taxScopeDisposition:'expense_cogs_in_matrix'}));
test('historical protected six and legacy mileage rows without elections remain pending, including matrix cells', () => {
  assert.equal(rows.length,26);
  assert.equal(rows.filter(row=>row.classification_status==='needs_review').length,6);
  const lifecycle=buildTaxDeductionsLifecycleProjection({rows:mapped,businessId:rows[0].business_id,taxYear:2026});
  assert.equal(lifecycle.counts.reviewed,0);
  assert.equal(lifecycle.counts.customer_input_required,26);
  for(const month of ['2026-05','2026-06','2026-07']) {
    const entries=lifecycle.entries.filter(e=>e.row.date.startsWith(month));
    const cell=projection.aggregateMonth(entries);
    assert.equal(cell.reviewedTransactionCount,0);
    assert.equal(cell.standardMileageTransactionCount,0);
    assert.equal(cell.reviewedDeductibleAmount,0);
    assert.equal(cell.reviewedTreatmentLabel,null);
    assert.equal(cell.needsInputTransactionCount,entries.length);
  }
  for(const row of mapped)assert.doesNotMatch(vehicleTreatmentProvenanceLabel(row),/Reviewed/);
  assert.ok(rows.every(row=>row.user_override));
});
test('treatment text and manual flags cannot establish a mileage election',()=>{
  const row=mapped.find(row=>JSON.stringify(row.raw.tax_treatment).includes('standard_mileage'));
  assert.equal(vehicleTreatmentProvenanceLabel(row),'Needs Input');
});

test('only persisted active confirmed election in the exact business/year/vehicle/date scope permits review', () => {
  const row={...mapped[0],businessId:'business',taxYear:2026,vehicleId:'vehicle',date:'2026-06-15'};
  const election={id:'election',businessId:'business',taxYear:2026,vehicleId:'vehicle',method:'standard_mileage',status:'active',electedBy:'owner',electedAt:'2026-01-01T00:00:00Z',effectiveStart:'2026-01-01',effectiveEnd:'2026-12-31'};
  assert.equal(hasConfirmedVehicleElection({...row,vehicleElectionEvidence:election},'standard_mileage'),true);
  for(const change of [{businessId:'other'},{taxYear:2025},{vehicleId:'other'},{status:'draft'},{status:'superseded'},{supersededBy:'replacement'},{electedBy:null},{electedAt:null},{effectiveEnd:'2026-05-31'},{method:'actual_expenses'}]) {
    assert.equal(hasConfirmedVehicleElection({...row,vehicleElectionEvidence:{...election,...change}},'standard_mileage'),false,JSON.stringify(change));
  }
  const forged={...row,vehicleElectionEvidence:election};
  assert.equal(attachVehicleElectionEvidence([forged],{businessId:'business',taxYear:2026,workflows:{vehicles:[]}})[0].vehicleElectionEvidence,null);
});

test('workspace overlay rechecks live election tables and rejects unverifiable sparse vehicle fallback', async () => {
  const { reconcileTaxWorkspaceProjection } = await import('../src/services/tax/taxWorkspaceProjection.service.js');
  const businessId=rows[0].business_id;
  const lifecycle=buildTaxDeductionsLifecycleProjection({rows:mapped,businessId,taxYear:2026});
  const baseline=projection.buildPayload({overview:{},lifecycle,businessId,taxYear:2026,sourceFingerprint:'a'.repeat(64),generatedAt:'2026-11-03T00:00:00Z'});
  let live=rows;
  const supabase={store:{tax_vehicles:[],tax_vehicle_method_elections:[],tax_vehicle_mileage_inputs:[],tax_vehicle_mileage_rates:[]},from(table){assert.equal(table,'transaction_tax_classifications');const q={select(){return this;},eq(){return this;},limit(){return this;},then(resolve){return Promise.resolve({data:live,error:null}).then(resolve);}};return q;}};
  const input={supabase,businessId,taxYear:2026,record:{id:'projection',source_fingerprint:'a'.repeat(64),projection_data:baseline},diagnosticLogger(){},metricLogger(){}};
  const before=JSON.stringify(rows);
  const result=await reconcileTaxWorkspaceProjection(input);
  assert.equal(result.treatmentCounts.reviewed,0);
  assert.equal(result.treatmentCounts.needs_input,26);
  assert.ok(result.matrix.every(c=>Object.values(c.months).every(m=>m.reviewedTransactionCount===0 && m.standardMileageTransactionCount===0)));
  assert.equal(JSON.stringify(rows),before,'read-only overlay preserves historical protected classifications');
  live=rows.slice(1);
  await assert.rejects(reconcileTaxWorkspaceProjection(input),e=>e.code==='tax_workspace_live_population_mismatch');
});
