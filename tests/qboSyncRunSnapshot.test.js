import test from "node:test";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { buildQboSyncRunSnapshot, syncDiagnosticHash } from "../src/services/jobCosting/qboSyncRunSnapshot.js";

test("successful snapshots stay below 16 KiB across sync modes without candidate arrays", () => {
  let maximum = 0;
  const candidates = Array.from({ length: 1000 }, (_, i) => ({ id: `candidate-${i}`, source_snapshot: { payload: "x".repeat(1000) } }));
  for (const mode of ["cdc", "webhook", "targeted_refresh", "reconciliation", "backfill"]) {
    const result = { mode, businessId: "business", realmId: "realm", since: "2026-11-11T15:29:00Z", entityCounts: { Invoice: { fetched: 1000, created: 3, updated: 2, failed: 1 } }, jobCandidates: { createdOrUpdated: 5, candidates }, missingRefs: candidates.map(() => ({ entity: "Invoice", error: "e".repeat(1000), payload: "secret" })) };
    const snapshot = buildQboSyncRunSnapshot(result);
    const serialized = JSON.stringify(snapshot);
    maximum = Math.max(maximum, Buffer.byteLength(serialized));
    assert.ok(Buffer.byteLength(serialized) < 16 * 1024);
    assert.equal(snapshot.schema_version, 1);
    assert.equal(snapshot.candidates.count, 1000);
    assert.equal(snapshot.changes.created, 3);
    assert.equal(snapshot.checkpoint.since, result.since);
    assert.equal(snapshot.diagnostics.missingRefs.sample.length, 3);
    assert.equal(serialized.includes('"source_snapshot"'), false);
    assert.equal(serialized.includes('"jobCandidates"'), false);
    assert.equal(serialized.includes('"payload"'), false);
    assert.equal(result.jobCandidates.candidates.length, 1000);
  }
  console.info(`Maximum fixture snapshot: ${maximum} bytes`);
  assert.equal(syncDiagnosticHash({ b: 2, a: 1 }), syncDiagnosticHash({ a: 1, b: 2 }));
});

test("bounded diagnostics stay compact even when all diagnostic collections are large", () => {
  const rows = Array.from({ length: 100 }, () => ({ entity: "e".repeat(1000), external_id: "i".repeat(1000), code: "c".repeat(1000), error: "x".repeat(1000), payload: "ignored" }));
  const snapshot = buildQboSyncRunSnapshot({ entityCounts: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`${i}-${"E".repeat(70)}`, { fetched: 1000, failed: 1000 }])), missingRefs: rows, orphanAllocations: rows, duplicateExternalIds: rows, reconciliationFailures: rows });
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  console.info(`Maximum bounded diagnostic fixture: ${bytes} bytes`);
  assert.ok(bytes < 16 * 1024);
});
