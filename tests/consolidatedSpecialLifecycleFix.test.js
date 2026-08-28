import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mapIntentToCoa } from "../src/services/bookkeeping/intentToCoaMapper.js";
import { removeSupersededPendingPlaidRows } from "../src/services/bookkeeping/pendingPlaidSupersession.js";
import { getProtectedWorkflowReason } from "../src/services/bookkeeping/protectedWorkflow.js";
import { deriveQboPostingLifecycle } from "../src/services/bookkeeping/qboPostingLifecycle.js";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

test("pending Plaid supersession removes explicit settled replacements without fuzzy amount merges", () => {
  const rows = [
    {
      id: "pending-chargeonsite",
      plaid_transaction_id: "pending-hold-35",
      pending: true,
      merchant_name: "CHARGEONSITE.COM",
      signed_amount: -35,
    },
    {
      id: "settled-chargeonsite",
      plaid_transaction_id: "settled-charge-15",
      pending_transaction_id: "pending-hold-35",
      pending: false,
      merchant_name: "CHARGEONSITE.COM",
      signed_amount: -15,
    },
    {
      id: "pending-micro-mart",
      plaid_transaction_id: "pending-hold-10",
      pending: true,
      merchant_name: "MICRO MART",
      signed_amount: -10,
    },
    {
      id: "settled-micro-mart-unlinked",
      plaid_transaction_id: "settled-charge-5",
      pending: false,
      merchant_name: "MICRO MART",
      signed_amount: -5,
    },
  ];

  assert.deepEqual(
    removeSupersededPendingPlaidRows(rows).map((row) => row.id),
    ["settled-chargeonsite", "pending-micro-mart", "settled-micro-mart-unlinked"]
  );
});

test("credit-card payment taxonomy is protected even before a durable pair exists", () => {
  const reason = getProtectedWorkflowReason({
    meta: {
      taxonomy_type: "cc_payment",
      cc_payment_pair_id: null,
    },
  });

  assert.equal(reason?.label, "Credit card payment · Needs match");
});

test("unsupported unpaired credit-card payment posting artifact is no longer shown as provider Failed/Retry", () => {
  const lifecycle = deriveQboPostingLifecycle({
    status: "failed",
    qbo_txn_id: null,
    post_error: "cc_payment_post_not_supported",
    meta: {
      taxonomy_type: "cc_payment",
      cc_payment_pair_id: null,
      post_block_reason: "cc_payment_post_not_supported",
    },
  });

  assert.equal(lifecycle.key, "needs_review");
  assert.notEqual(lifecycle.key, "failed");
});

test("entertainment intent cannot automatically fall back to Meals", () => {
  const match = mapIntentToCoa({
    intent: "entertainment",
    allowSemanticFallbackForCanonicalOnly: true,
    coaAccounts: [
      {
        id: "acct-meals",
        name: "Meals",
        type: "Expense",
      },
    ],
  });

  assert.equal(match, null);
});

test("payment hard-stop paths clear stale P&L suggestions during customer and reconsideration processing", () => {
  const suggestRoute = read("src/api/bookkeeping/routes/bookkeeping.suggest.routes.js");
  const reconsideration = read("src/services/bookkeeping/routineExpenseReconsiderationService.js");

  assert.match(suggestRoute, /taxHit\?\.type === "cc_payment"/);
  assert.match(suggestRoute, /const targetId = matched \? ccPaymentPair\.targetQboAccountId : null/);
  assert.match(suggestRoute, /suggested_qbo_account_id: targetId/);
  assert.match(suggestRoute, /final_qbo_account_id: null/);
  assert.match(suggestRoute, /continue;/);

  assert.match(reconsideration, /existingTaxonomyType === "cc_payment" \|\| hasCreditCardPaymentSignal\(bankTxn\)/);
  assert.match(reconsideration, /suggested_qbo_account_id: targetAccountId/);
  assert.match(reconsideration, /final_qbo_account_id: null/);
  assert.match(reconsideration, /status: matched \? "auto_approved" : "needs_review"/);
});

test("business-history learning only uses human-approved final categorizations and checks direction", () => {
  const reconsideration = read("src/services/bookkeeping/routineExpenseReconsiderationService.js");
  const historyBody = reconsideration.slice(
    reconsideration.indexOf("async function buildBusinessHistoryIndex"),
    reconsideration.indexOf("function canUseUniversalIntentForResolution")
  );

  assert.match(historyBody, /status === "approved"/);
  assert.match(historyBody, /decidedBy === "user"/);
  assert.match(historyBody, /decidedBy === "user_clarification"/);
  assert.match(historyBody, /directions: new Set/);
  assert.match(historyBody, /direction_mismatch: true/);
});

test("unpaired credit-card payments are made non-postable instead of failed by unsupported old path", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  const markFailedBody = cron.slice(
    cron.indexOf("async function markFailed"),
    cron.indexOf("async function processOnePostingItem")
  );

  assert.match(markFailedBody, /unsupportedUnpairedCcPayment/);
  assert.match(markFailedBody, /markTransactionNonPostable\(item, "cc_payment_pair_requires_confirmation"\)/);
});
