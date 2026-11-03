import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { buildTaxDeductionsLifecycleProjection } from "../src/services/tax/taxDeductionsLifecycleProjection.js";
import { mapDeductionTransactionRow } from "../src/components/Tax/Deductions/deductionsWorkspaceViewModel.js";
import { __taxWorkspaceProjectionTestInternals as projection, reconcileTaxWorkspaceProjection } from "../src/services/tax/taxWorkspaceProjection.service.js";
import { createGroupedDecisionPreview, __testables } from "../src/services/tax/taxGroupedDecisionPreview.service.js";
import { taxMembershipDiagnostics } from "../src/services/tax/taxPreviewDiagnostics.js";

const businessId = "00000000-0000-4000-8000-000000000010";
function fixture({ gasCount = 77, protectedOverrideCount = 0 } = {}) {
  const gas = Array.from({ length: gasCount }, (_, i) => ({ transaction_id: `gas-${String(i).padStart(3, "0")}`,
    business_id: businessId, tax_year: 2026, transaction_date: "2026-07-15", book_amount: -25,
    source_qbo_account_id: "1150040010", source_qbo_account_name: "Gas", tax_category: "vehicle_expense",
    classification_status: "needs_review", requires_review: true, user_override: false, cpa_override: false,
    tax_treatment: { type: "vehicle_expense" }, deductibility_status: "needs_review", deductible_percent: null,
    rule_code: "vehicle_method_review", rule_version: "bizzi-gl-2026-v4", source: "rule_engine", metadata: {},
  }));
  const other = Array.from({ length: 20 }, (_, i) => ({ ...gas[0], transaction_id: `other-${i}`,
    source_qbo_account_id: "other-vehicle", source_qbo_account_name: "Other Vehicle",
    classification_status: "user_confirmed", requires_review: false, user_override: true,
    deductibility_status: "fully_deductible", deductible_percent: 100, deductible_amount: 25 }));
  const baselineRows = [...gas, ...other];
  const lifecycle = buildTaxDeductionsLifecycleProjection({ businessId, taxYear: 2026,
    rows: baselineRows.map((row) => mapDeductionTransactionRow({ ...row, taxScopeDisposition: "expense_cogs_in_matrix" })) });
  const payload = projection.buildPayload({ businessId, taxYear: 2026, lifecycle,
    overview: { projection: { completeness: "complete" }, warnings: [] }, sourceFingerprint: "stored-gas-fingerprint",
    generatedAt: "2026-11-03T12:00:00.000Z" });
  const record = { id: "b89dcfba-3f08-47cd-be86-8e014242ca42", business_id: businessId, tax_year: 2026,
    projection_version: "tax-workspace-v2", source_fingerprint: payload.sourceFingerprint, projection_data: payload,
    status: "complete", generated_at: payload.generatedAt };
  const live = baselineRows.map((row) => row.transaction_id === "gas-076"
    ? { ...row, classification_status: "user_confirmed", requires_review: false, user_override: true,
      deductibility_status: "fully_deductible", deductible_percent: 100, deductible_amount: 25 } : { ...row });
  live.slice(0, protectedOverrideCount).forEach((row) => { row.user_override = true; });
  const db = { store: { tax_workspace_projections: [record] }, from(table) {
    let ids;
    const query = { select() { return this; }, eq() { return this; }, order() { return this; }, range() { return this; },
      limit() { return this; }, gte() { return this; }, lte() { return this; },
      in(_key, values) { ids = values; return this; },
      insert() { return Promise.resolve({ error: null }); },
      async maybeSingle() { return { data: { id: businessId, user_id: "owner" }, error: null }; },
      then(resolve) { return Promise.resolve(resolve({ error: null, data: table === "transaction_tax_classifications" ? live
        : table === "bank_transactions" ? live.filter((row) => ids.includes(row.transaction_id)).map((row) => ({
          id: row.transaction_id, date: row.transaction_date, amount: row.book_amount, name: "private-description" })) : [] })); },
    };
    return query;
  } };
  const groupId = payload.questionGroups.find((group) => group.qboAccountName === "Gas").id;
  return { db, record, live, groupId };
}
const preview = (f, diagnostics = {}) => createGroupedDecisionPreview({ supabase: f.db, businessId, taxYear: 2026,
  projectionId: f.record.id, sourceFingerprint: f.record.source_fingerprint, groupId: f.groupId,
  actor: { userId: "owner", source: "user" }, diagnostics });

test("live reconciliation cannot authorize unpublished membership under the old projection identity", async () => {
  const f = fixture();
  const workspace = await reconcileTaxWorkspaceProjection({ supabase: f.db, record: f.record, businessId, taxYear: 2026 });
  assert.equal(f.record.projection_data.identityEvidence.questionGroups[f.groupId].length, 77);
  assert.equal(workspace.identityEvidence.questionGroups[f.groupId].length, 76);
  assert.equal(workspace.sourceFingerprint, f.record.source_fingerprint);
  const before = {};
  assert.throws(() => __testables.matrixReconciliation({ record: { group_id: f.groupId },
    actionable: f.live.filter((row) => row.classification_status === "needs_review"), workspaceProjection: f.record, diagnostics: before }),
  { code: "grouped_decision_projection_stale" });
  assert.equal(before.expectedMemberCount, 77);
  assert.equal(before.currentMemberCount, 76);
  assert.equal(before.removedCount, 1);
  assert.equal(before.addedCount, 0);
  assert.equal(before.duplicateCount, 0);
  assert.equal(before.stage, "matrix_reconciliation");
  const diagnostics = {};
  await assert.rejects(preview(f, diagnostics), { code: "grouped_decision_projection_stale", status: 409 });
  assert.equal(diagnostics.expectedMemberCount, 77);
  assert.equal(diagnostics.currentMemberCount, 76);
  assert.equal(diagnostics.addedCount, 0);
  assert.equal(diagnostics.removedCount, 1);
  assert.equal(diagnostics.duplicateCount, 0);
  assert.notEqual(diagnostics.expectedMemberHash, diagnostics.currentMemberHash);
  assert.equal(diagnostics.membershipComparisonStage, "matrix_reconciliation");
  assert.equal(diagnostics.storedMemberCount, 77);
  assert.equal(diagnostics.storedMemberHash, diagnostics.expectedMemberHash);
});

test("a genuinely new Gas member outside the immutable population still rejects", async () => {
  const f = fixture();
  f.record.projection_data = await reconcileTaxWorkspaceProjection({ supabase: f.db, record: f.record, businessId, taxYear: 2026 });
  f.live.push({ ...f.live[0], transaction_id: "new-gas-outside-projection" });
  const diagnostics = {};
  await assert.rejects(preview(f, diagnostics), { code: "grouped_decision_projection_stale", status: 409 });
  assert.equal(diagnostics.failedComparison, "question_membership_mismatch");
  assert.equal(diagnostics.stage, "matrix_reconciliation");
  assert.equal(diagnostics.expectedMemberCount, 76);
  assert.equal(diagnostics.currentMemberCount, 77);
  assert.equal(diagnostics.addedCount, 1);
  assert.equal(diagnostics.removedCount, 0);
  assert.notEqual(diagnostics.expectedMemberHash, diagnostics.currentMemberHash);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-description|new-gas-outside-projection/);
});

test("matrix guard retains exact membership, duplicate, null and category rejection", () => {
  const f = fixture();
  for (const mutation of [
    (ids) => ids.slice(1),
    (ids) => [...ids.slice(1), "different-member"],
    (ids) => [...ids, ids[0]],
    (ids) => [...ids.slice(1), null],
    (ids) => ids.map((id) => ` ${id} `),
  ]) {
    const payload = structuredClone(f.record.projection_data);
    payload.identityEvidence.questionGroups[f.groupId] = mutation(payload.identityEvidence.questionGroups[f.groupId]);
    assert.throws(() => __testables.matrixReconciliation({ record: { group_id: f.groupId },
      actionable: f.live.filter((row) => row.classification_status === "needs_review").concat({ ...f.live[0], transaction_id: "gas-076" }),
      workspaceProjection: { projection_data: payload } }), { code: "grouped_decision_projection_stale" });
  }
  const payload = structuredClone(f.record.projection_data);
  payload.identityEvidence.categories.vehicle_expense = [];
  const diagnostics = {};
  assert.throws(() => __testables.matrixReconciliation({ record: { group_id: f.groupId },
    actionable: f.live.filter((row) => row.classification_status === "needs_review").concat({ ...f.live[0], transaction_id: "gas-076" }),
    workspaceProjection: { projection_data: payload }, diagnostics }), { code: "grouped_decision_projection_stale" });
  assert.equal(diagnostics.failedComparison, "question_outside_category");
});

test("membership changed between the workspace snapshot and live preview read still rejects", async () => {
  const f = fixture();
  f.record.projection_data = await reconcileTaxWorkspaceProjection({ supabase: f.db, record: f.record, businessId, taxYear: 2026 });
  const from = f.db.from.bind(f.db);
  let reads = 0;
  f.db.from = (table) => {
    if (table === "transaction_tax_classifications" && ++reads === 2) {
      Object.assign(f.live[0], { classification_status: "user_confirmed", user_override: true, requires_review: false });
    }
    return from(table);
  };
  const diagnostics = {};
  await assert.rejects(preview(f, diagnostics), { code: "grouped_decision_projection_stale", status: 409 });
  assert.equal(diagnostics.failedComparison, "question_membership_mismatch");
  assert.equal(diagnostics.expectedMemberCount, 76);
  assert.equal(diagnostics.currentMemberCount, 75);
  assert.equal(diagnostics.addedCount, 0);
  assert.equal(diagnostics.removedCount, 1);
});

test("set diagnostics normalize order and whitespace without leaking IDs or hiding invalid/duplicate counts", () => {
  const diagnostics = taxMembershipDiagnostics([" private-id-b ", "private-id-a", "private-id-a", null, ""], ["private-id-a", "private-id-b"]);
  assert.equal(diagnostics.expectedMemberCount, 2);
  assert.equal(diagnostics.currentMemberCount, 2);
  assert.equal(diagnostics.duplicateCount, 1);
  assert.equal(diagnostics.expectedInvalidCount, 2);
  assert.equal(diagnostics.expectedMemberHash, diagnostics.currentMemberHash);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-id/);
});

test("real preview route logs bounded matrix set diagnostics for genuinely stale Gas membership", async (t) => {
  process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
  const { default: router } = await import("../src/api/tax/taxClassificationReview.routes.js");
  const f = fixture();
  f.record.projection_data = await reconcileTaxWorkspaceProjection({ supabase: f.db, record: f.record, businessId, taxYear: 2026 });
  f.live.push({ ...f.live[0], transaction_id: "private-new-gas" });
  const logs = [];
  t.mock.method(console, "warn", (...args) => logs.push(args));
  const req = { id: "gas-matrix-request", headers: { authorization: "private-credential" }, query: {},
    tenantContext: { businessId }, user: { id: "owner" }, app: { locals: { supabase: f.db } },
    body: { businessId, year: 2026, groupId: f.groupId, projectionId: f.record.id, sourceFingerprint: f.record.source_fingerprint } };
  let status, body;
  const res = { req, set() { return this; }, status(value) { status = value; return this; }, json(value) { body = value; return this; } };
  await router.stack.find((layer) => layer.route?.path === "/deduction-decisions/preview").route.stack[0].handle(req, res);
  assert.equal(status, 409);
  assert.equal(body.error, "grouped_decision_projection_stale");
  const diagnostic = logs.find(([label]) => label === "[tax-grouped-deduction-decision]")[1];
  assert.equal(diagnostic.requestId, req.id);
  assert.equal(diagnostic.stage, "matrix_reconciliation");
  assert.equal(diagnostic.failedComparison, "question_membership_mismatch");
  assert.equal(diagnostic.expectedMemberCount, 76);
  assert.equal(diagnostic.currentMemberCount, 77);
  assert.equal(diagnostic.addedCount, 1);
  assert.equal(diagnostic.removedCount, 0);
  assert.equal(diagnostic.duplicateCount, 0);
  assert.notEqual(diagnostic.expectedMemberHash, diagnostic.currentMemberHash);
  assert.doesNotMatch(JSON.stringify(logs), /private-|book_amount|authorization/);
});

test("six protected overrides rebuild and publish a distinct 70-member Gas projection through the recovery queue", async (t) => {
  const { recoverTaxWorkspaceProjection } = await import("../src/services/tax/taxWorkspaceRecovery.js");
  const { processTaxWorkspaceProjectionRequests } = await import("../src/services/tax/processTaxWorkspaceProjectionRequests.js");
  const { getLatestTaxWorkspaceProjection } = await import("../src/services/tax/taxWorkspaceProjection.service.js");
  process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
  const { default: router } = await import("../src/api/tax/taxWorkspace.routes.js");
  const f = fixture({ gasCount: 76, protectedOverrideCount: 6 });
  await assert.rejects(preview(f), { code: "grouped_decision_projection_stale", status: 409 });
  const actionable = f.live.filter((row) => row.source_qbo_account_name === "Gas" && !row.user_override);
  const before = {};
  assert.throws(() => __testables.matrixReconciliation({ record: { group_id: f.groupId }, actionable,
    workspaceProjection: f.record, diagnostics: before }), { code: "grouped_decision_projection_stale", status: 409 });
  assert.deepEqual([before.expectedMemberCount, before.currentMemberCount, before.removedCount], [76, 70, 6]);
  // Status and requires_review still say needs_review: the override flag owns protection.
  assert.ok(f.live.slice(0, 6).every((row) => row.classification_status === "needs_review" && row.requires_review));
  const corrected = await reconcileTaxWorkspaceProjection({ supabase: f.db, record: f.record, businessId, taxYear: 2026 });
  assert.equal(corrected.questionGroups.find((group) => group.id === f.groupId).actionableTransactionCount, 70);
  const oldMapped = f.live.map((row) => {
    const mapped = mapDeductionTransactionRow({ ...row, taxScopeDisposition: "expense_cogs_in_matrix" });
    delete mapped.userOverride; delete mapped.cpaOverride;
    return mapped;
  });
  const beforeLifecycle = buildTaxDeductionsLifecycleProjection({ rows: oldMapped, businessId, taxYear: 2026 });
  assert.equal(beforeLifecycle.activeDecisionGroups.find((group) => group.id === f.groupId).actionableTransactionCount, 76);
  const fingerprintArgs = { overview: {}, rows: [], classificationRows: f.live };
  const newFingerprint = projection.fingerprint(fingerprintArgs);
  assert.notEqual(newFingerprint, projection.fingerprint({ ...fingerprintArgs,
    classificationRows: f.live.map((row) => ({ ...row, user_override: false })) }));
  f.db.store.business_billing = [{ business_id: businessId, subscription_status_test: "active", subscription_status_live: "active" }];
  let posts = 0, reads = 0;
  t.mock.method(console, "info", () => {});
  const initialId = f.record.id;
  const replacement = await recoverTaxWorkspaceProjection({ previousProjectionId: initialId, pollMs: 1,
    requestRebuild: async ({ previousProjectionId }) => {
      posts += 1;
      const req = { headers: {}, tenantContext: { businessId }, user: { id: "owner" }, query: {},
        body: { businessId, year: 2026, previousProjectionId }, app: { locals: { supabase: f.db } } };
      let body;
      const res = { set() { return this; }, status() { return this; }, json(value) { body = value; return this; } };
      await router.stack.find((layer) => layer.route?.path === "/workspace/refresh").route.stack[0].handle(req, res);
      assert.equal(body.ok, true, JSON.stringify(body));
      assert.equal(f.db.store.tax_workspace_projection_requests[0].reason, "grouped_preview_stale");
      // No outbox table/function is available in this fixture.
      assert.equal(f.db.store.tax_bookkeeping_change_outbox, undefined);
    },
    readWorkspace: async () => {
      reads += 1;
      const latest = await getLatestTaxWorkspaceProjection({ supabase: f.db, businessId, taxYear: 2026 });
      if (reads === 2) {
        const work = await processTaxWorkspaceProjectionRequests({ supabase: f.db, workerId: "test-workspace",
          buildProjection: async () => {
            const payload = { ...corrected, sourceFingerprint: newFingerprint, generatedAt: "2026-11-04T12:00:00.000Z" };
            const persisted = await projection.persist({ supabase: f.db, payload });
            return { projectionId: persisted.id };
          } });
        assert.equal(work.completed, 1);
      }
      return { projectionId: latest.id, sourceFingerprint: latest.source_fingerprint, projection: latest.projection_data };
    },
  });
  assert.equal(posts, 1);
  assert.equal(reads, 3, "the old completed projection is polled, never accepted as replacement");
  assert.notEqual(replacement.projectionId, initialId);
  assert.equal(replacement.projection.questionGroups.find((group) => group.id === f.groupId).actionableTransactionCount, 70);
  f.record = f.db.store.tax_workspace_projections.find((record) => record.id === replacement.projectionId);
  const result = await preview(f);
  assert.equal(result.actionableCount, 70);
  assert.equal(result.transactions.length, 70);
  assert.equal(f.db.store.tax_grouped_deduction_decision_operations, undefined, "no decision is submitted during rebuild recovery");
});
