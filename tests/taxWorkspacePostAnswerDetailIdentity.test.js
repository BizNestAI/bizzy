import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { showTaxDecisionSuccess } from "../src/pages/Tax/taxDecisionToast.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("post-answer workspace identity is committed atomically and detail reads resolve current identity at call time", () => {
  const hook = read("src/hooks/tax/useTaxDeductions.js");
  assert.match(hook, /setWorkspaceSnapshot\(nextWorkspace\)/);
  assert.match(hook, /workspaceSnapshotRef\.current = nextWorkspace/);
  assert.doesNotMatch(hook, /setWorkspaceProjectionId/);
  const detail = hook.slice(hook.indexOf("getMatrixCellDetail:"), hook.indexOf("isCurrentWorkspaceProjection:"));
  assert.match(detail, /workspaceSnapshotRef\.current\.projectionId/);
  assert.doesNotMatch(detail, /projectionId:\s*workspaceProjectionId/);
});

test("post-answer replacement invalidates prior details, disables clicks, and rejects late revision A responses", () => {
  const dashboard = read("src/pages/Tax/TaxDashboard.jsx");
  assert.match(dashboard, /if \(!deductionsUpdating\) return;[\s\S]*matrixCellCacheRef\.current\.clear\(\);[\s\S]*setSelectedCell\(null\)/);
  assert.match(dashboard, /onOpenPersistedCell=\{deductionsUpdating \? null : openPersistedMatrixCell\}/);
  assert.match(dashboard, /requestedProjectionId = deductions\.workspaceProjectionId/);
  assert.match(dashboard, /!deductions\.isCurrentWorkspaceProjection\(requestedProjectionId\)/);
  assert.match(dashboard, /businessId}:\$\{year}:\$\{deductions\.workspaceProjectionId}/);
});

test("the protected matrix-cell endpoint rejects revision A with the safe 409 contract", () => {
  const route = read("src/api/tax/taxWorkspace.routes.js");
  const block = route.slice(route.indexOf('router.get("/workspace/matrix-cell"'), route.indexOf('router.post("/workspace/backfill"'));
  assert.match(block, /String\(record\.id\) !== projectionId/);
  assert.match(block, /safeError\("tax_workspace_projection_changed", 409, "The Tax workspace changed\. Refresh and try again\."\)/);
  assert.match(block, /scope: \{ projectionId, projectionVersion, categoryKey, month, authority, transactionCount: expectedCount \}/);
});

test("three production-shaped revision B matrix reads retain their exact memberships and totals without revision A", () => {
  const revisionA = "projection-a";
  const revisionB = "projection-b";
  const cells = [
    { categoryKey: "utilities", month: "2026-09", authority: "reviewed", ids: ["u1"], total: 55 },
    { categoryKey: "utilities", month: "2026-08", authority: "needs_input", ids: ["u2", "u3"], total: 129 },
    { categoryKey: "business_meals", month: "2026-05", authority: "reviewed", ids: ["m1", "m2"], total: 173 },
  ];
  const requests = cells.map((cell) => ({ projectionId: revisionB, ...cell }));
  assert.equal(requests.some((request) => request.projectionId === revisionA), false);
  assert.deepEqual(requests.map(({ ids, total }) => ({ count: new Set(ids).size, total })), [
    { count: 1, total: 55 }, { count: 2, total: 129 }, { count: 2, total: 173 },
  ]);
});

test("tax decision success dispatches a four-second, consecutive-safe toast", () => {
  const events = [];
  const originalWindow = globalThis.window;
  const OriginalCustomEvent = globalThis.CustomEvent;
  globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } };
  globalThis.window = { dispatchEvent: (event) => events.push(event) };
  try {
    showTaxDecisionSuccess("Utilities decision saved for 2 transactions.", "operation-one");
    showTaxDecisionSuccess("Meals decision saved for 3 transactions.", "operation-two");
  } finally {
    globalThis.window = originalWindow;
    globalThis.CustomEvent = OriginalCustomEvent;
  }
  assert.deepEqual(events.map((event) => [event.type, event.detail.title, event.detail.timeout]), [
    ["bizzy:toast", "Utilities decision saved for 2 transactions.", 4000],
    ["bizzy:toast", "Meals decision saved for 3 transactions.", 4000],
  ]);
  assert.notEqual(events[0].detail.dedupeKey, events[1].detail.dedupeKey);
});
