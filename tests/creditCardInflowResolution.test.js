import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { normalizeTransactionResolution } from "../src/services/bookkeeping/transactionResolutionService.js";
import { classifyBookkeepingLifecycle, derivePostingOutcome } from "../src/services/bookkeeping/bookkeepingLifecycleClassifier.js";
import { buildCreditCardCreditPayload } from "../src/services/bookkeeping/creditCardMerchantRefundPayload.js";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("canonical resolution model distinguishes credit-card inflow intents", () => {
  assert.equal(normalizeTransactionResolution("merchant_refund"), "merchant_refund");
  assert.equal(normalizeTransactionResolution("match_credit_card_payment"), "match_credit_card_payment");
  assert.equal(normalizeTransactionResolution("credit_card_statement_credit"), "credit_card_statement_credit");
  assert.equal(normalizeTransactionResolution("credit_card_credit_other"), "credit_card_credit_other");
});

test("durable credit-card inflow decisions record canonical disposition and audit version", () => {
  const service = read("src/services/bookkeeping/transactionResolutionService.js");
  assert.match(service, /decision_version: 1/);
  assert.match(service, /qbo_disposition: qboDisposition/);
  assert.match(service, /operator_source: source/);
  assert.match(service, /request_id: requestId \|\| null/);
  assert.match(service, /prior_credit_card_inflow_resolution/);
  assert.match(service, /credit_card_inflow_resolution_not_persisted/);
});

test("unresolved credit-card inflow fails closed before any QuickBooks write", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  const guard = cron.indexOf("const isUnresolvedCreditCardInflow");
  const write = cron.indexOf('logPostSuccessStage("qbo_write_started"');
  assert.ok(guard > 0 && guard < write);
  assert.match(cron.slice(guard, write), /outcome: "confirmation_required"/);
  assert.match(cron.slice(guard, write), /status: "needs_review"/);
  assert.match(cron.slice(guard, write), /credit_card_inflow_resolution_required/);
});

test("merchant refunds use Credit direction with nonnegative card and expense magnitudes", () => {
  const payload = buildCreditCardCreditPayload({
    amount: 75.76,
    txnDate: "2026-08-25",
    sourceCreditCardAccountId: "card-1",
    categoryAccountId: "entertainment-1",
    vendorRef: { value: "sony-1" },
  });
  assert.equal(payload.PaymentType, "CreditCard");
  assert.equal(payload.Credit, true);
  assert.equal(payload.TotalAmt, 75.76);
  assert.equal(payload.Line[0].Amount, 75.76);
  assert.deepEqual(payload.EntityRef, { value: "sony-1", type: "Vendor" });
});

test("opposite-sign original card charge is not a refund duplicate", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  assert.match(cron, /qboTxnType === "CreditCardCredit"[\s\S]*Number\(candidateAmount\) < 0/);
  assert.match(cron, /c\.amount_matches && c\.direction_matches/);
});

test("legacy Handled inflow receives actionable credit-type UI", () => {
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  assert.match(page, /What type of credit is this\?/);
  assert.match(page, /Merchant refund — reduce/);
  assert.match(page, /Credit-card payment — match account/);
  assert.match(page, /Cash back or statement credit/);
  assert.match(page, /saveCreditCardInflowResolution/);
});

test("unresolved status is not mislabeled as a posting failure", () => {
  assert.equal(derivePostingOutcome({ meta: { post_block_reason: "credit_card_inflow_resolution_required" } }).label, "Needs credit type");
  assert.equal(derivePostingOutcome({ post_error: "credit_card_inflow_requires_review", last_post_attempt_at: "2026-06-10T00:00:00Z" }).label, "Needs credit type");
});

test("unresolved positive card activity stays in Needs Review even if previously auto-approved", () => {
  assert.equal(classifyBookkeepingLifecycle({ status: "auto_approved", account_type: "credit card", amount: 32.16, meta: {} }).bucket, "needs_review");
  assert.equal(classifyBookkeepingLifecycle({ status: "approved", account_type: "credit card", amount: 32.16, meta: { credit_card_inflow_resolution: { resolution_type: "merchant_refund" } } }).bucket, "handled");
});

test("payment choice remains routed through protected matching", () => {
  const service = read("src/services/bookkeeping/transactionResolutionService.js");
  assert.match(service, /const payment = normalized === "match_credit_card_payment"/);
  assert.match(service, /status: payment \|\| normalized === "credit_card_credit_other" \? "needs_review" : "approved"/);
  assert.match(service, /post_error: payment \? "cc_payment_pair_requires_confirmation"/);
});

test("Needs Review asks for credit type and exposes all four decisions", () => {
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
  assert.match(feed, /What type of credit is this\?/);
  assert.match(feed, /\["merchant_refund", "Merchant refund"\]/);
  assert.match(feed, /\["match_credit_card_payment", "Credit-card payment"\]/);
  assert.match(feed, /\["credit_card_statement_credit", "Cash back or statement credit"\]/);
  assert.match(feed, /\["credit_card_credit_other", "Something else"\]/);
});
