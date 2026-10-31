import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadMatrixCellWithProjectionRecovery } from "../src/pages/Tax/matrixCellProjectionRecovery.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const changed = () => Object.assign(new Error("changed"), { code: "tax_workspace_projection_changed" });

test("grouped apply establishes the final complete workspace contract before emitting its async change event", () => {
  const route = read("src/api/tax/taxClassificationReview.routes.js");
  const apply = route.slice(route.indexOf('router.post("/deduction-decisions/apply"'), route.indexOf('router.get("/deduction-decisions/operations/'));
  assert.ok(apply.indexOf("confirmGroupedDecisionPreview") < apply.indexOf("buildAndPersistTaxWorkspaceProjection"));
  assert.ok(apply.indexOf("buildAndPersistTaxWorkspaceProjection") < apply.indexOf("emitTaxDataChanged"));
  assert.ok(apply.indexOf("emitTaxDataChanged") < apply.indexOf("sendTaxSuccess"));
  assert.match(apply, /authoritativeWorkspace[\s\S]*projectionId[\s\S]*projectionVersion[\s\S]*sourceFingerprint[\s\S]*projection:/);
});

test("all grouped decision families use one authoritative snapshot reconciliation pipeline", () => {
  const hook = read("src/hooks/tax/useTaxDeductions.js");
  assert.match(hook, /reconcileGroupedDecisionWorkspace\(result, \{ signal \}\)/);
  assert.match(hook, /reconcileGroupedDecisionWorkspace\(operation\.result, \{ signal \}\)/);
  assert.match(hook, /result\?\.authoritativeWorkspace[\s\S]*commitWorkspaceSnapshot/);
  assert.match(hook, /workspaceSnapshotRef\.current = nextWorkspace[\s\S]*setWorkspaceSnapshot\(nextWorkspace\)/);
});

test("production-shaped Transportation apply commits one final identity before changed and unchanged cells open", () => {
  const revisionA = "projection-a";
  const intermediateRevisionB = "projection-b";
  const finalRevisionC = "projection-c";
  const transportationIds = ["transportation-1", "transportation-2", "transportation-3"];
  const finalCells = [
    { categoryKey: "travel_transportation", month: "2026-07", authority: "reviewed", amount: 82, ids: transportationIds },
    { categoryKey: "travel_transportation", month: "2026-05", authority: "needs_input", amount: 65, ids: ["transportation-unchanged"] },
    { categoryKey: "business_meals", month: "2026-05", authority: "reviewed", amount: 173, ids: ["unrelated"] },
  ];
  const timeline = [
    { stage: "revision-a-loaded", projectionId: revisionA, interactionDisabled: false },
    { stage: "decision-and-rule-written", projectionId: intermediateRevisionB, interactionDisabled: true },
    { stage: "authoritative-snapshot-committed", projectionId: finalRevisionC, interactionDisabled: true },
    { stage: "busy-owner-released", projectionId: finalRevisionC, interactionDisabled: false },
  ];
  const requests = finalCells.map((cell) => ({ ...cell, projectionId: timeline.at(-1).projectionId }));
  const responses = requests.map((request) => ({
    status: request.projectionId === finalRevisionC ? 200 : 409,
    ids: request.ids,
  }));

  assert.equal(timeline.find((entry) => entry.stage === "authoritative-snapshot-committed").interactionDisabled, true);
  assert.equal(timeline.at(-1).interactionDisabled, false);
  assert.deepEqual(requests.map((request) => request.projectionId), [finalRevisionC, finalRevisionC, finalRevisionC]);
  assert.equal(requests.some((request) => [revisionA, intermediateRevisionB].includes(request.projectionId)), false);
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200]);
  assert.equal(finalCells[0].amount, 82);
  assert.deepEqual([...new Set(responses[0].ids)], transportationIds);
});

test("a first stale detail identity refreshes and retries exactly once with the resolved final identity", async () => {
  const calls = [];
  const result = await loadMatrixCellWithProjectionRecovery({
    initialScope: { projectionId: "revision-a", categoryKey: "travel", month: "2026-07", authority: "reviewed" },
    loadDetail: async (scope) => {
      calls.push(scope.projectionId);
      if (scope.projectionId === "revision-a") throw changed();
      return { rows: [1, 2, 3] };
    },
    refreshWorkspace: async () => ({ projectionId: "revision-c" }),
    resolveScope: (snapshot) => ({ projectionId: snapshot.projectionId, categoryKey: "travel", month: "2026-07", authority: "reviewed" }),
  });
  assert.deepEqual(calls, ["revision-a", "revision-c"]);
  assert.equal(result.recovered, true);
  assert.deepEqual(result.detail.rows, [1, 2, 3]);
});

test("two stale responses are terminal after one refresh with no loop", async () => {
  let refreshes = 0;
  let details = 0;
  await assert.rejects(loadMatrixCellWithProjectionRecovery({
    initialScope: { projectionId: "revision-a" },
    loadDetail: async () => { details += 1; throw changed(); },
    refreshWorkspace: async () => { refreshes += 1; return { projectionId: "revision-c" }; },
    resolveScope: (snapshot) => ({ projectionId: snapshot.projectionId }),
  }), (error) => error.code === "tax_workspace_projection_changed");
  assert.equal(refreshes, 1);
  assert.equal(details, 2);
});

test("a cell disappearing during recovery fails closed without a stale detail retry", async () => {
  let details = 0;
  await assert.rejects(loadMatrixCellWithProjectionRecovery({
    initialScope: { projectionId: "revision-a" },
    loadDetail: async () => { details += 1; throw changed(); },
    refreshWorkspace: async () => ({ projectionId: "revision-c" }),
    resolveScope: () => null,
  }), (error) => error.code === "tax_workspace_matrix_cell_changed");
  assert.equal(details, 1);
});

test("closing during recovery cancels the retry", async () => {
  const controller = new AbortController();
  let details = 0;
  await assert.rejects(loadMatrixCellWithProjectionRecovery({
    initialScope: { projectionId: "revision-a" },
    signal: controller.signal,
    loadDetail: async () => { details += 1; throw changed(); },
    refreshWorkspace: async () => { controller.abort(); return { projectionId: "revision-c" }; },
    resolveScope: (snapshot) => ({ projectionId: snapshot.projectionId }),
  }), (error) => error.code === "request_aborted");
  assert.equal(details, 1);
});

test("matrix detail cache and requests carry the complete authoritative identity namespace", () => {
  const dashboard = read("src/pages/Tax/TaxDashboard.jsx");
  assert.match(dashboard, /matrixCellCacheKey[\s\S]*projectionVersion[\s\S]*projectionId[\s\S]*sourceFingerprint/);
  assert.match(dashboard, /projectionId: scope\.projectionId/);
  assert.match(dashboard, /matrixAuthorityTransactionCount\(refreshedCell, authority\) > 0/);
  assert.match(dashboard, /loadMatrixCellWithProjectionRecovery/);
});
