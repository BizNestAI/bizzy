import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import test from "node:test";

// Opt-in only: the caller must supply a disposable local Docker container.
const container = process.env.TAX_VEHICLE_TEST_CONTAINER;
test("real PostgreSQL vehicle commands preserve protected rows, snapshots, scope and idempotency", { skip: !container }, () => {
  assert.match(container, /^bizzi-vehicle-validation-[a-z0-9-]+$/);
  const database = `vehicle_validation_${Date.now()}`;
  const exec = (args, input) => {
    const result = spawnSync("docker", ["exec", "-i", container, ...args], { input, encoding: "utf8", timeout: 60000 });
    assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  exec(["createdb", "-U", "postgres", database]);
  try {
    const files = [
      "tests/fixtures/vehicleDeduction.setup.sql",
      "supabase/migrations/20261006_tax_vehicle_mileage_inputs.sql",
      "supabase/migrations/20261101121000_atomic_grouped_tax_deduction_decision.sql",
      "supabase/migrations/20261103130000_grouped_tax_decision_previews.sql",
      "supabase/migrations/20261101180000_vehicle_deduction_workflow.sql",
      "supabase/migrations/20261103160000_vehicle_deduction_snapshots.sql",
      "supabase/migrations/20261103160000_vehicle_deduction_snapshots.sql",
      "tests/fixtures/vehicleDeduction.assert.sql",
    ];
    const result = exec(["psql", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"], files.map((path) => readFileSync(path, "utf8")).join("\n"));
    assert.match(result.stderr, /PASS: 70 actionable, six protected/);
  } finally {
    exec(["dropdb", "-U", "postgres", database]);
  }
});
