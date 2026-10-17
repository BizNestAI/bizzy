import { createHash } from "node:crypto";

const SQL_IDENTIFIER = /^[a-z0-9_]{1,128}$/i;
const POSTGRES_CODE = /^[0-9A-Z]{5}$/;

export function buildSafeHandlerErrorDiagnostic(error, { requestId = null, failureStage = "handler" } = {}) {
  const postgresCode = safeValue(error?.code, POSTGRES_CODE);
  const table = safeValue(error?.table, SQL_IDENTIFIER);
  const constraint = safeValue(error?.constraint, SQL_IDENTIFIER);
  return {
    request_fingerprint: fingerprint(requestId),
    failure_stage: safeValue(failureStage, SQL_IDENTIFIER) || "handler",
    error_classification: postgresCode ? "database_operation_failed" : "handler_failure",
    ...(postgresCode ? { postgres_code: postgresCode } : {}),
    ...(table ? { table } : {}),
    ...(constraint ? { constraint } : {}),
  };
}

function safeValue(value, pattern) {
  const normalized = String(value || "").trim();
  return pattern.test(normalized) ? normalized : null;
}

function fingerprint(value) {
  const normalized = String(value || "").trim();
  return normalized ? createHash("sha256").update(normalized).digest("hex").slice(0, 16) : null;
}
