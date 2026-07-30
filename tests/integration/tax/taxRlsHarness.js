import { createClient } from "@supabase/supabase-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export const REPORT_JSON = resolve(process.cwd(), "reports/tax-rls-integration-report.json");
export const REPORT_MD = resolve(process.cwd(), "reports/tax-rls-integration-report.md");

const TAX_YEAR = 2026;
const SAFE_DENIED_STATUSES = new Set([401, 403, 404, 405, 410, 422]);

export const BUSINESS_SCOPED_RESOURCES = [
  { table: "tax_profiles", fixture: taxProfileFixture, mutable: false, required: true },
  { table: "tax_profile_memory", fixture: taxProfileMemoryFixture, mutable: false, required: true },
  { table: "transaction_tax_classifications", fixture: classificationFixture, mutable: false, required: true },
  { table: "tax_classification_overrides", fixture: overrideFixture, mutable: false, required: true },
  { table: "tax_adjustments", fixture: taxAdjustmentFixture, mutable: false, required: false },
  { table: "tax_calculation_runs", fixture: calculationRunFixture, mutable: false, required: true },
  { table: "tax_calculation_components", fixture: calculationComponentFixture, mutable: false, required: true },
  { table: "tax_payments", fixture: taxPaymentFixture, mutable: false, required: true },
  { table: "tax_reserve_accounts", fixture: reserveAccountFixture, mutable: false, required: true },
  { table: "tax_reserve_snapshots", fixture: reserveSnapshotFixture, mutable: false, required: true },
  { table: "tax_review_tasks", fixture: reviewTaskFixture, mutable: false, required: true },
  { table: "tax_projection_scenarios", fixture: projectionScenarioFixture, mutable: false, required: false },
  { table: "tax_recalculation_requests", fixture: recalculationRequestFixture, mutable: false, required: false },
  { table: "tax_snapshots", fixture: taxSnapshotFixture, mutable: false, required: true },
  { table: "insights", fixture: insightFixture, mutable: false, required: false },
  { table: "bank_transactions", fixture: bankTransactionFixture, mutable: false, required: false },
  { table: "transaction_categorizations", fixture: categorizationFixture, mutable: false, required: false },
  { table: "qbo_posted_transactions", fixture: qboPostedTransactionFixture, mutable: false, required: false },
];

export const INTERNAL_ONLY_RESOURCES = [
  { table: "tax_scheduler_runs", fixture: schedulerRunFixture },
];

export const RULE_TABLES = [
  "tax_rule_configs",
  "state_tax_rule_configs",
  "tax_deduction_rules",
  "tax_deadlines",
];

export function getTaxRlsIntegrationConfig(env = process.env) {
  const required = [
    "TEST_SUPABASE_URL",
    "TEST_SUPABASE_ANON_KEY",
    "TEST_SUPABASE_SERVICE_ROLE_KEY",
    "TEST_API_BASE_URL",
  ];
  const missing = required.filter((key) => !env[key]);
  const enabled = env.TAX_RLS_INTEGRATION_ENABLED === "true";
  const targetLabel = env.TAX_RLS_TARGET_ENV || env.TEST_ENVIRONMENT || "test";
  const url = env.TEST_SUPABASE_URL || "";
  const apiBaseUrl = env.TEST_API_BASE_URL || "";
  const appearsProduction = looksProductionLike(url) || looksProductionLike(apiBaseUrl) || targetLabel === "production";
  const productionOverride = env.TAX_RLS_ALLOW_PRODUCTION_DESTRUCTIVE_TESTS === "true";

  if (!enabled) {
    return { enabled: false, runnable: false, reason: "TAX_RLS_INTEGRATION_ENABLED is not true.", missing, appearsProduction };
  }
  if (missing.length) {
    return { enabled: true, runnable: false, reason: `Missing required environment variables: ${missing.join(", ")}.`, missing, appearsProduction };
  }
  if (appearsProduction && !productionOverride) {
    return {
      enabled: true,
      runnable: false,
      reason: "Target appears production-like. Set TAX_RLS_ALLOW_PRODUCTION_DESTRUCTIVE_TESTS=true only for an isolated non-customer environment.",
      missing,
      appearsProduction,
    };
  }

  return {
    enabled: true,
    runnable: true,
    reason: "configured",
    missing,
    appearsProduction,
    supabaseUrl: env.TEST_SUPABASE_URL,
    anonKey: env.TEST_SUPABASE_ANON_KEY,
    serviceRoleKey: env.TEST_SUPABASE_SERVICE_ROLE_KEY,
    apiBaseUrl: env.TEST_API_BASE_URL.replace(/\/+$/, ""),
    targetLabel,
  };
}

export function looksProductionLike(value = "") {
  const lowered = String(value).toLowerCase();
  return /\b(prod|production)\b/.test(lowered) || lowered.includes("bizzi.app") || lowered.includes("app.bizzi");
}

export async function writeSkippedTaxRlsReport(section, config) {
  const report = await readReport();
  if (!report.realSessionExecuted) {
    report.sections = Object.fromEntries(
      Object.entries(report.sections || {}).filter(([key]) => key === "direct_supabase" || key === "http_tenancy")
    );
  }
  report.status = "skipped";
  report.realSessionExecuted = false;
  report.generatedAt = new Date().toISOString();
  report.environment = safeEnvironmentSummary(config);
  report.sections[section] = {
    status: "skipped",
    reason: config.reason,
    missingEnvironment: config.missing || [],
  };
  await writeReport(report);
}

export async function createTaxRlsFixtureContext(config) {
  const testId = `tax-rls-it-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const password = `T!${randomUUID()}a9`;
  const service = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = () => createClient(config.supabaseUrl, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const userAEmail = `${testId}-a@example.test`;
  const userBEmail = `${testId}-b@example.test`;
  const userA = await createTestUser(service, userAEmail, password, testId);
  const userB = await createTestUser(service, userBEmail, password, testId);
  const clientA = anon();
  const clientB = anon();
  const { data: sessionA, error: signInAError } = await clientA.auth.signInWithPassword({ email: userAEmail, password });
  if (signInAError) throw signInAError;
  const { data: sessionB, error: signInBError } = await clientB.auth.signInWithPassword({ email: userBEmail, password });
  if (signInBError) throw signInBError;

  const businessA = randomUUID();
  const businessB = randomUUID();
  const runA = randomUUID();
  const runB = randomUUID();
  const transactionA = randomUUID();
  const transactionB = randomUUID();
  const paymentA = randomUUID();
  const paymentB = randomUUID();
  const reserveA = randomUUID();
  const reserveB = randomUUID();

  const ids = { businessA, businessB, runA, runB, transactionA, transactionB, paymentA, paymentB, reserveA, reserveB };
  const resources = [];

  await insertRequired(service, "business_profiles", [
    businessProfileFixture({ id: businessA, userId: userA.user.id, testId, name: "Tax RLS Business A" }),
    businessProfileFixture({ id: businessB, userId: userB.user.id, testId, name: "Tax RLS Business B" }),
  ]);

  for (const resource of [...BUSINESS_SCOPED_RESOURCES, ...INTERNAL_ONLY_RESOURCES]) {
    const rows = [
      resource.fixture({ side: "A", testId, ids, businessId: businessA, userId: userA.user.id }),
      resource.fixture({ side: "B", testId, ids, businessId: businessB, userId: userB.user.id }),
    ].filter(Boolean);
    const setup = await tryInsert(service, resource.table, rows);
    resources.push({ ...resource, setup, ids: rows.map((row) => row.id).filter(Boolean) });
  }

  return {
    config,
    testId,
    service,
    clientA,
    clientB,
    anonymous: anon(),
    users: { A: userA.user, B: userB.user },
    sessions: { A: sessionA.session, B: sessionB.session },
    ids,
    resources,
    async cleanup() {
      await cleanupFixtures({ service, testId, ids, users: [userA.user, userB.user] });
    },
  };
}

export async function runDirectSupabaseRlsChecks(ctx) {
  const results = [];
  const userPairs = [
    { label: "User A", client: ctx.clientA, ownBusinessId: ctx.ids.businessA, foreignBusinessId: ctx.ids.businessB, ownRunId: ctx.ids.runA, foreignRunId: ctx.ids.runB },
    { label: "User B", client: ctx.clientB, ownBusinessId: ctx.ids.businessB, foreignBusinessId: ctx.ids.businessA, ownRunId: ctx.ids.runB, foreignRunId: ctx.ids.runA },
  ];

  for (const resource of ctx.resources.filter((item) => BUSINESS_SCOPED_RESOURCES.some((r) => r.table === item.table))) {
    for (const pair of userPairs) {
      if (!resource.setup.ok) {
        results.push(result(resource.table, pair.label, "setup", resource.required ? "fail" : "skip", resource.setup.message));
        continue;
      }
      results.push(await ownRead(pair.client, resource.table, pair.ownBusinessId, pair.label));
      results.push(await foreignRead(pair.client, resource.table, pair.foreignBusinessId, pair.label));
      results.push(await foreignInsert(pair.client, resource, pair.foreignBusinessId, pair.label, ctx));
      results.push(await foreignUpdate(pair.client, resource.table, pair.foreignBusinessId, pair.label));
      results.push(await foreignDelete(pair.client, resource.table, pair.foreignBusinessId, pair.label));
    }
  }

  for (const pair of userPairs) {
    results.push(await businessProfileOwnRead(pair.client, pair.ownBusinessId, pair.label));
    results.push(await businessProfileForeignRead(pair.client, pair.foreignBusinessId, pair.label));
    results.push(await businessProfileForeignInsert(pair.client, pair.foreignBusinessId, pair.label, ctx));
    results.push(await businessProfileForeignUpdate(pair.client, pair.foreignBusinessId, pair.label));
    results.push(await businessProfileForeignDelete(pair.client, pair.foreignBusinessId, pair.label));
  }

  for (const resource of ctx.resources.filter((item) => INTERNAL_ONLY_RESOURCES.some((r) => r.table === item.table))) {
    for (const pair of userPairs) {
      if (!resource.setup.ok) {
        results.push(result(resource.table, pair.label, "setup", "skip", resource.setup.message));
        continue;
      }
      results.push(await foreignRead(pair.client, resource.table, pair.foreignBusinessId, pair.label, { expectedZeroForOwnToo: true }));
      results.push(await ownRead(pair.client, resource.table, pair.ownBusinessId, pair.label, { internalOnly: true }));
    }
  }

  for (const pair of userPairs) {
    results.push(await anonymousDenied(ctx.anonymous, "tax_profiles"));
    results.push(await immutableMutationDenied(pair.client, "tax_calculation_runs", pair.ownBusinessId, pair.label));
    results.push(await immutableMutationDenied(pair.client, "tax_calculation_components", pair.ownBusinessId, pair.label));
    results.push(await immutableMutationDenied(pair.client, "tax_classification_overrides", pair.ownBusinessId, pair.label));
    results.push(await immutableMutationDenied(pair.client, "tax_reserve_snapshots", pair.ownBusinessId, pair.label));
  }

  for (const table of RULE_TABLES) {
    for (const pair of userPairs) {
      results.push(await ruleTableReadAllowedOrEmpty(pair.client, table, pair.label));
      results.push(await ruleTableWriteDenied(pair.client, table, pair.label));
    }
  }

  return finalizeSection("direct_supabase", results, ctx.config);
}

export async function runHttpTenancyChecks(ctx) {
  const results = [];
  const tokenA = ctx.sessions.A?.access_token;
  const tokenB = ctx.sessions.B?.access_token;
  const userPairs = [
    { label: "User A", token: tokenA, ownBusinessId: ctx.ids.businessA, foreignBusinessId: ctx.ids.businessB, foreignRunId: ctx.ids.runB, foreignTransactionId: ctx.ids.transactionB, foreignPaymentId: ctx.ids.paymentB, foreignReserveId: ctx.ids.reserveB },
    { label: "User B", token: tokenB, ownBusinessId: ctx.ids.businessB, foreignBusinessId: ctx.ids.businessA, foreignRunId: ctx.ids.runA, foreignTransactionId: ctx.ids.transactionA, foreignPaymentId: ctx.ids.paymentA, foreignReserveId: ctx.ids.reserveA },
  ];

  for (const pair of userPairs) {
    const foreign = encodeURIComponent(pair.foreignBusinessId);
    const own = encodeURIComponent(pair.ownBusinessId);
    const routes = [
      { name: "overview foreign business", method: "GET", path: `/api/tax/overview?businessId=${foreign}&year=${TAX_YEAR}` },
      { name: "profile foreign business", method: "GET", path: `/api/tax/profile?businessId=${foreign}&year=${TAX_YEAR}` },
      { name: "profile patch foreign business", method: "PATCH", path: `/api/tax/profile?businessId=${foreign}`, body: { businessId: pair.foreignBusinessId, taxYear: TAX_YEAR, filingStatus: "single" } },
      { name: "deductions overview foreign business", method: "GET", path: `/api/tax/deductions/overview?businessId=${foreign}&year=${TAX_YEAR}` },
      { name: "deduction transactions foreign business", method: "GET", path: `/api/tax/deductions/transactions?businessId=${foreign}&year=${TAX_YEAR}` },
      { name: "deduction transaction idor", method: "GET", path: `/api/tax/deductions/transactions/${encodeURIComponent(pair.foreignTransactionId)}?businessId=${own}&year=${TAX_YEAR}` },
      { name: "classification detail idor", method: "GET", path: `/api/tax/classifications/${encodeURIComponent(pair.foreignTransactionId)}?businessId=${own}&year=${TAX_YEAR}` },
      { name: "classification confirm idor", method: "POST", path: `/api/tax/classifications/${encodeURIComponent(pair.foreignTransactionId)}/confirm`, body: { businessId: pair.ownBusinessId, taxYear: TAX_YEAR } },
      { name: "classification override idor", method: "PATCH", path: `/api/tax/classifications/${encodeURIComponent(pair.foreignTransactionId)}`, body: { businessId: pair.ownBusinessId, taxYear: TAX_YEAR, reason: "rls integration idor" } },
      { name: "calculation run idor", method: "GET", path: `/api/tax/calculations/${encodeURIComponent(pair.foreignRunId)}?businessId=${own}` },
      { name: "components idor", method: "GET", path: `/api/tax/calculations/${encodeURIComponent(pair.foreignRunId)}/components?businessId=${own}` },
      { name: "explanation idor", method: "GET", path: `/api/tax/calculations/${encodeURIComponent(pair.foreignRunId)}/explanation?businessId=${own}` },
      { name: "confidence idor", method: "GET", path: `/api/tax/calculations/${encodeURIComponent(pair.foreignRunId)}/confidence?businessId=${own}` },
      { name: "payment list foreign business", method: "GET", path: `/api/tax/payments?businessId=${foreign}&year=${TAX_YEAR}` },
      { name: "payment update idor", method: "PATCH", path: `/api/tax/payments/${encodeURIComponent(pair.foreignPaymentId)}`, body: { businessId: pair.ownBusinessId, amount: 20 } },
      { name: "reserve list foreign business", method: "GET", path: `/api/tax/reserve/accounts?businessId=${foreign}` },
      { name: "reserve update idor", method: "PATCH", path: `/api/tax/reserve/accounts/${encodeURIComponent(pair.foreignReserveId)}`, body: { businessId: pair.ownBusinessId, label: "IDOR" } },
      { name: "deductions export foreign business", method: "GET", path: `/api/tax/deductions/export?businessId=${foreign}&year=${TAX_YEAR}&format=summary_csv` },
      { name: "legacy history foreign business", method: "GET", path: `/api/tax/legacy/snapshots?businessId=${foreign}&year=${TAX_YEAR}` },
      { name: "seed deadlines foreign business", method: "POST", path: `/api/tax/seed-deadlines/run`, body: { businessId: pair.foreignBusinessId, year: TAX_YEAR } },
    ];

    for (const route of routes) {
      results.push(await httpDenied(ctx.config.apiBaseUrl, pair.token, pair.label, route));
    }

    for (const internalRoute of [
      { name: "daily scheduler ordinary user denied", method: "POST", path: "/api/tax/scheduler/run-daily", body: { taxYear: TAX_YEAR } },
      { name: "weekly scheduler ordinary user denied", method: "POST", path: "/api/tax/scheduler/run-weekly", body: { taxYear: TAX_YEAR } },
      { name: "recalculation diagnostics ordinary user denied", method: "GET", path: `/api/tax/recalculation/diagnostics?businessId=${own}&year=${TAX_YEAR}` },
      { name: "deductions upsert ordinary user denied", method: "POST", path: "/api/tax/deductions/upsert", body: { businessId: pair.ownBusinessId, year: TAX_YEAR } },
    ]) {
      results.push(await httpDenied(ctx.config.apiBaseUrl, pair.token, pair.label, internalRoute));
    }
  }

  results.push(await httpAnonymousDenied(ctx.config.apiBaseUrl, "/api/tax/overview?businessId=00000000-0000-4000-8000-000000000000&year=2026"));
  results.push(await httpAnonymousDenied(ctx.config.apiBaseUrl, "/api/tax/deductions/export?businessId=00000000-0000-4000-8000-000000000000&year=2026&format=summary_csv"));
  return finalizeSection("http_tenancy", results, ctx.config);
}

async function createTestUser(service, email, password, testId) {
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { taxRlsIntegrationTestId: testId },
  });
  if (error) throw error;
  return data;
}

async function cleanupFixtures({ service, testId, ids, users }) {
  const businessIds = [ids.businessA, ids.businessB].filter(Boolean);
  const tables = [
    "tax_calculation_components",
    "tax_calculation_runs",
    "tax_classification_overrides",
    "transaction_tax_classifications",
    "tax_profile_memory",
    "tax_profiles",
    "tax_adjustments",
    "tax_payments",
    "tax_reserve_snapshots",
    "tax_reserve_accounts",
    "tax_review_tasks",
    "tax_projection_scenarios",
    "tax_recalculation_requests",
    "tax_scheduler_runs",
    "tax_snapshots",
    "insights",
    "bank_transactions",
    "transaction_categorizations",
    "qbo_posted_transactions",
    "business_profiles",
  ];
  for (const table of tables) {
    try {
      let query = service.from(table).delete();
      if (table === "business_profiles") query = query.in("id", businessIds);
      else query = query.in("business_id", businessIds);
      await query;
    } catch {
      // Cleanup is best-effort and scoped to synthetic IDs only.
    }
  }
  for (const user of users) {
    if (!user?.id) continue;
    try {
      await service.auth.admin.deleteUser(user.id);
    } catch {
      // Best-effort. Test users are uniquely tagged by email and metadata.
    }
  }
}

async function insertRequired(service, table, rows) {
  const inserted = await tryInsert(service, table, rows);
  if (!inserted.ok) throw new Error(`Could not create required ${table} fixtures: ${inserted.message}`);
}

async function tryInsert(service, table, rows) {
  let candidateRows = rows;
  const strippedColumns = [];
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { error } = await service.from(table).insert(candidateRows);
      if (!error) {
        return strippedColumns.length
          ? { ok: true, message: `inserted after stripping unsupported columns: ${strippedColumns.join(", ")}` }
          : { ok: true };
      }
      const unknownColumn = extractUnknownColumn(error);
      if (!unknownColumn || !candidateRows.some((row) => Object.hasOwn(row, unknownColumn))) {
        return { ok: false, message: safeErrorMessage(error), code: error.code };
      }
      strippedColumns.push(unknownColumn);
      candidateRows = candidateRows.map((row) => {
        const next = { ...row };
        delete next[unknownColumn];
        return next;
      });
    }
    return { ok: false, message: "Too many unsupported fixture columns.", code: "fixture_shape_mismatch" };
  } catch (err) {
    return { ok: false, message: safeErrorMessage(err), code: err?.code };
  }
}

function extractUnknownColumn(error) {
  const message = `${error?.message || ""} ${error?.details || ""}`;
  return (
    message.match(/'([^']+)' column/)?.[1] ||
    message.match(/column "([^"]+)" of relation/)?.[1] ||
    null
  );
}

async function ownRead(client, table, businessId, userLabel, options = {}) {
  try {
    const { data, error } = await client.from(table).select("id,business_id").eq("business_id", businessId).limit(5);
    if (error) return result(table, userLabel, "own_read", options.internalOnly ? "pass" : "fail", safeErrorMessage(error));
    if (options.internalOnly) {
      return result(table, userLabel, "own_read_internal_only", data.length === 0 ? "pass" : "fail", `returned ${data.length} rows`);
    }
    return result(table, userLabel, "own_read", data.length > 0 ? "pass" : "fail", `returned ${data.length} rows`);
  } catch (err) {
    return result(table, userLabel, "own_read", options.internalOnly ? "pass" : "fail", safeErrorMessage(err));
  }
}

async function foreignRead(client, table, foreignBusinessId, userLabel) {
  try {
    const { data, error } = await client.from(table).select("id,business_id").eq("business_id", foreignBusinessId).limit(5);
    if (error) return result(table, userLabel, "foreign_read", "pass", safeErrorMessage(error));
    return result(table, userLabel, "foreign_read", data.length === 0 ? "pass" : "fail", `returned ${data.length} foreign rows`);
  } catch (err) {
    return result(table, userLabel, "foreign_read", "pass", safeErrorMessage(err));
  }
}

async function businessProfileOwnRead(client, businessId, userLabel) {
  try {
    const { data, error } = await client.from("business_profiles").select("id,user_id").eq("id", businessId).limit(5);
    if (error) return result("business_profiles", userLabel, "own_read", "fail", safeErrorMessage(error));
    return result("business_profiles", userLabel, "own_read", data.length > 0 ? "pass" : "fail", `returned ${data.length} rows`);
  } catch (err) {
    return result("business_profiles", userLabel, "own_read", "fail", safeErrorMessage(err));
  }
}

async function businessProfileForeignRead(client, foreignBusinessId, userLabel) {
  try {
    const { data, error } = await client.from("business_profiles").select("id,user_id").eq("id", foreignBusinessId).limit(5);
    if (error) return result("business_profiles", userLabel, "foreign_read", "pass", safeErrorMessage(error));
    return result("business_profiles", userLabel, "foreign_read", data.length === 0 ? "pass" : "fail", `returned ${data.length} foreign rows`);
  } catch (err) {
    return result("business_profiles", userLabel, "foreign_read", "pass", safeErrorMessage(err));
  }
}

async function businessProfileForeignInsert(client, foreignBusinessId, userLabel, ctx) {
  try {
    const id = randomUUID();
    const foreignUserId = userLabel === "User A" ? ctx.users.B.id : ctx.users.A.id;
    const { data, error } = await client
      .from("business_profiles")
      .insert(businessProfileFixture({ id, userId: foreignUserId, testId: ctx.testId, name: "Tax RLS forbidden insert" }))
      .select("id");
    if (error) return result("business_profiles", userLabel, "foreign_insert", "pass", safeErrorMessage(error));
    if (Array.isArray(data) && data.length > 0) {
      try {
        await ctx.service.from("business_profiles").delete().eq("id", id);
      } catch {
        // Scoped best-effort cleanup for the synthetic forbidden insert.
      }
    }
    return result("business_profiles", userLabel, "foreign_insert", Array.isArray(data) && data.length === 0 ? "pass" : "fail", "foreign business profile insert succeeded");
  } catch (err) {
    return result("business_profiles", userLabel, "foreign_insert", "pass", safeErrorMessage(err));
  }
}

async function businessProfileForeignUpdate(client, foreignBusinessId, userLabel) {
  try {
    const { data, error } = await client
      .from("business_profiles")
      .update({ business_name: "Tax RLS forbidden update" })
      .eq("id", foreignBusinessId)
      .select("id");
    if (error) return result("business_profiles", userLabel, "foreign_update", "pass", safeErrorMessage(error));
    return result("business_profiles", userLabel, "foreign_update", Array.isArray(data) && data.length === 0 ? "pass" : "fail", `updated ${data?.length ?? "unknown"} rows`);
  } catch (err) {
    return result("business_profiles", userLabel, "foreign_update", "pass", safeErrorMessage(err));
  }
}

async function businessProfileForeignDelete(client, foreignBusinessId, userLabel) {
  try {
    const { data, error } = await client.from("business_profiles").delete().eq("id", foreignBusinessId).select("id");
    if (error) return result("business_profiles", userLabel, "foreign_delete", "pass", safeErrorMessage(error));
    return result("business_profiles", userLabel, "foreign_delete", Array.isArray(data) && data.length === 0 ? "pass" : "fail", `deleted ${data?.length ?? "unknown"} rows`);
  } catch (err) {
    return result("business_profiles", userLabel, "foreign_delete", "pass", safeErrorMessage(err));
  }
}

async function foreignInsert(client, resource, foreignBusinessId, userLabel, ctx) {
  const row = resource.fixture({
    side: `${userLabel}-foreign-insert`,
    testId: ctx.testId,
    ids: ctx.ids,
    businessId: foreignBusinessId,
    userId: userLabel === "User A" ? ctx.users.B.id : ctx.users.A.id,
    id: randomUUID(),
  });
  try {
    const { data, error } = await client.from(resource.table).insert(row).select("id").maybeSingle();
    if (error) return result(resource.table, userLabel, "foreign_insert", "pass", safeErrorMessage(error));
    return result(resource.table, userLabel, "foreign_insert", data ? "fail" : "pass", data ? "foreign insert succeeded" : "insert returned no row");
  } catch (err) {
    return result(resource.table, userLabel, "foreign_insert", "pass", safeErrorMessage(err));
  }
}

async function foreignUpdate(client, table, foreignBusinessId, userLabel) {
  try {
    const { data, error } = await client.from(table).update({ metadata: { rlsAttempt: true } }).eq("business_id", foreignBusinessId).select("id");
    if (error) return result(table, userLabel, "foreign_update", "pass", safeErrorMessage(error));
    return result(table, userLabel, "foreign_update", Array.isArray(data) && data.length === 0 ? "pass" : "fail", `updated ${data?.length ?? "unknown"} rows`);
  } catch (err) {
    return result(table, userLabel, "foreign_update", "pass", safeErrorMessage(err));
  }
}

async function foreignDelete(client, table, foreignBusinessId, userLabel) {
  try {
    const { data, error } = await client.from(table).delete().eq("business_id", foreignBusinessId).select("id");
    if (error) return result(table, userLabel, "foreign_delete", "pass", safeErrorMessage(error));
    return result(table, userLabel, "foreign_delete", Array.isArray(data) && data.length === 0 ? "pass" : "fail", `deleted ${data?.length ?? "unknown"} rows`);
  } catch (err) {
    return result(table, userLabel, "foreign_delete", "pass", safeErrorMessage(err));
  }
}

async function immutableMutationDenied(client, table, businessId, userLabel) {
  try {
    const { data, error } = await client.from(table).update({ metadata: { immutableMutationAttempt: true } }).eq("business_id", businessId).select("id");
    if (error) return result(table, userLabel, "own_immutable_update", "pass", safeErrorMessage(error));
    return result(table, userLabel, "own_immutable_update", Array.isArray(data) && data.length === 0 ? "pass" : "fail", `updated ${data?.length ?? "unknown"} rows`);
  } catch (err) {
    return result(table, userLabel, "own_immutable_update", "pass", safeErrorMessage(err));
  }
}

async function anonymousDenied(client, table) {
  try {
    const { data, error } = await client.from(table).select("id").limit(1);
    if (error) return result(table, "anonymous", "read", "pass", safeErrorMessage(error));
    return result(table, "anonymous", "read", data.length === 0 ? "pass" : "fail", `returned ${data.length} rows`);
  } catch (err) {
    return result(table, "anonymous", "read", "pass", safeErrorMessage(err));
  }
}

async function ruleTableReadAllowedOrEmpty(client, table, userLabel) {
  try {
    const { error } = await client.from(table).select("id").limit(1);
    return result(table, userLabel, "rule_read", error ? "skip" : "pass", error ? safeErrorMessage(error) : "read allowed or empty");
  } catch (err) {
    return result(table, userLabel, "rule_read", "skip", safeErrorMessage(err));
  }
}

async function ruleTableWriteDenied(client, table, userLabel) {
  try {
    const { data, error } = await client.from(table).insert({ id: randomUUID(), tax_year: TAX_YEAR }).select("id");
    if (error) return result(table, userLabel, "rule_write_denied", "pass", safeErrorMessage(error));
    return result(table, userLabel, "rule_write_denied", Array.isArray(data) && data.length === 0 ? "pass" : "fail", "rule write succeeded");
  } catch (err) {
    return result(table, userLabel, "rule_write_denied", "pass", safeErrorMessage(err));
  }
}

async function httpDenied(apiBaseUrl, token, userLabel, route) {
  try {
    const response = await fetch(`${apiBaseUrl}${route.path}`, {
      method: route.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Request-ID": `tax-rls-${randomUUID()}`,
      },
      body: route.body ? JSON.stringify(route.body) : undefined,
    });
    const text = await response.text();
    const leaksBusinessB = /Tax RLS Business B|Tax RLS Business A/.test(text) && response.ok;
    const ok = SAFE_DENIED_STATUSES.has(response.status) && !leaksBusinessB;
    return result("http", userLabel, route.name, ok ? "pass" : "fail", `status ${response.status}`);
  } catch (err) {
    return result("http", userLabel, route.name, "fail", safeErrorMessage(err));
  }
}

async function httpAnonymousDenied(apiBaseUrl, path) {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`);
    return result("http", "anonymous", path, SAFE_DENIED_STATUSES.has(response.status) ? "pass" : "fail", `status ${response.status}`);
  } catch (err) {
    return result("http", "anonymous", path, "fail", safeErrorMessage(err));
  }
}

async function finalizeSection(section, results, config) {
  const failures = results.filter((item) => item.status === "fail");
  const report = await readReport();
  report.status = failures.length ? "fail" : "pass";
  report.realSessionExecuted = true;
  report.generatedAt = new Date().toISOString();
  report.environment = safeEnvironmentSummary(config);
  report.sections[section] = {
    status: failures.length ? "fail" : "pass",
    totals: {
      pass: results.filter((item) => item.status === "pass").length,
      fail: failures.length,
      skip: results.filter((item) => item.status === "skip").length,
    },
    results,
  };
  await writeReport(report);
  return { section, results, failures };
}

async function readReport() {
  try {
    return JSON.parse(await readFile(REPORT_JSON, "utf8"));
  } catch {
    return {
      status: "pending",
      realSessionExecuted: false,
      generatedAt: null,
      environment: {},
      sections: {},
    };
  }
}

async function writeReport(report) {
  await mkdir(resolve(process.cwd(), "reports"), { recursive: true });
  await writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(REPORT_MD, renderMarkdownReport(report));
}

function renderMarkdownReport(report) {
  const lines = [
    "# Tax RLS Integration Report",
    "",
    `Status: **${report.status}**`,
    `Real session executed: **${report.realSessionExecuted ? "yes" : "no"}**`,
    `Generated at: ${report.generatedAt || "not generated"}`,
    `Target: ${report.environment?.targetLabel || "unknown"}`,
    "",
  ];
  for (const [section, data] of Object.entries(report.sections || {})) {
    lines.push(`## ${section}`);
    lines.push("");
    lines.push(`Status: **${data.status}**`);
    if (data.reason) lines.push(`Reason: ${data.reason}`);
    if (data.missingEnvironment?.length) lines.push(`Missing env: ${data.missingEnvironment.join(", ")}`);
    if (data.totals) lines.push(`Totals: ${data.totals.pass} pass, ${data.totals.fail} fail, ${data.totals.skip} skip`);
    if (Array.isArray(data.results)) {
      lines.push("");
      lines.push("| Resource | Actor | Operation | Status | Detail |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const item of data.results) {
        lines.push(`| ${item.resource} | ${item.actor} | ${item.operation} | ${item.status} | ${escapeMd(item.detail || "")} |`);
      }
    }
    lines.push("");
  }
  lines.push("This report proves runtime RLS/tenancy only when `realSessionExecuted` is `yes`.");
  return `${lines.join("\n")}\n`;
}

function result(resource, actor, operation, status, detail) {
  return { resource, actor, operation, status, detail: String(detail || "") };
}

function safeEnvironmentSummary(config) {
  return {
    targetLabel: config.targetLabel || "unknown",
    supabaseConfigured: Boolean(config.supabaseUrl),
    apiConfigured: Boolean(config.apiBaseUrl),
    appearsProduction: Boolean(config.appearsProduction),
  };
}

function safeErrorMessage(error) {
  const message = error?.message || error?.error_description || String(error || "unknown error");
  return message.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]").slice(0, 240);
}

function escapeMd(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function businessProfileFixture({ id, userId, testId, name }) {
  return {
    id,
    user_id: userId,
    business_name: name,
    metadata: { taxRlsIntegrationTestId: testId },
  };
}

function taxProfileFixture({ businessId, testId, id = randomUUID() }) {
  return {
    id,
    business_id: businessId,
    tax_year: TAX_YEAR,
    entity_type: "sole_proprietor",
    filing_status: "single",
    primary_tax_state: "NC",
    profile_status: "active",
    source: "tax_rls_integration",
    metadata: { taxRlsIntegrationTestId: testId },
  };
}

function taxProfileMemoryFixture({ businessId, testId, id = randomUUID() }) {
  return {
    id,
    business_id: businessId,
    tax_year: TAX_YEAR,
    memory_key: "vehicle_deduction_method",
    value_json: { value: "undecided" },
    source: "tax_rls_integration",
    effective_from: `${TAX_YEAR}-01-01`,
    metadata: { taxRlsIntegrationTestId: testId },
  };
}

function classificationFixture({ businessId, testId, ids, side, id = randomUUID() }) {
  return {
    id,
    business_id: businessId,
    tax_year: TAX_YEAR,
    transaction_id: side === "A" ? ids.transactionA : ids.transactionB,
    tax_category: "office_expense",
    tax_treatment: "deductible",
    deductible_percentage: 1,
    deductible_amount: 10,
    amount: 10,
    status: "auto_classified",
    confidence_level: "medium",
    source: "tax_rls_integration",
    metadata: { taxRlsIntegrationTestId: testId },
  };
}

function overrideFixture({ businessId, testId, ids, side, id = randomUUID() }) {
  return {
    id,
    business_id: businessId,
    tax_year: TAX_YEAR,
    transaction_id: side === "A" ? ids.transactionA : ids.transactionB,
    action: "confirm",
    before_json: { taxTreatment: "deductible" },
    after_json: { taxTreatment: "deductible" },
    reason: "RLS integration fixture",
    source: "tax_rls_integration",
    metadata: { taxRlsIntegrationTestId: testId },
  };
}

function taxAdjustmentFixture({ businessId, testId, id = randomUUID() }) {
  return {
    id,
    business_id: businessId,
    tax_year: TAX_YEAR,
    adjustment_type: "other",
    amount: 0,
    description: "RLS integration fixture",
    metadata: { taxRlsIntegrationTestId: testId },
  };
}

function calculationRunFixture({ businessId, testId, ids, side, id = null }) {
  return {
    id: id || (side === "A" ? ids.runA : ids.runB),
    business_id: businessId,
    tax_year: TAX_YEAR,
    status: "completed",
    completion_type: "test_fixture",
    calculation_fingerprint: `tax-rls-${side}`,
    estimated_total_tax: 100,
    payments_ytd: 10,
    remaining_projected_liability: 90,
    warnings: [],
    assumptions: [],
    source_freshness: {},
    canonical_result: { meta: { source: "tax_rls_integration" } },
    metadata: { taxRlsIntegrationTestId: testId },
    completed_at: new Date().toISOString(),
  };
}

function calculationComponentFixture({ businessId, testId, ids, side, id = randomUUID() }) {
  return {
    id,
    business_id: businessId,
    run_id: side === "A" ? ids.runA : ids.runB,
    component_key: "federal_income_tax",
    component_type: "tax",
    component_name: "Federal income tax",
    amount: 100,
    direction: "tax",
    explanation: "RLS integration fixture",
    source_refs: [],
    metadata: { taxRlsIntegrationTestId: testId },
  };
}

function taxPaymentFixture({ businessId, testId, ids, side, id = null }) {
  return {
    id: id || (side === "A" ? ids.paymentA : ids.paymentB),
    business_id: businessId,
    tax_year: TAX_YEAR,
    jurisdiction: "federal",
    payment_type: "estimated_payment",
    payment_date: `${TAX_YEAR}-04-15`,
    amount: 10,
    source: "manual",
    status: "active",
    idempotency_key: `tax-rls-${side}`,
    payment_fingerprint: `tax-rls-${side}`,
    metadata: { taxRlsIntegrationTestId: testId },
  };
}

function reserveAccountFixture({ businessId, testId, ids, side, id = null }) {
  return {
    id: id || (side === "A" ? ids.reserveA : ids.reserveB),
    business_id: businessId,
    account_name: `Tax reserve ${side}`,
    account_type: "manual",
    source: "manual",
    manual_balance: 50,
    is_primary: true,
    status: "active",
    metadata: { taxRlsIntegrationTestId: testId },
  };
}

function reserveSnapshotFixture({ businessId, testId, ids, side, id = randomUUID() }) {
  return {
    id,
    business_id: businessId,
    tax_year: TAX_YEAR,
    reserve_account_id: side === "A" ? ids.reserveA : ids.reserveB,
    current_reserve: 50,
    recommended_reserve: 100,
    reserve_gap: 50,
    source: "tax_rls_integration",
    metadata: { taxRlsIntegrationTestId: testId },
  };
}

function reviewTaskFixture({ businessId, testId, ids, side, id = randomUUID() }) {
  return {
    id,
    business_id: businessId,
    tax_year: TAX_YEAR,
    transaction_id: side === "A" ? ids.transactionA : ids.transactionB,
    dedupe_key: `tax-rls-${side}`,
    status: "open",
    severity: "low",
    reason: "RLS integration fixture",
    metadata: { taxRlsIntegrationTestId: testId },
  };
}

function projectionScenarioFixture({ businessId, testId, id = randomUUID() }) {
  return {
    id,
    business_id: businessId,
    tax_year: TAX_YEAR,
    scenario_name: "RLS integration",
    scenario_type: "base",
    metadata: { taxRlsIntegrationTestId: testId },
  };
}

function recalculationRequestFixture({ businessId, testId, id = randomUUID() }) {
  return {
    id,
    business_id: businessId,
    tax_year: TAX_YEAR,
    event_type: "manual_tax_recalculation_requested",
    trigger_source: "tax_rls_integration",
    priority: "low",
    status: "pending",
    event_id: `tax-rls-${id}`,
    first_event_at: new Date().toISOString(),
    last_event_at: new Date().toISOString(),
    process_after: new Date().toISOString(),
    metadata: { taxRlsIntegrationTestId: testId },
  };
}

function taxSnapshotFixture({ businessId, testId, id = randomUUID() }) {
  return {
    id,
    business_id: businessId,
    tax_year: TAX_YEAR,
    month: 1,
    payload: { source: "tax_rls_integration" },
    metadata: { taxRlsIntegrationTestId: testId },
  };
}

function insightFixture({ businessId, userId, testId, id = randomUUID() }) {
  return {
    id,
    business_id: businessId,
    user_id: userId,
    module: "tax",
    category: "tax_profile_incomplete",
    title: "Tax RLS integration fixture",
    message: "Synthetic tax insight.",
    severity: "low",
    status: "active",
    metadata: { taxRlsIntegrationTestId: testId },
  };
}

function bankTransactionFixture({ businessId, testId, ids, side, id = randomUUID() }) {
  return {
    id,
    business_id: businessId,
    transaction_id: side === "A" ? ids.transactionA : ids.transactionB,
    amount: 10,
    date: `${TAX_YEAR}-01-15`,
    name: "Tax RLS integration fixture",
    metadata: { taxRlsIntegrationTestId: testId },
  };
}

function categorizationFixture({ businessId, testId, ids, side, id = randomUUID() }) {
  return {
    id,
    business_id: businessId,
    transaction_id: side === "A" ? ids.transactionA : ids.transactionB,
    category: "office_expense",
    source: "tax_rls_integration",
    metadata: { taxRlsIntegrationTestId: testId },
  };
}

function qboPostedTransactionFixture({ businessId, testId, ids, side, id = randomUUID() }) {
  return {
    id,
    business_id: businessId,
    transaction_id: side === "A" ? ids.transactionA : ids.transactionB,
    transaction_date: `${TAX_YEAR}-01-15`,
    amount: 10,
    vendor_name: "Tax RLS Integration Vendor",
    status: "posted",
    metadata: { taxRlsIntegrationTestId: testId },
  };
}

function schedulerRunFixture({ businessId, testId, id = randomUUID() }) {
  return {
    id,
    business_id: businessId,
    job_type: "daily_tax_calculation",
    scheduled_for: new Date().toISOString(),
    status: "completed",
    metadata: { taxRlsIntegrationTestId: testId },
  };
}
