import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const migration = read("supabase/migrations/20260812_lock_down_server_only_integrations.sql");

const SERVER_ONLY_TABLES = [
  "quickbooks_tokens",
  "plaid_items",
  "linked_financial_items",
  "oauth_connection_states",
  "email_accounts",
  "bank_sync_runs",
  "qbo_backfill_jobs",
  "qbo_cdc_cursors",
  "qbo_entity_sync_runs",
  "qbo_job_costing_backfill_runs",
  "qbo_job_costing_daily_sync_state",
  "qbo_webhook_events",
];

const LEGACY_POLICIES = [
  "email_accounts_select_own",
  "email_accounts_insert_own",
  "email_accounts_update_own",
  "email_accounts_delete_own",
  "jc_tenant_select",
  "jc_tenant_insert",
  "jc_tenant_update",
  "jc_tenant_delete",
];

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".git", "dist", "build", "coverage"].includes(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else if (/\.(js|jsx|ts|tsx)$/.test(entry)) files.push(full);
  }
  return files;
}

test("server-only integration migration enables RLS on every locked table", () => {
  for (const table of SERVER_ONLY_TABLES) {
    assert.match(
      migration,
      new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`),
      `${table} does not enable RLS`
    );
  }
});

test("server-only integration migration revokes all browser-role table access", () => {
  for (const table of SERVER_ONLY_TABLES) {
    assert.match(migration, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC;`));
    assert.match(migration, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM anon;`));
    assert.match(migration, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM authenticated;`));
    assert.match(migration, new RegExp(`GRANT ALL ON TABLE public\\.${table} TO service_role;`));

    assert.doesNotMatch(
      migration,
      new RegExp(`GRANT\\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)[^;]*public\\.${table}[^;]*TO\\s+(?:anon|authenticated|PUBLIC)`, "i"),
      `${table} grants browser role access`
    );
  }
});

test("server-only integration migration creates no browser-readable policies", () => {
  for (const table of SERVER_ONLY_TABLES) {
    assert.doesNotMatch(
      migration,
      new RegExp(`CREATE POLICY [^;]+ ON public\\.${table}[\\s\\S]*?TO authenticated`, "i"),
      `${table} creates authenticated policy`
    );
    assert.doesNotMatch(
      migration,
      new RegExp(`CREATE POLICY [^;]+ ON public\\.${table}[\\s\\S]*?TO anon`, "i"),
      `${table} creates anon policy`
    );
  }
  assert.doesNotMatch(migration, /USING\s*\(\s*true\s*\)/i);
  assert.doesNotMatch(migration, /WITH CHECK\s*\(\s*true\s*\)/i);
});

test("server-only integration migration removes known legacy browser policies", () => {
  for (const policy of LEGACY_POLICIES) {
    assert.match(migration, new RegExp(`DROP POLICY IF EXISTS "${policy}" ON public\\.`));
  }
});

test("frontend browser roots do not directly query server-only integration tables", () => {
  const browserRoots = [
    "src/components",
    "src/pages",
    "src/hooks",
    "src/context",
    "src/layout",
    "src/auth",
  ];
  const source = browserRoots
    .flatMap((dir) => walk(join(root, dir)))
    .map((file) => `\n// ${relative(root, file)}\n${readFileSync(file, "utf8")}`)
    .join("\n");

  for (const table of SERVER_ONLY_TABLES) {
    assert.doesNotMatch(
      source,
      new RegExp(`\\.from\\(\\s*["']${table}["']\\s*\\)`),
      `frontend directly queries ${table}`
    );
  }
});

test("QBO and Plaid status APIs remain backend-based and token-safe", () => {
  const compatibilityTest = read("tests/rlsCompatibilityPrep.security.test.js");
  const plaidTest = read("tests/plaidSecurity.test.js");
  const qboTest = read("tests/qboSecurity.test.js");

  assert.match(compatibilityTest, /QBO and Plaid status APIs are protected by canonical auth and tenant context/);
  assert.match(compatibilityTest, /status responses do not expose provider credential fields/);
  assert.match(plaidTest, /Plaid public-token exchange responses do not expose access token fields/);
  assert.match(qboTest, /QBO browser responses and status query do not expose token fields/);
});
