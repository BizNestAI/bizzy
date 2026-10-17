import test from "node:test";
import assert from "node:assert/strict";
import { buildSafeHandlerErrorDiagnostic } from "../src/api/gpt/brain/safeHandlerErrorDiagnostic.js";

test("GPT handler database diagnostics omit rejected rows and sensitive provider data", () => {
  const diagnostic = buildSafeHandlerErrorDiagnostic({
    code: "23514",
    table: "qbo_pnl_exact_range_evidence",
    constraint: "qbo_pnl_exact_range_timestamps",
    details: "Failing row contains (financial-values, full-realm-id)",
    message: "new row violates constraint",
    hint: "secret",
    stack: "sensitive stack",
  }, {
    requestId: "704b6c95-fdb9-4055-a070-33714eec9833",
    failureStage: "financial_evidence_acquisition",
  });

  assert.deepEqual(Object.keys(diagnostic).sort(), [
    "constraint", "error_classification", "failure_stage", "postgres_code", "request_fingerprint", "table",
  ]);
  assert.equal(diagnostic.postgres_code, "23514");
  assert.equal(diagnostic.table, "qbo_pnl_exact_range_evidence");
  assert.equal(diagnostic.constraint, "qbo_pnl_exact_range_timestamps");
  assert.equal(diagnostic.failure_stage, "financial_evidence_acquisition");
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, /financial-values|full-realm-id|secret|sensitive stack|704b6c95/);
});

test("GPT handler diagnostics discard untrusted metadata fields", () => {
  const diagnostic = buildSafeHandlerErrorDiagnostic({
    code: "not a pg code",
    table: "table; select secret",
    constraint: "constraint with spaces",
  }, { failureStage: "bad stage with spaces" });
  assert.deepEqual(diagnostic, {
    request_fingerprint: null,
    failure_stage: "handler",
    error_classification: "handler_failure",
  });
});
