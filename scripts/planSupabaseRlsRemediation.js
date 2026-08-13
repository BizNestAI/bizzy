import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SNAPSHOT = path.join(ROOT, "supabase/live_schema_snapshot.sql");
const AUDIT_JSON = path.join(ROOT, "reports/supabase-rls-security-audit.json");
const REPORT_MD = path.join(ROOT, "reports/supabase-rls-remediation-plan.md");
const REPORT_JSON = path.join(ROOT, "reports/supabase-rls-remediation-plan.json");

const sql = readFileSync(SNAPSHOT, "utf8");
const audit = JSON.parse(readFileSync(AUDIT_JSON, "utf8"));

function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".git", "dist", "build", "coverage"].includes(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else if (/\.(js|jsx|ts|tsx)$/.test(entry)) files.push(full);
  }
  return files;
}

function esc(value, max = 260) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function mdTable(rows, columns, limit = Infinity) {
  const selected = rows.slice(0, limit);
  if (!selected.length) return "_None._\n";
  return [
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...selected.map((row) => `| ${columns.map((col) => esc(row[col])).join(" | ")} |`),
  ].join("\n") + "\n";
}

function extractCreateTableColumns(tableName) {
  const re = new RegExp(`CREATE TABLE IF NOT EXISTS "public"\\."${tableName}" \\(([\\s\\S]*?)\\n\\);`);
  const match = sql.match(re);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((line) => line.trim().replace(/,$/, ""))
    .map((line) => line.match(/^"([^"]+)"\s+(.+)$/))
    .filter(Boolean)
    .map((m) => ({ name: m[1], definition: m[2] }));
}

const tableColumns = new Map(audit.tables.map((t) => [t.table, extractCreateTableColumns(t.table)]));

function hasColumn(table, name) {
  return (tableColumns.get(table) || []).some((c) => c.name === name);
}

function sourceFiles() {
  return walk(path.join(ROOT, "src"));
}

const source = sourceFiles().map((file) => {
  const rel = path.relative(ROOT, file);
  return { rel, text: readFileSync(file, "utf8") };
});

function tableSourceUsage(table) {
  const fromRe = new RegExp(`\\.from\\(\\s*['"\`]${table}['"\`]\\s*\\)`, "g");
  const rows = [];
  for (const file of source) {
    if (!fromRe.test(file.text)) continue;
    const isFrontend =
      /^(src\/components|src\/pages|src\/hooks|src\/auth)\//.test(file.rel) ||
      (/^src\/services\//.test(file.rel) && !/supabaseAdmin|quickbooks|plaid|google|bookkeeping|jobCosting|tax\/|qbo/i.test(file.rel));
    const isBackground = /^(src\/cron|src\/jobs)\//.test(file.rel);
    const isBackend = /^(src\/api|src\/services|src\/cron|src\/jobs)\//.test(file.rel) && !isFrontend;
    const ops = [];
    const idx = file.text.indexOf(`.from("${table}")`) >= 0 ? file.text.indexOf(`.from("${table}")`) : file.text.indexOf(`.from('${table}')`);
    const window = idx >= 0 ? file.text.slice(idx, idx + 700) : file.text;
    if (/\.select\(/.test(window)) ops.push("SELECT");
    if (/\.insert\(|\.upsert\(/.test(window)) ops.push("INSERT/UPSERT");
    if (/\.update\(/.test(window)) ops.push("UPDATE");
    if (/\.delete\(/.test(window)) ops.push("DELETE");
    rows.push({ file: file.rel, kind: isFrontend ? "frontend" : isBackground ? "background" : isBackend ? "backend/service" : "unknown", ops: ops.join(", ") || "unknown" });
  }
  return rows;
}

function functionBlocks() {
  const blocks = [];
  const re = /CREATE OR REPLACE FUNCTION "public"\."([^"]+)"\(([\s\S]*?)(?=\nCREATE OR REPLACE FUNCTION|\nCREATE TABLE|\nCREATE VIEW|\nCREATE MATERIALIZED VIEW|\nALTER TABLE|\nCREATE POLICY|\nGRANT |\nALTER DEFAULT PRIVILEGES|\n$)/g;
  for (const m of sql.matchAll(re)) {
    const text = m[0];
    blocks.push({
      name: m[1],
      args: (m[2].split(")").shift() || "").replace(/\s+/g, " ").trim(),
      returns: (text.match(/\)\s+RETURNS\s+([^\n]+)\n/i)?.[1] || "").trim(),
      security_definer: /\bSECURITY DEFINER\b/i.test(text),
      search_path: /\bSET\s+search_path\b/i.test(text),
      uses_auth_uid: /auth\.uid|auth"\."uid/i.test(text),
      uses_business_profiles: /business_profiles/i.test(text),
      uses_user_business_link: /user_business_link/i.test(text),
      accepts_business_id: /business_id|p_business/i.test(m[2]),
      accepts_user_id: /user_id|p_user/i.test(m[2]),
      modifies_data: /\b(insert|update|delete)\b/i.test(text),
      text,
    });
  }
  return blocks;
}

const functions = functionBlocks();
const grantByObject = new Map();
for (const grant of audit.grants || []) {
  const arr = grantByObject.get(grant.object) || [];
  arr.push(grant);
  grantByObject.set(grant.object, arr);
}

function categoryFor(row) {
  const table = row.table;
  if (["business_profiles", "user_business_link"].includes(table)) return "AUTHORIZATION_FOUNDATION";
  if (["user_profiles", "profiles"].includes(table)) return "USER_PRIVATE";
  if (/(tokens|oauth_connection_states|plaid_items|linked_financial_items|email_account_secrets|email_accounts|qbo_webhook_events|webhook|scheduled_job_locks|sync_runs|cdc_cursors|backfill_jobs|scheduler_runs|recalculation_requests|contractor_cfo_insight_runs)/i.test(table)) return "SYSTEM_INTERNAL";
  if (/(tax_rule_configs|tax_deduction_rules|tax_state_rates|state_tax_rule_configs|tax_reserve_policy_configs|prices_cache|securities)$/i.test(table)) return "GLOBAL_REFERENCE_READ_ONLY";
  if (/(post_gallery|notifications|meetings|prompt_usage|gpt_usage|bizzy_memory|gpt_threads|gpt_messages|bizzy_timeline|scenarios|insight_preferences|insight_reads)/i.test(table)) return "USER_PRIVATE";
  if (/(lock|audit|queue|cursor|integrity|backfill|sync|attempt|health|run|history|state)$/i.test(table)) return "SYSTEM_INTERNAL";
  if (row.tenant_key.includes("business") || /(business|bank|invoice|customer|job|ar_|bookkeeping|financial|reconciliation|tax_|qbo|plaid|calendar|doc|insight|billing|vendor|transaction|forecast|subscription)/i.test(table)) {
    const frontend = (row.direct_browser_usage || []).length > 0;
    return frontend ? "BUSINESS_TENANT_BROWSER" : "BUSINESS_TENANT_SERVER_ONLY";
  }
  return "UNKNOWN_REQUIRES_MANUAL_DECISION";
}

function sensitivityFor(row) {
  if (/(token|secret|credential|oauth|plaid_items|quickbooks_tokens|linked_financial_items|email_accounts)/i.test(row.table)) return "CREDENTIAL/SECRET";
  if (/(bank|transaction|invoice|financial|tax|billing|subscription|qbo|plaid|customer|job|ar_|document|doc|email)/i.test(row.table)) return "HIGH";
  if (/(profile|business|user|notification|insight|gpt|calendar|meeting)/i.test(row.table)) return "MODERATE";
  return "LOW";
}

function phaseFor(row, category) {
  if (category === "AUTHORIZATION_FOUNDATION") return "PHASE 1 - authorization foundation";
  if (category === "SYSTEM_INTERNAL" && sensitivityFor(row) === "CREDENTIAL/SECRET") return "PHASE 2 - server-only credentials/integration tables";
  if (category === "SYSTEM_INTERNAL") return "PHASE 2 - server-only internal tables";
  if (/(bank_transactions|ar_open_items|invoices|financial_metrics|account_breakdown|cashflow_forecast|tax_snapshots|transaction_categorizations|qbo_posted_transactions|vendor_rules|plaid_accounts|subscriptions)/.test(row.table)) return "PHASE 3 - critical financial tenant tables";
  if (category.startsWith("BUSINESS_TENANT")) return "PHASE 4 - remaining business tenant tables";
  if (category === "USER_PRIVATE") return "PHASE 5 - user-private tables";
  if (category === "GLOBAL_REFERENCE_READ_ONLY" || category === "PUBLIC_INTENTIONAL") return "PHASE 8 - grants/default privileges cleanup";
  return "PHASE 9 - manual decisions";
}

function targetStateFor(row, category) {
  if (category === "AUTHORIZATION_FOUNDATION") return "RLS enabled; owner/member policies with strict WITH CHECK; signup/onboarding moved or constrained safely.";
  if (category === "SYSTEM_INTERNAL") return "Revoke anon/authenticated grants; server/service-role only; optional deny-by-default RLS.";
  if (category === "GLOBAL_REFERENCE_READ_ONLY") return "Read-only grant only to intended roles; no browser writes; RLS optional if truly global.";
  if (category === "USER_PRIVATE") return "RLS by auth.uid() with INSERT/UPDATE WITH CHECK locking user_id/id to auth.uid().";
  if (category === "BUSINESS_TENANT_BROWSER") return "RLS by verified membership in user_business_link and immutable business_id/user_id checks.";
  if (category === "BUSINESS_TENANT_SERVER_ONLY") return "Prefer server-only grants; if browser access remains, use membership RLS.";
  return "Manual access decision required before migration.";
}

function remediationRisk(row, category) {
  if (["business_profiles", "user_business_link"].includes(row.table)) return "High: can break signup/onboarding/business switching if direct browser writes are not replaced first.";
  if (/(quickbooks_tokens|plaid_items|linked_financial_items|email_accounts)/i.test(row.table)) return "Medium: status fallbacks or integration flows may break unless backend status APIs are complete.";
  if ((row.direct_browser_usage || []).length) return "Medium: frontend direct Supabase usage must be preserved by correct RLS or moved behind API.";
  if ((row.service_role_usage || []).length) return "Medium: server queries bypass RLS and need endpoint authorization review.";
  return "Low/medium: validate dependent backend paths and runtime tests.";
}

function dependencyFor(row, category) {
  if (category === "AUTHORIZATION_FOUNDATION") return "auth.uid(), signup/onboarding flow, membership creation semantics";
  if (category.startsWith("BUSINESS_TENANT")) return "business_profiles owner integrity; user_business_link membership integrity; helper membership policy/function";
  if (category === "USER_PRIVATE") return "auth.uid() identity; user profile bootstrap";
  if (category === "SYSTEM_INTERNAL") return "backend service-role authorization; cron/webhook trusted source";
  if (category === "GLOBAL_REFERENCE_READ_ONLY") return "product decision: public vs authenticated read-only";
  return "manual owner decision";
}

const planRows = audit.tables.map((row) => {
  const category = categoryFor(row);
  const usage = tableSourceUsage(row.table);
  const frontend = usage.filter((u) => u.kind === "frontend");
  const backend = usage.filter((u) => u.kind === "backend/service");
  const background = usage.filter((u) => u.kind === "background");
  const dangerousPolicies = (audit.dangerous_policies || []).filter((p) => p.table === row.table);
  return {
    object: row.table,
    type: "table",
    current_rls: row.rls_enabled ? "enabled" : "disabled",
    policy_count: (audit.policies || []).filter((p) => p.table === row.table).length,
    current_dangerous_grant_policy: [
      row.anon_access !== "none" ? `anon=${row.anon_access}` : "",
      row.authenticated_access !== "none" ? `authenticated=${row.authenticated_access}` : "",
      dangerousPolicies.length ? dangerousPolicies.map((p) => `${p.command}:${p.name}`).join("; ") : "",
    ].filter(Boolean).join(" | "),
    classification: category,
    sensitivity: sensitivityFor(row),
    identity_columns: row.tenant_key,
    frontend_access: frontend.map((u) => `${u.file} (${u.ops})`).join("; "),
    backend_access: backend.map((u) => `${u.file} (${u.ops})`).join("; "),
    background_access: background.map((u) => `${u.file} (${u.ops})`).join("; "),
    target_state: targetStateFor(row, category),
    remediation_phase: phaseFor(row, category),
    dependency: dependencyFor(row, category),
    risk: remediationRisk(row, category),
    notes: row.finding,
  };
});

const permissivePolicies = (audit.dangerous_policies || [])
  .filter((p) => p.usingTrue || p.checkTrue || p.businessEqualsUid)
  .map((p) => {
    const row = planRows.find((r) => r.object === p.table);
    return {
      table: p.table,
      policy: p.name,
      command: p.command,
      role: (p.roles || []).join(", ") || "public",
      predicate: p.expression || p.sql,
      why: p.businessEqualsUid
        ? "Compares business identity to auth user identity; likely wrong tenant model."
        : p.checkTrue
          ? "WITH CHECK true permits caller-controlled owner/tenant values on writes."
          : "USING true permits unrestricted row visibility/mutation subject only to grants.",
      replacement: row?.classification === "USER_PRIVATE"
        ? "auth.uid() ownership predicate and WITH CHECK user_id/id = auth.uid()."
        : row?.classification === "AUTHORIZATION_FOUNDATION"
          ? "Special foundation policy: controlled business creation and membership invitation/owner semantics."
          : "Membership EXISTS predicate against user_business_link plus immutable tenant columns.",
      breakage_risk: remediationRisk(row || {}, row?.classification || "UNKNOWN"),
    };
  });

const rlsDisabledPlan = planRows
  .filter((r) => r.current_rls === "disabled")
  .map((r) => ({
    table: r.object,
    action_class:
      r.classification === "SYSTEM_INTERNAL" ? "SAFE_SERVER_ONLY_AFTER_GRANT_REVOKE" :
      r.classification === "USER_PRIVATE" ? "REQUIRES_USER_RLS" :
      r.classification === "GLOBAL_REFERENCE_READ_ONLY" ? "SAFE_REFERENCE_TABLE" :
      r.classification === "BUSINESS_TENANT_BROWSER" || r.classification === "BUSINESS_TENANT_SERVER_ONLY" ? "REQUIRES_TENANT_RLS" :
      "UNKNOWN_REQUIRES_MANUAL_REVIEW",
    target: r.target_state,
    phase: r.remediation_phase,
    risk: r.risk,
  }));

const securityDefinerPlan = functions
  .filter((f) => f.security_definer)
  .map((f) => ({
    function: f.name,
    args: f.args,
    returns: f.returns,
    search_path: f.search_path ? "pinned" : "not detected",
    accepts_ids: [f.accepts_user_id ? "user_id" : "", f.accepts_business_id ? "business_id" : ""].filter(Boolean).join(", ") || "none detected",
    auth_check: f.uses_auth_uid ? "auth.uid detected" : "no auth.uid detected",
    membership_check: f.uses_user_business_link || f.uses_business_profiles ? "business/membership table detected" : "not detected",
    modifies_data: f.modifies_data ? "yes" : "no",
    classification: !f.search_path ? "NEEDS_SEARCH_PATH_HARDENING" : f.uses_auth_uid || !f.accepts_business_id ? "NEEDS_MANUAL_REVIEW" : "NEEDS_AUTH_CHECK",
  }));

const views = audit.views.map((view) => {
  const usage = tableSourceUsage(view);
  const viewSql = sql.match(new RegExp(`CREATE(?: OR REPLACE)? VIEW "public"\\."${view}"[\\s\\S]*?;`))?.[0] || "";
  const baseTables = audit.tables.filter((t) => new RegExp(`\\b${t.table}\\b`, "i").test(viewSql)).map((t) => t.table);
  const sensitive = baseTables.some((t) => {
    const row = planRows.find((r) => r.object === t);
    return row && ["HIGH", "CREDENTIAL/SECRET"].includes(row.sensitivity);
  });
  return {
    view,
    base_tables: baseTables.join(", "),
    access: (grantByObject.get(view) || []).map((g) => `${g.role}:${g.privilege}`).join(", ") || "none detected",
    frontend_usage: usage.filter((u) => u.kind === "frontend").map((u) => u.file).join(", "),
    risk: sensitive ? "UNKNOWN/HIGH_RISK until security_invoker and base-table RLS are verified" : "UNKNOWN",
    target: "Prefer security_invoker views or revoke browser grants; ensure base-table RLS cannot be bypassed.",
  };
});

const dependencyGraph = {
  auth_uid: ["user_profiles", "profiles", "business_profiles.user_id", "user_business_link.user_id"],
  business_profiles: planRows.filter((r) => r.dependency.includes("business_profiles")).map((r) => r.object),
  user_business_link: planRows.filter((r) => r.dependency.includes("user_business_link")).map((r) => r.object),
  helper_functions: functions.filter((f) => f.uses_business_profiles || f.uses_user_business_link).map((f) => f.name),
};

const migrationSet = [
  { file: "202608xx_rls_foundation_hardening.sql", purpose: "Harden business_profiles, user_business_link, user_profiles/profiles, membership helpers.", dependencies: "Application onboarding decision.", risk: "High; can break signup/business creation." },
  { file: "202608xx_server_only_table_lockdown.sql", purpose: "Revoke browser grants from credential/internal tables and add deny-by-default RLS where useful.", dependencies: "Backend status APIs for Plaid/QBO/email/billing.", risk: "Medium; direct frontend fallbacks must be removed first." },
  { file: "202608xx_financial_tenant_rls.sql", purpose: "Enable tenant RLS on bank/AR/invoice/financial/tax critical tables.", dependencies: "Foundation membership policies.", risk: "High data-safety impact; broad runtime tests required." },
  { file: "202608xx_remaining_tenant_rls.sql", purpose: "Apply membership policies to remaining business tables.", dependencies: "Financial-table pattern proven.", risk: "Medium." },
  { file: "202608xx_user_private_rls.sql", purpose: "Lock user-private tables to auth.uid().", dependencies: "User bootstrap path.", risk: "Medium." },
  { file: "202608xx_view_security_hardening.sql", purpose: "Set/recreate views to respect invoker semantics or revoke browser access.", dependencies: "Base-table policies.", risk: "Medium." },
  { file: "202608xx_security_definer_hardening.sql", purpose: "Pin search_path, restrict EXECUTE, add auth/tenant checks to RPCs.", dependencies: "Function-specific review.", risk: "Medium/high for jobs and triggers." },
  { file: "202608xx_browser_grant_cleanup.sql", purpose: "Revoke unnecessary anon/authenticated grants from existing objects.", dependencies: "RLS and direct frontend inventory.", risk: "High if done before RLS/app changes." },
  { file: "202608xx_default_privilege_hardening.sql", purpose: "Stop granting future tables/functions/sequences to anon/authenticated by default.", dependencies: "None for future objects; coordinate deploy practice.", risk: "Low for existing objects, medium for future migrations relying on defaults." },
];

const phases = [
  {
    phase: "PHASE 0 - compatibility preparation",
    objects: "businessService onboarding, useOnboardingStatus, direct Supabase fallbacks",
    prerequisites: "No DB changes.",
    risk: "Prevents breakage when foundation/server-only lockdown lands.",
    tests: "Signup, onboarding, business creation, integration status.",
  },
  {
    phase: "PHASE 1 - authorization foundation",
    objects: "business_profiles, user_business_link, user_profiles, profiles, membership helper functions",
    prerequisites: "Decide business creation and membership creation flow.",
    risk: "Highest application breakage risk.",
    tests: "Owner create, member access, self-add denied, self-promote denied.",
  },
  {
    phase: "PHASE 2 - server-only secrets/integration tables",
    objects: "quickbooks_tokens, plaid_items, linked_financial_items, oauth_connection_states, email_accounts, webhook/sync state",
    prerequisites: "Backend status APIs replace direct frontend reads.",
    risk: "Medium; integration status/UI fallbacks may break.",
    tests: "Plaid/QBO/Gmail connect/status/sync/webhook paths.",
  },
  {
    phase: "PHASE 3 - critical financial tenant tables",
    objects: "bank_transactions, invoices, ar_open_items, financial_metrics, account_breakdown, cashflow_forecast, tax_snapshots, transaction_categorizations",
    prerequisites: "Phase 1.",
    risk: "High; direct browser and service-role users need tenant tests.",
    tests: "Two-tenant read/write/delete/UUID-known attack tests.",
  },
  {
    phase: "PHASE 4 - remaining business tenant tables",
    objects: "jobs, job costing, docs, calendar, insights, qbo/plaid account metadata, tax workpapers",
    prerequisites: "Phase 3 pattern proven.",
    risk: "Medium/high.",
    tests: "Module-by-module direct Supabase and API regression tests.",
  },
  {
    phase: "PHASE 5 - user-private tables",
    objects: "gpt_messages, gpt_usage, bizzy_memory, notifications, post_gallery, meetings, scenarios",
    prerequisites: "User profile bootstrap path.",
    risk: "Medium.",
    tests: "User A cannot read/write User B private rows.",
  },
  {
    phase: "PHASE 6 - views",
    objects: audit.views.join(", "),
    prerequisites: "Base-table RLS correct.",
    risk: "Medium.",
    tests: "View row visibility matches base-table visibility.",
  },
  {
    phase: "PHASE 7 - RPC / SECURITY DEFINER",
    objects: securityDefinerPlan.map((f) => f.function).join(", "),
    prerequisites: "Function-by-function auth semantics.",
    risk: "Medium/high.",
    tests: "RPC with foreign business_id/row IDs denied.",
  },
  {
    phase: "PHASE 8 - grants/default privileges",
    objects: "Explicit grants and ALTER DEFAULT PRIVILEGES",
    prerequisites: "Phases 1-7 deployed.",
    risk: "High if too early; low for default privileges alone.",
    tests: "PostgREST anon/authenticated permission matrix.",
  },
  {
    phase: "PHASE 9 - runtime attack testing",
    objects: "Full Supabase REST/RPC surface",
    prerequisites: "Dedicated staging or local Supabase with two tenants.",
    risk: "No production mutation.",
    tests: "User A/Business B select/insert/update/delete/RPC/resource UUID tests.",
  },
];

const doNotTouchFirst = [
  { object: "business_profiles", reason: "Frontend onboarding creates and updates this table directly in src/services/businessService.js." },
  { object: "user_business_link", reason: "Membership is the future authorization root; permissive writes must be replaced only after signup/member creation flow is understood." },
  { object: "user_profiles", reason: "Frontend bootstrap upserts profile rows directly during auth setup." },
  { object: "quickbooks_tokens", reason: "useOnboardingStatus has a direct Supabase fallback read for QBO status; must rely on backend status API first." },
  { object: "plaid_items", reason: "useOnboardingStatus has a direct Supabase fallback read for Plaid status; must rely on backend status API first." },
  { object: "cron/background tables", reason: "Cron jobs use service-role paths and should not receive browser RLS assumptions; grants can be revoked but server paths need validation." },
];

const topIssues = [
  "RLS disabled plus anon/authenticated ALL grants on tenant financial tables.",
  "RLS disabled plus browser grants on credential/integration tables such as quickbooks_tokens, plaid_items, linked_financial_items.",
  "business_profiles has USING true / WITH CHECK true and is not safe as an ownership root yet.",
  "user_business_link permits authenticated INSERT WITH CHECK true, enabling self-add membership risk.",
  "Default privileges grant future tables/functions/sequences to anon/authenticated.",
  "USING true policies on user-private tables expose or mutate rows outside auth.uid().",
  "WITH CHECK true policies permit caller-controlled user_id/business_id on writes.",
  "monthly_forecast compares business_id to auth.uid(), confusing business and user identity.",
  "Public views need security-invoker/base-RLS validation before relying on them.",
  "SECURITY DEFINER functions and broad function grants need function-by-function execute hardening.",
];

const output = {
  source: {
    snapshot: "supabase/live_schema_snapshot.sql",
    audit: "reports/supabase-rls-security-audit.json",
  },
  counts: audit.counts,
  authorization_model: {
    auth_user: "Supabase auth user enters backend via requireAuth; canonical ID is req.auth.userId and auth.uid() should represent user identity only.",
    business: "business_profiles.id is the canonical Bizzi business ID in code and schema.",
    ownership: "business_profiles.user_id is primary owner.",
    membership: "user_business_link.user_id + user_business_link.business_id grants additional access; role stores owner/member semantics.",
    server_authority: "supabaseAdmin/service-role is used broadly in APIs, services, cron, webhooks, and background jobs and must be protected by application authorization.",
  },
  top_issues: topIssues,
  plan_rows: planRows,
  permissive_policies: permissivePolicies,
  rls_disabled_plan: rlsDisabledPlan,
  views,
  security_definer_functions: securityDefinerPlan,
  dependency_graph: dependencyGraph,
  phases,
  do_not_touch_first: doNotTouchFirst,
  migration_set: migrationSet,
  standard_patterns: [
    "PATTERN 1 direct user-owned row: SELECT/UPDATE/DELETE USING user_id = auth.uid(); INSERT/UPDATE WITH CHECK user_id = auth.uid(); keep user_id immutable.",
    "PATTERN 2 business member read: EXISTS user_business_link for target business_id plus owner relationship where needed.",
    "PATTERN 3 owner/admin write: require owner business_profiles.user_id = auth.uid() or membership role in allowed set.",
    "PATTERN 4 immutable ownership fields: UPDATE must not allow business_id/user_id/role/owner changes except explicit controlled admin path.",
    "PATTERN 5 server-only table: revoke anon/authenticated grants; expose through backend only; optional deny-by-default RLS.",
    "PATTERN 6 global reference read-only: grant SELECT only to intended roles; no INSERT/UPDATE/DELETE to browser roles.",
    "PATTERN 7 insert-own-row: WITH CHECK auth.uid() owns user_id and is member/owner of business_id.",
    "PATTERN 8 membership creation: users cannot self-add to arbitrary business or self-promote role; owner/admin invitation only.",
    "PATTERN 9 business creation/onboarding: allow one controlled owner business create and first owner link creation, preferably server-side.",
    "PATTERN 10 protected RPC: SECURITY DEFINER only when needed, fixed search_path, least EXECUTE grants, auth.uid() and tenant checks inside.",
  ],
};

function section(title, body) {
  return `\n## ${title}\n\n${body}`;
}

const md = [
  "# Supabase RLS Remediation Plan and Dependency Map",
  "",
  "Planning-only artifact. Generated from `supabase/live_schema_snapshot.sql`, prior audit JSON, and static source scans. No Supabase connection was made. No SQL, migrations, policies, grants, application code, or production data were changed.",
  section("Executive Summary", [
    "**Implementation should not begin by blindly enabling RLS everywhere.** The authorization foundation is currently unsafe, and signup/onboarding has direct browser writes that appear to rely on permissive policies.",
    "",
    "Primary remediation order: prepare onboarding/status compatibility, harden `business_profiles` and `user_business_link`, lock down server-only credential tables, then apply tenant/user RLS by module, then views/RPCs/grants/default privileges.",
  ].join("\n")),
  section("Inventory Counts", mdTable(Object.entries(audit.counts).map(([metric, count]) => ({ metric, count })), ["metric", "count"])),
  section("Canonical Authorization Model", [
    "- `auth.uid()` / `req.auth.userId` is the authenticated Supabase user identity only.",
    "- `business_profiles.id` is the canonical Bizzi business ID.",
    "- `business_profiles.user_id` is the primary owner relationship.",
    "- `user_business_link.user_id + user_business_link.business_id` is the additional membership relationship.",
    "- `user_business_link.role` stores role-like membership state.",
    "- Business-scoped rows generally reference `business_profiles.id` through `business_id` or an inherited parent relationship.",
    "- Backend service-role access bypasses RLS and remains acceptable only after API/worker/webhook authorization has established user/business authority or trusted internal origin.",
  ].join("\n")),
  section("Top 10 Highest-Risk Issues", topIssues.map((x, i) => `${i + 1}. ${x}`).join("\n")),
  section("Objects To Fix First", mdTable(planRows.filter((r) => ["business_profiles", "user_business_link", "quickbooks_tokens", "plaid_items", "linked_financial_items", "bank_transactions", "ar_open_items", "invoices", "financial_metrics", "tax_snapshots"].includes(r.object)), ["object", "classification", "current_rls", "current_dangerous_grant_policy", "target_state", "remediation_phase", "risk"])),
  section("Do Not Touch First Without Compatibility Work", mdTable(doNotTouchFirst, ["object", "reason"])),
  section("Dependency Graph", [
    "- `auth.uid()` -> `user_profiles`, `profiles`, `business_profiles.user_id`, `user_business_link.user_id`",
    `- Functions touching auth foundations: ${dependencyGraph.helper_functions.join(", ") || "none detected"}`,
    `- Tables depending on business/member integrity: ${[...new Set([...dependencyGraph.business_profiles, ...dependencyGraph.user_business_link])].sort().join(", ")}`,
    "- Circularity concern: membership policies must allow a user to read only their own link rows without requiring unrestricted access to all membership rows.",
  ].join("\n")),
  section("Permissive/Suspicious Policies", mdTable(permissivePolicies, ["table", "policy", "command", "role", "predicate", "why", "replacement", "breakage_risk"])),
  section("RLS-Disabled Table Plan", mdTable(rlsDisabledPlan, ["table", "action_class", "target", "phase", "risk"])),
  section("Views", mdTable(views, ["view", "base_tables", "access", "frontend_usage", "risk", "target"])),
  section("SECURITY DEFINER Functions", mdTable(securityDefinerPlan, ["function", "args", "returns", "search_path", "accepts_ids", "auth_check", "membership_check", "modifies_data", "classification"])),
  section("Standard Target Policy Patterns", output.standard_patterns.map((p) => `- ${p}`).join("\n")),
  section("Remediation Phases", mdTable(phases, ["phase", "objects", "prerequisites", "risk", "tests"])),
  section("Proposed Future Migration Set", mdTable(migrationSet, ["file", "purpose", "dependencies", "risk"])),
  section("Object Remediation Matrix", mdTable(planRows, ["object", "type", "current_rls", "current_dangerous_grant_policy", "classification", "sensitivity", "identity_columns", "frontend_access", "backend_access", "background_access", "target_state", "remediation_phase", "dependency", "risk", "notes"])),
  section("Required Runtime Validation After Remediation", [
    "- Dedicated staging/local Supabase only; do not run destructive tests against production.",
    "- User A/Business A and User B/Business B direct PostgREST SELECT/INSERT/UPDATE/DELETE tests.",
    "- Known foreign UUID tests for jobs, invoices, transactions, tax runs, documents, QBO/Plaid account metadata.",
    "- Membership tests: owner allowed, real member allowed, non-member denied, self-add denied, role self-promotion denied.",
    "- RPC tests for every SECURITY DEFINER and every function accepting business/user/row IDs.",
    "- View tests proving view visibility matches base-table visibility.",
    "- Frontend smoke tests for signup, onboarding, business creation, business switcher, Plaid/QBO/Gmail/Stripe status, cron/webhook flows.",
  ].join("\n")),
  section("Final Planning Answers", [
    "1. Top 10 risks: see the Top 10 section above.",
    "2. Fix first: `business_profiles`, `user_business_link`, `quickbooks_tokens`, `plaid_items`, `linked_financial_items`, `bank_transactions`, `ar_open_items`, `invoices`, `financial_metrics`, `tax_snapshots`.",
    "3. `business_profiles` safe as ownership authority today? No; current policies are permissive.",
    "4. `user_business_link` safe as membership authority today? No; current INSERT permits arbitrary membership risk.",
    "5. Signup/onboarding depends on permissive RLS? Yes, current frontend writes `user_profiles` and `business_profiles` directly.",
    "6. Server-only tables: credential/OAuth/webhook/sync/cron/internal tables, especially QBO/Plaid/Gmail token/state tables.",
    "7. Direct browser access should be limited to deliberately chosen user-private or business UI tables after strict RLS; most financial/integration internals should move behind APIs.",
    "8. Known user/business confusion: `monthly_forecast` policy compares `business_id` to `auth.uid()`.",
    "9. Cross-tenant reads: any RLS-disabled tenant table with browser grants; `USING (true)` policies on private tables.",
    "10. Cross-tenant writes: `WITH CHECK (true)` policies and RLS-disabled tables with INSERT/UPDATE grants.",
    "11. Ownership/membership escalation: `business_profiles` and `user_business_link` permissive policies.",
    "12. Views that may bypass isolation: all seven views remain UNKNOWN until security-invoker/base-RLS review.",
    "13. Dangerous SECURITY DEFINER functions: all eleven need manual review; those without pinned search_path or tenant checks are priority.",
    "14. Service-role paths needing review: all API/services/cron paths listed in the matrix where service-role usage appears.",
    "15. Browser grants to revoke: all server-only tables and any tenant tables not intentionally direct-browser.",
    "16. Default privileges unsafe? Yes; future tables/functions/sequences are granted to anon/authenticated.",
    "17. Minimal breakage order: compatibility prep -> foundation -> server-only credentials -> critical tenant tables -> remaining tenant/user tables -> views/RPCs -> grants/default privileges -> runtime tests.",
    "18. Distinct patterns needed: 10 standard patterns cover most findings.",
    "19. Runtime tests required: two-tenant Supabase REST/RPC/view tests plus frontend/API compatibility smoke tests.",
    "20. Safe to begin implementation after review? Yes, after you review and approve this dependency map; implementation should be split into small prompts.",
  ].join("\n")),
].join("\n");

mkdirSync(path.dirname(REPORT_MD), { recursive: true });
writeFileSync(REPORT_JSON, JSON.stringify(output, null, 2));
writeFileSync(REPORT_MD, md);

console.log(JSON.stringify({
  report: path.relative(ROOT, REPORT_MD),
  json: path.relative(ROOT, REPORT_JSON),
  tables: planRows.length,
  permissivePolicies: permissivePolicies.length,
  rlsDisabled: rlsDisabledPlan.length,
  securityDefiners: securityDefinerPlan.length,
}, null, 2));
