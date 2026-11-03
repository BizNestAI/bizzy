import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import {vehicleDatabase} from './fixtures/vehicleDatabase.js';
import {calculateVehicleMileagePeriods} from '../src/services/tax/vehicleMileageRates.js';
const container=process.env.TAX_VEHICLE_TEST_CONTAINER;
test('monthly mileage snapshots match SQL numeric rounding, preserve retries, and never change Gas or fake transactions',{skip:!container},()=>{
 const db=vehicleDatabase();
 try{
  db.check(db.sql(`insert into public.tax_vehicles(id,business_id,display_name,ownership_type) values('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111','Monthly van','owned');
  insert into public.tax_vehicle_method_elections(id,business_id,vehicle_id,tax_year,method,status,effective_start,effective_end,source,authority,contract_version,elected_by) values('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444',2026,'standard_mileage','active','2026-01-01','2026-12-31','tax_workspace_question','customer','vehicle-election-v1','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');`));
  const rows=Array.from({length:12},(_,i)=>({period_start:`2026-${String(i+1).padStart(2,'0')}-01`,period_end:`2026-${String(i+1).padStart(2,'0')}-${new Date(Date.UTC(2026,i+1,0)).getUTCDate()}`,business_miles:i===0?1000:i===6?12000:i===1?0.2:0,substantiation_status:'supported',mileage_basis:'records'}));
  const js=calculateVehicleMileagePeriods({entries:rows});
  const cmd=`select public.replace_tax_vehicle_mileage_entries('11111111-1111-4111-8111-111111111111',2026,'44444444-4444-4444-8444-444444444444','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','55555555-5555-4555-8555-555555555555','${JSON.stringify(rows)}'::jsonb);`;
  const before=db.check(db.sql('select jsonb_agg(to_jsonb(c) order by id) from public.transaction_tax_classifications c;')).stdout;
  const saved=JSON.parse(db.check(db.sql(cmd,'service_role')).stdout.trim());const retry=JSON.parse(db.check(db.sql(cmd,'service_role')).stdout.trim());assert.deepEqual(saved.entry_ids,retry.entry_ids);assert.equal(Number(saved.total_deduction),js.totalDeduction);
  const months=JSON.parse(db.check(db.sql(`select jsonb_agg(jsonb_build_object('month',to_char(period_start,'YYYY-MM'),'miles',business_miles,'amount',deduction_amount) order by period_start) from public.tax_vehicle_mileage_inputs where status='active';`)).stdout.trim());
  assert.equal(months.length,12);assert.equal(Number(months[0].amount),725);assert.equal(Number(months[1].amount),0.15);assert.equal(Number(months[6].amount),9120);
  assert.equal(Math.round(months.reduce((s,m)=>s+Number(m.amount)*100,0)),Math.round(js.totalDeduction*100));
  assert.equal(db.check(db.sql('select count(*) from public.bank_transactions;')).stdout.trim(),'76');
  assert.equal(db.check(db.sql('select jsonb_agg(to_jsonb(c) order by id) from public.transaction_tax_classifications c;')).stdout,before,'all Gas rows including protected six stay byte-for-byte unchanged');
  assert.notEqual(db.sql(cmd.replace('55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-666666666666'),'service_role').status,0);
  assert.notEqual(db.sql(cmd,'authenticated').status,0,'browser role cannot execute snapshots');
  assert.equal(db.check(db.sql('select count(*) from public.tax_vehicle_mileage_inputs;')).stdout.trim(),'12','failed requests and retries create no duplicate history');
 }finally{db.cleanup();}
});
