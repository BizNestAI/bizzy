import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  __taxWorkspaceProjectionTestInternals as projection,
  buildPopulationMismatchDiagnostic,
  publicTaxWorkspaceProjection,
  reconcileTaxWorkspaceProjection,
} from "../src/services/tax/taxWorkspaceProjection.service.js";
import { createClient } from "@supabase/supabase-js";
import { listTaxWorkspaceClassificationSnapshot } from "../src/services/tax/taxClassification.repository.js";
import { workspaceReadError } from "../src/api/tax/taxWorkspaceErrors.js";
import { sendTaxSuccess } from "../src/api/tax/taxHttp.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("successful grouped apply refreshes the complete authoritative v2 workspace", () => {
  const hook = read("src/hooks/tax/useTaxDeductions.js");
  const confirm = hook.slice(hook.indexOf("confirmGroupedDeductionDecision:"), hook.indexOf("getGroupedDeductionDecisionOperation:"));
  assert.match(confirm, /load\(\{[^}]*refresh:\s*true/);
  assert.doesNotMatch(confirm, /refreshAuthoritativeQuestionSummary/);
});

test("v2 workspace and matrix cells reconcile live classifications over the immutable population baseline", () => {
  const route = read("src/api/tax/taxWorkspace.routes.js");
  const workspace = route.slice(route.indexOf('router.get("/workspace"'), route.indexOf('router.get("/workspace/transactions"'));
  const matrixCell = route.slice(route.indexOf('router.get("/workspace/matrix-cell"'), route.indexOf('router.post("/workspace/backfill"'));
  assert.match(workspace, /reconcileTaxWorkspaceProjection/);
  assert.match(matrixCell, /reconcileTaxWorkspaceProjection/);
  assert.match(workspace, /projectionVersion === TAX_WORKSPACE_PROJECTION_VERSION/);
});

test("normal v2 reconciliation uses one bounded classification snapshot and never runs projection-generation reads", () => {
  const service = read("src/services/tax/taxWorkspaceProjection.service.js");
  const reconciliation = service.slice(
    service.indexOf("export async function reconcileTaxWorkspaceProjection"),
    service.indexOf("async function buildCurrentTaxWorkspacePayload")
  );
  assert.match(reconciliation, /listTaxWorkspaceClassificationSnapshot/);
  assert.doesNotMatch(reconciliation, /buildCurrentTaxWorkspacePayload/);
  assert.doesNotMatch(reconciliation, /listTaxPostingSourceRows/);
  assert.doesNotMatch(reconciliation, /getDeductionsOverview/);
  assert.doesNotMatch(reconciliation, /loadRows/);
});

test("population mismatch diagnostic is complete, aggregate-only, and non-throwing", () => {
  const rawTransactionId = "raw-transaction-id-must-not-appear";
  const rawDescription = "private vendor description must not appear";
  const diagnostic = buildPopulationMismatchDiagnostic({
    requestId: "request-safe",
    record: {
      id: "projection-safe",
      projection_version: "tax-workspace-v2",
      formula_version: "identity-contract-v2.3-vehicle-semantic-questions",
    },
    evidence: {
      evaluated: [rawTransactionId, "matrix-missing", "outside-missing"],
      matrixIncluded: [rawTransactionId, "matrix-missing"],
      outsideDeductions: ["outside-missing"],
    },
    liveRows: [{
      transaction_id: rawTransactionId,
      description: rawDescription,
      source_qbo_account_name: "Phone Bill",
      classification_status: "user_confirmed",
      deductibility_status: "partially_deductible",
      source: "user",
    }, {
      transaction_id: rawTransactionId,
      description: rawDescription,
      classification_status: "auto_classified",
      deductibility_status: "fully_deductible",
      source: "rule_engine",
      metadata: { superseded_at: "2026-10-29T00:00:00.000Z" },
    }, {
      transaction_id: "live-extra-id-must-not-appear",
      classification_status: "auto_classified",
      deductibility_status: "fully_deductible",
      source: "rule_engine",
    }],
  });
  const requiredFields = [
    "event", "requestId", "projectionId", "projectionVersion", "projectionFormulaVersion",
    "projectionEvaluatedRawCount", "projectionEvaluatedDistinctCanonicalIdCount",
    "projectionMatrixRawCount", "projectionMatrixDistinctCount",
    "projectionOutsideDeductionsRawCount", "projectionOutsideDeductionsDistinctCount",
    "projectionNullMalformedIdentifierCount", "projectionDuplicateIdentifierCount",
    "liveRawRowCount", "liveCanonicalDistinctIdCount", "liveNullMalformedIdentifierCount",
    "liveDuplicateIdentifierCount", "liveDuplicateExcessRowCount", "liveActiveCurrentCount",
    "liveSupersededHistoryCount", "liveCountByTreatmentStatus", "liveCountByAuthority",
    "liveCountBySource", "intersectionDistinctCount", "projectionIdsMissingFromLiveCount",
    "projectionMatrixIdsMissingFromLiveCount", "projectionOutsideDeductionsIdsMissingFromLiveCount",
    "liveIdsOutsideProjectionCount", "projectionMembersWithMultipleEquallyAuthoritativeCurrentRowsCount",
    "projectionMembersResolvedByNormalAuthorityPrecedenceCount",
    "phoneBillProjectionMembersCurrentlyReviewedCount", "canonicalKeySourceCounts",
    "populationMismatchReason", "fingerprints",
  ];
  requiredFields.forEach((field) => assert.ok(Object.hasOwn(diagnostic, field), field));
  assert.deepEqual(Object.keys(diagnostic.fingerprints).sort(), [
    "extra", "intersection", "liveDistinct", "missing", "projectionEvaluated", "projectionMatrix", "projectionOutside",
  ]);
  assert.deepEqual(Object.keys(diagnostic.canonicalKeySourceCounts).sort(), [
    "another_established_field", "missing_key", "qbo_transaction_id", "source_transaction_id", "transaction_id",
  ]);
  assert.equal(diagnostic.liveRawRowCount, 3);
  assert.equal(diagnostic.liveDuplicateIdentifierCount, 1);
  assert.equal(diagnostic.liveDuplicateExcessRowCount, 1);
  assert.equal(diagnostic.phoneBillProjectionMembersCurrentlyReviewedCount, 1);
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, new RegExp(rawTransactionId));
  assert.doesNotMatch(serialized, new RegExp(rawDescription));
  assert.doesNotMatch(serialized, /live-extra-id-must-not-appear/);
  assert.doesNotThrow(() => buildPopulationMismatchDiagnostic({
    requestId: { toString() { throw new Error("unsafe"); } },
    record: new Proxy({}, { get() { throw new Error("unsafe getter"); } }),
    evidence: { evaluated: null, matrixIncluded: {}, outsideDeductions: "invalid" },
    liveRows: [null, "invalid"],
  }));
});

test("population mismatch logs once without another database call and preserves the fail-closed response", async () => {
  let reads = 0;
  const logs = [];
  const query = {
    select() { return this; }, eq() { return this; }, limit() { return this; },
    then(resolve) {
      reads += 1;
      return Promise.resolve(resolve({ data: [
        { transaction_id: "present", classification_status: "auto_classified" },
        { transaction_id: "present", classification_status: "auto_classified" },
      ], error: null }));
    },
  };
  const record = {
    id: "projection-safe",
    projection_version: "tax-workspace-v2",
    formula_version: "identity-contract-v2.3-vehicle-semantic-questions",
    projection_data: { identityEvidence: {
      evaluated: ["present", "missing"], matrixIncluded: ["present", "missing"], outsideDeductions: [],
    } },
  };
  let failure;
  try {
    await reconcileTaxWorkspaceProjection({
      supabase: { from() { return query; } }, record, businessId: "business-a", taxYear: 2026,
      requestId: "request-safe", diagnosticLogger: (...args) => logs.push(args),
    });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, "tax_workspace_live_population_mismatch");
  assert.equal(reads, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], "tax_workspace_live_population_mismatch_diagnostic");
  assert.equal(logs[0][1].event, "tax_workspace_live_population_mismatch_diagnostic");
  const browserError = workspaceReadError(failure);
  assert.deepEqual([browserError.code, browserError.status, browserError.message], [
    "tax_workspace_reconciliation_failed", 409, "Your Tax workspace could not be reconciled with current tax data.",
  ]);

  await assert.rejects(
    reconcileTaxWorkspaceProjection({
      supabase: { from() { return query; } }, record, businessId: "business-a", taxYear: 2026,
      diagnosticLogger() { throw new Error("logging unavailable"); },
    }),
    (error) => error.code === "tax_workspace_live_population_mismatch",
  );
  assert.equal(reads, 2);
});

test("production-shaped classification snapshot serializes as a narrow indexed PostgREST query", async () => {
  let requestUrl = null;
  const client = createClient("https://example.supabase.co", "test-anon-key", {
    global: { fetch: async (url) => {
      requestUrl = String(url);
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    } },
  });
  await listTaxWorkspaceClassificationSnapshot({ supabase: client, businessId: "business-a", taxYear: 2026 });
  const url = new URL(requestUrl);
  assert.notEqual(url.searchParams.get("select"), "*");
  assert.equal(url.searchParams.has("order"), false);
  assert.equal(url.searchParams.has("transaction_id"), false);
  assert.ok(requestUrl.length < 2_000);
});

test("classification snapshot preserves upstream query errors, rejects invalid scope, and separates cancellation", async () => {
  const failingClient = createClient("https://example.supabase.co", "test-anon-key", {
    global: { fetch: async () => new Response(JSON.stringify({
      code: "42703", message: "column does not exist", details: null, hint: null,
    }), { status: 400, statusText: "Bad Request", headers: { "content-type": "application/json" } }) },
  });
  await assert.rejects(
    listTaxWorkspaceClassificationSnapshot({ supabase: failingClient, businessId: "business-a", taxYear: 2026 }),
    (error) => error.code === "42703" && error.status === 400
  );
  assert.equal(workspaceReadError({ code: "42703", status: 400, message: "column does not exist" }).code, "tax_workspace_internal_failure");
  const typeError = workspaceReadError(new TypeError("Cannot read properties of undefined (reading 'includes')"));
  assert.deepEqual([typeError.code, typeError.status, typeError.message], [
    "tax_workspace_internal_failure", 500, "Your Tax workspace could not be loaded right now.",
  ]);
  assert.equal(typeError.message.includes("includes"), false);
  assert.match(read("src/api/tax/taxWorkspace.routes.js"), /stack: String\(error\?\.stack/);
  assert.equal(workspaceReadError({ code: "08006", status: 503, message: "connection failure" }).code, "tax_workspace_database_unavailable");
  await assert.rejects(
    listTaxWorkspaceClassificationSnapshot({ supabase: failingClient, businessId: null, taxYear: 2026 }),
    (error) => error.code === "invalid_workspace_classification_scope"
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    listTaxWorkspaceClassificationSnapshot({ supabase: failingClient, businessId: "business-a", taxYear: 2026, signal: controller.signal }),
    (error) => error.name === "AbortError" && error.code === "ABORT_ERR"
  );
});

test("a 714-row production-shaped workspace reconciles with one database read under the workspace deadline", async () => {
  const entries = Array.from({ length: 714 }, (_, index) => {
    const inMatrix = index < 690;
    return {
      id: `transaction-${index}`,
      outcome: "standard_rule_applied",
      actionOwner: "none",
      row: {
        transactionId: `transaction-${index}`,
        date: "2026-07-15",
        taxScopeDisposition: inMatrix ? "expense_cogs_in_matrix" : "posted_non_expense_outside_deductions",
        taxCategory: inMatrix ? "supplies" : "income",
        taxCategoryLabel: inMatrix ? "Supplies" : "Income",
        signedAmount: inMatrix ? -10 : 10,
        deductibleAmount: inMatrix ? 10 : 0,
      },
    };
  });
  const baseline = projection.buildPayload({
    overview: { projection: { completeness: "complete" }, warnings: [] },
    lifecycle: { entries, activeDecisionGroups: [] },
    businessId: "business-a",
    taxYear: 2026,
    sourceFingerprint: "c".repeat(64),
    generatedAt: "2026-10-30T12:00:00.000Z",
  });
  const classifications = entries.map((entry) => ({
    transaction_id: entry.id,
    transaction_date: entry.row.date,
    tax_category: entry.row.taxCategory,
    classification_status: "auto_classified",
    deductibility_status: entry.row.taxCategory === "income" ? "nondeductible" : "fully_deductible",
    deductible_percent: entry.row.taxCategory === "income" ? 0 : 100,
    book_amount: entry.row.signedAmount,
    deductible_amount: entry.row.deductibleAmount,
    source_qbo_account_id: entry.row.taxCategory,
    source_qbo_account_name: entry.row.taxCategoryLabel,
    rule_version: "v4",
  }));
  let reads = 0;
  const query = {
    select() { return this; }, eq() { return this; }, limit() { return this; },
    then(resolve) { reads += 1; return Promise.resolve(resolve({ data: classifications, error: null })); },
  };
  const startedAt = performance.now();
  const reconciled = await reconcileTaxWorkspaceProjection({
    supabase: { from() { return query; } },
    record: { source_fingerprint: baseline.sourceFingerprint, projection_data: baseline },
    businessId: "business-a",
    taxYear: 2026,
  });
  assert.equal(reads, 1);
  assert.equal(reconciled.evaluatedTransactionCount, 714);
  assert.equal(reconciled.matrixIncludedCount, 690);
  assert.equal(reconciled.outsideDeductionsCount, 24);
  assert.ok(performance.now() - startedAt < 1_000);
});

test("a sparse 713-row live overlay preserves the immutable 714-member production population", async () => {
  const { baseline, classifications, missingId, phoneIds } = productionSparseOverlayFixture();
  let reads = 0;
  const query = {
    select() { return this; }, eq() { return this; }, limit() { return this; },
    then(resolve) { reads += 1; return Promise.resolve(resolve({ data: classifications, error: null })); },
  };
  const startedAt = performance.now();
  const reconciled = await reconcileTaxWorkspaceProjection({
    supabase: { from() { return query; } },
    record: { id: "projection-sparse", source_fingerprint: baseline.sourceFingerprint, projection_data: baseline },
    businessId: "business-a", taxYear: 2026, diagnosticLogger() {}, metricLogger() {},
  });
  assert.ok(performance.now() - startedAt < 5_000);
  assert.equal(reads, 1);
  assert.deepEqual([
    reconciled.evaluatedTransactionCount, reconciled.matrixIncludedCount, reconciled.outsideDeductionsCount,
  ], [714, 690, 24]);
  assert.deepEqual(reconciled.treatmentCounts, { estimated: 276, reviewed: 48, needs_input: 366 });
  assert.deepEqual([
    reconciled.questionGroupCount, reconciled.questionMembershipSum,
    reconciled.questionCoveredUniqueCount, reconciled.questionMembershipOverlapCount,
  ], [7, 310, 310, 0]);
  assert.ok(reconciled.identityEvidence.treatments.needs_input.includes(missingId));
  assert.ok(Object.values(reconciled.identityEvidence.categories).some((ids) => ids.includes(missingId)));
  assert.ok(Object.values(reconciled.identityEvidence.months).some((ids) => ids.includes(missingId)));
  assert.ok(phoneIds.every((id) => reconciled.identityEvidence.treatments.reviewed.includes(id)));
  assert.ok(phoneIds.every((id) => !Object.values(reconciled.identityEvidence.questionGroups).flat().includes(id)));
  const matrixSum = (payload, field) => payload.matrix.reduce((sum, row) => sum + Object.values(row.months)
    .reduce((monthSum, value) => monthSum + Number(value[field] || 0), 0), 0);
  assert.equal(matrixSum(reconciled, "bookExpenseAmount"), matrixSum(baseline, "bookExpenseAmount"));
  assert.equal(reconciled.estimatedDeductibleAmount, baseline.estimatedDeductibleAmount + 260);
  assert.equal(matrixSum(reconciled, "needsInputGrossExpense"), matrixSum(baseline, "needsInputGrossExpense") - 260);
  assert.doesNotThrow(() => projection.validatePayload(reconciled));
  const browserProjection = publicTaxWorkspaceProjection(reconciled);
  assert.doesNotThrow(() => JSON.stringify({ ok: true, data: { state: "complete", projectionVersion: "tax-workspace-v2", projection: browserProjection } }));
  assert.equal(browserProjection.identityEvidence, undefined);
  assert.equal(browserProjection.matrix.reduce((sum, row) => sum + row.transactionCount, 0), 690);
});

test("a persisted-only sparse partition survives the complete v2 route response shape", async () => {
  const { baseline, classifications, missingId } = productionSparseOverlayFixture({ isolatedMissingPartition: true });
  const query = {
    select() { return this; }, eq() { return this; }, limit() { return this; },
    then(resolve) { return Promise.resolve(resolve({ data: classifications, error: null })); },
  };
  const reconciled = await reconcileTaxWorkspaceProjection({
    supabase: { from() { return query; } },
    record: { id: "projection-sparse", source_fingerprint: baseline.sourceFingerprint, projection_data: baseline },
    businessId: "business-a", taxYear: 2026, diagnosticLogger() {}, metricLogger() {},
  });
  const response = {
    state: "complete", projectionId: "projection-sparse", projectionVersion: "tax-workspace-v2",
    projection: publicTaxWorkspaceProjection(reconciled),
  };
  const serialized = JSON.stringify(response);
  assert.doesNotThrow(() => JSON.parse(serialized));
  assert.equal(serialized.includes("projection_baseline_fallback"), false);
  const http = { statusCode: 200, json(body) { this.body = body; return this; } };
  sendTaxSuccess(http, response);
  assert.deepEqual([http.statusCode, http.body.ok, http.body.data.projection.evaluatedTransactionCount], [200, true, 714]);
  assert.ok(reconciled.identityEvidence.categories.isolated_persisted_category.includes(missingId));
  assert.equal(Object.values(reconciled.identityEvidence.questionGroups).flat().includes(missingId), false);
});

test("sparse overlay isolates actionable, outside, and extra membership without weakening invariant failures", async () => {
  const reconcileFixture = async (fixture, mutate = () => {}) => {
    mutate(fixture.classifications);
    let reads = 0;
    const query = { select() { return this; }, eq() { return this; }, limit() { return this; },
      then(resolve) { reads += 1; return Promise.resolve(resolve({ data: fixture.classifications, error: null })); } };
    const value = await reconcileTaxWorkspaceProjection({ supabase: { from() { return query; } },
      record: { id: "projection-sparse", projection_data: fixture.baseline }, businessId: "business-a", taxYear: 2026,
      diagnosticLogger() {}, metricLogger() {} });
    assert.equal(reads, 1);
    return value;
  };

  const actionable = await reconcileFixture(productionSparseOverlayFixture({ missingId: "question-0" }));
  assert.deepEqual([actionable.evaluatedTransactionCount, actionable.matrixIncludedCount, actionable.outsideDeductionsCount], [714, 690, 24]);
  assert.equal(actionable.questionMembershipSum, 310);
  assert.ok(actionable.questionGroups.some((group) => group.state === "temporarily_unavailable" && group.liveOverlayMissingCount === 1));
  assert.doesNotThrow(() => projection.validatePayload(actionable));

  const outside = await reconcileFixture(productionSparseOverlayFixture({ missingId: "outside-0" }));
  assert.deepEqual([outside.evaluatedTransactionCount, outside.matrixIncludedCount, outside.outsideDeductionsCount], [714, 690, 24]);
  assert.doesNotThrow(() => projection.validatePayload(outside));

  for (const [missingId, treatment] of [
    ["estimated-0", "estimated"], ["reviewed-0", "reviewed"], ["missing-nonactionable", "needs_input"],
  ]) {
    const structural = await reconcileFixture(productionSparseOverlayFixture({ missingId }));
    assert.ok(structural.identityEvidence.treatments[treatment].includes(missingId));
    assert.equal(structural.identityEvidence.evaluated.filter((id) => id === missingId).length, 1);
    assert.doesNotThrow(() => projection.validatePayload(structural));
  }

  const extra = await reconcileFixture(productionSparseOverlayFixture(), (rows) => rows.push({
    ...rows[0], transaction_id: "live-extra", source_qbo_txn_id: "live-extra",
  }));
  assert.deepEqual([extra.evaluatedTransactionCount, extra.matrixIncludedCount, extra.outsideDeductionsCount], [714, 690, 24]);

  for (const mutate of [
    (rows) => rows.push({ ...rows[0] }),
    (rows) => rows.push({ ...rows[0], transaction_id: null, source_qbo_txn_id: null }),
    (rows) => rows.push({ ...rows[0], transaction_id: "cross-tenant", business_id: "business-b" }),
    (rows) => rows.push({ ...rows[0], transaction_id: "cross-year", tax_year: 2025 }),
  ]) {
    await assert.rejects(reconcileFixture(productionSparseOverlayFixture(), mutate),
      (error) => error.code === "tax_workspace_live_population_mismatch");
  }
});

function productionSparseOverlayFixture({ missingId = "missing-nonactionable", isolatedMissingPartition = false } = {}) {
  const entries = [];
  const add = (id, outcome, { scope = "expense_cogs_in_matrix", category = "supplies", amount = 10, account = "Supplies" } = {}) => entries.push({
    id, outcome, actionOwner: outcome === "customer_input_required" ? "customer_fact_required" : "none",
    row: { transactionId: id, date: "2026-07-15", taxScopeDisposition: scope, taxCategory: category,
      taxCategoryLabel: category === "utilities" ? "Utilities" : category === "income" ? "Income" : "Supplies",
      qboAccountId: account, qboAccountName: account, signedAmount: scope === "expense_cogs_in_matrix" ? -amount : amount,
      deductibleAmount: outcome === "customer_input_required" || scope !== "expense_cogs_in_matrix" ? null : amount },
  });
  for (let index = 0; index < 276; index += 1) add(`estimated-${index}`, "standard_rule_applied");
  for (let index = 0; index < 43; index += 1) add(`reviewed-${index}`, "reviewed");
  const phoneIds = Array.from({ length: 5 }, (_, index) => `phone-${index}`);
  phoneIds.forEach((id, index) => add(id, "customer_input_required", { category: "utilities", amount: 50 + index, account: "Phone Bill" }));
  const otherQuestionIds = Array.from({ length: 310 }, (_, index) => `question-${index}`);
  const counts = [171, 61, 61, 8, 4, 3, 2];
  const boundaries = counts.reduce((values, count) => [...values, (values.at(-1) || 0) + count], []);
  otherQuestionIds.forEach((id, index) => add(id, "customer_input_required", {
    category: "travel_transportation", account: `Transportation ${boundaries.findIndex((boundary) => index < boundary) + 1}`,
  }));
  add("missing-nonactionable", "ambiguous", {
    amount: 37,
    category: isolatedMissingPartition ? "isolated_persisted_category" : "supplies",
    account: isolatedMissingPartition ? "Persisted-only category" : "Supplies",
  });
  for (let index = 0; index < 55; index += 1) add(`other-input-${index}`, "ambiguous");
  for (let index = 0; index < 24; index += 1) add(`outside-${index}`, "outside_deductions", {
    scope: "posted_non_expense_outside_deductions", category: "income", amount: 20,
  });
  const group = (id, ids, account = id) => ({ id, decisionType: "business_use_confirmation", qboAccountId: account,
    qboAccountName: account, semanticFingerprint: `semantic-${id}`, semanticManifest: { version: 1, id }, ruleVersions: ["v4"],
    transactionCount: ids.length, actionableTransactionCount: ids.length, months: ["2026-07"],
    actionableGrossAmountCents: ids.reduce((sum, memberId) => sum + Math.abs(entries.find((entry) => entry.id === memberId).row.signedAmount) * 100, 0),
    actionableEstimatedDeductibleAmountCents: 0, state: "needs_input", stableTransactionIds: { actionable: ids } });
  let offset = 0;
  const groups = [group("phone", phoneIds, "Phone Bill"), ...counts.map((count, index) => {
    const ids = otherQuestionIds.slice(offset, offset + count); offset += count; return group(`group-${index}`, ids);
  })];
  const baseline = projection.buildPayload({ overview: { projection: { completeness: "complete" }, warnings: [] },
    lifecycle: { entries, activeDecisionGroups: groups }, businessId: "business-a", taxYear: 2026,
    sourceFingerprint: "d".repeat(64), generatedAt: "2026-10-30T12:00:00.000Z" });
  const classifications = entries.filter((entry) => entry.id !== missingId).map((entry) => {
    const phoneReviewed = phoneIds.includes(entry.id);
    return {
      business_id: "business-a", tax_year: 2026, transaction_id: entry.id, transaction_date: entry.row.date,
      tax_category: entry.row.taxCategory, classification_status: phoneReviewed ? "user_confirmed"
        : entry.outcome === "reviewed" ? "user_confirmed" : entry.outcome === "standard_rule_applied" ? "auto_classified" : "needs_review",
      deductibility_status: phoneReviewed || entry.outcome === "reviewed" || entry.outcome === "standard_rule_applied" ? "fully_deductible" : "needs_review",
      deductible_percent: phoneReviewed || entry.outcome === "reviewed" || entry.outcome === "standard_rule_applied" ? 100 : null,
      book_amount: entry.row.signedAmount, deductible_amount: phoneReviewed ? -entry.row.signedAmount : entry.row.deductibleAmount,
      source_qbo_account_id: entry.row.qboAccountId, source_qbo_account_name: entry.row.qboAccountName,
      rule_code: entry.outcome === "customer_input_required" ? "business_use_review"
        : entry.outcome === "ambiguous" ? null : "standard",
      rule_version: "v4", requires_review: entry.outcome === "customer_input_required" || entry.outcome === "ambiguous",
      source: phoneReviewed ? "user" : entry.outcome === "ambiguous" ? null : "rule_engine",
      metadata: { tax_scope_disposition: entry.row.taxScopeDisposition },
    };
  });
  return { baseline, classifications, missingId, phoneIds };
}

test("saved decision with a failed workspace refresh remains saved and exposes a retry", () => {
  const dashboard = read("src/pages/Tax/TaxDashboard.jsx");
  assert.match(dashboard, /decision saved[^\n]*workspace refresh failed/i);
  assert.match(dashboard, /Retry workspace refresh/);
});

test("Phone Bill transition conserves 690 identities and moves five Utilities memberships from needs input to reviewed", () => {
  const entries = [];
  const add = (id, outcome, category = "supplies", amount = 10) => entries.push({
    id, outcome, actionOwner: outcome === "customer_input_required" ? "customer_fact_required" : "none",
    row: { transactionId: id, taxScopeDisposition: "expense_cogs_in_matrix", taxCategory: category,
      taxCategoryLabel: category === "utilities" ? "Utilities" : "Supplies", date: "2026-07-15",
      signedAmount: -amount, deductibleAmount: outcome === "customer_input_required" ? null : amount },
  });
  for (let index = 0; index < 276; index += 1) add(`estimated-${index}`, "standard_rule_applied");
  for (let index = 0; index < 43; index += 1) add(`reviewed-${index}`, "reviewed");
  const phoneIds = Array.from({ length: 5 }, (_, index) => `phone-${index}`);
  phoneIds.forEach((id, index) => add(id, "customer_input_required", "utilities", 50 + index));
  const otherQuestionIds = Array.from({ length: 310 }, (_, index) => `question-${index}`);
  otherQuestionIds.forEach((id, index) => add(id, "customer_input_required", index < 2 ? "utilities" : "supplies"));
  for (let index = 0; index < 56; index += 1) add(`other-input-${index}`, "ambiguous");
  assert.equal(entries.length, 690);

  const group = (id, ids) => ({ id, decisionType: "business_use_percent", qboAccountId: id,
    qboAccountName: id, semanticFingerprint: `semantic-${id}`, semanticManifest: { version: 1, id }, ruleVersions: ["v4"],
    transactionCount: ids.length, actionableTransactionCount: ids.length, months: ["2026-07"],
    actionableGrossAmountCents: ids.length * 1000, actionableEstimatedDeductibleAmountCents: 0,
    state: "needs_input", stableTransactionIds: { actionable: ids } });
  const counts = [171, 61, 61, 8, 4, 3, 2];
  let offset = 0;
  const otherGroups = counts.map((count, index) => {
    const ids = otherQuestionIds.slice(offset, offset + count); offset += count;
    return group(`other-${index}`, ids);
  });
  const overview = { meta: { generatedAt: "2026-10-30T12:00:00.000Z" }, projection: { completeness: "complete" }, warnings: [] };
  const before = projection.buildPayload({ overview, lifecycle: { entries, activeDecisionGroups: [group("phone", phoneIds), ...otherGroups] },
    businessId: "business-a", taxYear: 2026, sourceFingerprint: "a".repeat(64), generatedAt: overview.meta.generatedAt });

  const answeredEntries = entries.map((entry) => phoneIds.includes(entry.id)
    ? { ...entry, outcome: "reviewed", actionOwner: "none", row: { ...entry.row, deductibleAmount: -entry.row.signedAmount } }
    : entry);
  const after = projection.buildPayload({ overview, lifecycle: { entries: answeredEntries, activeDecisionGroups: otherGroups },
    businessId: "business-a", taxYear: 2026, sourceFingerprint: "b".repeat(64), generatedAt: overview.meta.generatedAt });

  assert.deepEqual([before.matrixIncludedCount, before.treatmentCounts.reviewed, before.treatmentCounts.needs_input,
    before.questionGroupCount, before.questionCoveredUniqueCount], [690, 43, 371, 8, 315]);
  assert.deepEqual([after.matrixIncludedCount, after.treatmentCounts.reviewed, after.treatmentCounts.needs_input,
    after.questionGroupCount, after.questionCoveredUniqueCount], [690, 48, 366, 7, 310]);
  const beforeUtilities = before.matrix.find((row) => row.categoryKey === "utilities").months["2026-07"];
  const afterUtilities = after.matrix.find((row) => row.categoryKey === "utilities").months["2026-07"];
  assert.deepEqual([beforeUtilities.reviewedTransactionCount, beforeUtilities.needsInputTransactionCount], [0, 7]);
  assert.deepEqual([afterUtilities.reviewedTransactionCount, afterUtilities.needsInputTransactionCount], [5, 2]);
  assert.equal(afterUtilities.reviewedDeductibleAmount, 260);
  assert.equal(afterUtilities.needsInputGrossExpense, 20);
  assert.doesNotThrow(() => projection.validatePayload(after));
});
