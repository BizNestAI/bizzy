/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  applySpecializedTypeAuthority,
  hasFinalSpecializedTypeAuthority,
  supersedeProvisionalClassification,
} from "../src/services/bookkeeping/specializedTypeAuthority.js";
import { getProtectedWorkflowReason } from "../src/services/bookkeeping/protectedWorkflow.js";
import { resolveCanonicalPostingRail } from "../src/services/bookkeeping/canonicalPostingCompiler.js";
import { persistCreditCardInflowResolution } from "../src/services/bookkeeping/transactionResolutionService.js";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
const { normalizeBookkeepingTransactionRow } = await import("../src/services/bookkeeping/bookkeepingTransactionFeedService.js");

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function finalDecision() {
  return {
    decision_version: 2,
    resolution_type: "credit_card_statement_credit",
    destination_qbo_account_id: "1150040004",
    destination_qbo_account_name: "Credit Card Rewards",
    decided_by: "operator-1",
    decided_at: "2026-09-29T16:05:08.412Z",
    decision_source: "user",
    operator_source: "books_review",
  };
}

function staleCategorization(overrides = {}) {
  return {
    status: "failed",
    final_qbo_account_id: "1150040004",
    final_qbo_account_name: "Credit Card Rewards",
    post_error: "taxonomy_requires_review",
    meta: {
      taxonomy_type: "transfer_internal",
      taxonomy_confidence: "high",
      post_block_reason: "taxonomy_requires_review",
      user_selected_resolution: "categorize_new",
      credit_card_inflow_resolution: finalDecision(),
    },
    ...overrides,
  };
}

test("authorized statement-credit decision supersedes provisional transfer in shared authority", () => {
  const resolved = applySpecializedTypeAuthority(staleCategorization());
  assert.equal(hasFinalSpecializedTypeAuthority(resolved), true);
  assert.equal(resolved.taxonomy_type, undefined);
  assert.equal(resolved.meta.taxonomy_type, undefined);
  assert.equal(resolved.meta.post_block_reason, undefined);
  assert.equal(resolved.meta.superseded_provisional_classification.prior_type, "transfer_internal");
  assert.deepEqual(applySpecializedTypeAuthority(resolved), resolved);
});

test("canonical feed and both review surfaces receive no active transfer state", () => {
  const feedRow = normalizeBookkeepingTransactionRow({
    id: "statement-credit-1", date: "2026-06-06", amount: 0.76, direction: "INFLOW",
    name: "AUTOMATIC STATEMENT CREDIT", account_type: "credit card",
  }, staleCategorization(), "Discover it Card ••••9734");
  assert.equal(feedRow.taxonomy_type, null);
  assert.equal(feedRow.meta.taxonomy_type, undefined);
  assert.equal(feedRow.final_qbo_account_name, "Credit Card Rewards");
  assert.equal(feedRow.meta.credit_card_inflow_resolution.resolution_type, "credit_card_statement_credit");
  assert.equal(getProtectedWorkflowReason(feedRow), null);
  const adminRoute = read("src/api/admin/monthlyReview.routes.js");
  const customerRoute = read("src/api/bookkeeping/routes/bookkeeping.transactions.routes.js");
  assert.match(adminRoute, /bookkeepingTransactionFeedService|fetchBookkeepingTransactions/);
  assert.doesNotMatch(customerRoute, /function normalizeBookkeepingTransactionRow/);
});

test("statement credit compiles to canonical CreditCardCredit without transfer matching", () => {
  assert.equal(resolveCanonicalPostingRail({
    bankTransaction: { amount: 0.76, direction: "INFLOW" },
    categorization: staleCategorization(),
    mapping: { qbo_account_type: "CreditCard" },
  }), "CreditCardCredit");
  const worker = read("src/jobs/booksPost.cron.js");
  assert.match(worker, /applySpecializedTypeAuthority\(item\)/);
  assert.match(worker, /return "CreditCardCredit"/);
});

test("confirmed transfer and protected card-payment evidence cannot be overwritten", () => {
  const transfer = staleCategorization({ meta: { ...staleCategorization().meta, transfer_pair_id: "pair-1", transfer_pair_status: "confirmed" } });
  assert.equal(applySpecializedTypeAuthority(transfer).meta.taxonomy_type, "transfer_internal");
  const payment = supersedeProvisionalClassification({ taxonomy_type: "cc_payment", cc_payment_pair_id: "cc-pair", cc_payment_pair_status: "confirmed" });
  assert.equal(payment.taxonomy_type, "cc_payment");
  const posted = staleCategorization({ status: "posted", qbo_txn_id: "qbo-1" });
  assert.equal(applySpecializedTypeAuthority(posted).meta.taxonomy_type, "transfer_internal");
});

function memoryDb(initial) {
  const state = structuredClone(initial);
  return {
    state,
    from() {
      let operation = "select";
      let payload;
      const query = {
        select() { return query; }, eq() { return query; },
        upsert(value) { operation = "write"; payload = value; return query; },
        update(value) { operation = "write"; payload = value; return query; },
        async maybeSingle() {
          if (operation === "write") Object.assign(state, structuredClone(payload));
          return { data: structuredClone(state), error: null };
        },
      };
      return query;
    },
  };
}

test("confirmation persistence removes stale blocker, records v2 audit, and is idempotent in projection", async () => {
  const db = memoryDb({
    business_id: "biz-1", transaction_id: "statement-credit-1", status: "failed",
    final_qbo_account_id: "1150040004", post_error: "taxonomy_requires_review",
    meta: { taxonomy_type: "transfer_internal", post_block_reason: "taxonomy_requires_review" },
  });
  await persistCreditCardInflowResolution({
    db, businessId: "biz-1", transactionId: "statement-credit-1",
    resolution: "credit_card_statement_credit", selectedQboAccountId: "1150040004",
    selectedQboAccountName: "Credit Card Rewards", actor: "operator-1",
    source: "monthly_review", requestId: "request-1",
  });
  assert.equal(db.state.status, "approved");
  assert.equal(db.state.post_error, null);
  assert.equal(db.state.meta.taxonomy_type, undefined);
  assert.equal(db.state.meta.credit_card_inflow_resolution.decision_version, 2);
  assert.equal(db.state.meta.credit_card_inflow_resolution.request_id, "request-1");
  assert.equal(db.state.meta.superseded_provisional_classification.prior_type, "transfer_internal");
  assert.deepEqual(applySpecializedTypeAuthority(db.state), db.state);
});

test("posted or receipt-confirmed rows fail closed", async () => {
  for (const finalized of [
    { status: "posted", posted_at: "2026-10-01T00:00:00Z" },
    { status: "failed", meta: { qbo_receipt_confirmed_at: "2026-10-01T00:00:00Z" } },
  ]) {
    const db = memoryDb({ business_id: "biz-1", transaction_id: "txn-1", final_qbo_account_id: "24", ...finalized });
    await assert.rejects(() => persistCreditCardInflowResolution({
      db, businessId: "biz-1", transactionId: "txn-1", resolution: "credit_card_statement_credit",
      selectedQboAccountId: "24", actor: "operator-1",
    }), /finalized_workflow/);
  }
});

test("existing recovery mechanism consumes canonical cleaned metadata without a page reload", () => {
  const recovery = read("src/services/bookkeeping/postingEligibilityRecheckService.js");
  const consoleSource = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  assert.match(recovery, /applySpecializedTypeAuthority\(cat\)/);
  assert.match(recovery, /hasFinalSpecializedTypeAuthority\(cat\)/);
  assert.match(consoleSource, /patchManualPostingRow/);
  assert.doesNotMatch(consoleSource, /window\.location\.reload/);
});
