import test from "node:test";
import assert from "node:assert/strict";
import { deriveBookkeepingPostingAction } from "../src/services/bookkeeping/bookkeepingPostingActionEligibility.js";

const now = Date.parse("2026-10-04T12:00:00.000Z");
const manual = (extra = {}) => ({
  id: "txn-1",
  status: "approved",
  final_qbo_account_id: "22",
  final_qbo_account_name: "Electric",
  decided_by: "user",
  meta: { manual_qbo_account_selection: true, ...(extra.meta || {}) },
  ...extra,
});

test("eligible manual approval and early grace use Post now with confirmation only for early posting", () => {
  const ready = deriveBookkeepingPostingAction(manual(), { nowMs: now });
  assert.equal(ready.permitted_action, "post_now");
  assert.equal(ready.posting_eligible, true);
  assert.equal(ready.confirmation_required, false);

  const early = deriveBookkeepingPostingAction(manual({ post_after: "2026-10-05T12:00:00.000Z" }), { nowMs: now });
  assert.equal(early.permitted_action, "post_now");
  assert.equal(early.confirmation_required, true);
});

test("retry, active operation, receipt reconciliation and terminal failures map safely", () => {
  assert.equal(deriveBookkeepingPostingAction(manual({ status: "failed", post_error: "qbo_rate_limited" }), { nowMs: now }).permitted_action, "retry_posting");
  assert.equal(deriveBookkeepingPostingAction(manual({ meta: { manual_qbo_account_selection: true, posting_in_progress: true } }), { nowMs: now }).permitted_action, "posting");
  assert.equal(deriveBookkeepingPostingAction(manual({ post_error: "qbo_succeeded_local_finalize_pending" }), { nowMs: now }).permitted_action, "reconciling");
  assert.equal(deriveBookkeepingPostingAction(manual({ status: "failed", post_error: "qbo_account_incompatible" }), { nowMs: now }).permitted_action, "fix_issue");
});

test("weak evidence requires durable manual authority", () => {
  const approved = deriveBookkeepingPostingAction(manual({ post_error: "weak_memo_evidence" }), { nowMs: now });
  assert.equal(approved.permitted_action, "post_now");
  const automated = deriveBookkeepingPostingAction({
    status: "auto_approved",
    final_qbo_account_id: "22",
    post_error: "weak_memo_evidence",
    meta: { safe_to_auto_post: false },
  }, { nowMs: now });
  assert.equal(automated.permitted_action, "review");
  assert.equal(automated.posting_eligible, false);
});

test("credit-card inflow and match outage expose resolution actions rather than generic posting", () => {
  const credit = deriveBookkeepingPostingAction(manual({
    signed_amount: 32.16,
    account_type: "credit card",
    post_error: "credit_card_inflow_resolution_required",
  }), { nowMs: now });
  assert.equal(credit.permitted_action, "confirm_type");
  assert.equal(credit.posting_eligible, false);

  const match = deriveBookkeepingPostingAction(manual({
    meta: { manual_qbo_account_selection: true, post_block_reason: "match_check_unavailable", incoming_deposit_match_status: "match_check_unavailable" },
  }), { nowMs: now });
  assert.equal(match.permitted_action, "refresh_match_check");
});

test("posted and matched transactions never expose another write", () => {
  assert.equal(deriveBookkeepingPostingAction(manual({ status: "posted", qbo_txn_id: "123" }), { nowMs: now }).permitted_action, "completed");
  assert.equal(deriveBookkeepingPostingAction(manual({ status: "matched_existing_qbo", meta: { matched_existing_qbo: true } }), { nowMs: now }).permitted_action, "completed");
});
