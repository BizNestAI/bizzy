import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectQuickBooksPaymentsProtectedWorkflow,
  hasAuthoritativeQuickBooksMatch,
  quickBooksPaymentsProtectedMeta,
} from "../src/services/bookkeeping/quickBooksPaymentsProtectedWorkflow.js";
import { canAutoHandle } from "../src/services/bookkeeping/autoHandlingPolicy.js";
import { effectiveTransactionResolution, suggestedTransactionResolution } from "../src/services/bookkeeping/transactionResolutionService.js";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const read = (path) => readFileSync(join(root, path), "utf8");

test("verified QuickBooks Payments deposit and fee references are protected match workflows", () => {
  const deposit = detectQuickBooksPaymentsProtectedWorkflow({ name: "DEPOSIT INTUIT 99917073 OPTIMIST BOOKKEEPING ACH CREDIT", amount: 500, direction: "INFLOW" });
  const fee = detectQuickBooksPaymentsProtectedWorkflow({ name: "TRAN FEE INTUIT 18434453 OPTIMIST BOOKKEEPING ACH CORP DEBIT", amount: -14, direction: "OUTFLOW" });

  assert.equal(deposit?.classification, "quickbooks_payments_deposit_match_required");
  assert.equal(deposit?.settlement_reference, "99917073");
  assert.equal(fee?.classification, "quickbooks_payments_fee_match_required");
  assert.equal(fee?.settlement_reference, "18434453");
});

test("Intuit subscriptions, software purchases, wrong directions, and generic deposits are not protected", () => {
  const fixtures = [
    { name: "INTUIT QUICKBOOKS ONLINE SUBSCRIPTION", amount: -35, direction: "OUTFLOW" },
    { name: "PURCHASE INTUIT SOFTWARE", amount: -89, direction: "OUTFLOW" },
    { name: "DEPOSIT INTUIT", amount: 500, direction: "INFLOW" },
    { name: "DEPOSIT INTUIT 99917073", amount: -500, direction: "OUTFLOW" },
    { name: "GENERIC CUSTOMER DEPOSIT 99917073", amount: 500, direction: "INFLOW" },
  ];
  for (const fixture of fixtures) assert.equal(detectQuickBooksPaymentsProtectedWorkflow(fixture), null);
});

test("structured QuickBooks Payments evidence is supported without broad INTUIT matching", () => {
  assert.equal(detectQuickBooksPaymentsProtectedWorkflow({ payment_processor: "QuickBooks Payments", processor_activity_kind: "payout", amount: 120, direction: "INFLOW" })?.kind, "deposit");
  assert.equal(detectQuickBooksPaymentsProtectedWorkflow({ payment_processor: "QuickBooks Payments", processor_activity_kind: "fee", amount: -3, direction: "OUTFLOW" })?.kind, "fee");
  assert.equal(detectQuickBooksPaymentsProtectedWorkflow({ payment_processor: "Intuit", amount: -30, direction: "OUTFLOW" }), null);
});

test("rules, AI evidence, auto-post, and an existing GL suggestion cannot auto-handle protected activity", () => {
  for (const transaction of [
    { name: "DEPOSIT INTUIT 15453453 ACME ACH CREDIT", amount: 500, direction: "INFLOW" },
    { name: "TRAN FEE INTUIT 80831063 ACME ACH DEBIT", amount: -13.3, direction: "OUTFLOW" },
  ]) {
    const decision = canAutoHandle(transaction, {
      confidence: "high",
      source: "vendor_rule",
      accountId: "qbo-account",
      accountName: "Payment Processing Fees",
      meta: { safe_to_auto_post: true, auto_post_enabled: true },
    });
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, "quickbooks_payments_match_required");
  }
});

test("protected metadata is auditable and forces the existing Match resolution", () => {
  const detection = detectQuickBooksPaymentsProtectedWorkflow({ name: "DEPOSIT INTUIT 15453453 ACME", amount: 500, direction: "INFLOW" });
  const meta = quickBooksPaymentsProtectedMeta({ suggested_qbo_account_name: "Sales" }, detection);
  assert.equal(meta.safe_to_auto_handle, false);
  assert.equal(meta.safe_to_auto_post, false);
  assert.equal(meta.system_suggested_resolution, "match_existing_qbo");
  assert.equal(meta.protected_workflow_detector_version, "quickbooks_payments_match_v1");
  assert.equal(suggestedTransactionResolution({ meta }), "match_existing_qbo");
  assert.equal(effectiveTransactionResolution({ status: "needs_review", meta }), "match_existing_qbo");
});

test("zero-result and unavailable searches remain protected and never authorize a replacement fee", () => {
  const matcher = read("src/services/bookkeeping/incomingDepositMatchService.js");
  const feed = read("src/services/bookkeeping/bookkeepingTransactionFeedService.js");
  assert.match(matcher, /result\.confidence_tier === "tier_4" && !quickBooksPayments/);
  assert.match(feed, /canCreateNewFee: !quickBooksPayments/);
  assert.match(feed, /post_error: quickBooksPayments[\s\S]*?\? null/);
  assert.match(feed, /quickBooksPayments[\s\S]*?"quickbooks_payments_match_required"/);
});

test("all authoritative matched forms are immutable to protected-workflow writers", () => {
  const matchedForms = [
    { status: "matched" },
    { status: "matched_existing_qbo" },
    { meta: { matched_existing_qbo: true } },
    { meta: { incoming_deposit_match_status: "confirmed" } },
    { reconciled_at: "2026-09-29T00:00:00.000Z" },
    { meta: { confirmed_match_receipt: "receipt-1" } },
  ];
  for (const row of matchedForms) assert.equal(hasAuthoritativeQuickBooksMatch(row), true);
});

test("approval, Undo, feed discovery, and posting enforce match-only lifecycle without a migration", () => {
  const approval = read("src/services/bookkeeping/bookkeepingApprovalService.js");
  const undo = read("src/api/bookkeeping/routes/bookkeeping.approvals.routes.js");
  const matcher = read("src/services/bookkeeping/incomingDepositMatchService.js");
  const posting = read("src/jobs/booksPost.cron.js");
  const suggest = read("src/api/bookkeeping/routes/bookkeeping.suggest.routes.js");
  const ui = read("src/components/Accounting/BookkeepingFeed.jsx");

  assert.match(approval, /quickbooks_payments_match_required/);
  assert.match(approval, /status: "needs_review", post_after: null, post_error: null/);
  assert.match(undo, /quickBooksPaymentsProtectedMeta/);
  assert.match(undo, /confirmed_match_requires_match_undo/);
  assert.match(matcher, /hasAuthoritativeQuickBooksMatch\(existing \|\| \{\}\)\) return/);
  assert.match(matcher, /result\.confidence_tier === "tier_4" && !quickBooksPayments/);
  assert.match(posting, /outcome: "match_required", reason: "quickbooks_payments_match_required"/);
  assert.match(suggest, /"matched", "matched_existing_qbo"/);
  assert.match(ui, /QuickBooks payment · Needs match/);
  assert.match(ui, /QuickBooks processing fee · Needs match/);
  assert.doesNotMatch(read("src/services/bookkeeping/quickBooksPaymentsProtectedWorkflow.js"), /migration|backfill|repair/i);
});

test("manual confirmation remains idempotent, direct-to-Matched, and never calls a QBO create API", () => {
  const matcher = read("src/services/bookkeeping/incomingDepositMatchService.js");
  const confirmStart = matcher.indexOf("export async function confirmIncomingDepositQboMatch");
  const confirmEnd = matcher.indexOf("export async function rejectIncomingDepositQboMatch", confirmStart);
  const confirmation = matcher.slice(confirmStart, confirmEnd);
  assert.match(confirmation, /match\.status === "confirmed"[\s\S]*idempotent: true/);
  assert.match(confirmation, /status: "matched_existing_qbo"/);
  assert.match(confirmation, /qbo_write_performed: false/);
  assert.doesNotMatch(confirmation, /createQbo|postTransaction|createDeposit|createPurchase/);
});
