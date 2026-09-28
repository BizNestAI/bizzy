/* global process */
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
  assert.match(cron, /post_anyway_requires_confirmation: errorCode === "possible_qbo_duplicate" \? true/);
});

test("multiple plausible candidates are ambiguous and never auto-linked", () => {
  const cron = read("src/jobs/booksPost.cron.js");

  assert.match(cron, /deterministic\.length > 1\) return \{ confidence: "AMBIGUOUS"/);
  assert.match(cron, /if \(strong\.length > 1\) return \{ confidence: "AMBIGUOUS"/);
  assert.match(cron, /duplicateCheck\.confidence === "AMBIGUOUS"/);
  assert.doesNotMatch(cron, /AMBIGUOUS"[\s\S]{0,200}recordQboExistingLink/);
});

test("same account date amount with missing or conflicting payee becomes ambiguous instead of no match", () => {
  const cron = read("src/jobs/booksPost.cron.js");

  assert.match(cron, /const strong = scored\.filter\(\(c\) => c\.payee_matches\)/);
  assert.match(cron, /if \(strong\.length === 1\) return \{ confidence: "HIGH_CONFIDENCE_PROBABLE_DUPLICATE"/);
  assert.match(cron, /payeeConflicts/);
  assert.match(cron, /LOW_CONFIDENCE_FUZZY/);
  assert.match(cron, /scored\.every\(\(c\) => c\.payee_conflicts\)/);
  assert.match(cron, /if \(scored\.length > 0\) return \{ confidence: "AMBIGUOUS"/);
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
  assert.match(cron, /qbo_duplicate_review_actions: errorCode === "possible_qbo_duplicate"[\s\S]*\["link_existing_quickbooks_transaction", "post_anyway"\]/);
  assert.doesNotMatch(cron, /confidence === "AMBIGUOUS"[\s\S]{0,300}recordQboExistingLink/);
});

test("manual Post anyway requires explicit confirmation and still uses normal idempotency", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  const route = read("src/api/bookkeeping/routes/bookkeeping.posting.routes.js");

  assert.match(route, /confirm_post_anyway/);
  assert.match(route, /post_anyway/);
  assert.match(route, /duplicateChallengeId/);
  assert.match(cron, /confirmPostAnyway === true/);
  assert.match(cron, /duplicatePostAnyway/);
  assert.match(cron, /qbo_duplicate_challenge_id === duplicateChallengeIdValue/);
  assert.match(cron, /if \(!structuredManualCheckCompleted\)[\s\S]*classifyPreExistingQboMatch/);
  assert.match(cron, /if \(duplicateCheck\.confidence === "DETERMINISTIC_EXISTING"\)/);
  assert.match(cron, /if \(!duplicatePostAnyway && \([\s\S]*LOW_CONFIDENCE_FUZZY/);
  assert.match(cron, /claimQboPostingIntent/);
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
  assert.match(route, /qbo_duplicate_candidate_changed/);
  assert.doesNotMatch(route, /link-existing[\s\S]*postToQbo/);
  assert.doesNotMatch(route, /link-existing[\s\S]*purchase\.create/);
});

test("two same-day same-amount Zelle senders remain fuzzy and manual-only override is explicit", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  const client = read("src/services/bookkeeping/bookkeepingClient.js");

  assert.match(cron, /sourcePayeeText/);
  assert.match(cron, /candidateIdentityText/);
  assert.match(cron, /payee_conflicts/);
  assert.match(cron, /manual && !duplicatePostAnyway/);
  assert.match(page, /Possible duplicate/);
  assert.match(page, /Link existing/);
  assert.match(page, /Post separately/);
  assert.match(client, /confirm_post_anyway: true/);
  assert.match(client, /duplicate_challenge_id/);
});

test("manual fuzzy duplicate is a successful confirmation challenge, not a failed posting", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  const route = read("src/api/bookkeeping/routes/bookkeeping.posting.routes.js");
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  assert.match(cron, /outcome: "confirmation_required"/);
  assert.match(cron, /reason: "possible_qbo_match"/);
  assert.match(cron, /recordManualFuzzyDuplicateChallenge/);
  assert.match(cron, /post_error: null/);
  assert.match(route, /return res\.json\(result\)/);
  assert.match(page, /result\?\.outcome === "confirmation_required"/);
  const expectedBranch = page.slice(page.indexOf('result?.outcome === "confirmation_required"'), page.indexOf("} catch (err)"));
  assert.doesNotMatch(expectedBranch, /console\.(warn|error)/);
});

test("compact fuzzy modal compares current and candidate and hides raw details by default", () => {
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  assert.match(page, /You’re posting/);
  assert.match(page, /Possible QuickBooks match/);
  assert.match(page, /View QuickBooks details/);
  assert.match(page, /sm:grid-cols-2/);
  assert.match(page, /Post as a separate transaction\?/);
  assert.doesNotMatch(page, /different real-world transaction/);
});

test("fuzzy candidate UI shows accounting identity fields and link does not create", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  const route = read("src/api/bookkeeping/routes/bookkeeping.posting.routes.js");

  for (const field of ["payee_or_memo", "source_qbo_account_name", "destination_qbo_account_name", "qbo_txn_type", "qbo_txn_id"]) {
    assert.match(cron, new RegExp(field));
    assert.match(page, new RegExp(field));
  }
  assert.match(route, /status: "posted"/);
  assert.doesNotMatch(route.slice(route.indexOf('router.post("/posting/transactions/:transactionId/link-existing"')), /createQboDeposit/);
});

test("batch duplicate review retains all challenged rows and resolves them with bounded concurrency", () => {
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  assert.match(page, /Review possible QuickBooks matches/);
  assert.match(page, /These are separate charges — post all/);
  assert.match(page, /mapWithConcurrency\(entries, 3/);
  assert.match(page, /duplicateChallengeId: entry\.challenge\?\.challengeId/);
  assert.match(page, /status: receipt\?\.already_posted \? "already_posted" : "posted"/);
  assert.match(page, /const nextResults = \(bulkPostDialog\?\.results \|\| \[\]\)\.map/);
});

test("reviewed post-separately challenge is short-lived and skips duplicate rediscovery", () => {
  const cron = read("src/jobs/booksPost.cron.js");
  assert.match(cron, /qbo_duplicate_challenge_expires_at/);
  assert.match(cron, /let structuredManualCheckCompleted = duplicatePostAnyway/);
  assert.match(cron, /Date\.parse\(item\?\.meta\?\.qbo_duplicate_challenge_expires_at/);
});

test("one QuickBooks candidate cannot be linked to two source transactions", () => {
  const route = read("src/api/bookkeeping/routes/bookkeeping.posting.routes.js");
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  assert.match(route, /qbo_duplicate_candidate_already_linked/);
  assert.match(route, /\.neq\("transaction_id", transactionId\)/);
  assert.match(page, /candidateReservations\.has\(candidateKey\)/);
});

test("expense duplicate confirmation never describes the charge as a deposit", () => {
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  assert.match(page, /function duplicateEntityNoun/);
  assert.match(page, /amount < 0\) return "expenses"/);
  assert.doesNotMatch(page, /amount \|\| 0 \}\)\.replace\("\+", ""\)\} deposits dated/);
});
