import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { canAutoHandle } from "../src/services/bookkeeping/autoHandlingPolicy.js";
import { computePostAfterForAutoPost } from "../src/services/bookkeeping/autoPostControl.js";

const root = process.cwd();

const safeAccount = { accountId: "acct-software", accountName: "Subscriptions" };
const suspenseAccount = { accountId: "acct-uncat", accountName: "Uncategorized Expense" };
const businessContext = { suspenseIds: new Set(["acct-uncat", "acct-ama"]) };

function decide(overrides = {}) {
  return canAutoHandle(
    {
      id: "txn-1",
      pending: false,
      accounting_review_required: false,
      ...overrides.transaction,
    },
    {
      source: "model_high",
      confidence: "high",
      ...safeAccount,
      safeToAutoHandle: true,
      meta: {},
      ...overrides.evidence,
    },
    overrides.businessContext || businessContext
  );
}

test("high-confidence safe categorization can auto-handle while auto-post is off", () => {
  const decision = decide();
  assert.equal(decision.eligible, true);
  assert.equal(decision.needsReview, false);
  assert.equal(computePostAfterForAutoPost(false, 24, Date.parse("2026-08-01T00:00:00Z")), null);
});

test("high-confidence safe categorization can auto-handle while auto-post is on and then gets a grace timestamp", () => {
  const decision = decide();
  assert.equal(decision.eligible, true);
  assert.match(
    computePostAfterForAutoPost(true, 24, Date.parse("2026-08-01T00:00:00Z")),
    /^2026-08-02T00:00:00/
  );
});

test("generic medium first encounter remains Needs Review", () => {
  const decision = decide({
    evidence: {
      source: "plaid_mapping",
      confidence: "medium",
      safeToAutoHandle: false,
    },
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "medium_confidence_requires_review");
});

test("business-learned recurring merchant can auto-handle after reliable approval evidence", () => {
  const decision = decide({
    evidence: {
      source: "learned_recurring",
      confidence: "high",
      safeToAutoHandle: true,
      reason: "learned_recurring",
    },
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.source, "learned_recurring");
});

test("deterministic vendor rule can auto-handle but weak rule cannot", () => {
  assert.equal(
    decide({
      evidence: {
        source: "vendor_rule",
        confidence: "high",
        safeToAutoHandle: true,
      },
    }).eligible,
    true
  );

  const weak = decide({
    evidence: {
      source: "vendor_rule",
      confidence: "medium",
      safeToAutoHandle: false,
      weakRule: true,
    },
  });
  assert.equal(weak.eligible, false);
});

test("pending and Plaid duplicate/relink review fail closed", () => {
  assert.equal(decide({ transaction: { pending: true } }).reason, "pending_transaction_not_postable");
  assert.equal(
    decide({ transaction: { accounting_review_required: true } }).reason,
    "plaid_accounting_review_required"
  );
});

test("checks, owner moves, refunds, and transfers remain Needs Review", () => {
  assert.equal(decide({ evidence: { isCheck: true } }).reason, "check_requires_review");
  assert.equal(decide({ evidence: { taxonomyType: "owner_draw" } }).reason, "owner_draw_requires_review");
  assert.equal(decide({ evidence: { taxonomyType: "owner_contribution" } }).reason, "owner_contribution_requires_review");
  assert.equal(decide({ evidence: { taxonomyType: "refund" } }).reason, "refund_requires_review");
  assert.equal(decide({ evidence: { taxonomyType: "transfer_internal" } }).reason, "transfer_internal_requires_review");
});

test("credit-card payment needs verified two-sided mapping before auto-handling", () => {
  const ambiguous = decide({
    evidence: {
      taxonomyType: "cc_payment",
      source: "taxonomy",
      safeToAutoHandle: true,
      meta: { taxonomy_type: "cc_payment" },
    },
  });
  assert.equal(ambiguous.eligible, false);
  assert.equal(ambiguous.reason, "cc_payment_mapping_not_safe");

  const verified = decide({
    evidence: {
      taxonomyType: "cc_payment",
      source: "taxonomy",
      safeToAutoHandle: true,
      meta: {
        taxonomy_type: "cc_payment",
        cc_payment_mapping_confidence: "high",
        cc_payment_bank_qbo_account_id: "bank-1",
        cc_payment_cc_qbo_account_id: "cc-1",
      },
    },
  });
  assert.equal(verified.eligible, true);
});

test("suspense and uncategorized accounts remain Needs Review", () => {
  assert.equal(decide({ evidence: suspenseAccount }).reason, "review_or_suspense_account");
  assert.equal(
    decide({ evidence: { accountId: "acct-ama", accountName: "Ask My Accountant" } }).reason,
    "review_or_suspense_account"
  );
});

test("suggestion route uses central auto-handling policy and finalizes only handled rows", () => {
  const source = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.suggest.routes.js"), "utf8");

  assert.match(source, /canAutoHandle/);
  assert.match(source, /safe_to_auto_handle/);
  assert.match(source, /auto_handle_decision/);
  assert.match(source, /payload\.status = "auto_approved"[\s\S]*?payload\.final_qbo_account_id = suggestedId/);
  assert.match(source, /suggested_qbo_account_id/);
});
