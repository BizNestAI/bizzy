/* global process */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectProcessorSettlementActivity } from "../src/services/bookkeeping/processorSettlementProfiles.js";

const root = process.cwd();
const feed = readFileSync(join(root, "src/components/Accounting/BookkeepingFeed.jsx"), "utf8");
const feedService = readFileSync(join(root, "src/services/bookkeeping/bookkeepingTransactionFeedService.js"), "utf8");
const approvalService = readFileSync(join(root, "src/services/bookkeeping/bookkeepingApprovalService.js"), "utf8");

test("processor-fee rows expose the dedicated visible reconciliation controls", () => {
  assert.match(feed, /Checking QuickBooks for an existing processing fee/);
  assert.match(feed, /Possible QBO match/);
  assert.match(feed, /Choose the exact QuickBooks transaction/);
  assert.match(feed, /No existing QuickBooks fee found/);
  assert.match(feed, /Record New Fee/);
  assert.match(feed, /QuickBooks match check temporarily unavailable/);
  assert.match(feed, /Posting receipt protected/);
  assert.match(feed, /!isPending && !isCcPaymentWorkflow && !incomingMatch\.active/);
});

test("feed contract preserves every processor-fee match state instead of dropping authoritative no-match", () => {
  for (const state of [
    "checking_for_qbo_match",
    "qbo_match_found",
    "multiple_qbo_matches",
    "no_existing_qbo_match",
    "qbo_match_check_unavailable",
    "posted_duplicate_review_required",
  ]) assert.match(`${feed}\n${feedService}`, new RegExp(state));
  assert.doesNotMatch(feedService, /confidence_tier === "tier_4"\) return null/);
  assert.match(feedService, /processor_fee: processorFee/);
});

test("candidate evidence overrides stale new-fee metadata in every feed", () => {
  assert.match(feed, /hasQboCandidate/);
  assert.match(feed, /hasQboCandidate[\s\S]*"qbo_match_found"/);
  assert.match(feed, /!hasQboCandidate && processorFee\?\.canCreateNewFee/);
  assert.match(feedService, /processor_fee_new_fee_authorized === true/);
});

test("manual approval invokes the authoritative match guard for processor-fee outflows", () => {
  assert.match(approvalService, /detectProcessorSettlementActivity\(bankTxn \|\| \{\}\)\?\.kind === "fee"/);
  assert.match(approvalService, /\(!isIncomingDeposit && !isProcessorFee\)/);
  assert.match(approvalService, /evaluateIncomingDepositPostingGuard/);
});

test("supported platform fee fixtures share detection while subscriptions stay ordinary", () => {
  const feeNames = [
    "TRAN FEE INTUIT 73857673",
    "JOBBER PROCESSING FEE",
    "HOUSECALL PRO MERCHANT FEE",
    "JOIST TRANSACTION FEE",
    "STRIPE PROCESSING FEE",
    "SQUARE MERCHANT FEE",
    "PAYPAL TRANSACTION FEE",
    "CLOVER PROCESSING FEE",
  ];
  for (const description of feeNames) {
    assert.equal(detectProcessorSettlementActivity({ description, direction: "OUTFLOW", amount: -8.4 })?.kind, "fee", description);
  }
  assert.equal(detectProcessorSettlementActivity({ description: "JOBBER MONTHLY SOFTWARE PLAN", direction: "OUTFLOW", amount: -99 })?.kind, "platform_charge");
});

test("read-only recovery audit never mutates data", () => {
  const audit = readFileSync(join(root, "scripts/manual/auditProcessorFeeReviewRegression.sql"), "utf8");
  assert.match(audit, /handled_unposted_recovery_candidate/);
  assert.match(audit, /posted_duplicate_review_required/);
  assert.doesNotMatch(audit, /\b(update|insert|delete|alter|drop|truncate|create)\b/i);
});
