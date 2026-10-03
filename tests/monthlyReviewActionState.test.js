/* global process */
import assert from "node:assert/strict";
import test from "node:test";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const { deriveMonthlyReviewActionState } = await import("../src/services/bookkeeping/monthlyReviewActionState.js");
const {
  clearUnconfirmedIncomingDepositProposalMeta,
  hasUnconfirmedIncomingDepositProposal,
} = await import("../src/services/bookkeeping/bookkeepingReclassificationService.js");

const needsReview = { id: "txn-1", status: "needs_review", pending: false, meta: {} };

test("undo match then categorize as new exposes approval after duplicate acknowledgement", () => {
  const row = { ...needsReview, meta: { incoming_deposit_match_id: "old-proposal", incoming_deposit_match_status: "superseded" } };
  const blocked = deriveMonthlyReviewActionState({ row, resolution: "categorize_new", selectedAccountId: "79", duplicateRisk: true });
  assert.equal(blocked.kind, "approve_categorization");
  assert.equal(blocked.enabled, false);
  const ready = deriveMonthlyReviewActionState({ row, resolution: "categorize_new", selectedAccountId: "79", duplicateRisk: true, duplicateRiskAcknowledged: true });
  assert.equal(ready.enabled, true);
  assert.equal(ready.label, "Approve");
});

test("selected resolution exclusively determines match and credit-card actions", () => {
  assert.deepEqual(
    deriveMonthlyReviewActionState({ row: needsReview, resolution: "match_existing_qbo", selectedMatchCandidate: true }).kind,
    "approve_qbo_match"
  );
  assert.equal(deriveMonthlyReviewActionState({ row: needsReview, resolution: "match_existing_qbo" }).kind, "find_qbo_match");
  assert.equal(deriveMonthlyReviewActionState({ row: needsReview, resolution: "match_credit_card_payment", selectedCreditCardCounterpart: true }).kind, "confirm_credit_card_match");
});

test("incomplete and immutable selections fail closed", () => {
  assert.equal(deriveMonthlyReviewActionState({ row: needsReview, resolution: "categorize_new" }).enabled, false);
  for (const row of [
    { ...needsReview, pending: true },
    { ...needsReview, status: "posted" },
    { ...needsReview, status: "finalized" },
    { ...needsReview, status: "excluded" },
    { ...needsReview, status: "matched_existing_qbo" },
    { ...needsReview, meta: { posting_in_progress: true } },
  ]) assert.equal(deriveMonthlyReviewActionState({ row, resolution: "categorize_new", selectedAccountId: "79" }).enabled, false);
});

test("manual categorization clears only unconfirmed proposal fields and preserves audit", () => {
  const meta = {
    incoming_deposit_match_id: "proposal-1",
    incoming_deposit_match_status: "needs_confirmation",
    incoming_deposit_candidates: [{ qbo_entity_id: "1271" }],
    incoming_deposit_reason_codes: ["exact_amount_cents"],
    unrelated: "keep",
  };
  assert.equal(hasUnconfirmedIncomingDepositProposal(meta), true);
  const cleared = clearUnconfirmedIncomingDepositProposalMeta(meta, { actor: "reviewer", timestamp: "2026-10-03T12:00:00Z", selectedQboAccountId: "79" });
  assert.equal(cleared.incoming_deposit_match_id, undefined);
  assert.equal(cleared.unrelated, "keep");
  assert.equal(cleared.abandoned_incoming_deposit_matches[0].match_id, "proposal-1");
  const confirmed = { incoming_deposit_match_id: "match-1", incoming_deposit_match_status: "confirmed", matched_existing_qbo: true };
  assert.deepEqual(clearUnconfirmedIncomingDepositProposalMeta(confirmed), confirmed);
});
