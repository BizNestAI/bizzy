import test from "node:test";
import assert from "node:assert/strict";
import {
  applyManualAccountAuthorityToPostingItem,
  hasManualAccountAuthority,
  isProtectedPostingWorkflow,
  resolveManualApprovalBookkeepingMeta,
  taxonomyRequiresBookkeepingPostingReview,
} from "../src/services/bookkeeping/postingDecisionAuthority.js";

test("legacy manual handled rows with a valid selected QBO account are not blocked by stale taxonomy-only review tags", () => {
  const item = {
    status: "failed",
    decided_by: "user",
    final_qbo_account_id: "69",
    meta: {
      taxonomy_type: "owner_distribution",
      taxonomy_subtype: "possible_personal",
      taxonomy_confidence: 0.93,
      post_block_reason: "taxonomy_requires_review",
      auto_post_block_reason: "taxonomy_requires_review",
    },
  };

  assert.equal(hasManualAccountAuthority(item), true);
  assert.equal(taxonomyRequiresBookkeepingPostingReview(item), false);

  const resolved = applyManualAccountAuthorityToPostingItem(item);
  assert.equal(resolved.meta.taxonomy_type, undefined);
  assert.equal(resolved.meta.resolved_taxonomy_type, "owner_distribution");
  assert.equal(resolved.meta.taxonomy_resolved_by, "manual_qbo_account_selection");
  assert.equal(resolved.meta.post_block_reason, undefined);
  assert.equal(resolved.meta.auto_post_block_reason, undefined);
});

test("legacy positive bank reimbursement with explicit Expense GL account is not blocked by stale transfer taxonomy", () => {
  const item = {
    transaction_id: "cc513c09-00a3-4f74-b23f-393afc113e35",
    status: "failed",
    decided_by: "user",
    final_qbo_account_id: "29",
    final_qbo_account_name: "Fantasy Football",
    amount: 50,
    meta: {
      manual_post: true,
      taxonomy_type: "transfer_internal",
      confidence_tier: "high",
      evidence_source: "taxonomy",
      suggestion_debug: {
        taxonomy_type: "transfer_internal",
        taxonomy_confidence: "high",
      },
      post_block_reason: "transfer_posting_not_supported",
      safe_to_auto_post: false,
      auto_approve_reason: "manual_user",
      auto_handle_decision: {
        requiresReview: true,
        reason: "taxonomy_requires_review",
        status: "needs_review",
        safeToAutoHandle: false,
      },
      accounting_decision_source: "manual_qbo_account_selection",
      manual_qbo_account_selection: true,
    },
  };

  assert.equal(hasManualAccountAuthority(item), true);
  assert.equal(isProtectedPostingWorkflow(item.meta), false);
  assert.equal(taxonomyRequiresBookkeepingPostingReview(item), false);

  const resolved = applyManualAccountAuthorityToPostingItem(item);
  assert.equal(resolved.meta.taxonomy_type, undefined);
  assert.equal(resolved.meta.resolved_taxonomy_type, "transfer_internal");
  assert.equal(resolved.meta.taxonomy_resolved_by, "manual_qbo_account_selection");
  assert.equal(resolved.meta.post_block_reason, undefined);
  assert.equal(resolved.meta.manual_qbo_account_selection, true);
});

test("auto-approved rows do not bypass taxonomy review solely because an account id exists", () => {
  const item = {
    status: "auto_approved",
    decided_by: "bizzi",
    final_qbo_account_id: "69",
    meta: {
      taxonomy_type: "owner_distribution",
      auto_approve_reason: "vendor_rule",
    },
  };

  assert.equal(hasManualAccountAuthority(item), false);
  assert.equal(taxonomyRequiresBookkeepingPostingReview(item), true);
});

test("unresolved taxonomy review remains blocked without a valid explicit account selection", () => {
  const item = {
    status: "needs_review",
    decided_by: "bizzi",
    final_qbo_account_id: null,
    meta: {
      taxonomy_type: "transfer_internal",
      post_block_reason: "taxonomy_requires_review",
    },
  };

  assert.equal(hasManualAccountAuthority(item), false);
  assert.equal(taxonomyRequiresBookkeepingPostingReview(item), true);
});

test("new manual approvals clear stale taxonomy-only review state", () => {
  const resolved = resolveManualApprovalBookkeepingMeta(
    {
      taxonomy_type: "refund",
      taxonomy_subtype: "maybe_refund",
      taxonomy_confidence: 0.72,
      post_block_reason: "taxonomy_requires_review",
    },
    { explicitFinalAccountId: "sales-income" }
  );

  assert.equal(resolved.manual_qbo_account_selection, true);
  assert.equal(resolved.taxonomy_type, undefined);
  assert.equal(resolved.resolved_taxonomy_type, "refund");
  assert.equal(resolved.post_block_reason, undefined);
});

test("protected credit-card payment, transfer, and split workflows remain protected", () => {
  const cc = resolveManualApprovalBookkeepingMeta(
    { taxonomy_type: "cc_payment", cc_payment_pair_status: "candidate" },
    { explicitFinalAccountId: "expense-account" }
  );
  assert.equal(cc.taxonomy_type, "cc_payment");
  assert.equal(isProtectedPostingWorkflow(cc), true);

  const transfer = resolveManualApprovalBookkeepingMeta(
    {
      taxonomy_type: "transfer_internal",
      post_block_reason: "transfer_posting_not_supported",
      transfer_pair_txn_id: "paired-transfer-txn",
    },
    { explicitFinalAccountId: "expense-account" }
  );
  assert.equal(transfer.taxonomy_type, "transfer_internal");
  assert.equal(transfer.post_block_reason, "transfer_posting_not_supported");
  assert.equal(isProtectedPostingWorkflow(transfer), true);

  const split = resolveManualApprovalBookkeepingMeta(
    { taxonomy_type: "split_transaction", split_transaction_status: "confirmed", split_transaction_id: "split-1" },
    { explicitFinalAccountId: "expense-account" }
  );
  assert.equal(split.taxonomy_type, "split_transaction");
  assert.equal(split.split_transaction_status, "confirmed");
  assert.equal(isProtectedPostingWorkflow(split), true);
});
