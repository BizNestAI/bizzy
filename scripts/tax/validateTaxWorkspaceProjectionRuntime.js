/* global Buffer, process */
import assert from "node:assert/strict";
import express from "express";
import { performance } from "node:perf_hooks";

const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
const BUSINESS_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INTERNAL_SECRET = "validation-internal-only";

process.env.NODE_ENV = "test";
process.env.STRIPE_MODE = "test";
process.env.DISABLE_BACKGROUND_WORKERS = "true";
process.env.TAX_SCHEDULER_INTERNAL_SECRET = INTERNAL_SECRET;

const [{ default: router }, { supabase }] = await Promise.all([
  import("../../src/api/tax/taxWorkspace.routes.js"),
  import("../../src/services/supabaseAdmin.js"),
]);
const { buildAndPersistTaxWorkspaceProjection } = await import("../../src/services/tax/taxWorkspaceProjection.service.js");

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const principal = req.get("x-validation-principal");
  if (!principal) return res.status(401).json({ error: { code: "unauthorized" } });
  if (principal === "revoked") return res.status(403).json({ error: { code: "membership_revoked" } });
  if (principal === "admin-a") {
    req.tenantContext = { mode: "admin_view", businessId: BUSINESS_A, staffUserId: "validation-staff" };
    if (req.method !== "GET") return res.status(403).json({ error: { code: "admin_view_read_only" } });
    return next();
  }
  if (principal === "a") req.auth = { userId: USER_A, businessId: BUSINESS_A };
  else if (principal === "b") req.auth = { userId: USER_B, businessId: BUSINESS_B };
  else return res.status(401).json({ error: { code: "unauthorized" } });
  next();
});
app.locals.supabase = supabase;
app.use("/api/tax", router);

const server = await new Promise((resolve) => {
  const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
});
const base = `http://127.0.0.1:${server.address().port}`;
const timings = {};

async function request(path, { method = "GET", principal = "a", internal = false, key, body } = {}) {
  const start = performance.now();
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(principal ? { "x-validation-principal": principal } : {}),
      ...(internal ? { "x-internal-cron-secret": INTERNAL_SECRET } : {}),
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, ms: performance.now() - start, bytes: Buffer.byteLength(text) };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}
function stats(values) {
  return { min: Math.min(...values), p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values) };
}

try {
  const key = `complete-validation-${Date.now()}`;
  const first = await request("/api/tax/workspace/backfill", { method: "POST", internal: true, key, body: { year: 2026 } });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.idempotent, false);
  timings.backfill = first.ms;
  const replay = await request("/api/tax/workspace/backfill", { method: "POST", internal: true, key, body: { year: 2026 } });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.idempotent, true);
  assert.equal(replay.body.data.projectionId, first.body.data.projectionId);
  timings.replay = replay.ms;

  const conflictBusiness = await request("/api/tax/workspace/backfill", { method: "POST", principal: "b", internal: true, key, body: { year: 2026 } });
  assert.equal(conflictBusiness.status, 409);
  const conflictYear = await request("/api/tax/workspace/backfill", { method: "POST", internal: true, key, body: { year: 2025 } });
  assert.equal(conflictYear.status, 409);

  for (const test of [
    { principal: "a", expected: 403 }, { principal: "b", expected: 403 },
    { principal: "admin-a", internal: true, expected: 403 }, { principal: null, internal: true, expected: 401 },
    { principal: "revoked", internal: true, expected: 403 },
  ]) {
    const denied = await request("/api/tax/workspace/backfill", { method: "POST", principal: test.principal, internal: test.internal, key: `${key}-${test.principal}`, body: { year: 2026 } });
    assert.equal(denied.status, test.expected);
  }

  const full = await request("/api/tax/workspace?year=2026");
  assert.equal(full.status, 200);
  const projection = full.body.data.projection;
  assert.deepEqual([projection.evaluatedTransactionCount, projection.matrixIncludedCount, projection.outsideDeductionsCount, projection.questionGroupCount], [713, 689, 24, 8]);
  assert.equal(projection.matrix.flatMap((category) => Object.keys(category.months)).includes("2026-12"), true);
  assert.ok(projection.warnings.length > 0 && projection.limitations.length > 0);
  assert.ok(full.body.data.formulaVersion && full.body.data.sourceFingerprint && full.body.data.generatedAt);

  const beforeRows = await supabase.from("tax_workspace_projection_requests").select("id", { count: "exact", head: true });
  const sequential = [];
  for (let index = 0; index < 30; index += 1) sequential.push((await request("/api/tax/workspace?year=2026")).ms);
  timings.endpointSequential = stats(sequential);
  timings.responseBytes = full.bytes;

  await buildAndPersistTaxWorkspaceProjection({ supabase, businessId: BUSINESS_B, taxYear: 2026 });
  const concurrentResults = await Promise.all(Array.from({ length: 10 }, (_, index) => request("/api/tax/workspace?year=2026", { principal: index % 2 ? "b" : "a" })));
  assert.ok(concurrentResults.every((result) => result.status === 200));
  timings.endpointConcurrent = stats(concurrentResults.map((result) => result.ms));
  assert.equal((await request(`/api/tax/workspace?year=2026&businessId=${BUSINESS_A}`, { principal: "b" })).status, 403);
  assert.equal((await request("/api/tax/workspace?year=2025")).status, 503);
  const afterRows = await supabase.from("tax_workspace_projection_requests").select("id", { count: "exact", head: true });
  assert.equal(afterRows.count, beforeRows.count);

  console.log(JSON.stringify({
    ok: true,
    ids: { requestId: first.body.data.requestId, projectionId: first.body.data.projectionId },
    counts: [projection.evaluatedTransactionCount, projection.matrixIncludedCount, projection.outsideDeductionsCount, projection.questionGroupCount],
    amount: projection.estimatedDeductibleAmount,
    matrixCategories: projection.matrix.length,
    timings,
    security: { conflicts: [conflictBusiness.status, conflictYear.status], denied: [403, 403, 403, 401, 403], tenantIsolation: 403, incompatible: 503 },
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
