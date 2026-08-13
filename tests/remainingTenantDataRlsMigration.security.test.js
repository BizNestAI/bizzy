import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const migration = read("supabase/migrations/20260813_harden_remaining_tenant_data_rls.sql");
const harness = read("scripts/runStagingTwoTenantRlsAttackTest.js");

const BUSINESS_TABLES = [
  "bank_transactions",
  "ar_open_items",
  "invoices",
  "financial_metrics",
  "tax_snapshots",
];

const USER_TABLES = [
  "bizzy_memory",
  "gpt_usage",
];

const ALL_TABLES = [...BUSINESS_TABLES, ...USER_TABLES];

const RELATED_EXPOSURE_OBJECTS = [
  "ar_aging",
  "ar_aging_v2",
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

function tableStatements(table) {
  return migration
    .split(/\n(?=(?:ALTER|DROP|REVOKE|GRANT|CREATE|COMMIT|BEGIN)\b)/)
    .filter((stmt) => stmt.includes(`public.${table}`))
    .join("\n");
}

test("remaining tenant data migration targets only the seven runtime-failing tables plus related views/RPCs", () => {
  for (const table of ALL_TABLES) {
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`));
  }

  assert.doesNotMatch(migration, /ALTER TABLE public\.business_profiles/i);
  assert.doesNotMatch(migration, /ALTER TABLE public\.user_business_link/i);
  assert.doesNotMatch(migration, /ALTER TABLE public\.quickbooks_tokens/i);
  assert.doesNotMatch(migration, /ALTER TABLE public\.plaid_items/i);
});

test("business-scoped tables allow authenticated SELECT only through canonical business membership", () => {
  for (const table of BUSINESS_TABLES) {
    const statements = tableStatements(table);
    assert.match(statements, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC;`));
    assert.match(statements, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM anon;`));
    assert.match(statements, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM authenticated;`));
    assert.match(statements, new RegExp(`GRANT SELECT ON TABLE public\\.${table} TO authenticated;`));
    assert.match(statements, new RegExp(`GRANT ALL ON TABLE public\\.${table} TO service_role;`));
    assert.match(statements, new RegExp(`CREATE POLICY ${table}_member_select\\nON public\\.${table}\\nFOR SELECT\\nTO authenticated\\nUSING \\(public\\.bizzi_current_user_is_business_member\\(business_id\\)\\);`));
    assert.doesNotMatch(statements, /GRANT\s+(?:ALL|INSERT|UPDATE|DELETE)\b[^;]*\bTO authenticated/i);
  }
});

test("user-private tables allow authenticated SELECT only for auth.uid user rows", () => {
  assert.match(migration, /CREATE POLICY bizzy_memory_own_user_select\nON public\.bizzy_memory\nFOR SELECT\nTO authenticated\nUSING \(user_id = auth\.uid\(\)\);/);
  assert.match(migration, /CREATE POLICY gpt_usage_own_user_select\nON public\.gpt_usage\nFOR SELECT\nTO authenticated\nUSING \(user_id = auth\.uid\(\)\);/);

  for (const table of USER_TABLES) {
    const statements = tableStatements(table);
    assert.match(statements, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC;`));
    assert.match(statements, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM anon;`));
    assert.match(statements, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM authenticated;`));
    assert.match(statements, new RegExp(`GRANT SELECT ON TABLE public\\.${table} TO authenticated;`));
    assert.match(statements, new RegExp(`GRANT ALL ON TABLE public\\.${table} TO service_role;`));
    assert.doesNotMatch(statements, /GRANT\s+(?:ALL|INSERT|UPDATE|DELETE)\b[^;]*\bTO authenticated/i);
  }
});

test("permissive Bizzy memory and GPT usage policies are removed and not recreated", () => {
  const removedPolicies = [
    "Enable insert for authenticated users only",
    "Enable insert for users based on user_id",
    "Users can access their own memory",
    "Allow select for own GPT usage",
    "Allow users to read their own GPT usage",
    "Users can read and update their own usage",
  ];

  for (const policy of removedPolicies) {
    assert.match(migration, new RegExp(`DROP POLICY IF EXISTS "${policy}" ON public\\.`));
  }

  assert.doesNotMatch(migration, /USING\s*\(\s*true\s*\)/i);
  assert.doesNotMatch(migration, /WITH CHECK\s*\(\s*true\s*\)/i);
  assert.doesNotMatch(migration, /business_id\s*=\s*auth\.uid\(\)/i);
  assert.doesNotMatch(migration, /auth\.uid\(\)\s*=\s*business_id/i);
});

test("related AR views and Bizzy memory RPCs are not left as browser bypass paths", () => {
  for (const object of RELATED_EXPOSURE_OBJECTS) {
    assert.match(migration, new RegExp(`REVOKE ALL ON TABLE public\\.${object} FROM PUBLIC;`));
    assert.match(migration, new RegExp(`REVOKE ALL ON TABLE public\\.${object} FROM anon;`));
    assert.match(migration, new RegExp(`REVOKE ALL ON TABLE public\\.${object} FROM authenticated;`));
    assert.match(migration, new RegExp(`GRANT ALL ON TABLE public\\.${object} TO service_role;`));
  }

  assert.match(migration, /REVOKE ALL ON FUNCTION public\.match_bizzy_memory\(uuid, public\.vector, double precision, integer, text\[\]\) FROM authenticated;/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.match_memories\(public\.vector, uuid, integer\) FROM authenticated;/);
});

test("tax snapshot sequence is not writable by browser roles after table writes are removed", () => {
  assert.match(migration, /REVOKE ALL ON SEQUENCE public\.tax_snapshots_id_seq FROM PUBLIC;/);
  assert.match(migration, /REVOKE ALL ON SEQUENCE public\.tax_snapshots_id_seq FROM anon;/);
  assert.match(migration, /REVOKE ALL ON SEQUENCE public\.tax_snapshots_id_seq FROM authenticated;/);
  assert.match(migration, /GRANT ALL ON SEQUENCE public\.tax_snapshots_id_seq TO service_role;/);
});

test("runtime attack harness still exercises every table in this migration", () => {
  for (const table of ALL_TABLES) {
    assert.match(harness, new RegExp(`"${table}"`), `${table} is missing from runtime attack harness`);
  }
  assert.match(harness, /expectAllowed: true, targetTenant: "own tenant"/);
  assert.match(harness, /expectAllowed: false, targetTenant: p\.target, reason: "cross-tenant row read"/);
  assert.match(harness, /reason: "insert row assigned to foreign tenant"/);
  assert.match(harness, /reason: "cross-tenant update by row identity"/);
  assert.match(harness, /reason: "cross-tenant delete by row identity"/);
});

test("browser direct table access is limited to known read-only surfaces", () => {
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

  assert.match(source, /\.from\(\s*["']financial_metrics["']\s*\)/);
  assert.match(source, /\.from\(\s*["']gpt_usage["']\s*\)/);

  for (const table of ALL_TABLES) {
    assert.doesNotMatch(
      source,
      new RegExp(`\\.from\\(\\s*["']${table}["']\\s*\\)[\\s\\S]{0,800}\\.(?:insert|upsert|update|delete)\\(`),
      `browser appears to directly write ${table}`
    );
  }
}
);
