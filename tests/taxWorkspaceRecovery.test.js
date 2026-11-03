import test from "node:test";
import assert from "node:assert/strict";
import { recoverTaxWorkspaceProjection } from "../src/services/tax/taxWorkspaceRecovery.js";

const p1 = { projectionId: "P1", sourceFingerprint: "F1", projection: { status: "complete" } };
const p2 = { projectionId: "P2", sourceFingerprint: "F2", projection: { status: "complete" } };

test("stale recovery requests one rebuild and waits past the same complete projection", async () => {
  const calls = [];
  let reads = 0;
  const value = await recoverTaxWorkspaceProjection({ previousProjectionId: "P1", pollMs: 1,
    readWorkspace: async () => { calls.push("GET"); return ++reads < 3 ? p1 : p2; },
    requestRebuild: async ({ previousProjectionId }) => { assert.equal(previousProjectionId, "P1"); calls.push("POST"); },
  });
  assert.equal(value, p2);
  assert.deepEqual(calls, ["GET", "POST", "GET", "GET"]);
});

test("a discovered complete replacement avoids another rebuild", async () => {
  assert.equal(await recoverTaxWorkspaceProjection({ previousProjectionId: "P1", readWorkspace: async () => p2,
    requestRebuild: () => assert.fail("already published") }), p2);
});

test("same stale identity and incomplete replacements expire without an unbounded loop", async () => {
  let builds = 0;
  let reads = 0;
  await assert.rejects(recoverTaxWorkspaceProjection({ previousProjectionId: "P1", timeoutMs: 20, pollMs: 2,
    readWorkspace: async () => { reads += 1; return reads % 2 ? p1 : { ...p2, projection: { status: "processing" } }; },
    requestRebuild: async () => { builds += 1; },
  }), { code: "grouped_decision_preview_timeout" });
  assert.equal(builds, 1);
  assert.ok(reads < 30);
});

test("cancellation and hung reads settle; late results cannot schedule a rebuild", async () => {
  const controller = new AbortController();
  let release;
  const pending = recoverTaxWorkspaceProjection({ previousProjectionId: "P1", signal: controller.signal,
    readWorkspace: () => new Promise((resolve) => { release = resolve; }),
    requestRebuild: () => assert.fail("cancelled recovery must not rebuild"),
  });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { code: "request_aborted" });
  release(p1);
  await Promise.resolve();
  await assert.rejects(recoverTaxWorkspaceProjection({ previousProjectionId: "P1", timeoutMs: 5,
    readWorkspace: () => new Promise(() => {}), requestRebuild: () => assert.fail("hung read") }),
  { code: "grouped_decision_preview_timeout" });
});
