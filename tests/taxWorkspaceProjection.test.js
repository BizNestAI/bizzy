/* global Buffer */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  __taxWorkspaceProjectionTestInternals as internals,
  enqueueTaxWorkspaceProjection,
  getLatestTaxWorkspaceProjection,
  publicTaxWorkspaceProjection,
  TAX_WORKSPACE_LEGACY_PROJECTION_VERSION,
  TAX_WORKSPACE_FORMULA_VERSION,
  TAX_WORKSPACE_PROJECTION_VERSION,
} from "../src/services/tax/taxWorkspaceProjection.service.js";
import { workspaceReadError } from "../src/api/tax/taxWorkspaceErrors.js";
import { sendTaxError } from "../src/api/tax/taxHttp.js";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
function source() {
  const entries = [
    { id: "estimated-1", outcome: "standard_rule_applied", actionOwner: "none", row: { transactionId: "estimated-1", taxScopeDisposition: "expense_cogs_in_matrix", taxCategory: "software_subscriptions", taxCategoryLabel: "Software", date: "2026-10-01", amount: 100, deductibleAmount: 100 } },
    { id: "reviewed-1", outcome: "reviewed", actionOwner: "none", row: { transactionId: "reviewed-1", taxScopeDisposition: "expense_cogs_in_matrix", taxCategory: "business_meals", taxCategoryLabel: "Meals", date: "2026-10-02", amount: 100, deductibleAmount: 50 } },
    { id: "question-1", outcome: "customer_input_required", actionOwner: "customer_fact_required", row: { transactionId: "question-1", taxScopeDisposition: "expense_cogs_in_matrix", taxCategory: "business_meals", taxCategoryLabel: "Meals", date: "2026-10-03", amount: 75, deductibleAmount: 0 } },
    { id: "outside-1", outcome: "outside_deductions", actionOwner: "none", row: { transactionId: "outside-1", taxScopeDisposition: "income_outside_deductions", taxCategory: "income", date: "2026-10-04", amount: 500 } },
  ];
  return {
    overview: {
      meta: { generatedAt: "2026-10-23T12:00:00.000Z", engineVersion: "tax-deductions-v1" },
      projection: { completeness: "complete", estimatedDeductibleAmount: 8524, evaluatedTransactionCount: 713, matrixIncludedCount: 689, outsideDeductionsCount: 24 },
      categories: [{ taxCategory: "software_subscriptions", displayName: "Software", transactionCount: 689, monthly: { "2026-10": { transactionCount: 689, bookExpenseAmount: 9000, deductibleAmount: 8524, needsReviewAmount: 0 } } }],
      warnings: [],
    },
    lifecycle: { entries, activeDecisionGroups: [{ id: "q-meals", decisionType: "business_use_confirmation", qboAccountId: "a-meals", qboAccountName: "Meals", ruleVersion: "v1", transactionCount: 1, actionableTransactionCount: 1, months: ["2026-10"], actionableGrossAmountCents: 7500, actionableEstimatedDeductibleAmountCents: 0, state: "needs_input", stableTransactionIds: { actionable: ["question-1"] } }] },
  };
}

test("workspace payload is deterministic, complete, conserved, and bounded", () => {
  const { overview, lifecycle } = source();
  const args = { overview, lifecycle, businessId: BUSINESS, taxYear: 2026, sourceFingerprint: "a".repeat(64), generatedAt: overview.meta.generatedAt };
  const first = internals.buildPayload(args);
  const second = internals.buildPayload(args);
  assert.deepEqual(first, second);
  assert.equal(first.projectionVersion, TAX_WORKSPACE_PROJECTION_VERSION);
  assert.equal(first.formulaVersion, TAX_WORKSPACE_FORMULA_VERSION);
  assert.equal(first.evaluatedTransactionCount, first.matrixIncludedCount + first.outsideDeductionsCount);
  assert.equal(first.questionGroups.length, 1);
  assert.deepEqual(first.treatmentCounts, { estimated: 1, reviewed: 1, needs_input: 1 });
  assert.doesNotThrow(() => internals.validatePayload(first));
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 1_048_576);
});

test("same fingerprint and concurrent persistence create one complete projection", async () => {
  const store = { tax_workspace_projections: [] };
  const supabase = { store };
  const { overview, lifecycle } = source();
  const payload = internals.buildPayload({ overview, lifecycle, businessId: BUSINESS, taxYear: 2026, sourceFingerprint: "b".repeat(64), generatedAt: overview.meta.generatedAt });
  const results = await Promise.all(Array.from({ length: 5 }, () => internals.persist({ supabase, payload })));
  assert.equal(store.tax_workspace_projections.length, 1);
  assert.equal(new Set(results.map((row) => row.id)).size, 1);
  assert.equal((await getLatestTaxWorkspaceProjection({ supabase, businessId: BUSINESS, taxYear: 2026 })).projection_data.estimatedDeductibleAmount, 8524);
});

test("failed validation cannot replace the prior complete projection", async () => {
  const store = { tax_workspace_projections: [{ id: "prior", business_id: BUSINESS, tax_year: 2026, projection_version: TAX_WORKSPACE_PROJECTION_VERSION, status: "complete", generated_at: "2026-10-22T12:00:00Z", projection_data: { estimatedDeductibleAmount: 8000 } }] };
  assert.throws(() => internals.validatePayload({ evaluatedTransactionCount: 2, matrixIncludedCount: 2, outsideDeductionsCount: 2, matrix: [] }), /Tax workspace projection/);
  assert.equal(store.tax_workspace_projections.length, 1);
});

test("projection validation rejects a 690/689-style matrix contradiction", () => {
  const { overview, lifecycle } = source();
  const payload = internals.buildPayload({ overview, lifecycle, businessId: BUSINESS, taxYear: 2026, sourceFingerprint: "c".repeat(64), generatedAt: overview.meta.generatedAt });
  payload.matrixIncludedCount = 690;
  payload.evaluatedTransactionCount = 714;
  assert.throws(() => internals.validatePayload(payload), /Tax workspace projection/);
});

test("v2 matrix excludes Income and conserves category, month, treatment, and outside identities", () => {
  const { overview, lifecycle } = source();
  const payload = internals.buildPayload({ overview, lifecycle, businessId: BUSINESS, taxYear: 2026, sourceFingerprint: "d".repeat(64), generatedAt: overview.meta.generatedAt });
  assert.equal(payload.matrix.some((row) => row.categoryKey === "income"), false);
  assert.deepEqual(payload.identityEvidence.evaluated, ["estimated-1", "outside-1", "question-1", "reviewed-1"]);
  assert.deepEqual(payload.identityEvidence.matrixIncluded, ["estimated-1", "question-1", "reviewed-1"]);
  assert.deepEqual(payload.identityEvidence.outsideDeductions, ["outside-1"]);
  assert.doesNotThrow(() => internals.validatePayload(payload));
});

test("duplicate question membership reports group sum and unique union separately", () => {
  const { overview, lifecycle } = source();
  lifecycle.activeDecisionGroups.push({ ...lifecycle.activeDecisionGroups[0], id: "q-meals-overlap" });
  const payload = internals.buildPayload({ overview, lifecycle, businessId: BUSINESS, taxYear: 2026, sourceFingerprint: "e".repeat(64), generatedAt: overview.meta.generatedAt });
  assert.equal(payload.questionMembershipSum, 2);
  assert.equal(payload.questionCoveredUniqueCount, 1);
  assert.equal(payload.questionMembershipOverlapCount, 1);
  assert.doesNotThrow(() => internals.validatePayload(payload));
});

test("missing, duplicate, overlapping, or omitted identities fail closed", () => {
  const { overview, lifecycle } = source();
  const build = () => internals.buildPayload({ overview, lifecycle, businessId: BUSINESS, taxYear: 2026, sourceFingerprint: "f".repeat(64), generatedAt: overview.meta.generatedAt });
  for (const mutate of [
    (p) => { p.identityEvidence.matrixIncluded.push(""); },
    (p) => { p.identityEvidence.matrixIncluded.push(p.identityEvidence.matrixIncluded[0]); },
    (p) => { p.identityEvidence.outsideDeductions.push(p.identityEvidence.matrixIncluded[0]); },
    (p) => { p.identityEvidence.categories.business_meals = []; },
    (p) => { p.identityEvidence.months["2026-10"] = p.identityEvidence.months["2026-10"].slice(1); },
    (p) => { p.identityEvidence.treatments.needs_input = []; },
  ]) {
    const payload = build(); mutate(payload);
    assert.throws(() => internals.validatePayload(payload), /Tax workspace projection/);
  }
});

test("browser response omits stable identity manifests", () => {
  const { overview, lifecycle } = source();
  const payload = internals.buildPayload({ overview, lifecycle, businessId: BUSINESS, taxYear: 2026, sourceFingerprint: "1".repeat(64), generatedAt: overview.meta.generatedAt });
  const browser = publicTaxWorkspaceProjection(payload);
  assert.equal(browser.identityEvidence, undefined);
  assert.equal(browser.matrix[0].identityManifest, undefined);
  assert.equal(Object.values(browser.matrix[0].months)[0].identityManifest, undefined);
  assert.equal(browser.identityFingerprints.matrixIncluded.length, 64);
});

test("v1 and v2 selection is explicit and cannot interchange records", async () => {
  const supabase = { store: { tax_workspace_projections: [
    { id: "v1", business_id: BUSINESS, tax_year: 2026, projection_version: TAX_WORKSPACE_LEGACY_PROJECTION_VERSION, status: "complete", generated_at: "2026-10-01", projection_data: { projectionVersion: TAX_WORKSPACE_LEGACY_PROJECTION_VERSION } },
    { id: "v2", business_id: BUSINESS, tax_year: 2026, projection_version: TAX_WORKSPACE_PROJECTION_VERSION, status: "complete", generated_at: "2026-10-02", projection_data: { projectionVersion: TAX_WORKSPACE_PROJECTION_VERSION } },
  ] } };
  assert.equal((await getLatestTaxWorkspaceProjection({ supabase, businessId: BUSINESS, taxYear: 2026, projectionVersion: TAX_WORKSPACE_LEGACY_PROJECTION_VERSION })).id, "v1");
  assert.equal((await getLatestTaxWorkspaceProjection({ supabase, businessId: BUSINESS, taxYear: 2026, projectionVersion: TAX_WORKSPACE_PROJECTION_VERSION })).id, "v2");
});

test("projection enqueue is tenant/year scoped and idempotent", async () => {
  const supabase = { store: { tax_workspace_projection_requests: [] } };
  await Promise.all(Array.from({ length: 3 }, () => enqueueTaxWorkspaceProjection({ supabase, businessId: BUSINESS, taxYear: 2026, reason: "test", requestKey: "same-request" })));
  assert.equal(supabase.store.tax_workspace_projection_requests.length, 1);
  assert.equal(supabase.store.tax_workspace_projection_requests[0].business_id, BUSINESS);
});

test("migration denies browser access and exposes only service-role RPCs", () => {
  const sql = fs.readFileSync(new URL("../supabase/migrations/20261104120000_tax_workspace_projections.sql", import.meta.url), "utf8");
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /force row level security/i);
  assert.match(sql, /revoke all on table public\.tax_workspace_projections from public, anon, authenticated/i);
  assert.match(sql, /revoke all on table public\.tax_workspace_projections from service_role/i);
  assert.match(sql, /grant select on table public\.tax_workspace_projections to service_role/i);
  assert.doesNotMatch(sql, /grant select, insert on table public\.tax_workspace_projections to service_role/i);
  assert.match(sql, /security definer[\s\S]*set search_path = pg_catalog, public/i);
  assert.doesNotMatch(sql, /grant .* authenticated/i);
});

test("workspace endpoint enforces tenant access, entitlement, read-only GET, and internal-only backfill", () => {
  const route = fs.readFileSync(new URL("../src/api/tax/taxWorkspace.routes.js", import.meta.url), "utf8");
  const read = route.slice(route.indexOf('router.get("/workspace"'), route.indexOf('router.post("/workspace/backfill"'));
  const backfill = route.slice(route.indexOf('router.post("/workspace/backfill"'));
  assert.match(read, /assertTaxBusinessAccess/);
  assert.match(read, /businessHasPaidEntitlement/);
  assert.match(read, /getLatestTaxWorkspaceProjection/);
  assert.doesNotMatch(read, /buildAndPersistTaxWorkspaceProjection|enqueueTaxWorkspaceProjection/);
  assert.match(backfill, /assertInternalSchedulerAccess/);
  assert.match(backfill, /Idempotency-Key/);
  assert.match(backfill, /req\.body\?\.projectionVersion/);
  assert.match(backfill, /projectionVersion !== TAX_WORKSPACE_PROJECTION_VERSION/);
  assert.match(backfill, /tax-workspace-backfill:\$\{projectionVersion\}:\$\{requestId\}/);
  assert.doesNotMatch(backfill, /assertTaxBusinessAccess/);
});

test("canary validator is read-only, checks both exact versions, and validates browser redaction", () => {
  const validator = fs.readFileSync(new URL("../scripts/tax/validateTaxWorkspaceV2Canary.js", import.meta.url), "utf8");
  assert.match(validator, /\.eq\("projection_version", version\)/);
  assert.match(validator, /internals\.validatePayload\(payload\)/);
  assert.match(validator, /readWorkspace\(""\)/);
  assert.match(validator, /projectionVersion=\$\{encodeURIComponent\(TAX_WORKSPACE_PROJECTION_VERSION\)\}/);
  assert.match(validator, /assertNoIdentityManifests/);
  assert.doesNotMatch(validator, /\.insert\(|\.upsert\(|\.update\(|\.delete\(|buildAndPersist|provider/i);
});

test("missing production projection schema becomes a bounded retryable 503", () => {
  for (const databaseError of [
    { code: "42P01", message: 'relation "public.tax_workspace_projections" does not exist' },
    { code: "PGRST205", message: "Could not find the table in the schema cache" },
  ]) {
    const mapped = workspaceReadError(databaseError);
    assert.equal(mapped.code, "tax_workspace_schema_unavailable");
    assert.equal(mapped.status, 503);
    assert.equal(mapped.details.action, "retry");
  }
});

test("Tax errors always include a sanitized request correlation id", () => {
  let status = null;
  let body = null;
  const headers = {};
  const res = {
    req: { headers: {} },
    set(name, value) { headers[name] = value; },
    status(value) { status = value; return this; },
    json(value) { body = value; return value; },
  };
  sendTaxError(res, workspaceReadError({ code: "ECONNRESET" }));
  assert.equal(status, 503);
  assert.match(headers["X-Request-ID"], /^[0-9a-f-]{36}$/i);
  assert.equal(body.errorDetail.requestId, headers["X-Request-ID"]);
  assert.equal(body.error, "tax_workspace_database_unavailable");
  assert.doesNotMatch(JSON.stringify(body), /ECONNRESET/);
});
