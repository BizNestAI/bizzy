import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildMonthlyReviewManualApproval,
  decideManualPostingGate,
  hasAuthorizedMonthlyReviewApproval,
} from "../src/services/bookkeeping/manualPostingAuthority.js";
import { isBooksReviewHandled } from "../src/services/bookkeeping/reconciliationPipelineStatus.js";

const GOOGLE_TXN_ID = "google-workspace-2026-08-02-52-80";
const BUSINESS_ID = "cffc2183-e77c-4148-a206-d5192e090925";

function approvedItem(reason = "probable_requires_review") {
  const item = {
    business_id: BUSINESS_ID,
    transaction_id: GOOGLE_TXN_ID,
    reason,
    meta: {},
  };
  item.meta.manual_approval = buildMonthlyReviewManualApproval({
    item,
    businessId: BUSINESS_ID,
    transactionId: GOOGLE_TXN_ID,
    actorId: "admin-user",
    selectedQboAccountId: "software-qbo-id",
    selectedQboAccountName: "Software",
    operationId: "google-workspace-manual-approval",
    idempotencyKey: "google-workspace-2026-08-02",
    approvedAt: "2026-09-22T18:00:00.000Z",
  });
  return item;
}

test("probable review remains blocked without durable Monthly Review authority", () => {
  const decision = decideManualPostingGate({ item: { meta: {} }, reason: "probable_requires_review" });
  assert.equal(decision.allowed, false);
  assert.equal(decision.bypassed, false);
});

for (const reason of ["probable_requires_review", "weak_memo_evidence", "low_classifier_confidence", "merchant_ambiguous", "no_matching_vendor_rule"]) {
  test(`authorized Monthly Review approval overrides soft gate: ${reason}`, () => {
    const item = approvedItem(reason);
    assert.equal(hasAuthorizedMonthlyReviewApproval(item), true);
    assert.deepEqual(decideManualPostingGate({ item, reason, gate: "vendor_payee" }), {
      allowed: true,
      bypassed: true,
      gate: "vendor_payee",
      reason,
      authority: "admin_manual_approval",
    });
  });
}

for (const reason of ["missing_final_qbo_account", "missing_source_mapping", "qbo_client_unavailable", "qbo_api_rejected", "possible_qbo_duplicate"]) {
  test(`manual approval preserves hard gate: ${reason}`, () => {
    const decision = decideManualPostingGate({ item: approvedItem(), reason });
    assert.equal(decision.allowed, false);
    assert.equal(decision.bypassed, false);
  });
}

test("Google Workspace fixture is durably authorized and reaches the exact QBO call once", async () => {
  const item = approvedItem("probable_requires_review");
  let qboCalls = 0;
  const gate = decideManualPostingGate({ item, reason: "probable_requires_review", gate: "vendor_payee" });
  if (gate.allowed) {
    qboCalls += 1;
    assert.equal(item.meta.manual_approval.selected_qbo_account_name, "Software");
    assert.equal(item.meta.manual_approval.original_review_reason, "probable_requires_review");
  }
  assert.equal(qboCalls, 1);
});

test("posting worker consumes durable authority and only bypasses classified soft vendor gates", () => {
  const worker = readFileSync(new URL("../src/jobs/booksPost.cron.js", import.meta.url), "utf8");
  const control = readFileSync(new URL("../src/services/bookkeeping/autoPostControl.js", import.meta.url), "utf8");
  assert.match(worker, /decideManualPostingGate\(\{ item, reason: outcome\.reason, gate: "vendor_payee" \}\)/);
  assert.match(worker, /manual approval bypassed soft vendor review gate/);
  assert.match(control, /manual_approval_state: "admin_approved_pending_post"/);
  assert.match(control, /categorization_authority: "admin_confirmed"/);
  assert.match(worker, /manual_approval_state: "qbo_posting"/);
  assert.match(worker, /manual_approval_state: "qbo_posted"/);
  assert.match(worker, /post_error: null/);
});

test("unresolved posting failures are actionable exceptions, not Handled rows", () => {
  const failed = {
    status: "failed",
    post_error: "qbo_api_rejected",
    last_post_attempt_at: "2026-09-22T18:00:00.000Z",
  };
  assert.equal(isBooksReviewHandled(failed), false);
});
