import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildPaymentAccountCandidates,
  buildPaymentAccountDestinationOptions,
} from "../src/services/bookkeeping/creditCardPaymentAccountOptions.js";
import {
  classifyBookkeepingLifecycle,
  diagnoseBookkeepingLifecycle,
} from "../src/services/bookkeeping/bookkeepingLifecycleClassifier.js";

const mappings = [
  { plaidAccountId: "checking", plaidType: "depository", plaidSubtype: "checking", plaidMask: "8626", qboAccountId: "10", qboAccountName: "Checking", qboAccountType: "Bank", mapped: true, isActive: true },
  { plaidAccountId: "discover", plaidType: "credit", plaidSubtype: "credit card", plaidMask: "9734", qboAccountId: "17", qboAccountName: "Discover", qboAccountType: "CreditCard", mapped: true, isActive: true },
  { plaidAccountId: "chase", plaidType: "credit", plaidSubtype: "credit card", plaidMask: "6735", qboAccountId: "19", qboAccountName: "Chase", qboAccountType: "Credit Card", mapped: true, isActive: true },
  { plaidAccountId: "amex", plaidType: "credit", plaidSubtype: "credit card", plaidMask: "1008", qboAccountId: "20", qboAccountName: "Blue Cash", qboAccountType: "CreditCard", mapped: true, isActive: true },
];

test("canonical account capabilities produce bidirectional payment candidates", () => {
  const all = buildPaymentAccountDestinationOptions(mappings, "biz");
  assert.equal(all.length, 4);
  assert.deepEqual(buildPaymentAccountCandidates(mappings, {
    businessId: "biz", sourceClass: "depository", sourceConnectedAccountId: "checking", sourceQboAccountId: "10",
  }).map((row) => row.qboAccountId), ["17", "19", "20"]);
  assert.deepEqual(buildPaymentAccountCandidates(mappings, {
    businessId: "biz", sourceClass: "credit_card", sourceConnectedAccountId: "discover", sourceQboAccountId: "17",
  }).map((row) => row.qboAccountId), ["10"]);
});

test("inactive, unmapped, contradictory, duplicate, and source accounts are excluded", () => {
  const options = buildPaymentAccountDestinationOptions([
    ...mappings,
    { ...mappings[1] },
    { ...mappings[1], plaidAccountId: "inactive", qboAccountId: "21", isActive: false },
    { ...mappings[1], plaidAccountId: "unmapped", qboAccountId: null, mapped: false },
    { ...mappings[1], plaidAccountId: "wrong", qboAccountId: "22", qboAccountType: "Bank" },
  ]);
  assert.deepEqual(options.map((row) => row.qboAccountId), ["10", "17", "19", "20"]);
});

test("lifecycle classifier assigns the orphaned payment row to exactly one failed bucket", () => {
  const incident = {
    id: "c54988c5-ea58-491c-a899-72a07c1d6c22",
    status: "auto_approved", review_status: "handled", posting_status: "posting_failed",
    post_error: "cc_payment_pair_requires_confirmation", last_post_attempt_at: "2026-09-23T20:39:46.294Z", qbo_txn_id: null,
    meta: { taxonomy_type: "cc_payment", cc_payment_pair_status: "voided" },
  };
  const diagnosis = diagnoseBookkeepingLifecycle(incident);
  assert.equal(diagnosis.bucket, "failed");
  assert.equal(diagnosis.posted, false);
  assert.equal(diagnosis.matchedPair, false);
  assert.equal(diagnosis.orphaned, false);
});

test("matched credit-card status is recognized while voided pairs are not", () => {
  assert.equal(classifyBookkeepingLifecycle({ meta: { cc_payment_pair_id: "pair", cc_payment_pair_status: "matched" } }).bucket, "matched");
  assert.equal(classifyBookkeepingLifecycle({ meta: { cc_payment_pair_id: "pair", cc_payment_pair_status: "voided" } }).bucket, "needs_review");
});

test("both surfaces guard account requests against stale responses", () => {
  const cleanup = fs.readFileSync(new URL("../src/pages/accounting/BookkeepingCleanup.jsx", import.meta.url), "utf8");
  const monthly = fs.readFileSync(new URL("../src/pages/Admin/MonthlyReviewConsole.jsx", import.meta.url), "utf8");
  for (const source of [cleanup, monthly]) {
    assert.match(source, /RequestRef\.current !== requestId/);
    assert.match(source, /Loaded\(true\)/);
    assert.match(source, /Loaded\(false\)/);
  }
});

test("orphan repair utility is exact-ID scoped and read-only unless explicitly applied", () => {
  const script = fs.readFileSync(new URL("../scripts/manual/inspectCreditCardPaymentLifecycle.js", import.meta.url), "utf8");
  assert.match(script, /c54988c5-ea58-491c-a899-72a07c1d6c22/);
  assert.match(script, /if \(args\.has\("--apply"\)\)/);
  assert.match(script, /repair_refused_active_pair_exists/);
  assert.match(script, /repair_refused_not_exact_discover_incident/);
});
