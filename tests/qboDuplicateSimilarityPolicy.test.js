import test from "node:test";
import assert from "node:assert/strict";
import { isAdvisoryDuplicateSimilarity } from "../src/services/bookkeeping/qboDuplicateSimilarityPolicy.js";
import { deriveQboPostingLifecycle } from "../src/services/bookkeeping/qboPostingLifecycle.js";
import { formatPostingFailureLabel } from "../src/services/bookkeeping/postingFailureClassification.js";

const ordinary = (overrides = {}) => ({
  confidence: "HIGH_CONFIDENCE_PROBABLE_DUPLICATE",
  candidates: [{ qbo_txn_id: "1917", deterministic: false, payee_matches: true, amount_matches: true }],
  bankTransaction: { plaid_transaction_id: "plaid-new", date: "2026-10-07", amount: -3.12, direction: "OUTFLOW", pending: false },
  categorization: { final_qbo_account_id: "1150040008", final_qbo_account_name: "Parking", meta: {} },
  sourceMapping: { qbo_account_id: "19", qbo_account_type: "CreditCard" },
  qboTxnType: "CreditCardCharge",
  ...overrides,
});

test("same merchant and amount on distinct settled transactions is advisory similarity", () => {
  assert.equal(isAdvisoryDuplicateSimilarity(ordinary()), true);
  assert.equal(isAdvisoryDuplicateSimilarity(ordinary({
    bankTransaction: { plaid_transaction_id: "plaid-another", date: "2026-10-11", amount: -3.12, direction: "OUTFLOW", pending: false },
  })), true);
});

test("deterministic, pending, receipt-linked, ambiguous, and specialized transactions stay protected", () => {
  assert.equal(isAdvisoryDuplicateSimilarity(ordinary({ candidates: [{ qbo_txn_id: "1917", deterministic: true }] })), false);
  assert.equal(isAdvisoryDuplicateSimilarity(ordinary({ confidence: "AMBIGUOUS", candidates: [{ qbo_txn_id: "1917" }, { qbo_txn_id: "1918" }] })), false);
  assert.equal(isAdvisoryDuplicateSimilarity(ordinary({ bankTransaction: { amount: -3.12, direction: "OUTFLOW", pending: true } })), false);
  assert.equal(isAdvisoryDuplicateSimilarity(ordinary({ categorization: { final_qbo_account_id: "1150040008", qbo_txn_id: "1917", meta: {} } })), false);
  assert.equal(isAdvisoryDuplicateSimilarity(ordinary({ categorization: { final_qbo_account_id: "1150040008", meta: { ambiguous_provider_outcome: true } } })), false);
  assert.equal(isAdvisoryDuplicateSimilarity(ordinary({ categorization: { final_qbo_account_id: "1150040008", meta: { taxonomy_type: "cc_payment" } } })), false);
});

test("inflows and incompatible or missing account authority stay protected", () => {
  assert.equal(isAdvisoryDuplicateSimilarity(ordinary({ bankTransaction: { amount: 3.12, direction: "INFLOW", pending: false } })), false);
  assert.equal(isAdvisoryDuplicateSimilarity(ordinary({ categorization: { meta: {} } })), false);
  assert.equal(isAdvisoryDuplicateSimilarity(ordinary({ sourceMapping: { qbo_account_id: "19", qbo_account_type: "OtherCurrentAsset" } })), false);
  assert.equal(isAdvisoryDuplicateSimilarity(ordinary({ qboTxnType: "Deposit" })), false);
});

test("a pre-provider duplicate stop is not presented as a QuickBooks failure", () => {
  const lifecycle = deriveQboPostingLifecycle({
    status: "failed",
    post_error: "possible_qbo_duplicate",
    posting_job: { state: "failed", last_error_code: "possible_qbo_duplicate", qbo_request_id: "stable-request" },
    meta: {},
  });
  assert.equal(lifecycle.key, "blocked_before_posting");
  assert.equal(lifecycle.label, "Blocked before posting · Possible duplicate");
  assert.equal(lifecycle.technical.provider_write_started, false);
  assert.doesNotMatch(lifecycle.label, /QuickBooks (failed|rejected)/i);
});

test("provider-boundary failure labels distinguish rejection, reconciliation, receipts, and retry", () => {
  assert.match(formatPostingFailureLabel("qbo_transaction_rejected"), /^QuickBooks rejected ·/);
  assert.equal(formatPostingFailureLabel("qbo_succeeded_local_finalize_pending"), "Receipt saved · finalizing");
  assert.equal(formatPostingFailureLabel("posting_internal_failure"), "Posting failed · retry available");
  assert.equal(
    deriveQboPostingLifecycle({ status: "failed", meta: { ambiguous_provider_outcome: true }, posting_job: { state: "reconciling" } }).label,
    "QuickBooks outcome requires reconciliation"
  );
});
