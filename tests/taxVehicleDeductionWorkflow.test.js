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
  const migration = readFileSync("supabase/migrations/20261104120000_vehicle_deduction_workflow.sql", "utf8");
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
