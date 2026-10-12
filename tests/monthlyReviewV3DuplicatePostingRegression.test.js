/* global process */
import test from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const {
  excludeReviewedInformationalDuplicateCandidates,
  isRejectedSoftDuplicateCandidate,
} = await import("../src/jobs/booksPost.cron.js");

const decision = {
  decision: "categorize_as_new_despite_duplicate_risk",
  decision_version: 3,
  reviewed_candidates: [{
    qbo_txn_id: "1949",
    qbo_txn_type: "CreditCardCharge",
    informational_only: true,
    consumed_by_another_transaction: true,
  }],
};

test("saved v3 informational duplicate is excluded after canonical scoring", () => {
  const item = { meta: { duplicate_override_decision: decision } };
  const canonicalCandidate = {
    qbo_txn_id: "1949",
    qbo_txn_type: "CreditCardCharge",
    amount: 72,
    txn_date: "2026-06-28",
  };
  assert.equal(isRejectedSoftDuplicateCandidate(item, canonicalCandidate, { manual: true }), true);
  assert.deepEqual(excludeReviewedInformationalDuplicateCandidates(item, [canonicalCandidate], { manual: true }), []);
});

test("unreviewed exact duplicate remains protected", () => {
  const item = { meta: { duplicate_override_decision: decision } };
  const other = { qbo_txn_id: "2000", qbo_txn_type: "CreditCardCharge" };
  assert.deepEqual(excludeReviewedInformationalDuplicateCandidates(item, [other], { manual: true }), [other]);
});

test("saved v3 decision is manual-only and type scoped", () => {
  const item = { meta: { duplicate_override_decision: decision } };
  assert.equal(isRejectedSoftDuplicateCandidate(item, { qbo_txn_id: "1949", qbo_txn_type: "Deposit" }, { manual: true }), false);
  assert.equal(isRejectedSoftDuplicateCandidate(item, { qbo_txn_id: "1949", qbo_txn_type: "CreditCardCharge" }, { manual: false }), false);
});
