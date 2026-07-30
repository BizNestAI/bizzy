#!/usr/bin/env node
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { validateTaxRuleCoverage } from "../../src/services/tax/quality/validateTaxRuleCoverage.js";
import { TAX_SUPPORTED_SCOPE } from "../../src/services/tax/quality/taxSupportedScope.js";

const DEFAULT_YEAR = 2026;
const DEFAULT_STATES = ["NC"];
const DEFAULT_ENTITIES = [
  "sole_proprietor",
  "single_member_llc_disregarded",
  "single_member_llc_s_corp",
  "s_corporation",
];
const DEFAULT_FILING_STATUSES = [
  "single",
  "married_filing_jointly",
  "married_filing_separately",
  "head_of_household",
  "qualifying_surviving_spouse",
];

const args = parseArgs(process.argv.slice(2));

try {
  const environment = String(args.environment || process.env.TAX_VALIDATION_ENV || "").toLowerCase();
  validateEnvironment({ environment, allowProduction: args["allow-production-read-only"] === true });
  const supabase = createReadOnlySupabaseClient();
  const year = Number(args.year || args.taxYear || DEFAULT_YEAR);
  const states = splitArg(args.states, DEFAULT_STATES);
  const entityPaths = splitArg(args.entities, DEFAULT_ENTITIES);
  const filingStatuses = splitArg(args.filingStatuses || args.filing_statuses, DEFAULT_FILING_STATUSES)
    .filter((status) => TAX_SUPPORTED_SCOPE.filingStatuses.includes(status));

  const result = await validateTaxRuleCoverage({
    supabase,
    taxYear: year,
    states,
    entityPaths,
    filingStatuses,
    certificationMode: true,
  });
  result.environment = environment;
  result.requestedScope = { taxYear: year, states, entityPaths, filingStatuses };

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);

  if (args.report !== false && args["no-report"] !== true) {
    await writeReports(result, { year, states });
  }

  if (result.overallStatus === "pass") process.exit(0);
  if (result.overallStatus === "warning") process.exit(1);
  process.exit(2);
} catch (err) {
  console.error(`Tax rule validation failed: ${err.message}`);
  if (args.json) console.error(JSON.stringify({ code: err.code || "tax_rule_validation_failed", message: err.message }, null, 2));
  process.exit(3);
}

function validateEnvironment({ environment, allowProduction }) {
  if (!environment) throw new Error("Explicit --environment=staging or TAX_VALIDATION_ENV=staging is required.");
  if (environment === "production" && !allowProduction) {
    throw new Error("Production rule validation is blocked without --allow-production-read-only.");
  }
  if (environment === "production") {
    console.error("WARNING: production validation is read-only and must not mutate rule tables.");
  }
  if (!["staging", "production", "development", "test"].includes(environment)) {
    throw new Error(`Unsupported validation environment: ${environment}`);
  }
}

function createReadOnlySupabaseClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Missing Supabase admin env. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for staging validation.");
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "X-Client-Info": "bizzi-tax-rule-certification/1.0" } },
  });
}

function printHuman(result) {
  console.log(`Tax rule certification ${result.taxYear} ${result.requestedScope?.states?.join(",") || ""}: ${result.overallStatus.toUpperCase()}`);
  console.log(`Environment: ${result.environment}`);
  console.log("");
  console.log("Federal");
  for (const row of result.federal.components) printRow(row);
  for (const status of result.federal.filingStatusCoverage || []) {
    console.log(`  Filing status ${status.filingStatus}: ${status.status.toUpperCase()}`);
    for (const row of status.components.filter((item) => item.status !== "pass")) printRow(row, "    ");
  }
  for (const state of result.states) {
    console.log("");
    console.log(`${state.stateCode}: ${state.status.toUpperCase()}`);
    for (const row of state.components) printRow(row);
  }
  console.log("");
  console.log(`Deductions: ${result.deductions.status.toUpperCase()}`);
  for (const row of result.deductions.certificationRequirements || []) printRow({ ...row, key: row.key });
  console.log("");
  console.log("Certification matrix");
  for (const row of result.certificationMatrix || []) {
    const suffix = row.blockers?.length ? ` (${row.blockers.join(", ")})` : "";
    console.log(`${row.status.toUpperCase()} ${row.taxYear} ${row.stateCode} ${row.entityPath} ${row.filingStatus}${suffix}`);
  }
  if (result.blockers.length) {
    console.log("");
    console.log("Blockers");
    for (const blocker of result.blockers) console.log(`FAIL ${blocker.code} ${blocker.stateCode || ""} ${blocker.filingStatus || ""} ${blocker.ruleType || blocker.requirementKey || blocker.key || ""}`.trim());
  }
}

function printRow(row, prefix = "") {
  const status = row.status === "pass" ? "PASS" : row.status === "warning" ? "WARN" : "FAIL";
  const suffix = row.ruleId ? ` ${row.ruleId}` : row.reason ? ` ${row.reason}` : "";
  console.log(`${prefix}${status} ${row.key || row.ruleType}${suffix}`);
}

async function writeReports(result, { year, states }) {
  await mkdir("reports", { recursive: true });
  const stateSlug = states.join("-");
  const base = `reports/tax-rule-certification-${year}-${stateSlug}`;
  await writeFile(`${base}.json`, `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(`${base}.md`, markdownReport(result));
  if (result.missingRuleTemplates?.length) {
    await writeFile(`${base}-seed-template.sql`, seedTemplateSql(result.missingRuleTemplates));
  }
}

function markdownReport(result) {
  const lines = [
    `# Tax Rule Certification ${result.taxYear} ${result.requestedScope?.states?.join(", ") || ""}`,
    "",
    `Environment: ${result.environment}`,
    `Overall status: **${result.overallStatus.toUpperCase()}**`,
    "",
    "## Requested Scope",
    "",
    `- Tax year: ${result.requestedScope?.taxYear}`,
    `- States: ${result.requestedScope?.states?.join(", ")}`,
    `- Entities: ${result.requestedScope?.entityPaths?.join(", ")}`,
    `- Filing statuses: ${result.requestedScope?.filingStatuses?.join(", ")}`,
    "",
    "## Certification Matrix",
    "",
    "| State | Entity | Filing status | Status | Blockers |",
    "| --- | --- | --- | --- | --- |",
    ...(result.certificationMatrix || []).map((row) => `| ${row.stateCode || ""} | ${row.entityPath} | ${row.filingStatus} | ${row.status} | ${(row.blockers || []).join(", ")} |`),
    "",
    "## Blockers",
    "",
    ...(result.blockers.length ? result.blockers.map((row) => `- ${row.code}: ${row.stateCode || ""} ${row.filingStatus || ""} ${row.ruleType || row.requirementKey || row.key || ""}`) : ["None"]),
    "",
    "## Deferred / Unsupported",
    "",
    ...result.deferredUnsupportedFeatures.map((item) => `- ${item}`),
  ];
  return `${lines.join("\n")}\n`;
}

function seedTemplateSql(templates = []) {
  const lines = [
    "-- Tax rule certification seed template.",
    "-- Do not run until every REQUIRES_VERIFIED_SOURCE placeholder has been replaced from verified source material.",
    "-- This file is intentionally not applied automatically.",
    "",
  ];
  for (const template of templates) {
    const values = template.requiredValues || {};
    lines.push(`-- ${template.reason || "missing_rule"} -> ${template.table}`);
    lines.push(`-- Expected values: ${JSON.stringify(values)}`);
    lines.push(`-- insert into public.${template.table} (...) values (...);`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  return Object.fromEntries(argv.map((arg) => {
    const clean = arg.replace(/^--/, "");
    const [key, ...parts] = clean.split("=");
    return [key, parts.length ? parts.join("=") : true];
  }));
}

function splitArg(value, fallback = []) {
  if (!value || value === true) return fallback;
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}
