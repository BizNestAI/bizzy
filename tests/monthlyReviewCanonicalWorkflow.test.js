import test from "node:test";
import assert from "node:assert/strict";
import { deriveCanonicalBookkeepingWorkflow } from "../src/services/bookkeeping/bookkeepingPostingActionEligibility.js";

const nowMs = Date.parse("2026-10-12T22:00:00.000Z");

const base = (extra = {}) => ({
  id: "txn",
  status: "approved",
  pending: false,
  direction: "OUTFLOW",
  signed_amount: -20,
  account_type: "credit card",
  source_qbo_account_id: "19",
  final_qbo_account_id: "24",
  meta: { manual_qbo_account_selection: true, ...(extra.meta || {}) },
  provider_free_preflight: {
    preview_ready: true,
    qbo_entity_type: "CreditCardCharge",
    source_qbo_account_id: "19",
    destination_qbo_account_id: "24",
    ...(extra.provider_free_preflight || {}),
  },
  ...extra,
});

test("Adobe merchant refund decision supersedes its stale pre-provider match outage", () => {
  const workflow = deriveCanonicalBookkeepingWorkflow(base({
    id: "9e9c70f6-bd9c-4fa5-841a-1df04168f067",
    direction: "INFLOW",
    signed_amount: 32.16,
    post_error: "match_check_unavailable",
    posting_job: { state: "scheduled", qbo_request_id: "bizzi_adobe" },
    qbo_posting_lifecycle: { key: "qbo_match_check_unavailable", code: "match_check_unavailable", detail: "Duplicate check unavailable" },
    meta: {
      post_block_reason: "match_check_unavailable",
      incoming_deposit_match_status: "match_check_unavailable",
      incoming_deposit_match_check: "unavailable_manual_override",
      credit_card_inflow_resolution: {
        decision_version: 1,
        resolution_type: "merchant_refund",
        qbo_disposition: "create_new",
        destination_qbo_account_id: "24",
        decided_at: "2026-10-12T21:27:12.614Z",
        standalone_refund_acknowledged: true,
      },
    },
    provider_free_preflight: { preview_ready: true, qbo_entity_type: "CreditCardCredit" },
  }), { nowMs });

  assert.equal(workflow.primary_action, "preview_and_post");
  assert.equal(workflow.primary_action_enabled, true);
  assert.equal(workflow.posting_entity, "CreditCardCredit");
  assert.equal(workflow.duplicate_state, "reviewed_distinct");
  assert.deepEqual(workflow.blocking_reasons, []);
  assert.deepEqual(workflow.invariant_violations, []);
});

test("an unresolved match outage still has one retry primary", () => {
  const workflow = deriveCanonicalBookkeepingWorkflow(base({ post_error: "duplicate_check_unavailable" }), { nowMs });
  assert.equal(workflow.primary_action, "retry_duplicate_check");
  assert.equal(workflow.duplicate_state, "check_failed_retryable");
  assert.deepEqual(workflow.invariant_violations, []);
});

test("canonical workflow invariants hold across actionable, waiting, uncertain, and final states", () => {
  const rows = [
    base(),
    base({ pending: true }),
    base({ meta: { posting_in_progress: true } }),
    base({ post_error: "qbo_outcome_ambiguous" }),
    base({ status: "posted", qbo_txn_id: "qbo-123" }),
  ];
  for (const row of rows) {
    assert.deepEqual(deriveCanonicalBookkeepingWorkflow(row, { nowMs }).invariant_violations, []);
  }
});
