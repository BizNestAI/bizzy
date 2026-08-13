#!/usr/bin/env node
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const dryRun = args.has("--dry-run") || !apply;
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 1000;

if (!Number.isInteger(limit) || limit < 1) {
  console.error(JSON.stringify({ ok: false, error: "invalid_limit" }));
  process.exit(1);
}

try {
  const [{ supabase }, { migratePlaidItemAccessTokens }] = await Promise.all([
    import("../src/services/supabaseAdmin.js"),
    import("../src/services/plaid/plaidTokenMigration.js"),
  ]);
  const report = await migratePlaidItemAccessTokens({
    supabaseClient: supabase,
    apply: !dryRun,
    limit,
  });
  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err?.message || "plaid_token_migration_failed" }));
  process.exit(1);
}
