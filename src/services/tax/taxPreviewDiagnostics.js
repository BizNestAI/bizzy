import { createHash } from "node:crypto";

// Identity diagnostics only: never serialize request bodies, errors, rows, or
// semantic manifests. Hash fingerprints so reads and previews can be compared.
export function taxDiagnosticFingerprint(value) {
  return typeof value === "string" && value.length
    ? createHash("sha256").update(value).digest("hex").slice(0, 24)
    : null;
}

export function taxDiagnosticIdentity(value) {
  return typeof value === "string" && value.length
    ? value.replace(/[\r\n\t]/g, "").slice(0, 512)
    : null;
}

// Normalization is for aggregate diagnostics only. It does not relax the exact
// membership guard or turn malformed/duplicate IDs into accepted members.
export function taxMembershipDiagnostics(expected = [], current = []) {
  const inspect = (ids) => {
    const normalized = ids.filter((id) => id != null).map((id) => String(id).trim()).filter(Boolean);
    const members = [...new Set(normalized)].sort();
    return { members, duplicateCount: normalized.length - members.length, invalidCount: ids.length - normalized.length };
  };
  const left = inspect(expected);
  const right = inspect(current);
  const expectedSet = new Set(left.members);
  const currentSet = new Set(right.members);
  return {
    membershipComparisonStage: "matrix_reconciliation",
    expectedMemberCount: left.members.length,
    currentMemberCount: right.members.length,
    addedCount: right.members.filter((id) => !expectedSet.has(id)).length,
    removedCount: left.members.filter((id) => !currentSet.has(id)).length,
    duplicateCount: left.duplicateCount + right.duplicateCount,
    expectedDuplicateCount: left.duplicateCount,
    currentDuplicateCount: right.duplicateCount,
    expectedInvalidCount: left.invalidCount,
    currentInvalidCount: right.invalidCount,
    expectedMemberHash: taxDiagnosticFingerprint(JSON.stringify(left.members)),
    currentMemberHash: taxDiagnosticFingerprint(JSON.stringify(right.members)),
  };
}
