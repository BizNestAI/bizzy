import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import { vehicleDatabase } from "./fixtures/vehicleDatabase.js";

test("vehicle correction contracts exist and accept authoritative previews", { skip: !process.env.TAX_VEHICLE_TEST_CONTAINER }, async (t) => {
  const db = vehicleDatabase({ baseline: process.env.TAX_VEHICLE_BASELINE === "1" });
  const b = "11111111-1111-4111-8111-111111111111", u = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  try {
    db.check(db.sql(`insert into public.tax_vehicles(id,business_id,display_name,ownership_type) values('99999999-9999-4999-8999-999999999999','${b}','Synthetic mileage vehicle','owned');
      insert into public.tax_vehicle_method_elections(business_id,vehicle_id,tax_year,method,effective_start,effective_end,source,authority,eligibility,contract_version) values('${b}','99999999-9999-4999-8999-999999999999',2026,'standard_mileage','2026-01-01','2026-12-31','test','customer','{}','test');`));
    for (const [name, choices] of [
      ["authorized manual amendment of a prior or suggested decision", { action: "exclude", transactionIds: ["00000000-0000-4000-8000-000000000001"] }],
      ["year-wide business-use percentage amendment", { action: "amend", primaryVehicle: true, method: "actual_expenses", businessUsePercent: 80, ownershipType: "owned", confirmYearRecalculation: true }],
      ["explicit multi-vehicle assignment without a name", { action: "assign", newVehicle: true, transactionIds: ["00000000-0000-4000-8000-000000000001"] }],
      ["finalized-mileage correction contract", { action: "correct_mileage", vehicleId: "99999999-9999-4999-8999-999999999999", recordsConfirmed: true, entries: [{ periodStart: "2026-01-01", periodEnd: "2026-06-30", businessMiles: 100 }] }],
    ]) {
      await t.test(name, () => {
        const input = { ...choices, reason: "Explicit contract regression", projectionId: "33333333-3333-4333-8333-333333333333", sourceFingerprint: "a".repeat(64) };
        const result = db.sql(`select public.preview_tax_vehicle_command('${b}',2026,'${u}','${JSON.stringify(input).replaceAll("'", "''")}'::jsonb);`, "service_role");
        assert.equal(result.status, 0, result.stderr);
        const preview = JSON.parse(result.stdout.trim());
        assert.match(preview.previewId, /^[a-f0-9-]{36}$/);
        assert.ok(Array.isArray(preview.plan.rows));
      });
    }
  } finally { db.cleanup(); }
});
