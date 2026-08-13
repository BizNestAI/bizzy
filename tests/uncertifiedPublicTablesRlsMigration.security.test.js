import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const migration = read("supabase/migrations/20260814_harden_uncertified_public_tables_rls.sql");
const harness = read("scripts/runStagingTwoTenantRlsAttackTest.js");

const SERVER_ONLY_TABLES = [
  "account_breakdown",
  "affordability_assessments",
  "balance_sheet_history",
  "billing_customers",
  "bizzy_deadlines",
  "bizzy_headlines",
  "bookkeeping_health",
  "calendar_events",
  "categorization_rules",
  "gpt_messages_backup",
  "insight_reads",
  "integration_connections",
  "investment_accounts",
  "investment_balances",
  "monthly_forecast",
  "plaid_accounts",
  "plaid_qbo_account_mappings",
  "positions",
  "qbo_posted_transactions",
  "review_sources",
  "subscriptions",
  "transaction_categorizations",
  "vendor_rules",
  "cashflow_forecast",
  "gpt_messages",
];

const BUSINESS_READ_TABLES = [
  "expense_totals_monthly",
  "insights",
  "tax_deadlines",
];

const USER_PRIVATE_TABLES = [
  "notifications",
  "profiles",
  "insight_preferences",
];

const REFERENCE_TABLES = [
  "tax_state_rates",
];

const ALL_TARGETS = [
  ...SERVER_ONLY_TABLES,
  ...BUSINESS_READ_TABLES,
  ...USER_PRIVATE_TABLES,
  ...REFERENCE_TABLES,
];

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function tableStatements(table) {
  return migration
    .split(/\n(?=(?:ALTER|DROP|REVOKE|GRANT|CREATE|COMMIT|BEGIN)\b)/)
    .filter((stmt) => stmt.includes(`public.${table}`))
    .join("\n");
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

test("uncertified public-table migration enables RLS on every target table", () => {
  for (const table of ALL_TARGETS) {
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`));
  }
});

test("server-only tables revoke all browser-role access and grant only service role", () => {
  for (const table of SERVER_ONLY_TABLES) {
    const statements = tableStatements(table);
    assert.match(statements, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC;`));
    assert.match(statements, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM anon;`));
    assert.match(statements, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM authenticated;`));
    assert.match(statements, new RegExp(`GRANT ALL ON TABLE public\\.${table} TO service_role;`));
    assert.doesNotMatch(statements, /TO authenticated/i);
    assert.doesNotMatch(statements, /TO anon/i);
  }
});

test("business-readable tables are authenticated SELECT only through canonical membership", () => {
  for (const table of BUSINESS_READ_TABLES) {
    const statements = tableStatements(table);
    assert.match(statements, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC;`));
    assert.match(statements, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM anon;`));
    assert.match(statements, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM authenticated;`));
    assert.match(statements, new RegExp(`GRANT SELECT ON TABLE public\\.${table} TO authenticated;`));
    assert.match(statements, new RegExp(`GRANT ALL ON TABLE public\\.${table} TO service_role;`));
    assert.doesNotMatch(statements, /GRANT\s+(?:ALL|INSERT|UPDATE|DELETE)\b[^;]*\bTO authenticated/i);
  }

  assert.match(migration, /CREATE POLICY expense_totals_monthly_member_select[\s\S]*?USING \(public\.bizzi_current_user_is_business_member\(business_id\)\);/);
  assert.match(migration, /CREATE POLICY insights_member_select[\s\S]*?USING \(public\.bizzi_current_user_is_business_member\(business_id\)\);/);
  assert.match(migration, /CREATE POLICY tax_deadlines_global_or_member_select[\s\S]*?business_id IS NULL[\s\S]*?public\.bizzi_current_user_is_business_member\(business_id\)/);
});

test("user-private browser tables constrain identity to auth.uid and deny delete grants", () => {
  for (const table of USER_PRIVATE_TABLES) {
    const statements = tableStatements(table);
    assert.match(statements, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM authenticated;`));
    assert.match(statements, new RegExp(`GRANT SELECT, INSERT, UPDATE ON TABLE public\\.${table} TO authenticated;`));
    assert.doesNotMatch(statements, /DELETE\b[^;]*TO authenticated/i);
  }

  assert.match(migration, /CREATE POLICY notifications_own_member_select[\s\S]*?user_id = auth\.uid\(\)/);
  assert.match(migration, /CREATE POLICY notifications_own_member_insert[\s\S]*?WITH CHECK[\s\S]*?user_id = auth\.uid\(\)/);
  assert.match(migration, /CREATE POLICY notifications_own_member_update[\s\S]*?WITH CHECK[\s\S]*?user_id = auth\.uid\(\)/);
  assert.match(migration, /CREATE POLICY profiles_own_select[\s\S]*?USING \(id = auth\.uid\(\)\);/);
  assert.match(migration, /CREATE POLICY profiles_own_insert[\s\S]*?WITH CHECK \(id = auth\.uid\(\)\);/);
  assert.match(migration, /CREATE POLICY insight_preferences_own_select[\s\S]*?USING \(user_id = auth\.uid\(\)\);/);
});

test("reference table is authenticated read-only and not anonymous/public writable", () => {
  const statements = tableStatements("tax_state_rates");
  assert.match(statements, /REVOKE ALL ON TABLE public\.tax_state_rates FROM PUBLIC;/);
  assert.match(statements, /REVOKE ALL ON TABLE public\.tax_state_rates FROM anon;/);
  assert.match(statements, /GRANT SELECT ON TABLE public\.tax_state_rates TO authenticated;/);
  assert.doesNotMatch(statements, /GRANT\s+(?:ALL|INSERT|UPDATE|DELETE)\b[^;]*\bTO authenticated/i);
  assert.match(migration, /CREATE POLICY tax_state_rates_authenticated_select[\s\S]*?USING \(auth\.uid\(\) IS NOT NULL\);/);
});

test("known permissive policies are removed and not recreated", () => {
  const removedPolicies = [
    "Allow Inserts for Logged-In Users",
    "Allow insert from server only",
    "Allow user to read own forecasts",
    "Can read their forecast",
    "Users can access their own notifications",
    "Users can access their own profile",
    "insights_select_any",
    "tax_deadlines_read",
    "Users can access deadlines for their business",
    "tax_state_rates_read",
  ];
  for (const policy of removedPolicies) {
    assert.match(migration, new RegExp(`DROP POLICY IF EXISTS "${policy}" ON public\\.`));
  }
  assert.doesNotMatch(migration, /USING\s*\(\s*true\s*\)/i);
  assert.doesNotMatch(migration, /WITH CHECK\s*\(\s*true\s*\)/i);
  assert.doesNotMatch(migration, /business_id\s*=\s*auth\.uid\(\)/i);
  assert.doesNotMatch(migration, /auth\.uid\(\)\s*=\s*business_id/i);
});

test("expense sequence is not writable by browser roles after direct writes are removed", () => {
  assert.match(migration, /REVOKE ALL ON SEQUENCE public\.expense_totals_monthly_id_seq FROM PUBLIC;/);
  assert.match(migration, /REVOKE ALL ON SEQUENCE public\.expense_totals_monthly_id_seq FROM anon;/);
  assert.match(migration, /REVOKE ALL ON SEQUENCE public\.expense_totals_monthly_id_seq FROM authenticated;/);
  assert.match(migration, /GRANT ALL ON SEQUENCE public\.expense_totals_monthly_id_seq TO service_role;/);
});

test("runtime attack harness exercises all newly remediated tables", () => {
  for (const table of ALL_TARGETS) {
    assert.match(harness, new RegExp(`"${table}"`), `${table} is missing from runtime attack harness`);
  }
  assert.match(harness, /runUncertifiedTableTests/);
  assert.match(harness, /ordinary user should not directly read server-only table/);
  assert.match(harness, /cross-tenant read-only row/);
  assert.match(harness, /cross-user private row read/);
  assert.match(harness, /anonymous access denied/);
});

test("runtime harness seeds transaction categorizations with a real bank transaction parent", () => {
  assert.match(harness, /setupUncertifiedTableRows\(user, business, label, baseRows = \{\}\)/);
  assert.match(
    harness,
    /transaction_categorizations:\s*await insertSeed\("transaction_categorizations",\s*\{[\s\S]*?transaction_id:\s*baseRows\.bank_transactions\?\.id\s*\|\|\s*randomUUID\(\)/,
    "transaction_categorizations seed must use the tenant bank_transactions row id"
  );
  assert.match(
    harness,
    /const uncertifiedRowsA = await setupUncertifiedTableRows\(userA, bizA, "A", rowsA\);/
  );
  assert.match(
    harness,
    /const uncertifiedRowsB = await setupUncertifiedTableRows\(userB, bizB, "B", rowsB\);/
  );
});

test("browser direct Supabase writes remain limited to explicitly supported user-private notifications", () => {
  const browserRoots = ["src/components", "src/pages", "src/hooks", "src/context", "src/layout", "src/auth"];
  const source = browserRoots
    .flatMap((dir) => walk(join(root, dir)))
    .map((file) => `\n// ${relative(root, file)}\n${readFileSync(file, "utf8")}`)
    .join("\n")
    + `\n// src/services/notificationService.js\n${read("src/services/notificationService.js")}`;

  assert.match(source, /\.from\(\s*["']expense_totals_monthly["']\s*\)[\s\S]{0,300}\.select\(/);

  for (const table of [...SERVER_ONLY_TABLES, ...BUSINESS_READ_TABLES, "insight_preferences", "profiles"]) {
    assert.doesNotMatch(
      source,
      new RegExp(`\\.from\\(\\s*["']${table}["']\\s*\\)[\\s\\S]{0,800}\\.(?:insert|upsert|update|delete)\\(`),
      `browser appears to directly write ${table}`
    );
  }

  assert.match(source, /\.from\(\s*["']notifications["']\s*\)[\s\S]{0,800}\.update\(/);
});
