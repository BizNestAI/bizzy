import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { __testables } from "../src/services/tax/taxGroupedDecisionPreview.service.js";
import { taxDiagnosticFingerprint, taxDiagnosticIdentity } from "../src/services/tax/taxPreviewDiagnostics.js";

const businessId = "00000000-0000-4000-8000-000000000010";
const current = {
  id: "P2", business_id: businessId, tax_year: 2026, projection_version: "tax-workspace-v2",
  status: "complete", generated_at: "2026-11-03", source_fingerprint: "stored-F2",
  projection_data: { questionGroups: [{ id: "semantic:gas" }] },
};

for (const [name, projectionId, fingerprint, rows, comparison] of [
  ["missing current projection", "P1", "F1", [], "current_projection_missing"],
  ["old projection ID", "P1", "F1", [current], "projection_id_mismatch"],
  ["matching ID and different fingerprint", "P2", "live-F2", [current], "source_fingerprint_mismatch"],
]) test(`preview diagnostics distinguish ${name} without changing the 409 contract`, async () => {
  const diagnostics = {};
  await assert.rejects(__testables.requireCurrentWorkspaceProjection({
    supabase: { store: { tax_workspace_projections: rows } }, businessId, taxYear: 2026,
    projectionId, sourceFingerprint: fingerprint, groupId: "semantic:gas", diagnostics,
  }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "grouped_decision_projection_stale");
    assert.deepEqual(error.details, { action: "refresh_tax_deductions" });
    return true;
  });
  assert.equal(diagnostics.stage, "current_projection_identity");
  assert.equal(diagnostics.failedComparison, comparison);
  assert.equal(diagnostics.suppliedProjectionId, projectionId);
  assert.equal(diagnostics.suppliedSourceFingerprintHash, taxDiagnosticFingerprint(fingerprint));
  assert.equal(diagnostics.currentSourceFingerprintHash, rows.length ? taxDiagnosticFingerprint(current.source_fingerprint) : null);
  assert.equal(diagnostics.resolvedGroupId, rows.length ? "semantic:gas" : null);
});

test("matching identity is still accepted and a missing projected group is observable", async () => {
  const diagnostics = {};
  assert.equal(await __testables.requireCurrentWorkspaceProjection({
    supabase: { store: { tax_workspace_projections: [current] } }, businessId, taxYear: 2026,
    projectionId: "P2", sourceFingerprint: "stored-F2", groupId: "removed:gas", diagnostics,
  }), current);
  assert.equal(diagnostics.failedComparison, undefined);
  assert.equal(diagnostics.suppliedGroupId, "removed:gas");
  assert.equal(diagnostics.resolvedGroupId, null);
});

for (const comparison of ["matrix_category_missing", "question_membership_mismatch", "question_outside_category"]) {
  test(`matrix diagnostics distinguish ${comparison} from the initial identity guard`, () => {
    const diagnostics = {};
    const payload = {
      matrix: comparison === "matrix_category_missing" ? [] : [{ categoryKey: "vehicle_expense" }],
      identityEvidence: {
        questionGroups: { "semantic:gas": comparison === "question_membership_mismatch" ? ["different"] : ["gas-1"] },
        categories: { vehicle_expense: comparison === "question_outside_category" ? [] : ["gas-1"] },
      },
    };
    assert.throws(() => __testables.matrixReconciliation({
      record: { group_id: "semantic:gas" }, actionable: [{ transaction_id: "gas-1", tax_category: "vehicle_expense" }],
      workspaceProjection: { projection_data: payload }, diagnostics,
    }), { code: "grouped_decision_projection_stale", status: 409 });
    assert.equal(diagnostics.stage, "matrix_reconciliation");
    assert.equal(diagnostics.failedComparison, comparison);
  });
}

test("preview route correlates rejecting stage and hashes without logging request payloads", async (t) => {
  process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
  const { default: router } = await import("../src/api/tax/taxClassificationReview.routes.js");
  const records = [];
  t.mock.method(console, "warn", (...args) => records.push(args));
  const query = { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: { id: businessId, user_id: "owner" }, error: null }; } };
  const supabase = { store: { tax_workspace_projections: [current] }, from(table) {
    assert.equal(table, "business_profiles"); return query;
  } };
  const req = {
    id: "request-preview-409", headers: { authorization: "Bearer never-log-this", cookie: "never-log-cookie" },
    tenantContext: { businessId }, user: { id: "owner" }, query: { businessId, year: "2026" },
    body: { businessId, year: 2026, groupId: "semantic:gas", projectionId: "P2", sourceFingerprint: "live-F2", description: "never-log-merchant", amount: "never-log-amount" },
    app: { locals: { supabase } },
  };
  let status, body;
  const res = { req, set() { return this; }, status(value) { status = value; return this; }, json(value) { body = value; return this; } };
  const handler = router.stack.find((layer) => layer.route?.path === "/deduction-decisions/preview").route.stack[0].handle;
  await handler(req, res);
  assert.equal(status, 409); assert.equal(body.error, "grouped_decision_projection_stale");
  const [label, diagnostic] = records[0];
  assert.equal(label, "[tax-grouped-deduction-decision]");
  assert.equal(diagnostic.requestId, req.id);
  assert.equal(diagnostic.route, "POST /api/tax/deduction-decisions/preview");
  assert.equal(diagnostic.stage, "current_projection_identity");
  assert.equal(diagnostic.failedComparison, "source_fingerprint_mismatch");
  assert.equal(diagnostic.suppliedProjectionId, "P2");
  assert.equal(diagnostic.currentProjectionId, "P2");
  assert.equal(diagnostic.currentSourceFingerprintHash, taxDiagnosticFingerprint("stored-F2"));
  assert.equal(diagnostic.suppliedSourceFingerprintHash, taxDiagnosticFingerprint("live-F2"));
  assert.equal(diagnostic.workspacePublicationState, "not_read_by_preview");
  assert.ok(diagnostic.elapsedMs >= 0);
  assert.doesNotMatch(JSON.stringify(records), /never-log|live-F2|stored-F2|authorization|cookie/);
});

test("diagnostic identities are bounded and fingerprints are deterministic non-secret hashes", () => {
  assert.equal(taxDiagnosticFingerprint(null), null);
  assert.match(taxDiagnosticFingerprint("fingerprint"), /^[a-f0-9]{24}$/);
  assert.equal(taxDiagnosticIdentity("P1\r\n\t"), "P1");
  assert.equal(taxDiagnosticIdentity("x".repeat(1000)).length, 512);
});
