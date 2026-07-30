import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { validateTaxEnvironmentSafety } from "../taxEnvironmentSafety.js";

export const TAX_SECURITY_TABLES = Object.freeze([
  "tax_profiles",
  "tax_profile_memory",
  "tax_rule_configs",
  "state_tax_rule_configs",
  "tax_deduction_rules",
  "transaction_tax_classifications",
  "tax_classification_overrides",
  "tax_adjustments",
  "tax_calculation_runs",
  "tax_calculation_components",
  "tax_payments",
  "tax_deadlines",
  "tax_reserve_accounts",
  "tax_reserve_snapshots",
  "tax_review_tasks",
  "tax_projection_scenarios",
  "tax_recalculation_requests",
  "tax_scheduler_runs",
  "tax_snapshots",
  "tax_legacy_migration_records",
]);

export function runTaxProductionAudit({ root = process.cwd(), env = process.env } = {}) {
  const checks = [
    checkEnvironment({ env }),
    checkRequiredFiles({ root }),
    checkRlsMigration({ root }),
    checkTaxRouterSecurity({ root }),
    checkTaxRoutesAuthorization({ root }),
    checkServiceRoleBoundaries({ root }),
    checkLegacyIsolation({ root }),
    checkCiIntegration({ root }),
  ].flat();
  const criticalFailures = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warning");
  return {
    status: criticalFailures.length ? "fail" : warnings.length ? "warning" : "pass",
    generatedAt: new Date().toISOString(),
    checks,
    summary: {
      pass: checks.filter((check) => check.status === "pass").length,
      warning: warnings.length,
      fail: criticalFailures.length,
    },
  };
}

function checkEnvironment({ env }) {
  const checks = [];
  try {
    const result = validateTaxEnvironmentSafety({ env, logger: nullLogger });
    checks.push(pass("environment_safety", "Tax environment safety checks passed."));
  } catch (err) {
    checks.push(fail("environment_safety", err.message));
  }
  const schedulerEnabled = truthy(env.TAX_SCHEDULER_ENABLED) || String(env.NODE_ENV || "") === "production";
  if (schedulerEnabled && !env.TAX_SCHEDULER_INTERNAL_SECRET) {
    checks.push(fail("scheduler_internal_secret_missing", "Tax scheduler is enabled but TAX_SCHEDULER_INTERNAL_SECRET is missing."));
  }
  return checks;
}

function checkRequiredFiles({ root }) {
  const required = [
    "src/api/tax/taxRouteUtils.js",
    "src/api/tax/taxSecurity.js",
    "src/api/tax/taxSchedulerAuth.js",
    "src/services/tax/taxEnvironmentSafety.js",
    "src/services/tax/quality/runBusinessTaxQa.js",
    "src/services/tax/quality/validateTaxRuleCoverage.js",
    "scripts/tax/production-audit.js",
    "docs/tax-security-inventory.md",
    "docs/tax-production-readiness.md",
  ];
  return required.map((file) => existsSync(join(root, file))
    ? pass("required_file", `${file} exists.`, { file })
    : fail("required_file_missing", `${file} is missing.`, { file }));
}

function checkRlsMigration({ root }) {
  const file = "supabase/migrations/20260714_tax_security_rls_hardening.sql";
  const path = join(root, file);
  if (!existsSync(path)) return [fail("rls_migration_missing", "Tax RLS hardening migration is missing.", { file })];
  const sql = read(path);
  const checks = [
    sql.includes("enable row level security") ? pass("rls_enabled_sql", "RLS enable statements are present.") : fail("rls_enabled_sql_missing", "RLS enable statements are missing."),
    sql.includes("tax_user_owns_business") ? pass("rls_business_owner_function", "Business ownership helper exists.") : fail("rls_business_owner_function_missing", "Business ownership helper is missing."),
  ];
  for (const table of TAX_SECURITY_TABLES) {
    checks.push(sql.includes(table)
      ? pass("rls_table_covered", `${table} appears in RLS hardening migration.`, { table })
      : fail("rls_table_missing", `${table} is not covered by RLS hardening migration.`, { table }));
  }
  return checks;
}

function checkTaxRouterSecurity({ root }) {
  const router = read(join(root, "src/api/tax/index.js"));
  return [
    /taxSecurityMiddleware/.test(router) ? pass("tax_router_security_middleware", "Tax router mounts security middleware.") : fail("tax_router_security_middleware_missing", "Tax router does not mount security middleware."),
    /deprecatedTaxRoute/.test(router) && /410/.test(router) ? pass("legacy_410", "Legacy routes return 410 from router.") : fail("legacy_410_missing", "Legacy route quarantine is missing."),
  ];
}

function checkTaxRoutesAuthorization({ root }) {
  const dir = join(root, "src/api/tax");
  const files = readdirSync(dir).filter((file) => file.endsWith(".js") && file !== "index.js" && file !== "taxHttp.js" && file !== "taxValidation.js" && file !== "taxSecurity.js" && file !== "taxSchedulerAuth.js");
  const checks = [];
  for (const file of files) {
    const source = read(join(dir, file));
    const hasRouter = /router\.(get|post|patch|put|delete)/.test(source) || /export default async function/.test(source);
    if (!hasRouter) continue;
    const routeLike = relative(root, join(dir, file));
    const authorized = /assertTaxBusinessAccess|getTaxRequestContext|requireTaxBusiness|assertInternalSchedulerAccess|deprecatedTaxRoute|410/.test(source);
    const legacyUnmounted = ["generateMonthlyTaxSnapshot.js", "generateTaxInsights.js", "snapshotExport.js", "snapshotShare.js"].includes(file);
    if (authorized || legacyUnmounted) checks.push(pass("tax_route_authorized_or_isolated", `${routeLike} has authorization/internal guard or is isolated legacy.`, { file: routeLike }));
    else checks.push(fail("tax_route_authorization_missing", `${routeLike} lacks an obvious Tax authorization guard.`, { file: routeLike }));
  }
  return checks;
}

function checkServiceRoleBoundaries({ root }) {
  const frontendDirs = ["src/components", "src/pages", "src/hooks"];
  const checks = [];
  for (const dir of frontendDirs) {
    const full = join(root, dir);
    if (!existsSync(full)) continue;
    for (const file of walk(full).filter((item) => /\.(js|jsx|ts|tsx)$/.test(item))) {
      const source = read(file);
      if (/supabaseAdmin|SUPABASE_SERVICE_ROLE_KEY|service_role/i.test(source)) {
        checks.push(fail("frontend_service_role_import", `Frontend file references service-role/admin boundary: ${relative(root, file)}`, { file: relative(root, file) }));
      }
    }
  }
  if (!checks.length) checks.push(pass("frontend_service_role_import", "No frontend service-role imports found."));
  return checks;
}

function checkLegacyIsolation({ root }) {
  const router = stripComments(read(join(root, "src/api/tax/index.js")));
  const activeImportsLegacyMath = /import .*generateMonthlyTaxSnapshot|import .*generateTaxInsights|taxLiabilityEngine|monthly_metrics|tax_config/.test(router);
  const env = read(join(root, "src/services/tax/taxEnvironmentSafety.js"));
  return [
    activeImportsLegacyMath ? fail("active_legacy_tax_math", "Tax router imports legacy tax math or snapshot generation.") : pass("active_legacy_tax_math", "Tax router does not import legacy calculation paths."),
    /MOCK_TAX/.test(env) && /production/.test(env) ? pass("mock_environment_guard", "Production mock-tax guard exists.") : fail("mock_environment_guard_missing", "Production mock-tax guard is missing."),
  ];
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function checkCiIntegration({ root }) {
  const workflow = join(root, ".github/workflows/tax-ci.yml");
  if (!existsSync(workflow)) return [warning("tax_ci_missing", "Tax CI workflow is not present in this workspace.")];
  const source = read(workflow);
  return [
    /tax:production-audit/.test(source) ? pass("tax_ci_production_audit", "Tax CI runs production audit.") : warning("tax_ci_production_audit_missing", "Tax CI does not run production audit."),
    /taxQuality\.test\.js/.test(source) ? pass("tax_ci_quality_tests", "Tax CI runs quality tests.") : warning("tax_ci_quality_tests_missing", "Tax CI does not run quality tests."),
  ];
}

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function read(path) {
  return readFileSync(path, "utf8");
}

function pass(code, message, details = {}) {
  return { status: "pass", code, message, ...details };
}

function warning(code, message, details = {}) {
  return { status: "warning", code, message, ...details };
}

function fail(code, message, details = {}) {
  return { status: "fail", code, message, ...details };
}

const nullLogger = Object.freeze({ info() {}, warn() {}, error() {} });
