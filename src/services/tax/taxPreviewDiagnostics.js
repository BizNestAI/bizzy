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
