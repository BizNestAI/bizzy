import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createTaxRlsFixtureContext,
  looksProductionLike,
} from "../../integration/tax/taxRlsHarness.js";
import {
  redact,
  runStaticTaxOutputSafetyScan,
  scanTaxResponseSafety,
} from "../../../src/services/tax/security/taxResponseSafetyScanner.js";

const REPORT_JSON = resolve(process.cwd(), "reports/tax-sensitive-output-report.json");
const REPORT_MD = resolve(process.cwd(), "reports/tax-sensitive-output-report.md");
const TAX_YEAR = 2026;

test("Tax API runtime responses and exports do not leak sensitive output", async (t) => {
  const config = getOutputSafetyConfig();
  const staticScan = runStaticTaxOutputSafetyScan({ root: process.cwd() });
  if (!config.runnable) {
    await writeOutputSafetyReport({
      status: "skipped",
      runtimeExecuted: false,
      reason: config.reason,
      missingEnvironment: config.missing,
      environment: safeEnvironment(config),
      staticScan,
      results: [],
    });
    t.skip(config.reason);
    return;
  }

  const ctx = await createTaxRlsFixtureContext(config);
  t.after(async () => {
    await ctx.cleanup();
  });

  const responses = [];
  const businessId = ctx.ids.businessA;
  const foreignBusinessId = ctx.ids.businessB;
  const runId = ctx.ids.runA;
  const otherRunId = ctx.ids.runB;
  const transactionId = ctx.ids.transactionA;
  const paymentId = ctx.ids.paymentA;
  const reserveId = ctx.ids.reserveA;
  const token = ctx.sessions.A?.access_token;
  const foreignToken = ctx.sessions.B?.access_token;

  for (const endpoint of buildEndpointMatrix({
    businessId,
    foreignBusinessId,
    runId,
    otherRunId,
    transactionId,
    paymentId,
    reserveId,
  })) {
    responses.push(await requestAndScan(config.apiBaseUrl, token, endpoint));
  }

  responses.push(await requestAndScan(config.apiBaseUrl, null, {
    name: "missing token overview",
    method: "GET",
    path: `/api/tax/overview?businessId=${businessId}&year=${TAX_YEAR}`,
  }));
  responses.push(await requestAndScan(config.apiBaseUrl, "invalid.token.value", {
    name: "invalid token overview",
    method: "GET",
    path: `/api/tax/overview?businessId=${businessId}&year=${TAX_YEAR}`,
  }));
  responses.push(await requestAndScan(config.apiBaseUrl, token, {
    name: "foreign business denial",
    method: "GET",
    path: `/api/tax/overview?businessId=${foreignBusinessId}&year=${TAX_YEAR}`,
  }));
  responses.push(await requestAndScan(config.apiBaseUrl, foreignToken, {
    name: "cross-token foreign business denial",
    method: "GET",
    path: `/api/tax/profile?businessId=${businessId}&year=${TAX_YEAR}`,
  }));

  const unsafe = responses.flatMap((item) => item.scan.findings.map((finding) => ({ endpoint: item.name, ...finding })));
  const status = unsafe.length || staticScan.status === "fail" ? "fail" : "pass";
  await writeOutputSafetyReport({
    status,
    runtimeExecuted: true,
    reason: null,
    missingEnvironment: [],
    environment: safeEnvironment(config),
    staticScan,
    results: responses,
  });

  assert.equal(
    unsafe.length,
    0,
    unsafe.map((finding) => `${finding.endpoint}:${finding.category}:${finding.path}:${finding.preview}`).join("\n")
  );
  assert.equal(staticScan.status, "pass", staticScan.findings.map((finding) => `${finding.file}:${finding.line}:${finding.category}`).join("\n"));
});

function getOutputSafetyConfig(env = process.env) {
  const required = [
    "TEST_SUPABASE_URL",
    "TEST_SUPABASE_ANON_KEY",
    "TEST_SUPABASE_SERVICE_ROLE_KEY",
    "TEST_API_BASE_URL",
  ];
  const missing = required.filter((key) => !env[key]);
  const enabled = env.TAX_OUTPUT_SAFETY_ENABLED === "true";
  const targetLabel = env.TAX_OUTPUT_SAFETY_TARGET_ENV || env.TAX_RLS_TARGET_ENV || env.TEST_ENVIRONMENT || "test";
  const appearsProduction = looksProductionLike(env.TEST_SUPABASE_URL || "") || looksProductionLike(env.TEST_API_BASE_URL || "") || targetLabel === "production";
  const productionOverride = env.TAX_OUTPUT_SAFETY_ALLOW_PRODUCTION_READ_ONLY === "true";

  if (!enabled) {
    return { runnable: false, reason: "TAX_OUTPUT_SAFETY_ENABLED is not true.", missing, appearsProduction, targetLabel };
  }
  if (missing.length) {
    return { runnable: false, reason: `Missing required environment variables: ${missing.join(", ")}.`, missing, appearsProduction, targetLabel };
  }
  if (appearsProduction && !productionOverride) {
    return {
      runnable: false,
      reason: "Target appears production-like. Set TAX_OUTPUT_SAFETY_ALLOW_PRODUCTION_READ_ONLY=true only for an authorized read-only production scan.",
      missing,
      appearsProduction,
      targetLabel,
    };
  }
  return {
    runnable: true,
    reason: "configured",
    missing,
    appearsProduction,
    targetLabel,
    supabaseUrl: env.TEST_SUPABASE_URL,
    anonKey: env.TEST_SUPABASE_ANON_KEY,
    serviceRoleKey: env.TEST_SUPABASE_SERVICE_ROLE_KEY,
    apiBaseUrl: env.TEST_API_BASE_URL.replace(/\/+$/, ""),
  };
}

function buildEndpointMatrix({ businessId, foreignBusinessId, runId, otherRunId, transactionId, paymentId, reserveId }) {
  const biz = encodeURIComponent(businessId);
  const foreign = encodeURIComponent(foreignBusinessId);
  const run = encodeURIComponent(runId);
  const otherRun = encodeURIComponent(otherRunId);
  const txn = encodeURIComponent(transactionId);
  const pay = encodeURIComponent(paymentId);
  const reserve = encodeURIComponent(reserveId);
  const idempotencyKey = `tax-output-safety-${Date.now()}`;
  return [
    { name: "overview success", method: "GET", path: `/api/tax/overview?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "calculation create dry run", method: "POST", path: "/api/tax/calculations", body: { businessId, year: TAX_YEAR, persistRun: false, triggerSource: "manual" } },
    { name: "calculations list", method: "GET", path: `/api/tax/calculations?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "latest calculation", method: "GET", path: `/api/tax/calculations/latest?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "calculation run", method: "GET", path: `/api/tax/calculations/${run}?businessId=${biz}` },
    { name: "calculation components", method: "GET", path: `/api/tax/calculations/${run}/components?businessId=${biz}` },
    { name: "calculation explanation", method: "GET", path: `/api/tax/calculations/${run}/explanation?businessId=${biz}` },
    { name: "calculation confidence", method: "GET", path: `/api/tax/calculations/${run}/confidence?businessId=${biz}` },
    { name: "calculation changes", method: "GET", path: `/api/tax/calculations/${run}/changes?businessId=${biz}&otherRunId=${otherRun}` },
    { name: "missing run error", method: "GET", path: `/api/tax/calculations/00000000-0000-4000-8000-000000000999?businessId=${biz}` },
    { name: "profile success", method: "GET", path: `/api/tax/profile?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "profile initialize", method: "POST", path: `/api/tax/profile/initialize?businessId=${biz}&year=${TAX_YEAR}`, body: { businessId, year: TAX_YEAR, source: "output_safety_fixture" } },
    { name: "profile create duplicate/error", method: "POST", path: `/api/tax/profile?businessId=${biz}&year=${TAX_YEAR}`, body: { businessId, year: TAX_YEAR, filingStatus: "single" } },
    { name: "profile patch", method: "PATCH", path: `/api/tax/profile?businessId=${biz}&year=${TAX_YEAR}`, body: { businessId, year: TAX_YEAR, qbiEligible: "unsure" } },
    { name: "profile years", method: "GET", path: `/api/tax/profile/years?businessId=${biz}` },
    { name: "profile memory", method: "GET", path: `/api/tax/profile-memory?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "profile memory set", method: "POST", path: `/api/tax/profile-memory?businessId=${biz}`, body: { businessId, memoryKey: "home_office_method", value: "undecided", source: "output_safety_fixture" } },
    { name: "profile memory history", method: "GET", path: `/api/tax/profile-memory/home_office_method/history?businessId=${biz}` },
    { name: "profile memory expire", method: "POST", path: `/api/tax/profile-memory/home_office_method/expire?businessId=${biz}`, body: { businessId, effectiveTo: `${TAX_YEAR}-12-31` } },
    { name: "entity evaluate", method: "GET", path: `/api/tax/entity/evaluate?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "entity evaluate post", method: "POST", path: "/api/tax/entity/evaluate", body: { businessId, year: TAX_YEAR, entityType: "sole_proprietor" } },
    { name: "entity requirements", method: "GET", path: `/api/tax/entity/requirements?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "rule support", method: "GET", path: `/api/tax/rule-support?businessId=${biz}&year=${TAX_YEAR}&state=NC` },
    { name: "rule configs summary", method: "GET", path: `/api/tax/rule-configs/summary?businessId=${biz}&year=${TAX_YEAR}&state=NC` },
    { name: "federal rule support", method: "GET", path: `/api/tax/federal/rule-support?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "federal calculate", method: "POST", path: "/api/tax/federal/calculate", body: { businessId, year: TAX_YEAR, taxableIncome: 1000, filingStatus: "single" } },
    { name: "self employment calculate", method: "POST", path: "/api/tax/self-employment/calculate", body: { businessId, year: TAX_YEAR, netProfit: 1000 } },
    { name: "self employment rule support", method: "GET", path: `/api/tax/self-employment/rule-support?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "s corp evaluate", method: "POST", path: "/api/tax/s-corp/evaluate", body: { businessId, year: TAX_YEAR, netBusinessIncome: 1000, ownerWages: 500 } },
    { name: "s corp diagnostics", method: "GET", path: `/api/tax/s-corp/diagnostics?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "state rule support", method: "GET", path: `/api/tax/state/rule-support?businessId=${biz}&year=${TAX_YEAR}&state=NC` },
    { name: "unsupported state error", method: "POST", path: "/api/tax/state/calculate", body: { businessId, year: TAX_YEAR, state: "ZZ" } },
    { name: "posted transactions list", method: "GET", path: `/api/tax/transactions/posted?businessId=${biz}&year=${TAX_YEAR}&limit=5` },
    { name: "posted transaction detail", method: "GET", path: `/api/tax/transactions/posted/${txn}?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "unclassified transactions", method: "GET", path: `/api/tax/transactions/unclassified?businessId=${biz}&year=${TAX_YEAR}&limit=5` },
    { name: "transaction source health", method: "GET", path: `/api/tax/transactions/source-health?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "classification coverage", method: "GET", path: `/api/tax/classifications/coverage?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "classifications list", method: "GET", path: `/api/tax/classifications?businessId=${biz}&year=${TAX_YEAR}&limit=5` },
    { name: "classification preview", method: "POST", path: `/api/tax/classifications/preview?businessId=${biz}&year=${TAX_YEAR}`, body: { businessId, year: TAX_YEAR, transactionIds: [transactionId] } },
    { name: "classification run", method: "POST", path: `/api/tax/classifications/run?businessId=${biz}&year=${TAX_YEAR}`, body: { businessId, year: TAX_YEAR, limit: 1 } },
    { name: "classification review list", method: "GET", path: `/api/tax/classifications/review?businessId=${biz}&year=${TAX_YEAR}&limit=5` },
    { name: "classification review summary", method: "GET", path: `/api/tax/classifications/review/summary?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "deductions overview", method: "GET", path: `/api/tax/deductions/overview?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "deductions transactions", method: "GET", path: `/api/tax/deductions/transactions?businessId=${biz}&year=${TAX_YEAR}&limit=5` },
    { name: "deductions transaction detail", method: "GET", path: `/api/tax/deductions/transactions/${txn}?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "deductions category detail", method: "GET", path: `/api/tax/deductions/categories/office_expense?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "deductions export csv", method: "GET", path: `/api/tax/deductions/export?businessId=${biz}&year=${TAX_YEAR}&format=summary_csv`, export: true },
    { name: "deductions export cpa", method: "GET", path: `/api/tax/deductions/export?businessId=${biz}&year=${TAX_YEAR}&format=cpa_package_json`, export: true },
    { name: "classification detail", method: "GET", path: `/api/tax/classifications/${txn}?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "classification history", method: "GET", path: `/api/tax/classifications/${txn}/history?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "classification confirm", method: "POST", path: `/api/tax/classifications/${txn}/confirm?businessId=${biz}&year=${TAX_YEAR}`, body: { businessId, year: TAX_YEAR, reason: "output safety fixture" } },
    { name: "classification override invalid", method: "PATCH", path: `/api/tax/classifications/${txn}?businessId=${biz}&year=${TAX_YEAR}`, body: { businessId, year: TAX_YEAR, changes: { deductiblePercentage: 2 } } },
    { name: "classification exclude", method: "POST", path: `/api/tax/classifications/${txn}/exclude?businessId=${biz}&year=${TAX_YEAR}`, body: { businessId, year: TAX_YEAR, reason: "unsupported" } },
    { name: "classification restore", method: "POST", path: `/api/tax/classifications/${txn}/restore?businessId=${biz}&year=${TAX_YEAR}`, body: { businessId, year: TAX_YEAR } },
    { name: "classification bulk invalid", method: "POST", path: `/api/tax/classifications/bulk-update?businessId=${biz}&year=${TAX_YEAR}`, body: { businessId, year: TAX_YEAR, transactionIds: [], changes: {} } },
    { name: "payments list", method: "GET", path: `/api/tax/payments?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "payment invalid", method: "POST", path: `/api/tax/payments?businessId=${biz}&year=${TAX_YEAR}`, body: { businessId, year: TAX_YEAR, amount: -1, jurisdiction: "federal", paymentType: "estimated_payment" }, headers: { "Idempotency-Key": idempotencyKey } },
    { name: "payment update invalid", method: "PATCH", path: `/api/tax/payments/${pay}?businessId=${biz}&year=${TAX_YEAR}`, body: { businessId, year: TAX_YEAR, amount: -20 } },
    { name: "payment void", method: "POST", path: `/api/tax/payments/${pay}/void?businessId=${biz}&year=${TAX_YEAR}`, body: { businessId, year: TAX_YEAR, reason: "output safety fixture" } },
    { name: "reserve summary", method: "GET", path: `/api/tax/reserve?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "reserve calculate", method: "POST", path: `/api/tax/reserve/calculate?businessId=${biz}&year=${TAX_YEAR}`, body: { businessId, year: TAX_YEAR } },
    { name: "reserve accounts", method: "GET", path: `/api/tax/reserve/accounts?businessId=${biz}` },
    { name: "reserve account create manual", method: "POST", path: `/api/tax/reserve/accounts?businessId=${biz}`, body: { businessId, account: { accountName: "Output Safety Reserve", accountType: "manual", source: "manual", manualBalance: 10 } } },
    { name: "reserve history", method: "GET", path: `/api/tax/reserve/history?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "reserve update invalid", method: "PATCH", path: `/api/tax/reserve/accounts/${reserve}?businessId=${biz}`, body: { businessId, manualBalance: -1 } },
    { name: "reserve set primary", method: "POST", path: `/api/tax/reserve/accounts/${reserve}/set-primary?businessId=${biz}`, body: { businessId } },
    { name: "reserve refresh", method: "POST", path: `/api/tax/reserve/accounts/${reserve}/refresh?businessId=${biz}`, body: { businessId } },
    { name: "reserve deactivate", method: "POST", path: `/api/tax/reserve/accounts/${reserve}/deactivate?businessId=${biz}`, body: { businessId } },
    { name: "taxable income calculate", method: "POST", path: "/api/tax/taxable-income/calculate", body: { businessId, year: TAX_YEAR } },
    { name: "taxable income latest", method: "GET", path: `/api/tax/taxable-income/latest?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "taxable income components", method: "GET", path: `/api/tax/taxable-income/components?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "projection annual", method: "POST", path: "/api/tax/projections/annual", body: { businessId, year: TAX_YEAR } },
    { name: "projection methods", method: "GET", path: `/api/tax/projections/methods?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "projection compare", method: "POST", path: "/api/tax/projections/compare", body: { businessId, year: TAX_YEAR, scenarios: ["base"] } },
    { name: "seed deadlines preview", method: "GET", path: `/api/tax/seed-deadlines/preview?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "seed deadlines run", method: "POST", path: "/api/tax/seed-deadlines/run", body: { businessId, year: TAX_YEAR } },
    { name: "legacy compatibility", method: "POST", path: "/api/tax/calculate-tax-liability", body: { businessId, year: TAX_YEAR } },
    { name: "legacy retired snapshot", method: "POST", path: "/api/tax/generate-monthly-tax-snapshot", body: { businessId, year: TAX_YEAR } },
    { name: "legacy history", method: "GET", path: `/api/tax/legacy/snapshots?businessId=${biz}&year=${TAX_YEAR}` },
    { name: "legacy export missing", method: "GET", path: `/api/tax/legacy/snapshots/00000000-0000-4000-8000-000000000999/export?businessId=${biz}` },
    { name: "malformed business id", method: "GET", path: "/api/tax/overview?businessId=not-a-uuid&year=2026" },
    { name: "foreign business error", method: "GET", path: `/api/tax/overview?businessId=${foreign}&year=${TAX_YEAR}` },
    { name: "internal daily scheduler denial", method: "POST", path: "/api/tax/scheduler/run-daily", body: { taxYear: TAX_YEAR } },
    { name: "internal weekly scheduler denial", method: "POST", path: "/api/tax/scheduler/run-weekly", body: { taxYear: TAX_YEAR } },
    { name: "internal deductions upsert denial", method: "POST", path: "/api/tax/deductions/upsert", body: { businessId, year: TAX_YEAR } },
    { name: "recalculation diagnostics", method: "GET", path: `/api/tax/recalculation/diagnostics?businessId=${biz}&year=${TAX_YEAR}` },
  ];
}

async function requestAndScan(apiBaseUrl, token, endpoint) {
  const headers = {
    Accept: "*/*",
    "Content-Type": "application/json",
    "X-Request-ID": `tax-output-safety-${Date.now()}`,
    ...(endpoint.headers || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${apiBaseUrl}${endpoint.path}`, {
    method: endpoint.method,
    headers,
    body: endpoint.body ? JSON.stringify(endpoint.body) : undefined,
  });
  const body = await response.text();
  const responseHeaders = Object.fromEntries(response.headers.entries());
  const filename = safeFilename(responseHeaders["content-disposition"]);
  const scan = scanTaxResponseSafety({
    name: endpoint.name,
    status: response.status,
    headers: responseHeaders,
    body,
    filename,
    contentType: responseHeaders["content-type"],
  });
  return {
    name: endpoint.name,
    method: endpoint.method,
    path: sanitizePath(endpoint.path),
    status: response.status,
    contentType: responseHeaders["content-type"] || null,
    filename,
    scan,
  };
}

function safeFilename(disposition) {
  if (!disposition) return null;
  return disposition.match(/filename="?([^";]+)"?/i)?.[1] || disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1] || null;
}

function sanitizePath(path) {
  return String(path).replace(/access_token=[^&]+/gi, "access_token=[redacted]");
}

async function writeOutputSafetyReport({ status, runtimeExecuted, reason, missingEnvironment, environment, staticScan, results }) {
  const report = {
    status,
    runtimeExecuted,
    generatedAt: new Date().toISOString(),
    reason,
    missingEnvironment,
    environment,
    staticScan: {
      status: staticScan.status,
      findingCount: staticScan.findings.length,
      findings: staticScan.findings.map((finding) => ({ ...finding, preview: redact(finding.preview || "") })),
    },
    runtime: {
      totalResponses: results.length,
      unsafeResponses: results.filter((item) => !item.scan.safe).length,
      results: results.map((item) => ({
        name: item.name,
        method: item.method,
        path: item.path,
        status: item.status,
        contentType: item.contentType,
        filename: item.filename,
        safe: item.scan.safe,
        findings: item.scan.findings.map((finding) => ({ ...finding, preview: redact(finding.preview || "") })),
      })),
    },
  };
  await mkdir(resolve(process.cwd(), "reports"), { recursive: true });
  await writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(REPORT_MD, renderMarkdown(report));
}

function renderMarkdown(report) {
  const lines = [
    "# Tax Sensitive Output Report",
    "",
    `Status: **${report.status}**`,
    `Runtime executed: **${report.runtimeExecuted ? "yes" : "no"}**`,
    `Generated at: ${report.generatedAt}`,
    `Target: ${report.environment.targetLabel || "unknown"}`,
    "",
    "## Static Companion Scan",
    "",
    `Status: **${report.staticScan.status}**`,
    `Findings: ${report.staticScan.findingCount}`,
  ];
  if (report.staticScan.findings.length) {
    lines.push("", "| File | Line | Severity | Category | Preview |", "| --- | ---: | --- | --- | --- |");
    for (const finding of report.staticScan.findings) {
      lines.push(`| ${finding.file} | ${finding.line} | ${finding.severity} | ${finding.category} | ${escapeMd(finding.preview)} |`);
    }
  }
  lines.push("", "## Runtime Scan", "");
  if (!report.runtimeExecuted) {
    lines.push(`Runtime scan skipped: ${report.reason}`);
    if (report.missingEnvironment?.length) lines.push(`Missing env: ${report.missingEnvironment.join(", ")}`);
  } else {
    lines.push(`Responses scanned: ${report.runtime.totalResponses}`);
    lines.push(`Unsafe responses: ${report.runtime.unsafeResponses}`);
    lines.push("", "| Endpoint | Status | Safe | Findings |", "| --- | ---: | --- | --- |");
    for (const item of report.runtime.results) {
      lines.push(`| ${escapeMd(item.name)} | ${item.status} | ${item.safe ? "yes" : "no"} | ${item.findings.length} |`);
    }
  }
  lines.push("", "Runtime safety is proven only when `Runtime executed` is `yes` and `Unsafe responses` is `0`.");
  return `${lines.join("\n")}\n`;
}

function safeEnvironment(config) {
  return {
    targetLabel: config.targetLabel || "unknown",
    apiConfigured: Boolean(config.apiBaseUrl),
    supabaseConfigured: Boolean(config.supabaseUrl),
    appearsProduction: Boolean(config.appearsProduction),
  };
}

function escapeMd(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export async function readOutputSafetyReport() {
  return JSON.parse(await readFile(REPORT_JSON, "utf8"));
}
