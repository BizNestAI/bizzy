import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const {
  hasStrongRewardCreditDescriptor,
  isCashBackRewardCredit,
  rewardCreditIntent,
} = await import("../src/services/bookkeeping/rewardCreditPolicy.js");
const {
  normalizeBookkeepingRpcRow,
} = await import("../src/services/bookkeeping/bookkeepingTransactionFeedService.js");
const {
  mapIntentToCoa,
} = await import("../src/services/bookkeeping/intentToCoaMapper.js");

function creditCardRewardTxn(overrides = {}) {
  return {
    name: "Redeem Cash Back at Amazon.com",
    amount: 10.66,
    direction: "INFLOW",
    account_type: "credit",
    account_subtype: "credit card",
    ...overrides,
  };
}

test("strong reward descriptors on positive credit-card credits use the rewards COA workflow", () => {
  for (const name of [
    "REDEEM CASH BACK",
    "CASH BACK REDEMPTION",
    "CASHBACK REDEMPTION",
    "REWARDS REDEMPTION",
    "REDEEM REWARDS",
    "STATEMENT CREDIT - REWARDS",
    "Credit Card Rewards",
  ]) {
    const row = creditCardRewardTxn({ name });
    assert.equal(hasStrongRewardCreditDescriptor(name), true, name);
    assert.equal(isCashBackRewardCredit(row), true, name);
    assert.equal(rewardCreditIntent(row), "credit_card_rewards", name);
  }
});

test("reward classifier keeps payment, refund, transfer, generic redeem, and negative merchant rows out", () => {
  assert.equal(isCashBackRewardCredit(creditCardRewardTxn({ name: "MOBILE PAYMENT - THANK YOU" })), false);
  assert.equal(isCashBackRewardCredit(creditCardRewardTxn({ name: "Amazon refund cash back" })), false);
  assert.equal(isCashBackRewardCredit(creditCardRewardTxn({ name: "Transfer redeem rewards" })), false);
  assert.equal(isCashBackRewardCredit(creditCardRewardTxn({ name: "Redeem at Amazon" })), false);
  assert.equal(isCashBackRewardCredit(creditCardRewardTxn({ name: "Grocery cash back", amount: -12.34, direction: "OUTFLOW" })), false);
  assert.equal(isCashBackRewardCredit(creditCardRewardTxn({ name: "REDEEM CASH BACK", account_type: "depository", account_subtype: "checking" })), false);
});

test("stale incoming-deposit metadata is stripped from cash-back reward feed rows", () => {
  const row = normalizeBookkeepingRpcRow({
    id: "txn-reward-1",
    plaid_transaction_id: "plaid-reward-1",
    plaid_account_id: "plaid-cc-1",
    date: "2026-07-01",
    name: "Redeem Cash Back at Amazon.com",
    amount: 10.66,
    direction: "INFLOW",
    account_type: "credit",
    account_subtype: "credit card",
    cat_status: "needs_review",
    post_error: "match_check_unavailable",
    cat_meta: {
      safe_to_auto_post: false,
      post_block_reason: "match_check_unavailable",
      incoming_deposit_match_status: "match_check_unavailable",
      incoming_deposit_candidates: [],
    },
  });

  assert.equal(row.incoming_deposit_match_status, null);
  assert.deepEqual(row.incoming_deposit_candidates, []);
  assert.equal(row.post_error, null);
  assert.equal(row.taxonomy_type, "credit_card_rewards");
  assert.equal(row.meta.reward_credit_workflow, "coa_review");
  assert.equal(row.credit_card_payment_status, undefined);
});

test("existing Credit Card Rewards account can be suggested but remains selectable policy data", () => {
  const match = mapIntentToCoa({
    intent: "credit_card_rewards",
    coaAccounts: [
      { id: "sales", qbo_account_id: "sales", name: "Sales", type: "Income" },
      { id: "rewards", qbo_account_id: "rewards", name: "Credit Card Rewards", type: "Other Income" },
    ],
  });
  assert.equal(match?.qbo_account_name, "Credit Card Rewards");
});

test("Possible QBO match rows expose a review action instead of passive Needs match text", () => {
  const source = readFileSync(join(process.cwd(), "src/components/Accounting/BookkeepingFeed.jsx"), "utf8");
  assert.match(source, /Review match/);
  assert.match(source, /toggleExpandedRow\(txn\.id\)/);
});
