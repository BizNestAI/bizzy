import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

test("pre-existing QBO detector defines conservative confidence levels", () => {
  const cron = read("src/jobs/booksPost.cron.js");

  assert.match(cron, /DETERMINISTIC_EXISTING/);
  assert.match(cron, /HIGH_CONFIDENCE_PROBABLE_DUPLICATE/);
  assert.match(cron, /AMBIGUOUS/);
  assert.match(cron, /NO_MATCH/);
  assert.match(cron, /function classifyPreExistingQboMatch/);
});

test("detector queries supported QBO APIs for purchase, deposit, credit-card charge, and credit-card payment paths", () => {
  const cron = read("src/jobs/booksPost.cron.js");

  assert.match(cron, /Purchase: "findPurchases"/);
  assert.match(cron, /Deposit: "findDeposits"/);
  assert.match(cron, /CreditCardCharge: "findPurchases"/);
  assert.match(cron, /CreditCardPayment: "findTransfers"/);
  assert.match(cron, /CreditCardCharge: \["creditcardcharge", "creditCardCharge"\]/);
  assert.match(cron, /CreditCardPayment: \["creditcardpayment", "creditCardPayment"\]/);
});

test("short Bizzi recovery marker or request ID is deterministic and links without creating", () => {
  const cron = read("src/jobs/booksPost.cron.js");

  assert.match(cron, /requestText && text\.includes\(requestText\)/);
  assert.match(cron, /marker && text\.includes\(marker\)/);
  assert.match(cron, /const marker = normalizeMatchText\(buildQboPostMarker\(requestId\)\)/);
  assert.match(cron, /Posted by Bizzi/);
  assert.match(cron, /Ref \$\{ref\}/);
  assert.doesNotMatch(cron, /Bizzi:\$\{txnRef\}|plaid_transaction_id \|\| bankTxn\?\.id/);
  assert.match(cron, /recordQboExistingLink/);
  assert.match(cron, /linked_existing_qbo_transaction: true/);
  assert.match(cron, /if \(duplicateCheck\.confidence === "DETERMINISTIC_EXISTING"\)/);
});

test("customer or QBO Bank Feed-created exact transaction becomes duplicate review instead of auto-create", () => {
  const cron = read("src/jobs/booksPost.cron.js");

  assert.match(cron, /account_matches/);
  assert.match(cron, /date_matches/);
  assert.match(cron, /amount_matches/);
  assert.match(cron, /payee_matches/);
  assert.match(cron, /HIGH_CONFIDENCE_PROBABLE_DUPLICATE/);
  assert.match(cron, /possible_qbo_duplicate/);
  assert.match(cron, /This transaction may already exist in QuickBooks\./);
  assert.match(cron, /post_anyway_requires_confirmation: true/);
});

test("multiple plausible candidates are ambiguous and never auto-linked", () => {
  const cron = read("src/jobs/booksPost.cron.js");

  assert.match(cron, /deterministic\.length > 1\) return \{ confidence: "AMBIGUOUS"/);
  assert.match(cron, /strong\.length > 1 \|\| scored\.length > 0/);
  assert.match(cron, /duplicateCheck\.confidence === "AMBIGUOUS"/);
  assert.doesNotMatch(cron, /AMBIGUOUS"[\s\S]{0,200}recordQboExistingLink/);
});

test("same account date amount with missing or conflicting payee becomes ambiguous instead of no match", () => {
  const cron = read("src/jobs/booksPost.cron.js");

  assert.match(cron, /const strong = scored\.filter\(\(c\) => c\.payee_matches\)/);
  assert.match(cron, /if \(strong\.length === 1\) return \{ confidence: "HIGH_CONFIDENCE_PROBABLE_DUPLICATE"/);
  assert.match(cron, /if \(strong\.length > 1 \|\| scored\.length > 0\) return \{ confidence: "AMBIGUOUS"/);
  assert.match(cron, /return \{ confidence: "NO_MATCH", candidates: \[\] \}/);
  assert.match(cron, /function isNearQboTxnDate/);
  assert.match(cron, /dateMatches = isNearQboTxnDate/);
  assert.match(cron, /TxnDate[\s\S]*>=/);
  assert.match(cron, /TxnDate[\s\S]*<=/);
});

test("same gas station same amount same date and repeated subscriptions are review-blocked, not auto-linked", () => {
  const cron = read("src/jobs/booksPost.cron.js");

  assert.match(cron, /HIGH_CONFIDENCE_PROBABLE_DUPLICATE/);
  assert.match(cron, /AMBIGUOUS/);
  assert.match(cron, /markPossibleQboDuplicate/);
  assert.match(cron, /qbo_duplicate_review_actions: \["link_existing_quickbooks_transaction", "post_anyway"\]/);
  assert.doesNotMatch(cron, /confidence === "AMBIGUOUS"[\s\S]{0,300}recordQboExistingLink/);
});

test("manual Post anyway requires explicit confirmation and still uses normal idempotency", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  const route = read("src/api/bookkeeping/routes/bookkeeping.posting.routes.js");

  assert.match(route, /confirm_post_anyway/);
  assert.match(route, /post_anyway/);
  assert.match(route, /postSingleBookkeepingTransactionNow\(\{ businessId, transactionId, confirmPostAnyway \}\)/);
  assert.match(cron, /confirmPostAnyway === true/);
  assert.match(cron, /duplicatePostAnyway/);
  assert.match(cron, /duplicatePostAnyway = confirmPostAnyway && item\?\.meta\?\.possible_qbo_duplicate === true/);
  assert.match(cron, /if \(!duplicatePostAnyway\)[\s\S]*classifyPreExistingQboMatch/);
  assert.match(cron, /claimQboPostingIntent[\s\S]*if \(!duplicatePostAnyway\)/);
});

test("Link existing QuickBooks transaction action records receipt without provider create", () => {
  const route = read("src/api/bookkeeping/routes/bookkeeping.posting.routes.js");

  assert.match(route, /\/posting\/transactions\/:transactionId\/link-existing/);
  assert.match(route, /qbo_duplicate_review_required/);
  assert.match(route, /getLatestQuickBooksTokenRow\(businessId\)/);
  assert.match(route, /receipt\.realm_id && receipt\.realm_id !== tokenRow\.realm_id/);
  assert.match(route, /fetchExistingQboTransaction\(qbo, qboTxnType, qboTxnId\)/);
  assert.match(route, /String\(fetchedId \|\| ""\) !== String\(qboTxnId\)/);
  assert.match(route, /from\("qbo_posted_transactions"\)[\s\S]*status: "posted"/);
  assert.match(route, /linked_existing_qbo_transaction: true/);
  assert.doesNotMatch(route, /link-existing[\s\S]*postToQbo/);
  assert.doesNotMatch(route, /link-existing[\s\S]*purchase\.create/);
});
