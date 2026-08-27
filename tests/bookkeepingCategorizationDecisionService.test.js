import test from "node:test";
import assert from "node:assert/strict";

import { decideBookkeepingCategorization } from "../src/services/bookkeeping/bookkeepingCategorizationDecisionService.js";
import { deriveQboPostingLifecycle } from "../src/services/bookkeeping/qboPostingLifecycle.js";

function decide(overrides = {}) {
  return decideBookkeepingCategorization({
    transaction: {
      id: "txn-1",
      direction: "OUTFLOW",
      amount: -12.5,
      pending: false,
      accounting_review_required: false,
      merchant_name: "ParkMobile",
      ...overrides.transaction,
    },
    account: {
      id: "acct-1",
      name: "Transportation",
      type: "Expense",
      subType: "Travel",
      ...overrides.account,
    },
    evidence: {
      source: "approved_business_rule",
      confidenceTier: "very_high",
      canonicalAccountResolved: true,
      canonicalVendorReliable: true,
      merchantEvidenceStrong: true,
      inBookkeepingScope: true,
      ...overrides.evidence,
    },
    businessContext: overrides.businessContext || { suspenseIds: new Set(["acct-uncat", "acct-ama"]) },
  });
}

test("approval-backed same-business vendor rule evidence can auto-handle as very high confidence", () => {
  const decision = decide();

  assert.equal(decision.auto_handle, true);
  assert.equal(decision.resolved, true);
  assert.equal(decision.confidence_tier, "very_high");
  assert.equal(decision.final_qbo_account_id, "acct-1");
  assert.equal(decision.final_qbo_account_name, "Transportation");
});

test("exact strong universal vendor hint with resolved canonical account can auto-handle", () => {
  const decision = decide({
    account: { id: "acct-meals", name: "Meals", type: "Expense", subType: "MealsEntertainment" },
    evidence: {
      source: "universal_hint",
      confidenceTier: "high",
      safeToAutoHandle: true,
      canonicalAccountKey: "meals",
    },
  });

  assert.equal(decision.auto_handle, true);
  assert.equal(decision.confidence_tier, "high");
});

test("Plaid-only medium suggestion remains Needs Review even when a visible account exists", () => {
  const decision = decide({
    account: { id: "acct-meals", name: "Meals", type: "Expense" },
    evidence: {
      source: "plaid_mapping",
      confidenceTier: "medium",
      safeToAutoHandle: false,
      canonicalAccountResolved: false,
      canonicalVendorReliable: false,
    },
  });

  assert.equal(decision.auto_handle, false);
  assert.equal(decision.resolved, false);
  assert.equal(decision.block_reason, "medium_confidence_requires_review");
});

test("explicit conflicting evidence blocks auto-handle even with an otherwise valid account", () => {
  const decision = decide({
    account: { id: "acct-meals", name: "Meals", type: "Expense" },
    evidence: {
      source: "approved_business_rule",
      confidenceTier: "very_high",
      conflictingEvidence: true,
    },
  });

  assert.equal(decision.auto_handle, false);
  assert.equal(decision.block_reason, "conflicting_categorization_evidence");
});

test("suspense accounts never auto-handle even when they have QBO ids", () => {
  for (const name of ["Uncategorized Expense", "Uncategorized Income", "Ask My Accountant"]) {
    const decision = decide({
      account: { id: `acct-${name}`, name, type: "Expense" },
    });
    assert.equal(decision.auto_handle, false, name);
    assert.equal(decision.block_reason, "review_or_suspense_account");
  }
});

test("pending, archived, superseded, and incompatible accounts fail closed", () => {
  assert.equal(decide({ transaction: { pending: true } }).block_reason, "pending_transaction_not_postable");
  assert.equal(decide({ transaction: { is_archived: true } }).block_reason, "archived_transaction");
  assert.equal(decide({ transaction: { superseded: true } }).block_reason, "superseded_transaction");
  assert.equal(
    decide({ account: { id: "acct-bank", name: "Checking", type: "Bank" } }).block_reason,
    "qbo_account_type_incompatible"
  );
  assert.equal(
    decide({ transaction: { direction: "OUTFLOW" }, account: { id: "acct-income", name: "Sales", type: "Income" } }).block_reason,
    "qbo_account_type_incompatible"
  );
});

test("Auto-post off still means handled not posted after auto approval, without QBO id", () => {
  const decision = decide();
  const lifecycle = deriveQboPostingLifecycle({
    status: decision.auto_handle ? "auto_approved" : "needs_review",
    final_qbo_account_id: decision.final_qbo_account_id,
    final_qbo_account_name: decision.final_qbo_account_name,
    post_after: null,
    qbo_txn_id: null,
  });

  assert.equal(decision.auto_handle, true);
  assert.equal(lifecycle.key, "handled_not_posted");
});
