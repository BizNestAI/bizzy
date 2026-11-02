import test from "node:test";
import assert from "node:assert/strict";
import { optionalVehicleContext } from "../src/services/tax/taxGroupedDecisionPreview.service.js";
import { listVehicleDeductionWorkflows } from "../src/services/tax/taxVehicleDeduction.service.js";

test("a pending optional vehicle mileage-rate query cannot block the Gas population", async () => {
  const tables = [];
  const supabase = { from(table) {
    tables.push(table);
    const query = { select() { return query; }, eq() { return query; }, then(resolve) {
      if (table === "tax_vehicle_mileage_rates") return new Promise(() => {});
      return Promise.resolve({ data: [], error: null }).then(resolve);
    } };
    return query;
  } };
  const context = await optionalVehicleContext(() => listVehicleDeductionWorkflows({ supabase, businessId: "business-1", taxYear: 2026 }), 5);
  assert.ok(tables.includes("tax_vehicle_mileage_rates"));
  assert.deepEqual(context, { vehicles: [], unavailable: true });
});

test("optional vehicle metadata degrades on failure and retains successful setup", async () => {
  assert.deepEqual(await optionalVehicleContext(() => { throw new Error("unavailable"); }), { vehicles: [], unavailable: true });
  const ready = { vehicles: [{ id: "vehicle-1" }] };
  assert.equal(await optionalVehicleContext(async () => ready), ready);
});
