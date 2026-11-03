import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { buildTaxDeductionsLifecycleProjection } from "../src/services/tax/taxDeductionsLifecycleProjection.js";
import { mapDeductionTransactionRow } from "../src/components/Tax/Deductions/deductionsWorkspaceViewModel.js";
import { __taxWorkspaceProjectionTestInternals as projection, reconcileTaxWorkspaceProjection } from "../src/services/tax/taxWorkspaceProjection.service.js";
import { createGroupedDecisionPreview, __testables } from "../src/services/tax/taxGroupedDecisionPreview.service.js";
import { taxMembershipDiagnostics } from "../src/services/tax/taxPreviewDiagnostics.js";

const businessId = "00000000-0000-4000-8000-000000000010";
function fixture() {
  const gas = Array.from({ length: 77 }, (_, i) => ({ transaction_id: `gas-${String(i).padStart(3, "0")}`,
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

test("real Gas preview uses the displayed 76-member live question over the same immutable projection", async () => {
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
  const result = await preview(f, diagnostics);
  assert.equal(result.actionableCount, 76);
  assert.equal(result.matrixReconciliation.questionTransactionCount, 76);
  assert.equal(result.matrixReconciliation.matrixTransactionCount, 97);
  assert.equal(diagnostics.expectedMemberCount, 76);
  assert.equal(diagnostics.currentMemberCount, 76);
  assert.equal(diagnostics.addedCount, 0);
  assert.equal(diagnostics.removedCount, 0);
  assert.equal(diagnostics.duplicateCount, 0);
  assert.equal(diagnostics.expectedMemberHash, diagnostics.currentMemberHash);
  assert.equal(diagnostics.membershipComparisonStage, "matrix_reconciliation");
  assert.equal(diagnostics.storedMemberCount, 77);
  assert.notEqual(diagnostics.storedMemberHash, diagnostics.expectedMemberHash);
  assert.deepEqual(result.transactions.map((row) => row.transactionId).sort(), workspace.identityEvidence.questionGroups[f.groupId]);
});

test("a genuinely new Gas member outside the immutable population still rejects", async () => {
  const f = fixture();
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
