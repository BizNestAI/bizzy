import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { findPendingLifecycleCandidate } from "../src/services/plaid/plaidCanonicalIdentity.js";
import { deriveCreditCardPaymentStatus } from "../src/services/bookkeeping/creditCardPaymentStatus.js";
import { deriveQboPostingLifecycle } from "../src/services/bookkeeping/qboPostingLifecycle.js";
import { derivePipelineStatus } from "../src/services/bookkeeping/reconciliationPipelineStatus.js";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

test("pending rows have their own Books Review population and are excluded from actionable Needs Review", () => {
  const migration = read("supabase/migrations/20260914_pending_bookkeeping_population.sql");
  const customerRoute = read("src/api/bookkeeping/routes/bookkeeping.transactions.routes.js");
  const customerPage = read("src/pages/accounting/BookkeepingCleanup.jsx");
  const adminRoute = read("src/api/admin/monthlyReview.routes.js");

  assert.match(migration, /p_status_filter, 'needs_review'\)\) = 'pending' and bt\.pending is true/);
  assert.match(migration, /lower\(coalesce\(p_status_filter, 'needs_review'\)\) <> 'pending'\s+and bt\.pending is not true/s);
  assert.match(customerRoute, /statusFilter: "pending"/);
  assert.match(customerPage, /key: "pending", label: "Pending"/);
  assert.match(customerPage, /if \(tabKey === "pending"\) return txn\.pending === true/);
  assert.match(adminRoute, /new Set\(\["needs_review", "handled", "pending"\]\)/);
  assert.match(adminRoute, /pending,/);
});

test("pending lifecycle and reconciliation labels are non-actionable", () => {
  const qbo = deriveQboPostingLifecycle({
    pending: true,
    status: "needs_review",
    meta: {},
  });
  assert.equal(qbo.key, "pending");
  assert.equal(qbo.label, "Pending");

  const pipeline = derivePipelineStatus({
    bank: { pending: true },
    cat: { status: "needs_review", meta: {} },
  });
  assert.equal(pipeline.key, "pending_bank_transaction");
  assert.equal(pipeline.kpi_group, "pending");
});

test("amount-changing authorization hold supersession requires same physical account merchant direction date and unique candidate", () => {
  const incoming = {
    physical_account_id: "phys-1",
    pending: false,
    merchant_name: "CHARGEONSITE.COM",
    signed_amount: -14.72,
    date: "2026-08-29",
    authorized_date: "2026-08-28",
  };
  const pending = {
    id: "pending-hold",
    physical_account_id: "phys-1",
    pending: true,
    merchant_name: "CHARGEONSITE.COM",
    signed_amount: -35,
    date: "2026-08-28",
    authorized_date: "2026-08-28",
  };

  assert.equal(findPendingLifecycleCandidate(incoming, [pending])?.id, "pending-hold");
  assert.equal(findPendingLifecycleCandidate(incoming, [pending, { ...pending, id: "pending-hold-2" }]), null);
  assert.equal(findPendingLifecycleCandidate({ ...incoming, merchant_name: "OTHER" }, [pending]), null);
  assert.equal(findPendingLifecycleCandidate({ ...incoming, signed_amount: 14.72 }, [pending]), null);
});

test("credit-card payment workflow status hides ordinary P&L lifecycle and separates matching from posting", () => {
  const needsMatch = deriveCreditCardPaymentStatus({
    status: "needs_review",
    meta: { taxonomy_type: "cc_payment" },
  });
  assert.equal(needsMatch.key, "cc_payment_needs_match");
  assert.equal(needsMatch.postable, false);

  const matched = deriveCreditCardPaymentStatus({
    status: "auto_approved",
    meta: { taxonomy_type: "cc_payment", cc_payment_pair_id: "pair-1", cc_payment_pair_status: "confirmed" },
  });
  assert.equal(matched.key, "cc_payment_matched");

  const qbo = deriveQboPostingLifecycle({
    status: "auto_approved",
    meta: { taxonomy_type: "cc_payment", cc_payment_pair_id: "pair-1", cc_payment_pair_status: "confirmed" },
  });
  assert.equal(qbo.key, "cc_payment_matched");
  assert.notEqual(qbo.key, "handled_not_posted");
});

test("dedicated credit-card payment match routes and UI do not use ordinary COA approval", () => {
  const customerRoute = read("src/api/bookkeeping/routes/bookkeeping.approvals.routes.js");
  const adminRoute = read("src/api/admin/monthlyReview.routes.js");
  const client = read("src/services/bookkeeping/bookkeepingClient.js");
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
  const mirror = read("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx");
  const pairService = read("src/services/bookkeeping/creditCardPaymentPairService.js");

  assert.match(customerRoute, /credit-card-payments\/:transactionId\/confirm-match/);
  assert.match(adminRoute, /credit-card-payment\/confirm-match/);
  assert.match(client, /confirmCreditCardPaymentMatch/);
  assert.match(pairService, /confirmCreditCardPaymentMatchForTransaction/);
  assert.match(pairService, /targetQboAccountId/);
  assert.match(pairService, /createSafeCreditCardPaymentPairForRow/);
  assert.match(pairService, /derivePairSourceOrientation/);
  assert.match(feed, /deriveCreditCardPaymentStatus/);
  assert.match(feed, /deriveCreditCardPaymentOrientation/);
  assert.match(feed, /CreditCardPaymentMatchControl/);
  assert.match(feed, /counterpartAccountType === "Bank"/);
  assert.match(feed, /counterpartAccountType === "CreditCard"/);
  assert.match(feed, /isQboBankAccount/);
  assert.match(feed, /isQboCreditCardAccount/);
  assert.doesNotMatch(feed, /onCreateAccount=\{!isCcPayment/);
  assert.match(mirror, /CreditCardPaymentMatchControl/);
  assert.match(mirror, /counterpartAccountType === "Bank"/);
  assert.match(mirror, /counterpartAccountType === "CreditCard"/);
});

test("confirm-match creates/reuses a Plaid pair only and does not call QBO posting", () => {
  const pairService = read("src/services/bookkeeping/creditCardPaymentPairService.js");
  const body = pairService.slice(
    pairService.indexOf("export async function confirmCreditCardPaymentMatchForTransaction"),
    pairService.indexOf("export async function createManualCreditCardPaymentPair")
  );

  assert.match(pairService, /validateBusinessQboPaymentAccountType/);
  assert.match(body, /targetQboAccountId/);
  assert.match(body, /linkCategorizationToCreditCardPair/);
  assert.doesNotMatch(body, /createQboTransfer|postSingleBookkeepingTransactionNow|claimCreditCardPaymentPairPosting|getQBOClient/);
});
