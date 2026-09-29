import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { bulkActionForFeed, isBulkActionEligible, summarizeBulkPost } from "../src/services/bookkeeping/bookkeepingBulkActions.js";

const handled = (id, extra = {}) => ({
  id,
  status: "approved",
  vendor: "Haraz Coffee",
  glAccountId: "meals",
  glAccountName: "Meals",
  amount: -5,
  ...extra,
});

test("bulk actions are explicitly scoped to their feed", () => {
  assert.equal(bulkActionForFeed("needs_review"), "approve");
  assert.equal(bulkActionForFeed("handled"), "post");
  for (const feed of ["posted", "matched", "pending", "excluded"]) assert.equal(bulkActionForFeed(feed), null);
});

test("Handled eligibility rejects receipts and protected matching or split workflows", () => {
  assert.equal(isBulkActionEligible(handled("a"), "handled"), true);
  assert.equal(isBulkActionEligible(handled("b", { qbo_txn_id: "101" }), "handled"), false);
  assert.equal(isBulkActionEligible(handled("c", { taxonomy_type: "cc_payment" }), "handled"), false);
  assert.equal(isBulkActionEligible(handled("d", { taxonomy_type: "split_transaction" }), "handled"), false);
  assert.equal(isBulkActionEligible(handled("e", { incoming_deposit_match: { id: "match" } }), "handled"), false);
});

test("same vendor and GL account remain distinct rows in the posting summary", () => {
  const summary = summarizeBulkPost([handled("haraz-1", { amount: -5.85 }), handled("haraz-2", { amount: -5.05 })]);
  assert.equal(summary.count, 2);
  assert.equal(summary.vendor, "Haraz Coffee");
  assert.equal(summary.account, "Meals");
  assert.equal(summary.totalExpenses.toFixed(2), "10.90");
});

test("Handled bulk workflow uses the canonical posting client and not approval", () => {
  const source = fs.readFileSync(new URL("../src/pages/accounting/BookkeepingCleanup.jsx", import.meta.url), "utf8");
  const bulkPostBody = source.slice(source.indexOf("const runBulkPost"), source.indexOf("const reviewBulkPostResult"));
  assert.match(bulkPostBody, /postTransactionToQuickBooks\(businessId, txn\.id, \{ operationId, childOperationId \}\)/);
  assert.doesNotMatch(bulkPostBody, /approveTransactions/);
  assert.match(bulkPostBody, /mapWithConcurrency\(batch, 3, async \(txn\)/);
  assert.match(bulkPostBody, /status: "duplicate"/);
  assert.match(bulkPostBody, /status: "failed"/);
  assert.match(bulkPostBody, /\? "already_posted" : "posted"/);
  assert.match(bulkPostBody, /results\.some\(\(entry\) => \["duplicate", "failed"\]\.includes\(entry\.status\)\)/);
  assert.match(bulkPostBody, /if \(requiresReview\) \{\s*setBulkPostDialog\(\{ type: "results", results \}\)/);
  assert.match(source, /bulkAction === "approve" \? handleBulkApprove : openBulkPostConfirmation/);
  assert.doesNotMatch(source.slice(source.indexOf("const handleBulkApprove"), source.indexOf("const handleManualPostTransaction")), /window\.alert/);
});

test("selection is reset for view changes and revalidated against refreshed eligibility", () => {
  const source = fs.readFileSync(new URL("../src/pages/accounting/BookkeepingCleanup.jsx", import.meta.url), "utf8");
  assert.match(source, /setSelectedIds\(new Set\(\)\);\s*\}, \[transactionViewKey\]\)/);
  assert.match(source, /filter\(\(id\) => selectableIdSet\.has\(id\)\)/);
});

test("Needs Review eligibility remains guarded by lifecycle status", () => {
  assert.equal(isBulkActionEligible({ id: "review", status: "needs_review" }, "needs_review"), true);
  assert.equal(isBulkActionEligible(handled("handled"), "needs_review"), false);
});

test("confirmed bulk posting shows a non-dismissible animated progress state", () => {
  const source = fs.readFileSync(new URL("../src/pages/accounting/BookkeepingCleanup.jsx", import.meta.url), "utf8");
  assert.match(source, /type: "posting"/);
  assert.match(source, /Posting to QuickBooks/);
  assert.match(source, /This may take a few moments/);
  assert.match(source, /animate-spin/);
  assert.match(source, /Keep this window open while Bizzi confirms each QuickBooks receipt/);
  assert.match(source, /!bulkPosting && \(bulkPostDialog\.type === "results"/);
  assert.match(source, /Checking local history/);
  assert.match(source, /Checking QuickBooks/);
  assert.match(source, /Could not complete check/);
  assert.match(source, /of \$\{bulkPostDialog\.transactions\?\.length \|\| 0\} checked/);
});

test("Handled row Posting pill animates its ellipsis", () => {
  const source = fs.readFileSync(new URL("../src/components/Accounting/BookkeepingFeed.jsx", import.meta.url), "utf8");
  const postingPill = source.slice(source.indexOf('aria-label="Post to QuickBooks"'), source.indexOf("</button>", source.indexOf('aria-label="Post to QuickBooks"')));
  assert.match(postingPill, /aria-label="Posting to QuickBooks"/);
  assert.equal((postingPill.match(/animate-dot-bounce/g) || []).length, 3);
  assert.match(postingPill, /animationDelay: "240ms"/);
  assert.match(postingPill, /motion-reduce:animate-none/);
});
