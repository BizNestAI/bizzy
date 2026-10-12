import test from "node:test";
import assert from "node:assert/strict";
import { canOverrideReviewedCandidate, classifyQboDuplicateCandidate } from "../src/services/bookkeeping/qboDuplicateCandidateClassification.js";

test("candidate already linked to another transaction is informational and cannot be matched twice", () => {
  const candidate = classifyQboDuplicateCandidate({ qbo_txn_id: "1949", payee_conflicts: true }, {
    transactionId: "june-29-rebill",
    consumerTransactionIds: ["june-28-refund"],
  });
  assert.equal(candidate.candidate_state, "already_linked_to_another_transaction");
  assert.equal(candidate.matchable, false);
  assert.equal(candidate.informational_only, true);
  assert.equal(canOverrideReviewedCandidate(candidate), true);
});

test("unconsumed plausible candidates remain matchable and require review", () => {
  const candidate = classifyQboDuplicateCandidate({ qbo_txn_id: "new", payee_matches: true }, { transactionId: "txn", consumerTransactionIds: [] });
  assert.equal(candidate.candidate_state, "available_match");
  assert.equal(candidate.matchable, true);
  assert.equal(canOverrideReviewedCandidate(candidate), true);
});

test("confirmed duplicates and ambiguous provider outcomes cannot be overridden", () => {
  const confirmed = classifyQboDuplicateCandidate({ qbo_txn_id: "confirmed" }, { confirmedDuplicate: true });
  const ambiguous = classifyQboDuplicateCandidate({ qbo_txn_id: "ambiguous" }, { providerOutcomeAmbiguous: true });
  assert.equal(canOverrideReviewedCandidate(confirmed), false);
  assert.equal(canOverrideReviewedCandidate(ambiguous), false);
});
