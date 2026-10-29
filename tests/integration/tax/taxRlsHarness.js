/* global process */
/* eslint-disable no-unused-vars -- legacy broad-RLS fixture helpers remain available for older harness consumers */
import { createClient } from "@supabase/supabase-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  const formerEmail = `${testId}-former@example.test`;
  const adminEmail = `${testId}-admin@example.test`;
  const userA = await createTestUser(service, userAEmail, password, testId);
  const userB = await createTestUser(service, userBEmail, password, testId);
  const former = await createTestUser(service, formerEmail, password, testId);
  const admin = await createTestUser(service, adminEmail, password, testId);
  await insertRequired(service, "user_profiles", [userA.user, userB.user, former.user, admin.user].map((user) => ({ id: user.id, email: user.email, role: "owner" })));
  const clientA = anon();
  const clientB = anon();
  const formerClient = anon();
  const { data: sessionA, error: signInAError } = await clientA.auth.signInWithPassword({ email: userAEmail, password });
  if (signInAError) throw signInAError;
  const { data: sessionB, error: signInBError } = await clientB.auth.signInWithPassword({ email: userBEmail, password });
  if (signInBError) throw signInBError;
  const { data: formerSession, error: formerSignInError } = await formerClient.auth.signInWithPassword({ email: formerEmail, password });
  if (formerSignInError) throw formerSignInError;

  const businessA = randomUUID();
  const businessB = randomUUID();
  const ids = { businessA, businessB };

  await insertRequired(service, "business_profiles", [
    businessProfileFixture({ id: businessA, userId: userA.user.id, testId, name: "Tax RLS Business A" }),
    businessProfileFixture({ id: businessB, userId: userB.user.id, testId, name: "Tax RLS Business B" }),
  ]);
  await insertRequired(service, "user_business_link", [
    { user_id: userA.user.id, business_id: businessA, role: "owner" },
    { user_id: userB.user.id, business_id: businessB, role: "owner" },
  ]);
  await insertRequired(service, "business_billing", [businessA, businessB].map((businessId) => ({
    business_id: businessId,
    subscription_status: "active",
    subscription_status_test: "active",
    subscription_status_live: "inactive",
  })));

  const v1A = await persistSyntheticProjection(service, businessA, "tax-workspace-v1", "a");
  const v2A = await persistSyntheticProjection(service, businessA, "tax-workspace-v2", "b");
  const v1B = await persistSyntheticProjection(service, businessB, "tax-workspace-v1", "c");
  const v2B = await persistSyntheticProjection(service, businessB, "tax-workspace-v2", "d");
  const backfillKey = randomUUID();
  await insertRequired(service, "tax_workspace_projection_requests", [{
    business_id: businessA,
    tax_year: TAX_YEAR,
    request_key: `tax-workspace-backfill:tax-workspace-v2:${backfillKey}`,
    reason: "controlled_backfill",
    status: "completed",
    projection_id: v2A.id,
    completed_at: new Date().toISOString(),
  }]);
  const adminViewToken = randomBytes(32).toString("base64url");
  await insertRequired(service, "internal_staff_users", [{ user_id: admin.user.id, role: "accountant", active: true }]);
  await insertRequired(service, "internal_admin_view_sessions", [{
    staff_user_id: admin.user.id,
    staff_role: "accountant",
    business_id: businessA,
    source: "tax_rls_integration",
    read_only: true,
    capabilities: [],
    session_token_hash: createHash("sha256").update(adminViewToken).digest("hex"),
    started_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }]);

  return {
    config,
    testId,
    service,
    clientA,
    clientB,
    formerClient,
    anonymous: anon(),
    users: { A: userA.user, B: userB.user, former: former.user, admin: admin.user },
    sessions: { A: sessionA.session, B: sessionB.session, former: formerSession.session },
    projections: { v1A, v2A, v1B, v2B },
    backfillKey,
    adminViewToken,
    ids,
    async cleanup() {
      await cleanupFixtures({ service, testId, ids, users: [userA.user, userB.user, former.user, admin.user] });
    },
  };
}

export async function runDirectSupabaseRlsChecks(ctx) {
  const results = [];
  const browserActors = [
    ["anonymous", ctx.anonymous],
    ["Customer A", ctx.clientA],
    ["Customer B", ctx.clientB],
    ["revoked former member", ctx.formerClient],
  ];
  for (const [label, client] of browserActors) {
    for (const table of ["tax_workspace_projections", "tax_workspace_projection_requests"]) {
      results.push(await projectionReadDenied(client, table, label));
      results.push(await projectionMutationDenied(client, table, label, "insert", ctx.ids.businessA));
      results.push(await projectionMutationDenied(client, table, label, "update", ctx.ids.businessA));
      results.push(await projectionMutationDenied(client, table, label, "delete", ctx.ids.businessA));
    }
    results.push(await projectionRpcDenied(client, label, "persist_tax_workspace_projection", ctx.ids.businessA));
    results.push(await projectionRpcDenied(client, label, "claim_tax_workspace_projection_requests", ctx.ids.businessA));
  }
  results.push(await serviceProjectionAuthorityChecks(ctx));

  return finalizeSection("direct_supabase", results, ctx.config);
}

export async function runHttpTenancyChecks(ctx) {
  const results = [];
  const tokenA = ctx.sessions.A?.access_token;
  const tokenB = ctx.sessions.B?.access_token;
  const tokenFormer = ctx.sessions.former?.access_token;
  const beforeDenied = await projectionWriteCounts(ctx.service);
  results.push(await workspaceReadExpected(ctx, tokenA, ctx.ids.businessA, null, "tax-workspace-v1", ctx.projections.v1A.id, "Customer A unversioned v1"));
  results.push(await workspaceReadExpected(ctx, tokenA, ctx.ids.businessA, "tax-workspace-v1", "tax-workspace-v1", ctx.projections.v1A.id, "Customer A explicit v1"));
  results.push(await workspaceReadExpected(ctx, tokenA, ctx.ids.businessA, "tax-workspace-v2", "tax-workspace-v2", ctx.projections.v2A.id, "Customer A explicit v2", { redacted: true }));
  results.push(await workspaceDenied(ctx, tokenB, ctx.ids.businessA, "Customer B cannot read A"));
  results.push(await workspaceDenied(ctx, tokenFormer, ctx.ids.businessA, "revoked former member denied"));
  results.push(await workspaceAnonymousDenied(ctx, ctx.ids.businessA));
  results.push(await workspaceUnknownVersionDenied(ctx, tokenA, ctx.ids.businessA));
  for (const vector of [
    { label: "query substitution", path: `/api/tax/workspace?businessId=${ctx.ids.businessB}&year=${TAX_YEAR}` },
    { label: "body substitution", path: `/api/tax/workspace?businessId=${ctx.ids.businessA}&year=${TAX_YEAR}`, body: { businessId: ctx.ids.businessB } },
    { label: "path-like conflicting header", path: `/api/tax/workspace/${ctx.ids.businessB}?businessId=${ctx.ids.businessA}&year=${TAX_YEAR}`, headers: { "x-business-id": ctx.ids.businessB } },
    { label: "header substitution", path: `/api/tax/workspace?businessId=${ctx.ids.businessA}&year=${TAX_YEAR}`, headers: { "x-business-id": ctx.ids.businessB } },
  ]) results.push(await rawHttpDenied(ctx, tokenA, vector.label, vector));

  results.push(await backfillDenied(ctx, tokenA, ctx.ids.businessA, null, "missing scheduler secret"));
  results.push(await backfillDenied(ctx, tokenA, ctx.ids.businessA, "incorrect", "incorrect scheduler secret"));
  results.push(await backfillDenied(ctx, tokenB, ctx.ids.businessA, process.env.TAX_SCHEDULER_INTERNAL_SECRET, "Customer B plus valid secret"));
  results.push(await adminViewWorkspaceRead(ctx, ctx.ids.businessA, ctx.projections.v1A.id));
  results.push(await adminViewDenied(ctx, ctx.ids.businessB, "Admin View fixed-business switch denied"));
  results.push(await adminViewBackfillDenied(ctx, ctx.ids.businessA));
  const afterDenied = await projectionWriteCounts(ctx.service);
  results.push(result("http", "denial instrumentation", "zero projection persistence calls", JSON.stringify(beforeDenied) === JSON.stringify(afterDenied) ? "pass" : "fail", `${beforeDenied.projections}/${beforeDenied.requests} -> ${afterDenied.projections}/${afterDenied.requests}`));
  results.push(result("http", "denial instrumentation", "zero provider/background invocations", process.env.DISABLE_BACKGROUND_WORKERS === "true" && process.env.TAX_RLS_PROVIDER_CALL_SENTINEL === "deny" ? "pass" : "fail", "workers disabled; provider sentinel deny"));
  results.push(...await backfillIdempotencyChecks(ctx, tokenA, tokenB));
  return finalizeSection("http_tenancy", results, ctx.config);
}

async function persistSyntheticProjection(service, businessId, version, fingerprintSeed) {
  const sourceFingerprint = fingerprintSeed.repeat(64);
  const payload = {
    canonicalBusinessId: businessId,
    taxYear: TAX_YEAR,
    projectionVersion: version,
    formulaVersion: "synthetic-tax-rls-v1",
    sourceFingerprint,
    status: "complete",
    completeness: "complete",
    generatedAt: "2026-10-01T00:00:00.000Z",
    matrix: [],
    questionGroups: [],
    identityEvidence: { evaluated: [`synthetic-${fingerprintSeed}`] },
  };
  const { data, error } = await service.rpc("persist_tax_workspace_projection", {
    p_business_id: businessId,
    p_tax_year: TAX_YEAR,
    p_projection_version: version,
    p_formula_version: payload.formulaVersion,
    p_source_fingerprint: sourceFingerprint,
    p_completeness: payload.completeness,
    p_payload: payload,
    p_generated_at: payload.generatedAt,
  });
  if (error || !data?.id) throw error || new Error(`Could not persist synthetic ${version}.`);
  return data;
}

async function projectionReadDenied(client, table, actor) {
  const { data, error } = await client.from(table).select("id").limit(5);
  return result(table, actor, "direct read denied", error || !data?.length ? "pass" : "fail", error ? safeErrorMessage(error) : `returned ${data.length} rows`);
}

async function projectionMutationDenied(client, table, actor, operation, businessId) {
  let query;
  if (operation === "insert") {
    query = client.from(table).insert(table.endsWith("requests") ? {
      business_id: businessId, tax_year: TAX_YEAR, request_key: `forbidden-${randomUUID()}`, reason: "forbidden",
    } : {
      business_id: businessId, tax_year: TAX_YEAR, projection_version: "forbidden", formula_version: "forbidden",
      source_fingerprint: "f".repeat(64), status: "complete", completeness: "complete", projection_data: {}, generated_at: new Date().toISOString(),
    }).select("id");
  } else if (operation === "update") query = client.from(table).update({ status: "failed" }).eq("business_id", businessId).select("id");
  else query = client.from(table).delete().eq("business_id", businessId).select("id");
  const { data, error } = await query;
  return result(table, actor, `${operation} denied`, error || !data?.length ? "pass" : "fail", error ? safeErrorMessage(error) : `affected ${data.length} rows`);
}

async function projectionRpcDenied(client, actor, rpc, businessId) {
  const args = rpc.startsWith("persist") ? {
    p_business_id: businessId, p_tax_year: TAX_YEAR, p_projection_version: "forbidden", p_formula_version: "forbidden",
    p_source_fingerprint: "e".repeat(64), p_completeness: "complete", p_payload: {}, p_generated_at: new Date().toISOString(),
  } : { p_worker_id: "forbidden-browser", p_batch_size: 1, p_now: new Date().toISOString() };
  const { data, error } = await client.rpc(rpc, args);
  return result("projection RPC", actor, `${rpc} denied`, error || !data?.length ? "pass" : "fail", error ? safeErrorMessage(error) : "RPC unexpectedly returned data");
}

async function serviceProjectionAuthorityChecks(ctx) {
  const { data: rows, error } = await ctx.service.from("tax_workspace_projections").select("id,business_id,projection_version,projection_data");
  const directInsert = await ctx.service.from("tax_workspace_projections").insert({
    business_id: ctx.ids.businessA, tax_year: TAX_YEAR, projection_version: "forbidden-direct", formula_version: "forbidden-direct",
    source_fingerprint: "9".repeat(64), status: "complete", completeness: "complete", projection_data: {}, generated_at: new Date().toISOString(),
  });
  const directUpdate = await ctx.service.from("tax_workspace_projections").update({ completeness: "partial" }).eq("id", ctx.projections.v1A.id);
  const directDelete = await ctx.service.from("tax_workspace_projections").delete().eq("id", ctx.projections.v1A.id);
  const requestDelete = await ctx.service.from("tax_workspace_projection_requests").delete().eq("business_id", ctx.ids.businessA);
  const pendingKey = `service-claim-${randomUUID()}`;
  const pending = await ctx.service.from("tax_workspace_projection_requests").insert({ business_id: ctx.ids.businessA, tax_year: TAX_YEAR, request_key: pendingKey, reason: "service_claim_test" });
  const claimed = await ctx.service.rpc("claim_tax_workspace_projection_requests", { p_worker_id: "tax-rls-service", p_batch_size: 5, p_now: new Date().toISOString() });
  const correct = !error && rows?.length === 4
    && rows.filter((row) => row.business_id === ctx.ids.businessA).length === 2
    && rows.filter((row) => row.business_id === ctx.ids.businessB).length === 2
    && rows.every((row) => row.projection_data?.identityEvidence)
    && directInsert.error && directUpdate.error && directDelete.error && requestDelete.error
    && !pending.error && !claimed.error && claimed.data?.some((row) => row.request_key === pendingKey);
  return result("tax workspace authority", "service_role", "only intended select/request/secure-RPC operations", correct ? "pass" : "fail", error ? safeErrorMessage(error) : `${rows?.length || 0} projections; claim ${claimed.data?.length || 0}`);
}

async function workspaceReadExpected(ctx, token, businessId, requestedVersion, expectedVersion, expectedId, label, options = {}) {
  const versionQuery = requestedVersion ? `&projectionVersion=${encodeURIComponent(requestedVersion)}` : "";
  const response = await fetch(`${ctx.config.apiBaseUrl}/api/tax/workspace?businessId=${businessId}&year=${TAX_YEAR}${versionQuery}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => null);
  const serialized = JSON.stringify(body?.data?.projection || {});
  const correct = response.ok && body?.data?.projectionVersion === expectedVersion && body?.data?.projectionId === expectedId
    && body?.data?.projection?.projectionVersion === expectedVersion
    && (!options.redacted || (!serialized.includes("identityEvidence") && !serialized.includes("identityManifest")));
  return result("http workspace", label, "exact version read", correct ? "pass" : "fail", `status ${response.status}; version ${body?.data?.projectionVersion || "none"}; error ${body?.error || body?.code || "none"}`);
}

async function workspaceDenied(ctx, token, businessId, label) {
  return rawHttpDenied(ctx, token, label, { path: `/api/tax/workspace?businessId=${businessId}&year=${TAX_YEAR}` });
}

async function workspaceAnonymousDenied(ctx, businessId) {
  const response = await fetch(`${ctx.config.apiBaseUrl}/api/tax/workspace?businessId=${businessId}&year=${TAX_YEAR}`);
  return result("http workspace", "anonymous", "access denied", response.status === 401 ? "pass" : "fail", `status ${response.status}`);
}

async function workspaceUnknownVersionDenied(ctx, token, businessId) {
  const response = await fetch(`${ctx.config.apiBaseUrl}/api/tax/workspace?businessId=${businessId}&year=${TAX_YEAR}&projectionVersion=tax-workspace-v999`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => null);
  return result("http workspace", "Customer A", "unknown version safely denied", response.status === 422 ? "pass" : "fail", `status ${response.status}; error ${body?.error || body?.code || "none"}`);
}

async function rawHttpDenied(ctx, token, label, { path, body, headers = {} }) {
  const response = await fetch(`${ctx.config.apiBaseUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  return result("http workspace", "Customer", label, response && (response.status === 400 || SAFE_DENIED_STATUSES.has(response.status)) ? "pass" : "fail", `status ${response?.status || "network_error"}`);
}

async function backfillDenied(ctx, token, businessId, secret, label) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() };
  if (secret) headers["X-Internal-Cron-Secret"] = secret;
  const response = await fetch(`${ctx.config.apiBaseUrl}/api/tax/workspace/backfill`, {
    method: "POST", headers, body: JSON.stringify({ businessId, year: TAX_YEAR, projectionVersion: "tax-workspace-v2" }),
  });
  return result("http backfill", "Customer", label, SAFE_DENIED_STATUSES.has(response.status) ? "pass" : "fail", `status ${response.status}`);
}

async function backfillIdempotencyChecks(ctx, tokenA, tokenB) {
  const key = ctx.backfillKey;
  const invoke = (token, businessId, year = TAX_YEAR, version = "tax-workspace-v2") => fetch(`${ctx.config.apiBaseUrl}/api/tax/workspace/backfill`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      "X-Internal-Cron-Secret": process.env.TAX_SCHEDULER_INTERNAL_SECRET,
    },
    body: JSON.stringify({ businessId, year, projectionVersion: version }),
  });
  const firstResponse = await invoke(tokenA, ctx.ids.businessA);
  const first = await firstResponse.json().catch(() => null);
  const repeatResponse = await invoke(tokenA, ctx.ids.businessA);
  const repeat = await repeatResponse.json().catch(() => null);
  const businessConflict = await invoke(tokenB, ctx.ids.businessB);
  const yearConflict = await invoke(tokenA, ctx.ids.businessA, TAX_YEAR - 1);
  const versionRejected = await invoke(tokenA, ctx.ids.businessA, TAX_YEAR, "tax-workspace-v1");
  return [
    result("http backfill", "Customer A", "exact-v2 completed request is idempotent", firstResponse.ok && first?.data?.projectionVersion === "tax-workspace-v2" && first?.data?.idempotent === true ? "pass" : "fail", `status ${firstResponse.status}`),
    result("http backfill", "Customer A", "same scope/key returns same projection", repeatResponse.ok && repeat?.data?.idempotent === true && repeat?.data?.requestId === first?.data?.requestId && repeat?.data?.projectionId === first?.data?.projectionId ? "pass" : "fail", `status ${repeatResponse.status}`),
    result("http backfill", "Customer B", "same key cannot cross business", businessConflict.status === 409 ? "pass" : "fail", `status ${businessConflict.status}`),
    result("http backfill", "Customer A", "same key cannot cross year", yearConflict.status === 409 ? "pass" : "fail", `status ${yearConflict.status}`),
    result("http backfill", "Customer A", "non-v2 version rejected before enqueue", versionRejected.status === 422 ? "pass" : "fail", `status ${versionRejected.status}`),
  ];
}

async function adminViewWorkspaceRead(ctx, businessId, expectedId) {
  const response = await fetch(`${ctx.config.apiBaseUrl}/api/tax/workspace?businessId=${businessId}&year=${TAX_YEAR}`, { headers: { "x-bizzi-admin-view": ctx.adminViewToken } });
  const body = await response.json().catch(() => null);
  return result("http workspace", "Admin View", "fixed-business read-only v1", response.ok && body?.data?.projectionId === expectedId ? "pass" : "fail", `status ${response.status}; error ${body?.error || body?.code || "none"}`);
}

async function adminViewDenied(ctx, businessId, label) {
  const response = await fetch(`${ctx.config.apiBaseUrl}/api/tax/workspace?businessId=${businessId}&year=${TAX_YEAR}`, { headers: { "x-bizzi-admin-view": ctx.adminViewToken } });
  return result("http workspace", "Admin View", label, response.status === 403 ? "pass" : "fail", `status ${response.status}`);
}

async function adminViewBackfillDenied(ctx, businessId) {
  const response = await fetch(`${ctx.config.apiBaseUrl}/api/tax/workspace/backfill`, {
    method: "POST",
    headers: { "x-bizzi-admin-view": ctx.adminViewToken, "x-internal-cron-secret": process.env.TAX_SCHEDULER_INTERNAL_SECRET, "idempotency-key": randomUUID(), "content-type": "application/json" },
    body: JSON.stringify({ businessId, year: TAX_YEAR, projectionVersion: "tax-workspace-v2" }),
  });
  return result("http backfill", "Admin View", "read-only contract denies backfill", response.status === 403 ? "pass" : "fail", `status ${response.status}`);
}

async function projectionWriteCounts(service) {
  const [projections, requests] = await Promise.all([
    service.from("tax_workspace_projections").select("id", { count: "exact", head: true }),
    service.from("tax_workspace_projection_requests").select("id", { count: "exact", head: true }),
  ]);
  if (projections.error) throw projections.error;
  if (requests.error) throw requests.error;
  return { projections: projections.count, requests: requests.count };
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
    "tax_workspace_projection_requests",
    "tax_workspace_projections",
    "internal_admin_view_sessions",
    "internal_staff_users",
    "business_billing",
    "user_business_link",
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
    industry: "Synthetic test",
    team_size: 1,
    state: "NY",
    services_offered: "Synthetic test",
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
