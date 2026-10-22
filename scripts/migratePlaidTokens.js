#!/usr/bin/env node
/* global process */
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const verify = args.has("--verify");
const dryRun = args.has("--dry-run") || !apply;
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 25;
const expectedArg = process.argv.find((arg) => arg.startsWith("--expected-active="));
const expectedActiveItems = expectedArg ? Number(expectedArg.slice("--expected-active=".length)) : null;

if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
  console.error(JSON.stringify({ ok: false, error: "invalid_limit" }));
  process.exit(1);
}

try {
  const [{ supabase }, migration] = await Promise.all([
    import("../src/services/supabaseAdmin.js"),
    import("../src/services/plaid/plaidTokenMigration.js"),
  ]);
  const report = verify
    ? await migration.verifyPlaidTokenRotation({ supabaseClient: supabase, expectedActiveItems, limit })
    : await migration.migratePlaidTokens({ supabaseClient: supabase, apply: !dryRun, limit });
  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
  if (verify && !report.ok) process.exitCode = 2;
} catch {
  console.error(JSON.stringify({ ok: false, error: "plaid_token_rotation_command_failed" }));
  process.exit(1);
}
