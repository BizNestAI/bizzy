/* global process */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

process.env.NODE_ENV = "test";
const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
const BUSINESS_B = "22222222-2222-4222-8222-222222222222";
const [{ supabase }, projectionService, workerService] = await Promise.all([
  import("../../src/services/supabaseAdmin.js"),
  import("../../src/services/tax/taxWorkspaceProjection.service.js"),
  import("../../src/services/tax/processTaxWorkspaceProjectionRequests.js"),
]);
const { enqueueTaxWorkspaceProjection, getLatestTaxWorkspaceProjection } = projectionService;
const { processTaxWorkspaceProjectionRequests } = workerService;

const stamp = Date.now();
const original = await getLatestTaxWorkspaceProjection({ supabase, businessId: BUSINESS_A, taxYear: 2026 });
assert.ok(original);
const projectionsBefore = await supabase.from("tax_workspace_projections").select("id", { count: "exact", head: true });

const failedRequest = await enqueueTaxWorkspaceProjection({
  supabase, businessId: BUSINESS_A, taxYear: 2026, reason: "validation_failure", requestKey: `validation-failure-${stamp}`,
});
const injected = new Error("controlled persistence failure");
injected.code = "controlled_persist_failure";
const failed = await processTaxWorkspaceProjectionRequests({
  supabase, workerId: `validation-failure-${stamp}`, batchSize: 1, now: new Date(),
  buildProjection: async () => { throw injected; },
});
assert.deepEqual(failed, { processed: 1, completed: 0, failed: 1 });
const failedRow = await supabase.from("tax_workspace_projection_requests").select("status,attempt_count,max_attempts,process_after,error_code").eq("id", failedRequest.id).single();
assert.equal(failedRow.data.status, "failed");
assert.equal(failedRow.data.attempt_count, 1);
assert.equal(failedRow.data.error_code, "controlled_persist_failure");
assert.ok(new Date(failedRow.data.process_after) > new Date());
const afterFailure = await getLatestTaxWorkspaceProjection({ supabase, businessId: BUSINESS_A, taxYear: 2026 });
assert.equal(afterFailure.id, original.id);
const projectionsAfterFailure = await supabase.from("tax_workspace_projections").select("id", { count: "exact", head: true });
assert.equal(projectionsAfterFailure.count, projectionsBefore.count);

const retryAt = new Date(new Date(failedRow.data.process_after).getTime() + 1);
const replayStarted = performance.now();
const replay = await processTaxWorkspaceProjectionRequests({ supabase, workerId: `validation-replay-${stamp}`, batchSize: 1, now: retryAt });
const replayMs = performance.now() - replayStarted;
assert.deepEqual(replay, { processed: 1, completed: 1, failed: 0 });
const completedFailure = await supabase.from("tax_workspace_projection_requests").select("status,projection_id,attempt_count").eq("id", failedRequest.id).single();
assert.equal(completedFailure.data.status, "completed");
assert.ok(completedFailure.data.projection_id);

const queued = await enqueueTaxWorkspaceProjection({
  supabase, businessId: BUSINESS_B, taxYear: 2026, reason: "validation_worker", requestKey: `validation-worker-${stamp}`,
});
const workerStarted = performance.now();
const completed = await processTaxWorkspaceProjectionRequests({ supabase, workerId: `validation-worker-${stamp}`, batchSize: 1, now: new Date() });
const workerMs = performance.now() - workerStarted;
assert.deepEqual(completed, { processed: 1, completed: 1, failed: 0 });
const completedRow = await supabase.from("tax_workspace_projection_requests").select("status,projection_id,attempt_count").eq("id", queued.id).single();
assert.equal(completedRow.data.status, "completed");
assert.ok(completedRow.data.projection_id);
const duplicate = await processTaxWorkspaceProjectionRequests({ supabase, workerId: `validation-duplicate-${stamp}`, batchSize: 1, now: new Date() });
assert.equal(duplicate.processed, 0);

console.log(JSON.stringify({
  ok: true,
  failure: { requestId: failedRequest.id, status: failedRow.data.status, attempts: failedRow.data.attempt_count, priorProjectionPreserved: true, partialProjectionCreated: false },
  replay: { status: completedFailure.data.status, attempts: completedFailure.data.attempt_count, ms: replayMs },
  worker: { requestId: queued.id, status: completedRow.data.status, attempts: completedRow.data.attempt_count, ms: workerMs, duplicateClaims: duplicate.processed },
}, null, 2));
