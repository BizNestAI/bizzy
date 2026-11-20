import fs from "node:fs";

// Generated from the fresh public-schema catalog, scoped via scope.json.
// Supplemental column/schema ACLs, role flags/memberships and auth.uid are
// reproduced. auth.users remains an id-only synthetic seed boundary.
export function stalePendingResolutionDatabaseSchema({ includeMigration = true, includeScopeCorrection = false } = {}) {
  const schema = fs.readFileSync("tests/fixtures/stalePendingProduction/prerequisites.sql", "utf8");
  return schema + (includeMigration ? [
    "20261117230000_stale_pending_admin_resolution.sql",
    "20261118220000_stale_pending_global_admin_availability.sql",
    "20261118230000_stale_pending_permanent_admin_capability.sql",
  ].map(file => fs.readFileSync(`scripts/releases/stale-pending/supabase/migrations/${file}`, "utf8")).join("\n") : "") + (includeScopeCorrection ? fs.readFileSync("supabase/migrations/20261120220000_stale_pending_durable_account_scope.sql", "utf8") : "");
}
