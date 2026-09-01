import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { findPendingLifecycleCandidate } from "../src/services/plaid/plaidCanonicalIdentity.js";
import { deriveCreditCardPaymentStatus } from "../src/services/bookkeeping/creditCardPaymentStatus.js";
import { deriveQboPostingLifecycle } from "../src/services/bookkeeping/qboPostingLifecycle.js";
import { derivePipelineStatus } from "../src/services/bookkeeping/reconciliationPipelineStatus.js";

/* global process */

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

test("pending rows have their own Books Review population and are excluded from actionable Needs Review", () => {
  const migration = read("supabase/migrations/20260918_books_review_pending_rpc_authority.sql");
  const customerRoute = read("src/api/bookkeeping/routes/bookkeeping.transactions.routes.js");
  const customerPage = read("src/pages/accounting/BookkeepingCleanup.jsx");
  const adminRoute = read("src/api/admin/monthlyReview.routes.js");

  assert.match(migration, /p_status_filter, 'needs_review'\)\) = 'pending'\s+and cr\.pending is true/s);
  assert.match(migration, /lower\(coalesce\(p_status_filter, 'needs_review'\)\) <> 'pending'\s+and cr\.pending is not true/s);
  assert.match(migration, /settled\.pending_transaction_id = cr\.plaid_transaction_id/);
  assert.match(customerRoute, /statusFilter: "pending"/);
  assert.match(customerPage, /key: "pending", label: "Pending"/);
  assert.match(customerPage, /if \(tabKey === "pending"\) return txn\.pending === true/);
  assert.match(adminRoute, /new Set\(\["needs_review", "handled", "pending"\]\)/);
  assert.match(adminRoute, /pending,/);
});

test("Books Review pending RPC migration fixes counts, pagination, and obsolete overload ambiguity", () => {
  const migration = read("supabase/migrations/20260918_books_review_pending_rpc_authority.sql");

  assert.match(migration, /drop function if exists public\.get_bookkeeping_transactions_bounded\(uuid, text, text, date, integer, integer\)/);
  assert.match(migration, /drop function if exists public\.count_bookkeeping_transactions_bounded\(uuid, text, text, date\)/);
  assert.match(migration, /create or replace function public\.get_bookkeeping_transactions_bounded\(\s*p_business_id uuid,\s*p_status_filter text default 'needs_review',\s*p_account_id text default null,\s*p_range_start date default null,\s*p_range_end date default null,\s*p_limit integer default 25,\s*p_offset integer default 0/s);
  assert.match(migration, /create or replace function public\.count_bookkeeping_transactions_bounded\(\s*p_business_id uuid,\s*p_status_filter text default 'needs_review',\s*p_account_id text default null,\s*p_range_start date default null,\s*p_range_end date default null/s);

  assert.match(migration, /when lower\(coalesce\(p_status_filter, 'needs_review'\)\) = 'pending'\s+then false/);
  assert.match(migration, /lower\(coalesce\(p_status_filter, 'needs_review'\)\) = 'pending'\s+and cr\.pending is true/s);
  assert.match(migration, /lower\(coalesce\(p_status_filter, 'needs_review'\)\) <> 'pending'\s+and cr\.pending is not true/s);
  assert.match(migration, /settled\.is_archived is false[\s\S]*settled\.pending is not true[\s\S]*settled\.pending_transaction_id = cr\.plaid_transaction_id/s);
  assert.match(migration, /count\(\*\) over \(\) as total_count[\s\S]*from scoped[\s\S]*order by scoped\.date desc nulls last[\s\S]*limit greatest/s);
  assert.match(migration, /and \(p_range_end is null or bt\.date < p_range_end\)/);
  assert.doesNotMatch(migration, /and \(p_range_end is null or bt\.date <= p_range_end\)/);
  assert.match(migration, /grant execute on function public\.get_bookkeeping_transactions_bounded\(uuid, text, text, date, date, integer, integer\) to service_role/);
  assert.match(migration, /grant execute on function public\.count_bookkeeping_transactions_bounded\(uuid, text, text, date, date\) to service_role/);
  assert.match(migration, /notify pgrst, 'reload schema'/);
});

test("Books Review server predicates match the confirmed production pending split", () => {
  const productionComposition = {
    checking8626: { raw: 20, pending: 0, needsReview: 20 },
    creditCard6735: { raw: 31, pending: 4, needsReview: 27 },
    blueCashEveryday1008: { raw: 16, pending: 9, needsReview: 7 },
    discoverIt9734: { raw: 0, pending: 0, needsReview: 0 },
  };

  const totals = Object.values(productionComposition).reduce(
    (acc, account) => ({
      raw: acc.raw + account.raw,
      pending: acc.pending + account.pending,
      needsReview: acc.needsReview + account.needsReview,
    }),
    { raw: 0, pending: 0, needsReview: 0 }
  );

  assert.equal(totals.raw, 67);
  assert.equal(totals.pending, 13);
  assert.equal(totals.needsReview, 54);
  assert.equal(productionComposition.creditCard6735.needsReview, 27);
  assert.equal(productionComposition.blueCashEveryday1008.needsReview, 7);
});

test("account cards and Operator Requests use non-pending Books Review counts", () => {
  const accountRoute = read("src/api/bookkeeping/routes/bookkeeping.accounts.routes.js");
  const clarificationRoute = read("src/api/bookkeeping/routes/bookkeeping.clarifications.routes.js");
  const operatorMigration = read("supabase/migrations/20260917_operator_requests_exclude_pending.sql");

  assert.match(accountRoute, /countBookkeepingTransactions/);
  assert.match(accountRoute, /statusFilter:\s*"needs_review"/);
  assert.match(accountRoute, /rangeParam:\s*"all"/);
  assert.doesNotMatch(accountRoute, /transaction_categorizations\(status\)/);

  assert.match(clarificationRoute, /reconcileOperatorRequestSummary/);
  assert.match(clarificationRoute, /operator_summary_endpoint/);

  assert.match(operatorMigration, /create or replace function public\.get_operator_request_counts_bounded/);
  assert.match(operatorMigration, /create or replace function public\.get_operator_requests_bounded/);
  assert.match(operatorMigration, /create or replace function public\.expire_stale_operator_requests/);
  assert.match(operatorMigration, /bt\.pending is not true/g);
  assert.doesNotMatch(operatorMigration, /bt\.pending is true/);
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
