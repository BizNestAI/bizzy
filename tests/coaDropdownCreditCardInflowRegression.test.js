import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

globalThis.process.env.SUPABASE_URL ||= "https://example.supabase.co";
globalThis.process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
const { normalizeBookkeepingTransactionRow } = await import("../src/services/bookkeeping/bookkeepingTransactionFeedService.js");

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function adobeRow() {
  return {
    id: "9e9c70f6-bd9c-4fa5-841a-1df04168f067",
    date: "2026-06-10",
    name: "ADOBE *800-833-6687",
    merchant_name: "Adobe",
    amount: 32.16,
    direction: "INFLOW",
    account_type: "credit card",
  };
}

const amazonCashBackFixtures = Object.freeze([
  {
    id: "amazon-cash-back-2026-09-07-3050",
    date: "2026-09-07",
    name: "Redeem Cash Back at Amazon.com...",
    merchant_name: "Amazon",
    amount: 30.50,
    direction: "INFLOW",
    account_type: "credit card",
  },
  {
    id: "amazon-cash-back-2026-07-02-1066",
    date: "2026-07-02",
    name: "Redeem Cash Back at Amazon.com...",
    merchant_name: "Amazon",
    amount: 10.66,
    direction: "INFLOW",
    account_type: "credit card",
  },
]);

test("stale card-payment taxonomy cannot erase an authoritative categorized account", () => {
  const normalized = normalizeBookkeepingTransactionRow(adobeRow(), {
    status: "approved",
    final_qbo_account_id: "software-id",
    final_qbo_account_name: "Software",
    meta: { taxonomy_type: "cc_payment", user_selected_resolution: "categorize_new" },
  });
  assert.equal(normalized.final_qbo_account_id, "software-id");
  assert.equal(normalized.final_qbo_account_name, "Software");
  assert.equal(normalized.glAccountId, "software-id");
  assert.equal(normalized.glAccountName, "Software");
});

test("refund resolution keeps source card account separate from Software counter-account", () => {
  const normalized = normalizeBookkeepingTransactionRow(adobeRow(), {
    status: "approved",
    final_qbo_account_id: "software-id",
    final_qbo_account_name: "Software",
    meta: { credit_card_inflow_resolution: { resolution_type: "merchant_refund", destination_qbo_account_id: "software-id", destination_qbo_account_name: "Software" } },
  }, "Business Credit Card");
  assert.equal(normalized.currentAccount, "Business Credit Card");
  assert.equal(normalized.glAccountName, "Software");
});

test("Account column always mounts canonical selector in Needs Review and Handled", () => {
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
  assert.match(feed, /const showCanonicalCoa = \["needs_review", "handled"\]\.includes/);
  assert.match(feed, /showCanonicalCoa && accounts\.length > 0 \? \([\s\S]*<CoaDropdown/);
  assert.match(feed, /"Select account"/);
  assert.match(feed, /"Account unavailable"/);
  assert.ok(feed.includes('disabledReason={coaEditingProtected ? "Resolve this transaction through the protected credit-card payment matching workflow.'));
});

test("special resolution UI coexists with the COA selector", () => {
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
  const prompt = feed.indexOf("What type of credit is this?");
  const selector = feed.indexOf("{showCanonicalCoa && accounts.length > 0", prompt);
  assert.ok(prompt > 0 && selector > prompt);
});

for (const fixture of amazonCashBackFixtures) {
  test(`${fixture.date} Amazon cash back retains the canonical empty-account state`, () => {
    const normalized = normalizeBookkeepingTransactionRow(fixture, {
      status: "approved",
      post_error: "credit_card_inflow_requires_review",
      meta: { post_block_reason: "credit_card_inflow_requires_review" },
    });
    assert.equal(normalized.vendor, "Amazon");
    assert.equal(normalized.signed_amount, fixture.amount);
    assert.equal(normalized.glAccountId, null);
    assert.equal(normalized.glAccountName, null);
    assert.equal(normalized.status, "approved");
  });
}

test("Amazon cash-back resolution UI never suppresses the canonical COA selector", () => {
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
  const creditOptions = feed.indexOf('["credit_card_statement_credit", "Cash back or statement credit"]');
  const canonicalSelector = feed.indexOf("{showCanonicalCoa && accounts.length > 0", creditOptions);
  assert.ok(creditOptions > 0 && canonicalSelector > creditOptions);
  assert.match(feed.slice(canonicalSelector, canonicalSelector + 2_500), /<CoaDropdown[\s\S]*resolutionOptions=\{rowResolutionOptions\}/);
  assert.match(feed.slice(canonicalSelector, canonicalSelector + 2_500), /suggestedName=\{txn\.suggestedAccountName \|\| txn\.glAccountName\}/);
  assert.equal(amazonCashBackFixtures.every((fixture) => fixture.account_type === "credit card" && fixture.amount > 0), true);
});

test("cash back plus a selected GL account posts with QuickBooks credit semantics", () => {
  const service = read("src/services/bookkeeping/transactionResolutionService.js");
  assert.match(service, /\["merchant_refund", "credit_card_statement_credit"\]\.includes\(normalized\) && !effectiveAccountId/);
  assert.match(service, /final_qbo_account_id: String\(effectiveAccountId\)/);
  const cron = read("src/jobs/booksPost.cron.js");
  assert.match(cron, /isCreditCard && isInflowLike\(bankTxn\) && \["merchant_refund", "credit_card_statement_credit"\][\s\S]*return "CreditCardCredit"/);
  const payloadBuilder = read("src/services/bookkeeping/creditCardMerchantRefundPayload.js");
  assert.match(payloadBuilder, /PaymentType: "CreditCard"/);
  assert.match(payloadBuilder, /Credit: true/);
  assert.match(payloadBuilder, /TotalAmt: magnitude/);
  assert.match(payloadBuilder, /Amount: magnitude/);
});

test("ordinary account edits are not diverted by stale card-payment taxonomy", () => {
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  const helper = page.slice(page.indexOf("const isCreditCardPaymentWorkflowTxn"), page.indexOf("const clearCreditCardPaymentDiscovery"));
  assert.match(helper, /explicitResolution && explicitResolution !== "match_credit_card_payment" && !hasDurablePair\) return false/);
  const accountChange = page.slice(page.indexOf("const handleAccountChange"), page.indexOf("useEffect(() => {\n    setSelectedIds", page.indexOf("const handleAccountChange")));
  assert.match(accountChange, /updateHandledTransaction[\s\S]*final_qbo_account_id: accountId/);
  assert.match(accountChange, /reloadCurrentBookkeepingView/);
});

test("posting still requires an authoritative credit type", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  assert.match(cron, /const isUnresolvedCreditCardInflow/);
  assert.match(cron, /reason: "credit_card_inflow_resolution_required"/);
  assert.match(cron, /available_resolution_actions/);
});
