import { readFileSync } from "node:fs";
// Uses the checked-in production schema's real columns, NOT NULLs, defaults,
// checks, primary/unique keys and all FKs between the selected domain tables.
export function vehicleProductionSchema() {
  const snapshot = readFileSync("supabase/live_schema_snapshot.sql", "utf8");
  const tables = ["business_profiles", "user_business_link", "bank_transactions", "tax_deduction_rules", "transaction_tax_classifications", "tax_classification_overrides", "tax_review_tasks"];
  const ddl = tables.map((name) => {
    const start = snapshot.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);
    if (start < 0) throw new Error(`Production table missing: ${name}`);
    return snapshot.slice(start, snapshot.indexOf("\n);", start) + 3);
  });
  const constraints = [...snapshot.matchAll(/ALTER TABLE ONLY "public"\."([^"]+)"\n\s+ADD CONSTRAINT[^;]+;/g)]
    .filter((match) => tables.includes(match[1]))
    .filter((match) => !match[0].includes("FOREIGN KEY") || tables.some((table) => match[0].includes(`REFERENCES "public"."${table}"`)))
    .map((match) => match[0]);
  return `create schema if not exists extensions;
create extension if not exists "uuid-ossp" with schema extensions;
do $$ begin create role anon;exception when duplicate_object then null;end $$;
do $$ begin create role authenticated;exception when duplicate_object then null;end $$;
do $$ begin create role service_role bypassrls;exception when duplicate_object then null;end $$;
${ddl.join("\n")}
${constraints.join("\n")}
grant usage on schema public to service_role,authenticated,anon;
grant all on all tables in schema public to service_role;
${readFileSync("supabase/migrations/20260923_tax_phase1_contract_repair.sql", "utf8")}
`;
}
export const vehicleCommandMigrationFiles = [
  "20261006_tax_vehicle_mileage_inputs.sql", "20261101121000_atomic_grouped_tax_deduction_decision.sql",
  "20261103130000_grouped_tax_decision_previews.sql", "20261101180000_vehicle_deduction_workflow.sql",
  "20261103160000_vehicle_deduction_snapshots.sql", "20261104120000_tax_workspace_projections.sql",
  "20261104160000_vehicle_authority_amendments.sql",
];
