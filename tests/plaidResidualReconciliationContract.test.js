/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { importFreshnessHours, PLAID_RECOVERY_CONTRACT } from "../src/services/plaid/plaidRecoveryContract.js";
import { projectPlaidAccountRecoveryStatus } from "../src/services/plaid/plaidAccountRecoveryStatus.js";
import { reconcileResidualPlaidBatch } from "../src/services/plaid/plaidResidualReconciliationService.js";

function facts() {
  const success = "2026-11-09T00:00:00Z";
  return { account: { id: "account", is_active: true, connection_state: "connected", last_sync_at: success },
    item: { status: "connected", is_active: true, last_success_at: success }, last_checkpoint: { finished_at: success },
    latest_run: { status: "completed", finished_at: success, started_at: success }, auto_post_enabled: false,
    metrics: { active_count: 10, missing_categorization: 0, missing_processing_admission: 42,
      required_processing_admission_missing: 2, missing_both: 0, processing_count: 0,
      review_count: 0, automation_failed_count: 0, active_lease_count: 0, dead_letter_count: 0,
      posting_hold_count: 3, receipt_reconciliation_count: 1, posting_failed_count: 0 } };
}

test("freshness SLA defaults to 26 hours and accepts bounded configuration", () => {
  assert.equal(importFreshnessHours(undefined), 26);
  for (const value of ["", "invalid", 0, -1, 169]) assert.equal(importFreshnessHours(value), 26);
  assert.equal(importFreshnessHours("48"), 48);
  assert.equal(PLAID_RECOVERY_CONTRACT.reconciliationManifestTtlSeconds, 300);
  const saved = process.env.PLAID_IMPORT_FRESHNESS_HOURS;
  try {
    process.env.PLAID_IMPORT_FRESHNESS_HOURS = "3";
    const status = projectPlaidAccountRecoveryStatus(facts(), { observedAt: "2026-11-09T06:00:00Z" });
    assert.equal(status.transaction_import.state, "delayed");
    assert.equal(status.transaction_import.last_checked_at, "2026-11-09T00:00:00Z");
  } finally {
    if (saved === undefined) delete process.env.PLAID_IMPORT_FRESHNESS_HOURS;
    else process.env.PLAID_IMPORT_FRESHNESS_HOURS = saved;
  }
});

test("customer missing-request counts use the required subset and held counts survive auth/receipt blockers", () => {
  const f = facts();
  f.metrics.qbo_auth_error_at = "2026-11-09T05:00:00Z";
  const status = projectPlaidAccountRecoveryStatus(f, { observedAt: "2026-11-09T06:00:00Z" });
  assert.equal(status.categorization_automation.missing.processing_admission, 2);
  assert.equal(status.quickbooks_posting.state, "reconciling");
  assert.equal(status.quickbooks_posting.affected_count, 3);
  assert.equal(status.quickbooks_posting.blockers.qbo_authentication_failure, true);
  assert.equal(status.quickbooks_posting.blockers.auto_post_disabled, true);
});

test("service defaults to preview for a nonliteral execute flag and never forwards body authority", async () => {
  let call;
  const db = { rpc: async (name, args) => { call = { name, args }; return { data: { dry_run: true }, error: null }; } };
  await reconcileResidualPlaidBatch({ db, businessId: "trusted-business", plaidEnv: "production", plaidAccountId: "account",
    batchId: "batch", actorUserId: "trusted-operator", execute: "true" });
  assert.equal(call.name, "preview_plaid_residual_reconciliation");
  assert.equal(call.args.p_actor_id, "trusted-operator");
  assert.equal(call.args.p_business_id, "trusted-business");
  assert.equal(call.args.p_execute, undefined);
});

test("reconciliation errors discard raw database details and return only safe changed IDs", async () => {
  const id = "8c3ffad5-524f-4932-a29c-d87fde807f62";
  const db = { rpc: async () => ({ data: null, error: { code: "40001", message: "plaid_reconciliation_evidence_changed",
    details: JSON.stringify({ changed_transaction_ids: [id, "SECRET_CREDENTIAL"], row: "SENSITIVE_DESCRIPTION", cursor: "RAW_CURSOR" }) } }) };
  await assert.rejects(reconcileResidualPlaidBatch({ db, businessId: "b", plaidEnv: "production", plaidAccountId: "a", batchId: "batch", actorUserId: "operator" }), error => {
    assert.deepEqual(error.details.changed_transaction_ids, [id]);
    assert.doesNotMatch(JSON.stringify(error), /SECRET_CREDENTIAL|SENSITIVE_DESCRIPTION|RAW_CURSOR/);
    return true;
  });
});
