import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SNAPSHOT = path.join(ROOT, "supabase/live_schema_snapshot.sql");
const REPORT_MD = path.join(ROOT, "reports/supabase-rls-security-audit.md");
const REPORT_JSON = path.join(ROOT, "reports/supabase-rls-security-audit.json");

const sql = readFileSync(SNAPSHOT, "utf8");

function statementsMatching(re) {
  const out = [];
  for (const match of sql.matchAll(re)) out.push(match);
  return out;
}

function cleanIdent(value = "") {
  return value.replaceAll('"', "").replace(/^public\./, "");
}

function splitTopLevelColumns(body) {
  const lines = body.split("\n");
  const cols = [];
  for (const raw of lines) {
    const line = raw.trim().replace(/,$/, "");
    if (!line.startsWith('"')) continue;
    const m = line.match(/^"([^"]+)"\s+(.+)$/);
    if (m) cols.push({ name: m[1], definition: m[2] });
  }
  return cols;
}

const tables = new Map();
for (const match of statementsMatching(/CREATE TABLE IF NOT EXISTS "public"\."([^"]+)" \(([\s\S]*?)\n\);/g)) {
  const name = match[1];
  const columns = splitTopLevelColumns(match[2]);
  tables.set(name, {
    name,
    columns,
    columnNames: columns.map((c) => c.name),
    rlsEnabled: false,
    rlsForced: false,
    policies: [],
    grants: [],
    sequenceGrants: [],
    frontendUsage: [],
    serviceUsage: [],
  });
}

const views = [...statementsMatching(/CREATE(?: OR REPLACE)? VIEW "public"\."([^"]+)"/g)].map((m) => m[1]);
const materializedViews = [...statementsMatching(/CREATE MATERIALIZED VIEW "public"\."([^"]+)"/g)].map((m) => m[1]);
const sequences = [...statementsMatching(/CREATE SEQUENCE "public"\."([^"]+)"/g)].map((m) => m[1]);

const functionBlocks = [];
const fnRe = /CREATE OR REPLACE FUNCTION "public"\."([^"]+)"\(([\s\S]*?)(?=\nCREATE OR REPLACE FUNCTION|\nCREATE TABLE|\nCREATE VIEW|\nCREATE MATERIALIZED VIEW|\nALTER TABLE|\nCREATE POLICY|\nGRANT |\nALTER DEFAULT PRIVILEGES|\n$)/g;
for (const match of statementsMatching(fnRe)) {
  functionBlocks.push({
    name: match[1],
    text: match[0],
    securityDefiner: /\bSECURITY DEFINER\b/i.test(match[0]),
    hasSearchPath: /\bSET\s+search_path\b/i.test(match[0]),
    args: match[2].split(")").shift() || "",
  });
}

for (const match of statementsMatching(/ALTER TABLE "public"\."([^"]+)" ENABLE ROW LEVEL SECURITY;/g)) {
  const table = tables.get(match[1]);
  if (table) table.rlsEnabled = true;
}
for (const match of statementsMatching(/ALTER TABLE "public"\."([^"]+)" FORCE ROW LEVEL SECURITY;/g)) {
  const table = tables.get(match[1]);
  if (table) table.rlsForced = true;
}

const policyRe = /CREATE POLICY "([^"]+)" ON "public"\."([^"]+)"(?:\s+AS\s+(PERMISSIVE|RESTRICTIVE))?(?:\s+FOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE))?(?:\s+TO\s+([^ ]+(?:,\s*[^ ]+)*))?([\s\S]*?);/g;
const policies = [];
for (const match of statementsMatching(policyRe)) {
  const policy = {
    name: match[1],
    table: match[2],
    command: match[4] || "ALL",
    roles: (match[5] || "public").replaceAll('"', "").split(",").map((r) => r.trim()).filter(Boolean),
    expression: match[6].replace(/\s+/g, " ").trim(),
    sql: match[0].replace(/\s+/g, " ").trim(),
  };
  policy.permissive = /\bUSING\s*\(\s*true\s*\)|\bWITH CHECK\s*\(\s*true\s*\)/i.test(policy.sql);
  policy.usingTrue = /\bUSING\s*\(\s*true\s*\)/i.test(policy.sql);
  policy.checkTrue = /\bWITH CHECK\s*\(\s*true\s*\)/i.test(policy.sql);
  policy.businessEqualsUid = /business_id"?\s*=\s*"auth"\."uid"\(\)|"business_id"\s*=\s*"auth"\."uid"\(\)|business_id\s*=\s*auth\.uid\(\)/i.test(policy.sql);
  policy.usesMembership = /user_business_link|is_member|tax_user_owns_business|business_profiles/i.test(policy.sql);
  policy.usesAuthUid = /auth"\."uid|auth\.uid/i.test(policy.sql);
  policies.push(policy);
  tables.get(policy.table)?.policies.push(policy);
}

const grants = [];
for (const match of statementsMatching(/GRANT ([^;]+?) ON (TABLE|SEQUENCE|FUNCTION) "public"\."([^"]+)"(?:\([^\)]*\))? TO "([^"]+)";/g)) {
  const grant = { privilege: match[1], objectType: match[2], object: match[3], role: match[4], sql: match[0] };
  grants.push(grant);
  if (grant.objectType === "TABLE" && tables.has(grant.object)) tables.get(grant.object).grants.push(grant);
  if (grant.objectType === "SEQUENCE") {
    for (const table of tables.values()) {
      if (grant.object.startsWith(`${table.name}_`) || grant.object.includes(table.name)) table.sequenceGrants.push(grant);
    }
  }
}
const defaultPrivilegeStatements = [...statementsMatching(/ALTER DEFAULT PRIVILEGES[\s\S]*?;/g)].map((m) => m[0].replace(/\s+/g, " ").trim());

function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".git", "dist"].includes(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else if (/\.(js|jsx|ts|tsx)$/.test(entry)) files.push(full);
  }
  return files;
}

const sourceFiles = walk(path.join(ROOT, "src"));
const frontendRoots = ["src/components/", "src/pages/", "src/hooks/", "src/auth/", "src/insights/", "src/services/", "src/utils/"];
const serverOnlyRoots = ["src/api/", "src/services/", "src/jobs/", "src/cron/", "src/scripts/"];

for (const file of sourceFiles) {
  const rel = path.relative(ROOT, file);
  const text = readFileSync(file, "utf8");
  for (const table of tables.values()) {
    const re = new RegExp(`\\.from\\(\\s*['"\`]${table.name}['"\`]\\s*\\)|schema\\([^\\)]*\\)\\.from\\(\\s*['"\`]${table.name}['"\`]\\s*\\)`, "g");
    if (!re.test(text)) continue;
    if (frontendRoots.some((root) => rel.startsWith(root)) && !rel.startsWith("src/services/quickbooks/") && !rel.startsWith("src/services/plaid/") && !/supabaseAdmin|quickbooksTokenService|plaidClient|qboToken|serviceRole/i.test(rel)) {
      table.frontendUsage.push(rel);
    }
    if (serverOnlyRoots.some((root) => rel.startsWith(root)) && /supabaseAdmin|from\(|getAdminClient|service_role|SUPABASE_SERVICE_ROLE/i.test(text)) {
      table.serviceUsage.push(rel);
    }
  }
}

function tenantKey(table) {
  const cols = new Set(table.columnNames);
  if (cols.has("business_id") && cols.has("user_id")) return "business_id + user_id";
  if (cols.has("business_id")) return "business_id";
  if (cols.has("user_id")) return "user_id";
  if (["bid_estimate_line_items", "bid_outcomes"].includes(table.name)) return "inherited through bid_estimates";
  if (["job_payment_allocations"].includes(table.name)) return "inherited through job_payment_records";
  if (["tax_calculation_components", "tax_calculation_nodes", "tax_calculation_run_links", "tax_calculation_workpaper_lines"].includes(table.name)) return "inherited through tax_calculation_runs";
  if (["ar_followups"].includes(table.name)) return "inherited through ar_open_items";
  return "none";
}

const sensitiveNameRe = /(token|oauth|secret|credential|password|refresh|access_token|plaid|quickbooks|qbo|stripe|billing|email|gmail|bank|transaction|invoice|tax|document|doc|financial|reconciliation|webhook|sync|job|customer|profile|business|membership|user_business_link)/i;
function hasSensitiveData(table) {
  return sensitiveNameRe.test(table.name) || table.columnNames.some((c) => sensitiveNameRe.test(c));
}

function classify(table) {
  const name = table.name;
  if (/(tokens|oauth_connection_states|plaid_items|linked_financial_items|email_accounts|qbo_webhook_events|webhook|scheduled_job_locks|sync_runs|cdc_cursors|backfill_jobs|recalculation_requests|scheduler_runs|contractor_cfo_insight_runs)/i.test(name)) return "SERVER_ONLY_SENSITIVE";
  if (/(tax_rule_configs|tax_deduction_rules|tax_state_rates|state_tax_rule_configs|tax_reserve_policy_configs|prices_cache|securities|expense_category_map)/i.test(name)) return "SHARED_REFERENCE";
  if (/(user_profiles|profiles|notifications|meetings|post_gallery|prompt_usage|gpt_usage|bizzy_memory|gpt_threads|gpt_messages|bizzy_timeline|scenarios|insight_preferences|insight_reads)/i.test(name)) return "USER_PRIVATE";
  if (/(lock|audit|run|queue|cursor|state|health|integrity|backfill|sync|attempt|history)/i.test(name)) return "INTERNAL_OPERATIONAL";
  if (tenantKey(table).includes("business") || /(business|bank|invoice|customer|job|ar_|bookkeeping|financial|reconciliation|tax_|qbo|plaid|calendar|doc|insight|billing)/i.test(name)) return "TENANT_PRIVATE";
  return "UNKNOWN / NEEDS REVIEW";
}

function policyStatus(table, command) {
  const ps = table.policies.filter((p) => p.command === command || p.command === "ALL");
  if (!table.rlsEnabled) return "NO_RLS";
  if (!ps.length) return "NO_POLICY";
  if (ps.some((p) => p.usingTrue || p.checkTrue)) return "PERMISSIVE_TRUE";
  if (ps.some((p) => p.businessEqualsUid)) return "SUSPICIOUS_BUSINESS_EQ_UID";
  if (ps.some((p) => p.usesMembership || p.usesAuthUid)) return "CONSTRAINED";
  return "NEEDS_REVIEW";
}

function roleAccess(table, role) {
  const gs = table.grants.filter((g) => g.role === role).map((g) => g.privilege).join(", ");
  return gs || "none";
}

function severityFor(table) {
  const cls = table.classification;
  const anon = roleAccess(table, "anon");
  const auth = roleAccess(table, "authenticated");
  const sensitive = hasSensitiveData(table);
  const anyTrue = table.policies.some((p) => p.usingTrue || p.checkTrue);
  const dangerousWrite = table.policies.some((p) => p.checkTrue && /INSERT|UPDATE|ALL/.test(p.command));
  if (!table.rlsEnabled && /(ALL|SELECT|INSERT|UPDATE|DELETE)/.test(anon) && sensitive) return "CRITICAL";
  if (!table.rlsEnabled && /(ALL|SELECT|INSERT|UPDATE|DELETE)/.test(auth) && sensitive) return "CRITICAL";
  if (cls === "SERVER_ONLY_SENSITIVE" && /(ALL|SELECT|INSERT|UPDATE|DELETE)/.test(anon + auth) && (!table.rlsEnabled || anyTrue)) return "CRITICAL";
  if (cls.includes("PRIVATE") && anyTrue) return dangerousWrite ? "CRITICAL" : "HIGH";
  if (cls.includes("PRIVATE") && !table.rlsEnabled) return "HIGH";
  if (cls === "INTERNAL_OPERATIONAL" && !table.rlsEnabled && /(ALL|INSERT|UPDATE|DELETE|SELECT)/.test(anon + auth)) return "HIGH";
  if (table.policies.some((p) => p.businessEqualsUid)) return "MEDIUM";
  if (cls === "SHARED_REFERENCE" && !table.rlsEnabled) return "LOW";
  return "MEDIUM";
}

function findingFor(table) {
  const cls = table.classification;
  const parts = [];
  if (!table.rlsEnabled) parts.push("RLS is disabled");
  if (table.policies.some((p) => p.usingTrue)) parts.push("USING true policy");
  if (table.policies.some((p) => p.checkTrue)) parts.push("WITH CHECK true policy");
  if (table.policies.some((p) => p.businessEqualsUid)) parts.push("policy compares business_id to auth.uid()");
  if (roleAccess(table, "anon") !== "none") parts.push(`anon grant: ${roleAccess(table, "anon")}`);
  if (roleAccess(table, "authenticated") !== "none") parts.push(`authenticated grant: ${roleAccess(table, "authenticated")}`);
  if (!parts.length) parts.push("RLS exists but policy semantics require manual review");
  return `${cls}: ${parts.join("; ")}`;
}

function recommendationFor(table) {
  if (table.classification === "SERVER_ONLY_SENSITIVE") return "Revoke browser role grants or add deny-by-default RLS; expose only through authorized backend.";
  if (!table.rlsEnabled && table.classification === "SHARED_REFERENCE") return "Confirm table is non-sensitive reference data; prefer read-only authenticated/anon grants if public access is intended.";
  if (!table.rlsEnabled) return "Enable RLS and add tenant/user membership policies before browser role access.";
  if (table.policies.some((p) => p.usingTrue || p.checkTrue)) return "Replace permissive true policy with auth.uid()/membership checks and WITH CHECK ownership enforcement.";
  if (table.policies.some((p) => p.businessEqualsUid)) return "Replace business_id = auth.uid() with business owner/membership check.";
  return "Manually validate policy covers SELECT/INSERT/UPDATE/DELETE with tenant-safe USING and WITH CHECK.";
}

const tableRows = [...tables.values()].sort((a, b) => a.name.localeCompare(b.name)).map((table) => {
  table.classification = classify(table);
  const row = {
    table: table.name,
    classification: table.classification,
    rls_enabled: table.rlsEnabled,
    rls_forced: table.rlsForced,
    tenant_key: tenantKey(table),
    select_policy_status: policyStatus(table, "SELECT"),
    insert_policy_status: policyStatus(table, "INSERT"),
    update_policy_status: policyStatus(table, "UPDATE"),
    delete_policy_status: policyStatus(table, "DELETE"),
    anon_access: roleAccess(table, "anon"),
    authenticated_access: roleAccess(table, "authenticated"),
    direct_browser_usage: [...new Set(table.frontendUsage)].sort(),
    service_role_usage: [...new Set(table.serviceUsage)].sort(),
    severity: severityFor(table),
    sensitive: hasSensitiveData(table),
    finding: findingFor(table),
    recommended_action: recommendationFor(table),
  };
  return row;
});

const rlsDisabled = tableRows.filter((r) => !r.rls_enabled);
const dangerousPolicies = policies.filter((p) => p.usingTrue || p.checkTrue || p.businessEqualsUid || (!p.usesAuthUid && !p.usesMembership));
const sensitiveTables = tableRows.filter((r) => r.classification === "SERVER_ONLY_SENSITIVE");
const crossTenantRisks = tableRows.filter((r) => ["CRITICAL", "HIGH"].includes(r.severity) || /PERMISSIVE_TRUE|NO_RLS|SUSPICIOUS/.test(`${r.select_policy_status} ${r.insert_policy_status} ${r.update_policy_status} ${r.delete_policy_status}`));
const securityDefiners = functionBlocks.filter((f) => f.securityDefiner);

function mdTable(rows, columns, limit = Infinity) {
  const selected = rows.slice(0, limit);
  if (!selected.length) return "_None._\n";
  const header = `| ${columns.join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = selected.map((row) => `| ${columns.map((c) => String(row[c] ?? "").replace(/\|/g, "\\|").slice(0, 300)).join(" | ")} |`);
  return [header, sep, ...body].join("\n") + "\n";
}

const summary = {
  generated_at: new Date().toISOString(),
  snapshot: "supabase/live_schema_snapshot.sql",
  counts: {
    tables: tables.size,
    views: views.length,
    materialized_views: materializedViews.length,
    functions: functionBlocks.length,
    security_definer_functions: securityDefiners.length,
    rls_enabled_tables: tableRows.filter((r) => r.rls_enabled).length,
    rls_disabled_tables: rlsDisabled.length,
    policies: policies.length,
    grants: grants.length,
    grants_anon: grants.filter((g) => g.role === "anon").length,
    grants_authenticated: grants.filter((g) => g.role === "authenticated").length,
    grants_service_role: grants.filter((g) => g.role === "service_role").length,
    sequences: sequences.length,
    default_privilege_statements: defaultPrivilegeStatements.length,
  },
  tables: tableRows,
  views,
  materialized_views: materializedViews,
  functions: functionBlocks.map((f) => ({
    name: f.name,
    security_definer: f.securityDefiner,
    has_search_path: f.hasSearchPath,
    accepts_business_or_user_id: /\b(p_)?business_id\b|\b(p_)?user_id\b|\bmatch_user_id\b/i.test(f.args),
    granted_execute: grants.filter((g) => g.objectType === "FUNCTION" && g.object === f.name).map((g) => ({ role: g.role, privilege: g.privilege })),
  })),
  dangerous_policies: dangerousPolicies,
  rls_disabled: rlsDisabled,
  sensitive_tables: sensitiveTables,
  cross_tenant_risks: crossTenantRisks,
  default_privileges: defaultPrivilegeStatements,
};

const severityCounts = tableRows.reduce((acc, row) => {
  acc[row.severity] = (acc[row.severity] || 0) + 1;
  return acc;
}, {});

const md = `# Supabase RLS Security Audit

Source: \`supabase/live_schema_snapshot.sql\`

Generated from local schema snapshot only. No Supabase connection was made, no migrations were run, and no production data was modified.

## Executive Verdict

**FAIL / NOT READY FOR PRODUCTION CUSTOMER ONBOARDING from a direct-Supabase RLS perspective.**

The live public schema grants broad privileges to browser-accessible roles and relies heavily on RLS. Many tenant/private or server-only sensitive tables either have RLS disabled or have permissive policies such as \`USING (true)\` / \`WITH CHECK (true)\`. A legitimate authenticated user issuing arbitrary Supabase REST/RPC requests could plausibly read or mutate cross-tenant data on multiple tables. Anonymous access is also plausible on RLS-disabled tables because \`anon\` has broad grants in the dump.

## Exact Inventory Counts

${mdTable(Object.entries(summary.counts).map(([metric, count]) => ({ metric, count })), ["metric", "count"])}

## Severity Summary

${mdTable(Object.entries(severityCounts).map(([severity, count]) => ({ severity, count })), ["severity", "count"])}

## Canonical Ownership Model Observed

- \`business_profiles.id\` appears to represent the Bizzi business.
- \`business_profiles.user_id\` appears to represent the primary owner.
- \`user_business_link.user_id\` + \`user_business_link.business_id\` appears to represent explicit membership.
- \`user_business_link.role\` stores membership role.

Critical issue: \`business_profiles\` and \`user_business_link\` have permissive insert/manage policies in the snapshot, including \`WITH CHECK (true)\` and \`USING (true)\` patterns. That means the membership/ownership foundation itself is not safely enforced by database RLS.

## Required Table-by-Table Report

${mdTable(tableRows.map((r) => ({
  table: r.table,
  classification: r.classification,
  rls_enabled: r.rls_enabled ? "yes" : "no",
  rls_forced: r.rls_forced ? "yes" : "no",
  tenant_key: r.tenant_key,
  select_policy_status: r.select_policy_status,
  insert_policy_status: r.insert_policy_status,
  update_policy_status: r.update_policy_status,
  delete_policy_status: r.delete_policy_status,
  anon_access: r.anon_access,
  authenticated_access: r.authenticated_access,
  direct_browser_usage: r.direct_browser_usage.join(", "),
  service_role_usage: r.service_role_usage.slice(0, 6).join(", "),
  severity: r.severity,
  finding: r.finding,
  recommended_action: r.recommended_action,
})), ["table", "classification", "rls_enabled", "rls_forced", "tenant_key", "select_policy_status", "insert_policy_status", "update_policy_status", "delete_policy_status", "anon_access", "authenticated_access", "direct_browser_usage", "service_role_usage", "severity", "finding", "recommended_action"])}

## Matrix A - Tables Without RLS

${mdTable(rlsDisabled, ["table", "classification", "tenant_key", "anon_access", "authenticated_access", "severity", "finding", "recommended_action"])}

## Matrix B - Dangerous / Permissive Policies

${mdTable(dangerousPolicies.map((p) => ({
  table: p.table,
  policy: p.name,
  command: p.command,
  roles: p.roles.join(", "),
  using_true: p.usingTrue ? "yes" : "no",
  check_true: p.checkTrue ? "yes" : "no",
  business_equals_uid: p.businessEqualsUid ? "yes" : "no",
  expression: p.sql,
})), ["table", "policy", "command", "roles", "using_true", "check_true", "business_equals_uid", "expression"])}

## Matrix C - Cross-Tenant Risks

${mdTable(crossTenantRisks, ["table", "classification", "tenant_key", "select_policy_status", "insert_policy_status", "update_policy_status", "delete_policy_status", "severity", "finding"])}

## Matrix D - Server-Only Sensitive Tables

${mdTable(sensitiveTables, ["table", "rls_enabled", "anon_access", "authenticated_access", "select_policy_status", "insert_policy_status", "update_policy_status", "delete_policy_status", "severity", "finding", "recommended_action"])}

## Matrix E - RPC / Function Risks

### SECURITY DEFINER Functions

${mdTable(summary.functions.filter((f) => f.security_definer).map((f) => ({
  name: f.name,
  has_search_path: f.has_search_path ? "yes" : "no",
  accepts_business_or_user_id: f.accepts_business_or_user_id ? "yes" : "no",
  granted_execute: f.granted_execute.map((g) => `${g.role}:${g.privilege}`).join(", ") || "implicit/default grants need review",
})), ["name", "has_search_path", "accepts_business_or_user_id", "granted_execute"])}

### All Public Functions

${mdTable(summary.functions.map((f) => ({
  name: f.name,
  security_definer: f.security_definer ? "yes" : "no",
  has_search_path: f.has_search_path ? "yes" : "no",
  accepts_business_or_user_id: f.accepts_business_or_user_id ? "yes" : "no",
  granted_execute: f.granted_execute.map((g) => `${g.role}:${g.privilege}`).join(", ") || "implicit/default grants need review",
})), ["name", "security_definer", "has_search_path", "accepts_business_or_user_id", "granted_execute"])}

## Matrix F - Browser Supabase Surface

${mdTable(tableRows.filter((r) => r.direct_browser_usage.length).map((r) => ({
  table: r.table,
  direct_browser_usage: r.direct_browser_usage.join(", "),
  rls_enabled: r.rls_enabled ? "yes" : "no",
  select_policy_status: r.select_policy_status,
  insert_policy_status: r.insert_policy_status,
  update_policy_status: r.update_policy_status,
  delete_policy_status: r.delete_policy_status,
  severity: r.severity,
})), ["table", "direct_browser_usage", "rls_enabled", "select_policy_status", "insert_policy_status", "update_policy_status", "delete_policy_status", "severity"])}

## Matrix G - Service Role Usage

${mdTable(tableRows.filter((r) => r.service_role_usage.length).map((r) => ({
  table: r.table,
  service_role_usage: r.service_role_usage.slice(0, 10).join(", "),
  classification: r.classification,
  severity: r.severity,
  note: "Service-role bypasses RLS; application authorization must be verified for each browser-triggered path.",
})), ["table", "service_role_usage", "classification", "severity", "note"])}

## Grants / Default Privileges Findings

- The snapshot contains broad \`GRANT ALL ON TABLE ... TO anon\` and \`GRANT ALL ON TABLE ... TO authenticated\` patterns.
- RLS is therefore the primary barrier for many browser-accessible tables.
- \`ALTER DEFAULT PRIVILEGES\` grants future tables, functions, and sequences to \`anon\` and \`authenticated\`, which is dangerous by default.

${mdTable(defaultPrivilegeStatements.map((statement) => ({ statement })), ["statement"])}

## Cross-Tenant Attack Reasoning

- **SELECT Business B rows:** YES/POSSIBLE where tables have RLS disabled with anon/authenticated grants, or \`USING (true)\` policies on tenant/private data.
- **INSERT rows into Business B:** YES/POSSIBLE where \`WITH CHECK (true)\` exists on tenant tables or ownership tables.
- **UPDATE Business B rows:** YES/POSSIBLE where \`USING (true)\` / broad update policy exists or RLS is disabled.
- **DELETE Business B rows:** YES/POSSIBLE on RLS-disabled tables with broad grants and on tables with permissive delete policies.
- **Ownership transfer:** POSSIBLE where update policies do not include \`WITH CHECK\` preventing \`business_id\`, \`user_id\`, \`role\`, or ownership-column changes.
- **Membership escalation:** YES/POSSIBLE because \`user_business_link\` has \`WITH CHECK (true)\` insert policy and broad grants in the dump.
- **RPC bypass:** UNKNOWN/POSSIBLE. Several functions accept business/user IDs and default privileges grant broad future function execute. SECURITY DEFINER functions are present and require manual body-level remediation review.

## Runtime Test Readiness

REAL TWO-TENANT SUPABASE RUNTIME TEST: NOT EXECUTED.

This audit is static against the schema-only dump. Safe runtime validation requires a dedicated staging/test Supabase project or disposable tenants in a non-production project, two real auth users, two businesses, and test records for jobs/transactions/invoices/tax/provider tables. Do not execute destructive tests against production customer data.

## Final Answers

| Question | Answer | Explanation |
| --- | --- | --- |
| Is RLS enabled on every table that requires tenant isolation? | NO | ${rlsDisabled.length} public tables have RLS disabled; several appear tenant/private or operational. |
| Are all RLS-disabled tables intentionally safe without RLS? | NO | Several disabled tables are sensitive/tenant-related and still have broad anon/authenticated grants. |
| Can an authenticated User A directly SELECT Business B data through Supabase? | YES | Permissive policies and RLS-disabled tables with authenticated grants make this plausible/confirmed by static policy analysis. |
| Can User A INSERT rows assigned to Business B? | YES | \`WITH CHECK (true)\` policies exist on business/membership and other tenant-sensitive tables. |
| Can User A UPDATE Business B rows? | PARTIAL | Static analysis finds permissive/broad update exposure on some tables; runtime proof not executed. |
| Can User A DELETE Business B rows? | PARTIAL | RLS-disabled tables with grants are exposed; per-table delete runtime not executed. |
| Can User A modify ownership fields to move records between businesses? | PARTIAL | Many policies lack visible \`WITH CHECK\` ownership protection; runtime proof not executed. |
| Can User A add themselves to Business B through user_business_link? | YES | \`user_business_link\` has authenticated insert \`WITH CHECK (true)\` and broad grants. |
| Can User A elevate themselves to owner/admin? | YES | Membership role appears writable through permissive insert path unless blocked by constraints not visible in policy. |
| Do any USING (true) policies expose tenant-sensitive data? | YES | Examples include business_profiles, bizzy_memory, notifications, profiles. |
| Do any WITH CHECK (true) policies permit dangerous writes? | YES | Examples include user_business_link, business_profiles, bizzy_memory, gpt_messages, cashflow_forecast. |
| Do any policies confuse business_id with auth.uid()? | YES | \`monthly_forecast\` uses \`business_id = auth.uid()\`. |
| Can any public view bypass intended tenant isolation? | UNKNOWN | Views have broad grants; source/RLS/security semantics require manual review. |
| Can any RPC/function bypass intended tenant isolation? | UNKNOWN | SECURITY DEFINER and business_id-taking functions exist; runtime/body-level proof not executed. |
| Are all SECURITY DEFINER functions safe for their granted roles? | UNKNOWN | They require manual remediation review; default function privileges are broad. |
| Can ordinary authenticated users read provider/OAuth credentials? | YES/POSSIBLE | Server-only sensitive tables have broad grants; RLS varies. \`oauth_connection_states\` has RLS but no visible restrictive policy; \`quickbooks_tokens\`/Plaid-related grants are broad. |
| Can anonymous users read customer financial information? | YES/POSSIBLE | RLS-disabled financial/tenant tables with anon grants are present. |
| Are direct frontend Supabase calls protected by correct RLS? | NO | Some direct browser-used tables rely on weak or missing RLS semantics. |
| Are service-role operations appropriately protected by application authorization? | PARTIAL | Earlier API hardening improved many paths, but every service-role path still requires endpoint-by-endpoint verification. |
| Is the live database safe from known cross-tenant access from a CODE/SCHEMA perspective? | NO | Static schema shows direct Supabase cross-tenant risks. |
| Has real two-user/two-business runtime isolation been executed? | NO | Static audit only. |
| Is Supabase/RLS security ready for production? | NO | RLS/remediation is required before onboarding production customers. |
| What exact issues must be fixed before customer onboarding? | REQUIRED | Revoke broad anon/authenticated grants where inappropriate, enable RLS on tenant/sensitive tables, replace permissive policies, harden membership/ownership tables, audit SECURITY DEFINER/RPCs/views, and run real two-tenant staging tests. |
`;

mkdirSync(path.dirname(REPORT_MD), { recursive: true });
writeFileSync(REPORT_JSON, JSON.stringify(summary, null, 2));
writeFileSync(REPORT_MD, md);

console.log(JSON.stringify({
  report: path.relative(ROOT, REPORT_MD),
  json: path.relative(ROOT, REPORT_JSON),
  counts: summary.counts,
  severityCounts,
}, null, 2));
