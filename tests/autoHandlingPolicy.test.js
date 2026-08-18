import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { canAutoHandle, isRoutineExpenseFullyResolved } from "../src/services/bookkeeping/autoHandlingPolicy.js";
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

function routineDecision(overrides = {}) {
  return canAutoHandle(
    {
      id: "txn-routine",
      pending: false,
      accounting_review_required: false,
      direction: "OUTFLOW",
      amount: -24.99,
      merchant_name: "Apple",
      ...overrides.transaction,
    },
    {
      source: "universal_hint",
      confidence: "medium",
      accountId: "acct-software",
      accountName: "Software",
      canonicalAccountKey: "software",
      canonicalAccountResolved: true,
      canonicalVendorId: "vendor-apple",
      canonicalVendorReliable: true,
      merchantEvidenceStrong: true,
      meta: {
        suggestion_source: "universal_hint",
        canonical_account_key: "software",
      },
      ...overrides.evidence,
    },
    overrides.businessContext || businessContext
  );
}

test("medium routine expense with canonical vendor and canonical COA can auto-handle", () => {
  const decision = routineDecision();
  assert.equal(decision.eligible, true);
  assert.equal(decision.reason, "routine_expense_fully_resolved");
  assert.equal(decision.evidence.canonicalAccountResolved, true);
  assert.equal(decision.evidence.canonicalVendorReliable, true);
});

test("routine merchant evidence can promote Apple/Figma/Railway style SaaS only when COA is resolved", () => {
  for (const merchant of ["Apple", "Figma", "Railway"]) {
    const decision = routineDecision({
      transaction: { merchant_name: merchant },
      evidence: { canonicalVendorId: null, canonicalVendorReliable: false, merchantEvidenceStrong: true },
    });
    assert.equal(decision.eligible, true, merchant);
  }

  const unresolved = routineDecision({
    evidence: {
      canonicalAccountResolved: false,
      canonicalAccountKey: null,
      meta: { suggestion_source: "universal_hint" },
    },
  });
  assert.equal(unresolved.eligible, false);
  assert.equal(unresolved.reason, "medium_confidence_requires_review");
  assert.equal(isRoutineExpenseFullyResolved(
    { direction: "OUTFLOW", amount: -12, merchant_name: "Apple" },
    {
      source: "universal_hint",
      confidence: "medium",
      accountId: "acct-software",
      accountName: "Software",
      canonicalAccountResolved: false,
      merchantEvidenceStrong: true,
      meta: {},
    },
    businessContext
  ).reason, "canonical_account_not_resolved");
});

test("routine restaurant and parking expenses can auto-handle when fully resolved", () => {
  const restaurants = ["Chick-fil-A", "Not Just Coffee"];
  for (const merchant of restaurants) {
    assert.equal(routineDecision({
      transaction: { merchant_name: merchant },
      evidence: { accountId: "acct-meals", accountName: "Meals", canonicalAccountKey: "meals" },
    }).eligible, true, merchant);
  }
  assert.equal(routineDecision({
    transaction: { merchant_name: "ParkMobile" },
    evidence: { accountId: "acct-parking", accountName: "Parking & Tolls", canonicalAccountKey: "parking_tolls" },
  }).eligible, true);
});

test("routine path does not auto-handle weak merchant evidence or risky classes", () => {
  assert.equal(routineDecision({
    transaction: { merchant_name: null, name: "ACH WEB PAYMENT 928374" },
    evidence: {
      canonicalVendorId: null,
      canonicalVendorReliable: false,
      merchantEvidenceStrong: false,
    },
  }).eligible, false);
  assert.equal(routineDecision({ transaction: { pending: true } }).reason, "pending_transaction_not_postable");
  assert.equal(routineDecision({ evidence: { isCheck: true } }).reason, "check_requires_review");
  assert.equal(routineDecision({ evidence: { taxonomyType: "transfer_internal" } }).reason, "transfer_internal_requires_review");
  assert.equal(routineDecision({ evidence: { taxonomyType: "owner_draw" } }).reason, "owner_draw_requires_review");
  assert.equal(routineDecision({ evidence: { taxonomyType: "cc_payment" } }).reason, "cc_payment_mapping_not_safe");
  assert.equal(routineDecision({
    evidence: {
      vendorAmbiguous: true,
      meta: {
        suggestion_source: "universal_hint",
        canonical_account_key: "software",
        vendor_ambiguous: true,
      },
    },
  }).reason, "vendor_review_required");
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
  assert.match(source, /resolveCanonicalVendorEvidenceForPromotion/);
  assert.match(source, /canonicalAccountResolved/);
  assert.match(source, /safe_to_auto_handle/);
  assert.match(source, /auto_handle_decision/);
  assert.match(source, /validateCanonicalQboAccountForPromotion/);
  assert.match(source, /payload\.status = "auto_approved"[\s\S]*?payload\.final_qbo_account_id = validatedAccount\?\.id/);
  assert.match(source, /suggested_qbo_account_id/);
});

test("backlog reconsideration endpoint and Books background flow use the shared policy", () => {
  const routeSource = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.suggest.routes.js"), "utf8");
  const serviceSource = readFileSync(join(root, "src/services/bookkeeping/routineExpenseReconsiderationService.js"), "utf8");
  const pageSource = readFileSync(join(root, "src/pages/accounting/BookkeepingCleanup.jsx"), "utf8");

  assert.match(routeSource, /router\.post\("\/suggest\/reconsider"/);
  assert.match(serviceSource, /canAutoHandle/);
  assert.match(serviceSource, /resolveCanonicalVendorForTransaction/);
  assert.match(serviceSource, /validateCanonicalQboAccountForPromotion/);
  assert.doesNotMatch(serviceSource, /ensureCanonicalVendorMappedToQbo/);
  assert.match(pageSource, /reconsiderNeedsReviewTransactions/);
  assert.match(pageSource, /books_review_background/);
  assert.match(pageSource, /next_cursor/);
  assert.match(pageSource, /localStorage/);
});
