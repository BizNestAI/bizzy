import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  VEHICLE_MILEAGE_RATES,
  calculateVehicleMileagePeriods,
} from "../src/services/tax/vehicleMileageRates.js";
import {
  createTaxVehicle,
  listVehicleDeductionWorkflows,
  previewVehicleMileage,
  saveVehicleMileage,
} from "../src/services/tax/taxVehicleDeduction.service.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const actor = { userId: USER_ID, source: "user", tenantMode: "customer" };

function storeClient() {
  return {
    store: {
      tax_vehicles: [],
      tax_vehicle_method_elections: [],
      tax_vehicle_mileage_inputs: [],
      tax_vehicle_mileage_rates: VEHICLE_MILEAGE_RATES.map((rate, index) => ({
        id: `rate-${index + 1}`,
        purpose: rate.purpose,
        effective_start: rate.effectiveFrom,
        effective_end: rate.effectiveTo,
        amount_per_mile: rate.amountPerMile,
        source_version: rate.sourceVersion,
        status: "active",
      })),
    },
  };
}

test("2026 standard mileage applies the effective rate to each non-overlapping period", () => {
  const result = calculateVehicleMileagePeriods({ entries: [
    { periodStart: "2026-01-01", periodEnd: "2026-06-30", businessMiles: 100 },
    { periodStart: "2026-07-01", periodEnd: "2026-12-31", businessMiles: 100 },
  ] });
  assert.equal(result.totalBusinessMiles, 200);
  assert.equal(result.totalDeduction, 148.5);
  assert.deepEqual(result.periods.map((period) => period.amountPerMile), [0.725, 0.76]);
});

test("mileage fails closed for overlap, excessive precision, and a period crossing rate boundaries", () => {
  assert.throws(() => calculateVehicleMileagePeriods({ entries: [
    { periodStart: "2026-01-01", periodEnd: "2026-06-30", businessMiles: 1 },
    { periodStart: "2026-06-30", periodEnd: "2026-07-01", businessMiles: 1 },
  ] }), (error) => error.code === "duplicate_or_overlapping_mileage");
  assert.throws(() => calculateVehicleMileagePeriods({ entries: [
    { periodStart: "2026-01-01", periodEnd: "2026-06-30", businessMiles: "1.001" },
  ] }), (error) => error.code === "invalid_business_miles");
  assert.throws(() => calculateVehicleMileagePeriods({ entries: [
    { periodStart: "2026-06-01", periodEnd: "2026-07-31", businessMiles: 10 },
  ] }), (error) => error.code === "mileage_period_requires_rate_allocation");
});

test("a standard-mileage workflow previews, replaces, and totals one active canonical mileage set", async () => {
  const supabase = storeClient();
  const vehicle = await createTaxVehicle({ supabase, businessId: BUSINESS_ID, actor, input: { displayName: "Work van", ownershipType: "owned" } });
  supabase.store.tax_vehicle_method_elections.push({
    id: "33333333-3333-4333-8333-333333333333", business_id: BUSINESS_ID, vehicle_id: vehicle.id,
    tax_year: 2026, method: "standard_mileage", status: "active", effective_start: "2026-01-01", effective_end: "2026-12-31",
  });
  const input = { vehicleId: vehicle.id, expectedElectionId: "33333333-3333-4333-8333-333333333333", entries: [
    { periodStart: "2026-01-01", periodEnd: "2026-06-30", businessMiles: 100 },
    { periodStart: "2026-07-01", periodEnd: "2026-12-31", businessMiles: 50 },
  ] };
  const preview = await previewVehicleMileage({ supabase, businessId: BUSINESS_ID, taxYear: 2026, actor, input });
  assert.equal(preview.totalDeduction, 110.5);
  const firstSave = await saveVehicleMileage({ supabase, businessId: BUSINESS_ID, taxYear: 2026, actor, input });
  assert.equal(firstSave.saved, true);
  await saveVehicleMileage({ supabase, businessId: BUSINESS_ID, taxYear: 2026, actor, input: { ...input, entries: [{ periodStart: "2026-07-01", periodEnd: "2026-12-31", businessMiles: 10 }] } });
  const workflow = await listVehicleDeductionWorkflows({ supabase, businessId: BUSINESS_ID, taxYear: 2026 });
  assert.equal(workflow.vehicles[0].mileage.entryCount, 1);
  assert.equal(workflow.vehicles[0].mileage.businessMiles, 10);
  assert.equal(workflow.vehicles[0].mileage.deductionAmount, 7.6);
  assert.equal(supabase.store.tax_vehicle_mileage_inputs.filter((entry) => entry.status === "superseded").length, 2, "replaced entries remain as audit history");
});

test("actual-expense elections cannot preview or contribute mileage", async () => {
  const supabase = storeClient();
  const vehicle = await createTaxVehicle({ supabase, businessId: BUSINESS_ID, actor, input: { displayName: "Truck" } });
  supabase.store.tax_vehicle_method_elections.push({ id: "election-actual", business_id: BUSINESS_ID, vehicle_id: vehicle.id, tax_year: 2026, method: "actual_expenses", status: "active" });
  await assert.rejects(
    previewVehicleMileage({ supabase, businessId: BUSINESS_ID, taxYear: 2026, actor, input: { vehicleId: vehicle.id, entries: [{ periodStart: "2026-01-01", periodEnd: "2026-06-30", businessMiles: 1 }] } }),
    (error) => error.code === "standard_mileage_inactive",
  );
});

test("the database command keeps treatment, election, default, and mileage activation in one transaction", () => {
  const migration = readFileSync("supabase/migrations/20261101180000_vehicle_deduction_workflow.sql", "utf8");
  const wrapper = migration.slice(migration.indexOf("create or replace function public.apply_grouped_tax_vehicle_decision_from_preview"), migration.indexOf("create or replace function public.replace_tax_vehicle_mileage_entries"));
  assert.match(wrapper, /apply_grouped_tax_deduction_decision_from_preview/);
  assert.match(wrapper, /status='superseded'/);
  assert.match(wrapper, /status='inactive'/);
  assert.match(wrapper, /status='active'/);
  assert.match(wrapper, /vehicle_attribution_required/);
  assert.doesNotMatch(wrapper, /commit\s*;/i, "the wrapper cannot partially commit inside the command");
});

test("browser payload contains choices and vehicle identity but no authoritative treatment or membership", () => {
  const client = readFileSync("src/services/tax/taxApiClient.js", "utf8");
  const apply = client.slice(client.indexOf("export async function confirmGroupedTaxDeductionDecision"), client.indexOf("export async function createTaxVehicle"));
  assert.match(apply, /vehicleId, expectedActiveElectionId, eligibility/);
  assert.doesNotMatch(apply, /taxTreatment|deductibilityStatus|deductiblePercent|targetTransactionIds|defaultScope|authority/);
});

async function mileageFixture() {
  const supabase = storeClient();
  const vehicle = await createTaxVehicle({ supabase, businessId: BUSINESS_ID, actor, input: { displayName: "Primary vehicle" } });
  const electionId = "33333333-3333-4333-8333-333333333333";
  supabase.store.tax_vehicle_method_elections.push({ id: electionId, business_id: BUSINESS_ID, vehicle_id: vehicle.id, tax_year: 2026, method: "standard_mileage", status: "active" });
  return { supabase, input: { vehicleId: vehicle.id, expectedElectionId: electionId }, save: (input) => saveVehicleMileage({ supabase, businessId: BUSINESS_ID, taxYear: 2026, actor, input }) };
}

test("cumulative snapshots replace 1,500 March miles with 3,200 June miles, and identical retries add no history", async () => {
  const { supabase, input, save } = await mileageFixture();
  await save({ ...input, entries: [{ periodStart: "2026-01-01", periodEnd: "2026-03-31", businessMiles: 1500 }] });
  const june = { ...input, entries: [{ periodStart: "2026-01-01", periodEnd: "2026-06-30", businessMiles: 3200 }] };
  const result = await save(june);
  const retry = await save(june);
  assert.deepEqual(retry.entryIds, result.entryIds);
  assert.equal(supabase.store.tax_vehicle_mileage_inputs.length, 2);
  assert.deepEqual(supabase.store.tax_vehicle_mileage_inputs.map((row) => row.business_miles), [1500, 3200]);
  const workflows = await listVehicleDeductionWorkflows({ supabase, businessId: BUSINESS_ID, taxYear: 2026 });
  assert.equal(workflows.vehicles[0].mileage.businessMiles, 3200);
  assert.equal(workflows.vehicles[0].mileage.deductionAmount, 2320);
});

test("year-end finalization requires records, replays idempotently, and prevents later edits", async () => {
  const { supabase, input, save } = await mileageFixture();
  const final = { ...input, finalize: true, entries: [{ periodStart: "2026-07-01", periodEnd: "2026-12-31", businessMiles: 100 }] };
  await assert.rejects(save(final), (error) => error.code === "mileage_finalization_requires_records");
  final.substantiationStatus = "supported";
  const result = await save(final);
  assert.deepEqual((await save(final)).entryIds, result.entryIds);
  assert.equal(supabase.store.tax_vehicle_method_elections[0].status, "finalized");
  await assert.rejects(save({ ...final, entries: [{ ...final.entries[0], businessMiles: 101 }] }), (error) => error.code === "vehicle_election_finalized");
  assert.equal(supabase.store.tax_vehicle_mileage_inputs.length, 1);
});

test("mileage rejects empty entries, impossible dates, unsupported years, and cross-business vehicles", async () => {
  const { supabase, input, save } = await mileageFixture();
  await assert.rejects(save({ ...input, entries: [] }), (error) => error.code === "mileage_entries_required");
  await assert.rejects(save({ ...input, entries: [{ periodStart: "2026-02-30", periodEnd: "2026-03-31", businessMiles: 1 }] }), (error) => error.code === "invalid_mileage_period");
  assert.throws(() => calculateVehicleMileagePeriods({ entries: [{ periodStart: "2027-01-01", periodEnd: "2027-03-31", businessMiles: 1 }] }), (error) => error.code === "mileage_period_requires_rate_allocation");
  await assert.rejects(previewVehicleMileage({ supabase, businessId: "another-business", taxYear: 2026, actor, input: { ...input, entries: [] } }), /vehicle.*not available/i);
});

test("vehicle scope survives every browser adapter to reach the authoritative command", () => {
  const hook = readFileSync("src/hooks/tax/useTaxDeductions.js", "utf8");
  const client = readFileSync("src/services/tax/taxApiClient.js", "utf8");
  const route = readFileSync("src/api/tax/taxClassificationReview.routes.js", "utf8");
  assert.match(route, /vehicleScope: req.body\?\.vehicleScope/);
  assert.match(hook, /confirmGroupedTaxDeductionDecision\(\{[^}]*vehicleScope/);
  assert.match(client, /compact\(\{[^}]*vehicleScope/);
});

test('monthly snapshots reconcile preview, saved rate amounts, reload, retries, and reject stale preview without writes', async () => {
  const supabase=storeClient();const vehicle=await createTaxVehicle({supabase,businessId:BUSINESS_ID,actor,input:{displayName:'Monthly van'}});
  const electionId='33333333-3333-4333-8333-333333333333';
  supabase.store.tax_vehicle_method_elections.push({id:electionId,business_id:BUSINESS_ID,vehicle_id:vehicle.id,tax_year:2026,method:'standard_mileage',status:'active',effective_start:'2026-01-01',effective_end:'2026-12-31'});
  const entries=Array.from({length:12},(_,i)=>({periodStart:`2026-${String(i+1).padStart(2,'0')}-01`,periodEnd:`2026-${String(i+1).padStart(2,'0')}-${new Date(Date.UTC(2026,i+1,0)).getUTCDate()}`,businessMiles:i===0?1000:i===6?12000:0}));
  const input={vehicleId:vehicle.id,expectedElectionId:electionId,entries,substantiationStatus:'supported'};
  const preview=await previewVehicleMileage({supabase,businessId:BUSINESS_ID,taxYear:2026,actor,input});
  assert.equal(preview.totalDeduction,9845);assert.equal(preview.monthlyAllocation.status,'complete');assert.equal(preview.monthlyAllocation.months['2026-01'].deductionAmount,725);assert.equal(preview.monthlyAllocation.months['2026-07'].deductionAmount,9120);
  input.expectedPreview={electionId,periods:preview.periods,totalDeduction:preview.totalDeduction};
  const saved=await saveVehicleMileage({supabase,businessId:BUSINESS_ID,taxYear:2026,actor,input});
  const replay=await saveVehicleMileage({supabase,businessId:BUSINESS_ID,taxYear:2026,actor,input});assert.deepEqual(saved.entryIds,replay.entryIds);assert.equal(supabase.store.tax_vehicle_mileage_inputs.length,12);
  const reload=(await listVehicleDeductionWorkflows({supabase,businessId:BUSINESS_ID,taxYear:2026})).vehicles[0];
  assert.equal(reload.mileage.businessMiles,13000);assert.equal(reload.mileage.deductionAmount,9845);assert.deepEqual(reload.mileage.monthlyAllocation,preview.monthlyAllocation);
  const before=JSON.stringify(supabase.store.tax_vehicle_mileage_inputs);
  supabase.store.tax_vehicle_mileage_rates[0].amount_per_mile=0.726;
  await assert.rejects(saveVehicleMileage({supabase,businessId:BUSINESS_ID,taxYear:2026,actor,input}),e=>e.code==='mileage_preview_stale');assert.equal(JSON.stringify(supabase.store.tax_vehicle_mileage_inputs),before);
  await assert.rejects(saveVehicleMileage({supabase,businessId:BUSINESS_ID,taxYear:2026,actor,input:{...input,expectedElectionId:'stale'}}),e=>e.code==='vehicle_election_changed');
  await assert.rejects(saveVehicleMileage({supabase,businessId:'22222222-2222-4222-8222-222222222222',taxYear:2026,actor,input}));
  await assert.rejects(saveVehicleMileage({supabase,businessId:BUSINESS_ID,taxYear:2026,actor:{},input}));assert.equal(JSON.stringify(supabase.store.tax_vehicle_mileage_inputs),before);
});
