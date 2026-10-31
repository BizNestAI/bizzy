import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createWorkspaceOperationTracker } from "../src/hooks/tax/workspaceOperationTracker.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("revision B commit releases the owned interaction lock without a remount", () => {
  const activeStates = [];
  const tracker = createWorkspaceOperationTracker((active) => activeStates.push(active));
  const revisionA = { total: 9217, questions: 6, memberships: 308, reviewed: 50, needsInput: 364 };
  const owner = tracker.acquire("grouped-decision-reconciliation");
  assert.equal(tracker.activeCount(), 1);

  const revisionB = {
    ...revisionA,
    total: 9461,
    questions: 5,
    memberships: 304,
    reviewed: 54,
    needsInput: 360,
    utilitiesFullyReviewed: true,
    projectionId: "revision-b",
  };
  assert.deepEqual(revisionB, {
    total: 9461,
    questions: 5,
    memberships: 304,
    reviewed: 54,
    needsInput: 360,
    utilitiesFullyReviewed: true,
    projectionId: "revision-b",
  });

  assert.equal(tracker.release(owner), true);
  assert.equal(tracker.activeCount(), 0);
  assert.deepEqual(activeStates, [true, false]);
});

test("every terminal reconciliation path releases exactly its own owner", () => {
  for (const terminalPath of ["mutation_failure", "refresh_failure", "timeout", "cancellation", "stale_response"]) {
    const states = [];
    const tracker = createWorkspaceOperationTracker((active) => states.push(active));
    const owner = tracker.acquire(terminalPath);
    assert.equal(tracker.release(owner), true, terminalPath);
    assert.equal(tracker.release(owner), false, `${terminalPath} cleanup must be idempotent`);
    assert.equal(tracker.activeCount(), 0, terminalPath);
    assert.deepEqual(states, [true, false], terminalPath);
  }
});

test("superseded and rapid operations cannot clear a newer owner or underflow", () => {
  const states = [];
  const tracker = createWorkspaceOperationTracker((active) => states.push(active));
  const revisionAOwner = tracker.acquire("revision-a");
  const revisionBOwner = tracker.acquire("revision-b");
  assert.equal(tracker.release(revisionAOwner), true);
  assert.equal(tracker.activeCount(), 1);
  assert.equal(states.at(-1), true);
  assert.equal(tracker.release(revisionAOwner), false);
  assert.equal(tracker.release(revisionBOwner), true);
  assert.equal(tracker.activeCount(), 0);
  assert.equal(states.at(-1), false);
});

test("unmount disposal makes late cleanup inert and cannot re-lock the workspace", () => {
  const states = [];
  const tracker = createWorkspaceOperationTracker((active) => states.push(active));
  const owner = tracker.acquire("pending-on-unmount");
  tracker.dispose();
  assert.equal(tracker.activeCount(), 0);
  assert.equal(tracker.release(owner), false);
  assert.deepEqual(states, [true]);
});

test("dashboard lock follows owned requests, not the server rebuild hint", () => {
  const dashboard = read("src/pages/Tax/TaxDashboard.jsx");
  const hook = read("src/hooks/tax/useTaxDeductions.js");
  assert.match(dashboard, /const deductionsUpdating = deductions\.refreshing;/);
  assert.doesNotMatch(dashboard, /deductions\.refreshing \|\| deductions\.rebuildPending/);
  assert.match(hook, /acquire\("grouped-decision-reconciliation"\)/);
  assert.match(hook, /workspaceOperationTrackerRef\.current\.release\(operationOwner\)/);
  assert.match(hook, /if \(refreshInFlight\.current === operation\) refreshInFlight\.current = null/);
});
