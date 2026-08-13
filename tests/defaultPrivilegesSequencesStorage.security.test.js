import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const migration = read("supabase/migrations/20260816_harden_default_privileges_sequences_schema.sql");
const storageAudit = read("scripts/auditStagingPrivilegesAndStorage.sql");

const PUBLIC_SEQUENCES = [
  "expense_category_map_id_seq",
  "expense_totals_monthly_id_seq",
  "tax_snapshots_id_seq",
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

test("default privileges no longer expose future public objects to browser roles", () => {
  for (const objectType of ["TABLES", "FUNCTIONS", "SEQUENCES"]) {
    assert.match(
      migration,
      new RegExp(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public\\s+REVOKE ALL ON ${objectType} FROM PUBLIC;`)
    );
    assert.match(
      migration,
      new RegExp(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public\\s+REVOKE ALL ON ${objectType} FROM anon;`)
    );
    assert.match(
      migration,
      new RegExp(`ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public\\s+REVOKE ALL ON ${objectType} FROM authenticated;`)
    );
  }
  assert.match(migration, /ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public\s+GRANT ALL ON TABLES TO service_role;/);
  assert.match(migration, /ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public\s+GRANT EXECUTE ON FUNCTIONS TO service_role;/);
  assert.match(migration, /ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public\s+GRANT ALL ON SEQUENCES TO service_role;/);
});

test("browser roles retain public schema usage but not schema create", () => {
  for (const role of ["PUBLIC", "anon", "authenticated"]) {
    assert.match(migration, new RegExp(`REVOKE CREATE ON SCHEMA public FROM ${role};`));
  }
  assert.match(migration, /GRANT USAGE ON SCHEMA public TO anon;/);
  assert.match(migration, /GRANT USAGE ON SCHEMA public TO authenticated;/);
  assert.match(migration, /GRANT USAGE ON SCHEMA public TO service_role;/);
});

test("all existing public sequences become server-only", () => {
  for (const sequence of PUBLIC_SEQUENCES) {
    assert.match(migration, new RegExp(`REVOKE ALL ON SEQUENCE public\\.${sequence} FROM PUBLIC;`));
    assert.match(migration, new RegExp(`REVOKE ALL ON SEQUENCE public\\.${sequence} FROM anon;`));
    assert.match(migration, new RegExp(`REVOKE ALL ON SEQUENCE public\\.${sequence} FROM authenticated;`));
    assert.match(migration, new RegExp(`GRANT ALL ON SEQUENCE public\\.${sequence} TO service_role;`));
  }
});

test("expense_category_map is locked down because no browser dependency exists", () => {
  assert.match(migration, /ALTER TABLE public\.expense_category_map ENABLE ROW LEVEL SECURITY;/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.expense_category_map FROM PUBLIC;/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.expense_category_map FROM anon;/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.expense_category_map FROM authenticated;/);
  assert.match(migration, /GRANT ALL ON TABLE public\.expense_category_map TO service_role;/);

  const browserRoots = ["src/components", "src/pages", "src/hooks", "src/context", "src/layout", "src/auth"];
  const browserSource = browserRoots
    .flatMap((dir) => walk(join(root, dir)))
    .map((file) => `\n// ${relative(root, file)}\n${readFileSync(file, "utf8")}`)
    .join("\n");
  assert.doesNotMatch(browserSource, /\.from\(\s*["']expense_category_map["']\s*\)/);
});

test("migration does not weaken previous table policies, function hardening, or storage", () => {
  const executableSql = migration
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.doesNotMatch(executableSql, /DROP POLICY/i);
  assert.doesNotMatch(executableSql, /CREATE POLICY/i);
  assert.doesNotMatch(executableSql, /GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)\b[^;]*\bTO\s+(?:anon|authenticated)/i);
  assert.doesNotMatch(executableSql, /GRANT EXECUTE ON FUNCTION\b[^;]*\bTO\s+(?:anon|authenticated)/i);
  assert.doesNotMatch(executableSql, /storage\./i);
});

test("storage audit is read-only and covers buckets, policies, and grants", () => {
  assert.match(storageAudit, /FROM storage\.buckets/);
  assert.match(storageAudit, /FROM pg_policies/);
  assert.match(storageAudit, /schemaname = 'storage'/);
  assert.match(storageAudit, /information_schema\.table_privileges/);
  const executableLines = storageAudit
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("--"))
    .join("\n");
  assert.doesNotMatch(executableLines, /^(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|REVOKE|TRUNCATE)\b/im);
});

test("code-discovered storage buckets are documented by name only", () => {
  const source = ["src", "tests", "scripts"]
    .flatMap((dir) => walk(join(root, dir)))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  for (const bucket of ["bizzy-docs", "financial-reports", "bid-attachments"]) {
    assert.match(source, new RegExp(bucket));
  }
});
