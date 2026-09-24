import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* global process */

process.env.SUPABASE_URL ||= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const { matchesTransactionStatusFilter } = await import("../src/services/bookkeeping/bookkeepingTransactionFeedService.js");

const migration = readFileSync(new URL("../supabase/migrations/20261013_credit_card_payment_matched_lifecycle.sql", import.meta.url), "utf8");
const neverHandledMigration = readFileSync(new URL("../supabase/migrations/20261018_credit_card_payments_never_handled.sql", import.meta.url), "utf8");
const unconfirmedPairPrecedenceMigration = readFileSync(new URL("../supabase/migrations/20261019_unconfirmed_credit_card_payments_stay_in_review.sql", import.meta.url), "utf8");
const feedUi = readFileSync(new URL("../src/components/Accounting/BookkeepingFeed.jsx", import.meta.url), "utf8");
const reconsiderationService = readFileSync(new URL("../src/services/bookkeeping/routineExpenseReconsiderationService.js", import.meta.url), "utf8");
const suggestionRoute = readFileSync(new URL("../src/api/bookkeeping/routes/bookkeeping.suggest.routes.js", import.meta.url), "utf8");

const confirmedLeg = {
  status: "matched",
  qbo_txn_id: null,
  post_after: null,
  meta: {
    taxonomy_type: "cc_payment",
    match_type: "credit_card_payment_pair",
    cc_payment_pair_id: "pair-1",
    cc_payment_pair_status: "confirmed",
    safe_to_auto_post: false,
  },
};

test("a confirmed credit-card-payment leg belongs only to Matched", () => {
  assert.equal(matchesTransactionStatusFilter("matched", confirmedLeg), true);
  for (const feed of ["needs_review", "handled", "posted", "pending"])
    assert.equal(matchesTransactionStatusFilter(feed, confirmedLeg), false, feed);
});

test("ordinary Handled rows retain Undo while matched payments stay out of Handled", () => {
  assert.match(feedUi, /\["approved", "auto_approved", "handled", "failed"\]\.includes\(txn\.status\)/);
  assert.equal(matchesTransactionStatusFilter("handled", { status: "handled", meta: {} }), true);
  assert.equal(matchesTransactionStatusFilter("handled", confirmedLeg), false);
});

test("an unresolved payment with stale approved status is Needs Review and never Handled", () => {
  const legacyHybrid = {
    status: "approved",
    final_qbo_account_id: "old-expense-account",
    meta: {
      taxonomy_type: "cc_payment",
      taxonomy_override: "cc_payment",
      user_selected_resolution: "match_credit_card_payment",
      cc_payment_rejected: false,
    },
  };
  assert.equal(matchesTransactionStatusFilter("needs_review", legacyHybrid), true);
  assert.equal(matchesTransactionStatusFilter("handled", legacyHybrid), false);
  assert.equal(matchesTransactionStatusFilter("matched", legacyHybrid), false);
});

test("an unresolved payment with stale matched status returns to Needs Review", () => {
  const partiallyMatchedLegacyLeg = {
    status: "matched",
    qbo_txn_id: null,
    meta: {
      taxonomy_type: "cc_payment",
      taxonomy_override: "cc_payment",
      user_selected_resolution: "match_credit_card_payment",
      cc_payment_rejected: false,
      cc_payment_pair_id: "candidate-pair",
      cc_payment_pair_status: "candidate",
    },
  };
  assert.equal(matchesTransactionStatusFilter("needs_review", partiallyMatchedLegacyLeg), true);
  assert.equal(matchesTransactionStatusFilter("matched", partiallyMatchedLegacyLeg), false);
  assert.equal(matchesTransactionStatusFilter("handled", partiallyMatchedLegacyLeg), false);
});

test("bounded feed predicate keeps all active card payments out of Handled", () => {
  assert.match(neverHandledMigration, /and not is_credit_card_payment/);
  assert.match(neverHandledMigration, /is_credit_card_payment[\s\S]*not is_confirmed_credit_card_payment/);
  assert.match(neverHandledMigration, /unresolved credit-card payments are Needs Review/i);
});

test("bounded feed predicate gives pair confirmation precedence over stale matched status", () => {
  assert.match(unconfirmedPairPrecedenceMigration, /is_credit_card_payment and is_confirmed_credit_card_payment/);
  assert.match(unconfirmedPairPrecedenceMigration, /not is_credit_card_payment[\s\S]*current_status in \('matched', 'matched_existing_qbo'\)/);
  assert.match(unconfirmedPairPrecedenceMigration, /unconfirmed credit-card pairs remain Needs Review/i);
});

test("background classification cannot treat a high-confidence candidate as a confirmed payment", () => {
  for (const source of [reconsiderationService, suggestionRoute]) {
    assert.match(source, /isConfirmedCreditCardPaymentPairStatus/);
    assert.match(source, /pairConfidence|match_confidence/);
    assert.match(source, /pairStatus|pair\.status/);
  }
  assert.match(reconsiderationService, /status: matched \? "auto_approved" : "needs_review"/);
  assert.match(suggestionRoute, /status: matched \? "auto_approved" : "needs_review"/);
  for (const source of [reconsiderationService, suggestionRoute]) {
    assert.match(source, /post_error: null/);
  }
});

test("database transition is atomic, idempotent, non-posting, and feed-canonical", () => {
  assert.match(migration, /for update|pg_get_functiondef/i);
  assert.match(migration, /status='matched', review_status='matched'/);
  assert.match(migration, /when new\.status in \('matched', 'matched_existing_qbo'\) then 'not_scheduled'/);
  assert.match(migration, /never schedules or creates QBO activity/);
  assert.match(migration, /cc_payment_pair_status' in \('confirmed', 'posting', 'failed', 'posted'\)/);
  assert.doesNotMatch(migration, /update public\.transaction_categorizations[\s\S]*where[\s\S]*cc_payment_pair_status/);
});

test("the audit is read-only and the repair remains an explicit rollback template", () => {
  const audit = readFileSync(new URL("../scripts/manual/auditCreditCardPaymentPairLifecycle.sql", import.meta.url), "utf8");
  const repair = readFileSync(new URL("../scripts/manual/repairCreditCardPaymentPairLifecycle.sql", import.meta.url), "utf8");
  assert.doesNotMatch(audit, /\b(update|insert|delete)\b/i);
  assert.match(repair, /<BUSINESS_UUID>/);
  assert.match(repair, /<PAIR_UUID>/);
  assert.match(repair, /rollback;/i);
});
