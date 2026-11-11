import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

const COUNT_KEYS = ["fetched", "created", "updated", "unchanged", "failed", "deleted", "linked"];
const DIAGNOSTIC_KEYS = ["missingRefs", "orphanAllocations", "duplicateExternalIds", "reconciliationFailures"];
const text = (value, length = 160) => String(value ?? "").slice(0, length);
const count = (value) => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export function syncDiagnosticHash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value ?? null))).digest("hex");
}
export function boundedSyncDiagnostics(rows = []) {
  return rows.slice(0, 3).map((row) => {
    const sample = {};
    for (const key of ["entity", "external_id", "code", "error", "ref_type", "ref_id", "reason", "payment_id", "lookup_key", "revenue_document_id"]) {
      if (row?.[key] == null) continue;
      const next = { ...sample, [key]: text(row[key], 96) };
      if (Buffer.byteLength(JSON.stringify(next)) <= 640) Object.assign(sample, next);
    }
    return sample;
  });
}
export function buildQboSyncRunSnapshot(result = {}) {
  const entities = Object.entries(result.entityCounts || {}).slice(0, 16);
  const entityCounts = Object.fromEntries(entities.map(([name, values]) => [text(name, 64), Object.fromEntries(COUNT_KEYS.map((key) => [key, count(values?.[key])]))]));
  const candidates = result.jobCandidates || {};
  return {
    schema_version: 1,
    mode: text(result.mode, 64),
    scope: { businessId: text(result.businessId, 64), realmId: text(result.realmId, 64) },
    checkpoint: { since: result.since == null ? null : text(result.since, 64) },
    coverage: entities.map(([name]) => text(name, 64)),
    entityCounts,
    changes: Object.fromEntries(COUNT_KEYS.map((key) => [key, entities.reduce((sum, [, values]) => sum + count(values?.[key]), 0)])),
    candidates: {
      createdOrUpdated: count(candidates.createdOrUpdated), linkedExisting: count(candidates.linkedExisting),
      ignored: count(candidates.ignored), manualReview: count(candidates.manualReview),
      count: candidates.candidates?.length || 0,
      identifiers_hash: syncDiagnosticHash((candidates.candidates || []).map((row) => row.id || row.source_entity_id).sort()),
      skipped: candidates.skipped === true,
    },
    diagnostics: Object.fromEntries(DIAGNOSTIC_KEYS.map((key) => [key, {
      count: result[key]?.length || 0, hash: syncDiagnosticHash(result[key] || []), sample: boundedSyncDiagnostics(result[key]),
    }])),
  };
}
