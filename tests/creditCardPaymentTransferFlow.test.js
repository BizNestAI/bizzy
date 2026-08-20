import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

test("credit-card-payment pairs are durable, tenant scoped, and one leg cannot belong to multiple active pairs", () => {
  const migration = read("supabase/migrations/20260903_credit_card_payment_pairs.sql");

  assert.match(migration, /create table if not exists public\.credit_card_payment_pairs/i);
  assert.match(migration, /business_id uuid not null references public\.business_profiles\(id\) on delete cascade/i);
  assert.match(migration, /checking_transaction_id uuid not null references public\.bank_transactions\(id\)/i);
  assert.match(migration, /credit_card_transaction_id uuid references public\.bank_transactions\(id\)/i);
  assert.match(migration, /credit_card_payment_pairs_active_checking_uq/);
  assert.match(migration, /credit_card_payment_pairs_active_card_uq/);
  assert.match(migration, /where status <> 'voided'/i);
  assert.match(migration, /qbo_txn_type is null or qbo_txn_type = 'Transfer'/i);
  assert.match(migration, /validate_credit_card_payment_pair_business/);
  assert.match(migration, /credit_card_payment_pair_checking_business_mismatch/);
  assert.match(migration, /credit_card_payment_pair_card_business_mismatch/);
});

test("safe matcher requires more than amount and fails ambiguous matches closed", () => {
  const service = read("src/services/bookkeeping/creditCardPaymentPairService.js");

  assert.match(service, /hasCreditCardPaymentSignal\(row\)/);
  assert.match(service, /neq\("plaid_account_id", row\.plaid_account_id\)/);
  assert.match(service, /sourceRail === "bank"/);
  assert.match(service, /candidateRail === "credit_card"/);
  assert.match(service, /qboMappingRail\(sourceMapping\)/);
  assert.match(service, /issuerMatchesCheckingToCard/);
  assert.match(service, /plausible\.length !== 1/);
  assert.match(service, /"cc_payment_pair_ambiguous"/);
  assert.doesNotMatch(service, /sort\(\(a, b\) => a\.dateDiff - b\.dateDiff\)[\s\S]{0,200}scored\[0\]/);
});

test("suggestion creates canonical pairs and writes symmetric metadata to both legs", () => {
  const suggest = read("src/api/bookkeeping/routes/bookkeeping.suggest.routes.js");
  const service = read("src/services/bookkeeping/creditCardPaymentPairService.js");

  assert.match(suggest, /createSafeCreditCardPaymentPairForRow/);
  assert.match(suggest, /cc_payment_pair_ambiguous/);
  assert.match(service, /linkCategorizationToCreditCardPair/);
  assert.match(service, /role: "checking"/);
  assert.match(service, /role: "credit_card"/);
  assert.match(service, /cc_payment_pair_id: pair\.id/);
  assert.match(service, /cc_payment_pair_txn_id: item\.counterpart/);
  assert.match(service, /safe_to_auto_handle: false/);
});

test("one confirmation resolves the pair and manual target must be a CreditCard account", () => {
  const approvals = read("src/api/bookkeeping/routes/bookkeeping.approvals.routes.js");
  const service = read("src/services/bookkeeping/creditCardPaymentPairService.js");
  const qboAccounts = read("src/services/bookkeeping/qboAccounts.js");

  assert.match(approvals, /createManualCreditCardPaymentPair/);
  assert.match(approvals, /confirmCreditCardPaymentPairForTransaction/);
  assert.doesNotMatch(approvals, /isCreditCardQboType/);
  assert.doesNotMatch(approvals, /explicitFinalType/);
  assert.doesNotMatch(service, /targetQboAccountName/);
  assert.match(service, /validateBusinessQboCreditCardAccount\(businessId, targetQboAccountId\)/);
  assert.match(service, /throw new Error\(validatedTarget\?\.reason \|\| "cc_payment_target_credit_card_required"\)/);
  assert.match(qboAccounts, /getLatestQuickBooksTokenRow\(businessId\)/);
  assert.match(qboAccounts, /getQBOClient\(businessId\)/);
  assert.match(qboAccounts, /normalizeQboPaymentAccountType\(resolved\.account\.type\) !== "CreditCard"/);
  assert.match(approvals, /confirmedCcPairs/);
  assert.match(approvals, /pair\.checking_transaction_id/);
  assert.match(approvals, /pair\.credit_card_transaction_id/);
  assert.match(approvals, /status: "approved"[\s\S]*cc_payment_pair_status: "confirmed"/);
});

test("manual target validation rejects manipulated or unusable QBO accounts before pair persistence", () => {
  const service = read("src/services/bookkeeping/creditCardPaymentPairService.js");
  const qboAccounts = read("src/services/bookkeeping/qboAccounts.js");
  const migration = read("supabase/migrations/20260903_credit_card_payment_pairs.sql");

  assert.match(qboAccounts, /cc_payment_target_account_not_found/);
  assert.match(qboAccounts, /cc_payment_target_account_inactive/);
  assert.match(qboAccounts, /cc_payment_target_not_credit_card/);
  assert.match(qboAccounts, /cc_payment_target_wrong_realm/);
  assert.match(qboAccounts, /account\.Active !== false && account\.active !== false/);
  assert.match(qboAccounts, /String\(account\.id\) !== String\(qboAccountId\)/);
  assert.match(service, /validatedTarget = await validateBusinessQboCreditCardAccount/);
  assert.match(service, /if \(!validatedTarget\?\.ok\)[\s\S]*throw new Error/);
  assert.match(service, /qbo_account_id: validatedTarget\.account\.id/);
  assert.match(service, /qbo_account_name: validatedTarget\.account\.name/);
  assert.match(service, /qbo_account_type: validatedTarget\.account\.type/);
  assert.match(service, /target_qbo_account_validated_server_side: true/);
  assert.match(migration, /qbo_realm_id text/);
  assert.match(migration, /qbo_env text/);
  const manualBody = service.slice(service.indexOf("export async function createManualCreditCardPaymentPair"), service.indexOf("export async function confirmCreditCardPaymentPairForTransaction"));
  assert.match(manualBody, /validateBusinessQboCreditCardAccount/);
  assert.match(manualBody, /\.insert\(pairRecord\)/);
  assert.ok(manualBody.indexOf("validateBusinessQboCreditCardAccount") < manualBody.indexOf(".insert(pairRecord)"));
  assert.doesNotMatch(manualBody, /createQboTransfer|postCreditCardPaymentPairToQbo|claimCreditCardPaymentPairPosting/);
});

test("posting either leg uses one pair-level Transfer with From checking and To credit card", () => {
  const cron = read("src/jobs/booksPost.cron.js");

  assert.match(cron, /handleCreditCardPaymentPairItem/);
  assert.match(cron, /findExistingCreditCardPaymentPairForTransaction/);
  assert.match(cron, /claimCreditCardPaymentPairPosting/);
  assert.match(cron, /createQboTransfer/);
  assert.match(cron, /FromAccountRef: \{ value: String\(pair\.checking_qbo_account_id\) \}/);
  assert.match(cron, /ToAccountRef: \{ value: String\(pair\.credit_card_qbo_account_id\) \}/);
  assert.match(cron, /qboTxnType: "Transfer"/);
  assert.match(cron, /markCreditCardPaymentPairPosted/);
  const pairBody = cron.slice(cron.indexOf("async function handleCreditCardPaymentPairItem"), cron.indexOf("async function postBankOutflowPurchase"));
  assert.doesNotMatch(pairBody, /cc_payment_post_not_supported/);
});

test("pair-level concurrency, duplicate preflight, and posted propagation are explicit", () => {
  const migration = read("supabase/migrations/20260903_credit_card_payment_pairs.sql");
  const cron = read("src/jobs/booksPost.cron.js");
  const service = read("src/services/bookkeeping/creditCardPaymentPairService.js");

  assert.match(migration, /claim_credit_card_payment_pair_posting/);
  assert.match(migration, /for update/i);
  assert.match(migration, /lease_expires_at > p_now/i);
  assert.match(cron, /findQboTransactions\(qbo, "Transfer"/);
  assert.match(cron, /classifyPreExistingQboTransferMatch/);
  assert.match(cron, /FromAccountRef/);
  assert.match(cron, /ToAccountRef/);
  assert.match(service, /status: "posted"/);
  assert.match(service, /qbo_txn_type: "Transfer"/);
  assert.match(service, /\.in\("transaction_id", ids\)/);
});

test("failed posts remain visible generically in Books Review handled state", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  const route = read("src/api/bookkeeping/routes/bookkeeping.transactions.routes.js");
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");

  assert.match(cron, /status: shouldStop \? "failed" : item\.status/);
  assert.match(cron, /posting_in_progress: false/);
  assert.match(route, /\["approved", "auto_approved", "failed"\]\.includes\(status\)/);
  assert.match(page, /const handledStatuses = \["approved", "auto_approved", "failed"\]/);
  assert.match(feed, /\["approved", "auto_approved", "failed"\]\.includes\(txn\.status\)/);
});

test("credit-card-payment UI exposes transfer target state instead of only a generic GL category", () => {
  const txRoute = read("src/api/bookkeeping/routes/bookkeeping.transactions.routes.js");
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");

  assert.match(txRoute, /cc_payment_transfer_target_qbo_account_name/);
  assert.match(feed, /Credit Card Payment/);
  assert.match(feed, /ccSelectableAccounts/);
  assert.match(feed, /type === "creditcard"/);
  assert.match(page, /newAccountType/);
});
