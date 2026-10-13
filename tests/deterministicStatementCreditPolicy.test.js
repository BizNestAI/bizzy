import test from "node:test";
import assert from "node:assert/strict";
import {
  deterministicStatementCreditDecision,
  hasStrongRewardCreditDescriptor,
} from "../src/services/bookkeeping/rewardCreditPolicy.js";
import { resolveProtectedCreditCardInflowDecision } from "../src/services/bookkeeping/incomingDepositResolution.js";

const bankTransaction = {
  name: "AUTOMATIC STATEMENT CREDIT",
  amount: 1.63,
  direction: "INFLOW",
  account_type: "credit card",
  pending: false,
};

const categorization = {
  status: "auto_approved",
  final_qbo_account_id: "1150040004",
  final_qbo_account_name: "Credit Card Rewards",
  meta: { taxonomy_type: "transfer_internal" },
};

test("reviewed deterministic statement-credit descriptors produce one durable canonical decision", () => {
  for (const descriptor of [
    "AUTOMATIC STATEMENT CREDIT",
    "STATEMENT CREDIT",
    "CASH BACK REWARD",
    "CASHBACK REWARD",
    "CARD REWARD CREDIT",
  ]) assert.equal(hasStrongRewardCreditDescriptor(descriptor), true, descriptor);

  const decision = deterministicStatementCreditDecision(bankTransaction, categorization, {
    now: "2026-10-13T12:00:00.000Z",
  });
  assert.equal(decision.canonical_type, "cash_back_statement_credit");
  assert.equal(decision.resolution_type, "credit_card_statement_credit");
  assert.equal(decision.qbo_disposition, "categorize_as_new");
  assert.equal(decision.destination_qbo_account_id, "1150040004");
  assert.equal(decision.confidence, "deterministic");
  assert.equal(decision.safety_eligible, true);
  assert.equal(resolveProtectedCreditCardInflowDecision({ ...categorization, meta: { credit_card_inflow_resolution: decision } }).final, true);
});

test("statement-credit policy fails closed for contradictory or finalized evidence", () => {
  const protectedShapes = [
    { row: { ...bankTransaction, pending: true }, meta: {} },
    { row: { ...bankTransaction, name: "MOBILE PAYMENT THANK YOU" }, meta: {} },
    { row: { ...bankTransaction, name: "MERCHANT REFUND" }, meta: {} },
    { row: { ...bankTransaction, name: "TRANSFER" }, meta: {} },
    { row: bankTransaction, meta: { cc_payment_pair_id: "pair-1" } },
    { row: bankTransaction, meta: { transfer_pair_id: "pair-1" } },
    { row: bankTransaction, meta: { matched_existing_qbo: true } },
    { row: bankTransaction, meta: { qbo_duplicate_detection_confidence: "DETERMINISTIC_EXISTING" } },
    { row: bankTransaction, meta: { qbo_receipt_confirmed_at: "2026-10-13T12:00:00.000Z" } },
    { row: bankTransaction, meta: { ambiguous_provider_outcome: true } },
  ];
  for (const shape of protectedShapes) {
    assert.equal(deterministicStatementCreditDecision(shape.row, { ...categorization, meta: shape.meta }), null);
  }
});

