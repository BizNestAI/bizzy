import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const monthlyReview = read("src/pages/Admin/MonthlyReviewConsole.jsx");
const mirrorTable = read("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx");
const customerFeed = read("src/components/Accounting/BookkeepingFeed.jsx");
const cleanup = read("src/pages/accounting/BookkeepingCleanup.jsx");

function functionSlice(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const end = source.indexOf(nextSignature, start + signature.length);
  return source.slice(start, end === -1 ? source.length : end);
}

test("Monthly Review defines and threads canonical payment-account query state", () => {
  assert.match(monthlyReview, /const paymentAccountsLoaded = !loadingPaymentAccounts && !paymentAccountsError;/);

  const panels = functionSlice(
    monthlyReview,
    "function BookkeepingFeedMirrorPanels(",
    "function PostingReviewMirrorSection("
  );
  assert.match(panels, /paymentAccountsLoaded,/);
  assert.match(panels, /loadingPaymentAccounts,/);
  assert.match(panels, /paymentAccountsError,/);
  assert.match(panels, /<BookkeepingFeedMirrorSection[\s\S]*paymentAccountsLoaded=\{paymentAccountsLoaded\}/);

  const section = functionSlice(
    monthlyReview,
    "function BookkeepingFeedMirrorSection(",
    "function PostingReview"
  );
  assert.match(section, /paymentAccountsLoaded,/);
  assert.match(section, /loadingPaymentAccounts,/);
  assert.match(section, /paymentAccountsError,/);
});

test("payment account loading and failure remain localized to each matcher", () => {
  assert.match(mirrorTable, /paymentAccountsLoaded = true,/);
  assert.match(mirrorTable, /loadingPaymentAccounts = false,/);
  assert.match(mirrorTable, /paymentAccountsError = "",/);
  assert.match(mirrorTable, /accountsLoaded=\{paymentAccountsLoaded\}/);
  assert.match(mirrorTable, /loadingAccounts=\{loadingPaymentAccounts\}/);
  assert.match(mirrorTable, /accountsError=\{paymentAccountsError\}/);
  assert.match(customerFeed, /Couldn’t load credit-card accounts/);
  assert.match(customerFeed, /Loading credit-card accounts/);
  assert.match(customerFeed, /No eligible mapped payment accounts/);
});

test("Not a credit card payment uses the shared optimistic resolution transition on both surfaces", () => {
  assert.match(customerFeed, /onUseCoa=\{canRejectCcPayment \? \(\) => changeResolution\(txn, "categorize_new"\)/);
  assert.match(mirrorTable, /onUseCoa=\{!isPosted \? \(\) => changeResolution\("categorize_new"\)/);

  const customerChange = functionSlice(customerFeed, "const changeResolution = async", "const clearLoanSplit");
  assert.ok(customerChange.indexOf("setResolutionSelections") < customerChange.indexOf("onResolutionChange?."));
  assert.match(customerChange, /setAccountSelections\(\(state\) => new Map\(state\)\.set\(txn\.id, normalAccountId\)\)/);
  assert.match(customerChange, /onRejectCcPayment\?\.\(txn\.id\)/);
  assert.doesNotMatch(customerChange, /onPost|onApprove|postTransaction/);

  const mirrorChange = functionSlice(mirrorTable, "const changeResolution = async", "return (");
  assert.ok(mirrorChange.indexOf("setResolution(nextResolution)") < mirrorChange.indexOf("onResolutionChange?."));
  assert.match(mirrorChange, /setSelectedCcCandidateId\(""\)/);
  assert.match(mirrorChange, /onRejectCcPayment\?\.\(row\)/);
  assert.doesNotMatch(mirrorChange, /onPost|onApprove|postTransaction/);
});

test("switching back keeps the credit-card matcher rendered during persistence and taxonomy refresh", () => {
  assert.match(customerFeed, /deriveResolutionAwareCreditCardPaymentStatus\(txn, effectiveResolution\)/);
  assert.match(mirrorTable, /deriveResolutionAwareCreditCardPaymentStatus\(row, resolution\)/);
  assert.match(customerFeed, /effectiveResolution === "match_credit_card_payment" \|\| isCcPaymentSuspected/);
});

test("resolution state and credit-card cleanup are transaction scoped and stale discovery is cancelled", () => {
  assert.match(customerFeed, /new Map\(state\)\.set\(txn\.id, resolution\)/);
  assert.match(customerFeed, /new Map\(state\)\.set\(txn\.id, \{ busy: true, error: "" \}\)/);
  assert.match(mirrorTable, /key=\{row\.id\}/);
  assert.match(cleanup, /ccDiscoveryAbortRef\.current\.get\(discoveryKey\)\?\.abort\?\.\(\)/);
  assert.match(cleanup, /ccDiscoverySeqRef\.current\.set\(discoveryKey,/);
  assert.match(cleanup, /\[id\]: \{ loading: false, error:/);
  assert.doesNotMatch(cleanup, /window\.alert\(e\?\.message \|\| "Could not mark this as not a credit card payment\."\)/);
});

test("regular categorization continues to use canonical accounts and exact QBO IDs", () => {
  assert.match(customerFeed, /accounts=\{accounts\}/);
  assert.match(customerFeed, /onChange=\{\(id\) => handleAccountSelect\(txn\.id, id\)\}/);
  assert.match(mirrorTable, /accounts=\{accounts\}/);
  assert.match(mirrorTable, /onChange=\{\(id\) => setSelectedAccountId\(id\)\}/);
  assert.match(customerFeed, /key=\{acct\.id\}/);
  assert.match(customerFeed, /onChange\(acct\.id\)/);
});
