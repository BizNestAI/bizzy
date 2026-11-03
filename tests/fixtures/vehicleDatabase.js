import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { vehicleProductionSchema, vehicleCommandMigrationFiles } from "./vehicleProductionSchema.js";
const container = process.env.TAX_VEHICLE_TEST_CONTAINER;
export function vehicleDatabase({ seed = readFileSync("tests/fixtures/vehicleCommands.seed.sql", "utf8"), baseline = false } = {}) {
  assert.match(container, /^bizzi-vehicle-validation-[a-z0-9-]+$/);
  const database = `vehicle_commands_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const docker = (args, input) => spawnSync("docker", ["exec", "-i", container, ...args], { input, encoding: "utf8", timeout: 60000 });
  const sql = (input, role = "postgres") => {
    const result = docker(["psql", "-U", "postgres", "-d", database, "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"], `set role ${role};\n${input}`);
    return result;
  };
  const check = (result) => { assert.equal(result.status, 0, `${result.error || ""}\n${result.stderr}`); return result; };
  check(docker(["createdb", "-U", "postgres", database]));
  const files = vehicleCommandMigrationFiles.slice(0, -1).map((f) => readFileSync(`supabase/migrations/${f}`, "utf8"));
  const amendment = readFileSync(`supabase/migrations/${vehicleCommandMigrationFiles.at(-1)}`, "utf8");
  check(sql(vehicleProductionSchema() + files.join("\n") + seed + (baseline ? "" : amendment + amendment)));
  return { database, sql, check, cleanup: () => check(docker(["dropdb", "-U", "postgres", database])) };
}
