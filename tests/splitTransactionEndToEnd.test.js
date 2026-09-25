import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildSplitTransactionQboPayload,
  validateSplitTransaction,
} from "../src/services/bookkeeping/splitTransactionWorkflow.js";
import { computePostAfterForAutoPost } from "../src/services/bookkeeping/autoPostControl.js";

const transaction = {
  id: "alliant-1",
  date: "2026-09-01",
  amount: -517.55,
  direction: "OUTFLOW",
  pending: false,
};
const lines = [
  { id: "line-liability", description: "Car Loan", amount_minor: 46755, qbo_account_id: "1150040047", qbo_account_name: "Car Loan" },
  { id: "line-interest", description: "Car Loan Interest", amount_minor: 5000, qbo_account_id: "1150040048", qbo_account_name: "Car Loan Interest" },
];

test("a confirmed split validates line accounts and exact integer-cent allocation", () => {
  const result = validateSplitTransaction({ transaction, split: { lines } });
  assert.equal(result.expected_amount_minor, 51755);
  assert.deepEqual(result.lines.map((line) => line.amount_minor), [46755, 5000]);
  assert.throws(
    () => validateSplitTransaction({ transaction, split: { lines: lines.map((line, index) => index ? { ...line, qbo_account_id: null } : line) } }),
    /split_transaction_line_missing_account/
  );
});

test("the canonical split builder creates one Purchase with two GL lines and one source account", () => {
  const payload = buildSplitTransactionQboPayload({
    transaction,
    split: { lines },
    mapping: { qbo_account_id: "checking-qbo", qbo_account_type: "Bank" },
    requestId: "split-idempotency-1",
  });
  assert.equal(payload.AccountRef.value, "checking-qbo");
  assert.equal(payload.Line.length, 2);
  assert.deepEqual(payload.Line.map((line) => line.Amount), [467.55, 50]);
  assert.equal(payload.Line.reduce((sum, line) => sum + line.Amount, 0), 517.55);
});

test("split approval uses the shared 24-hour scheduler", () => {
  assert.equal(
    computePostAfterForAutoPost(true, 24, Date.parse("2026-09-25T21:52:58.609Z")),
    "2026-09-26T21:52:58.609Z"
  );
  const route = fs.readFileSync(new URL("../src/api/bookkeeping/routes/bookkeeping.approvals.routes.js", import.meta.url), "utf8");
  assert.match(route, /resolveBookkeepingPostAfter\(\{/);
  assert.doesNotMatch(route, /post_after:\s*nowIso/);
});

test("manual and scheduled posting both dispatch verified splits to the canonical multi-line builder", () => {
  const worker = fs.readFileSync(new URL("../src/jobs/booksPost.cron.js", import.meta.url), "utf8");
  assert.match(worker, /hasConfirmedSplitTransactionMeta\(item\)/);
  assert.match(worker, /fetchConfirmedSplitTransaction\(\{/);
  assert.match(worker, /postSplitTransactionPurchase\(item, bankTxn, qbo, mapping, requestId\)/);
  assert.match(worker, /return "Purchase"/);
  assert.match(worker, /claim_qbo_posting_intent/);
});

test("feed hydration and Post Now UX preserve and present authoritative split lines", () => {
  const feedService = fs.readFileSync(new URL("../src/services/bookkeeping/bookkeepingTransactionFeedService.js", import.meta.url), "utf8");
  const feed = fs.readFileSync(new URL("../src/components/Accounting/BookkeepingFeed.jsx", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../src/pages/accounting/BookkeepingCleanup.jsx", import.meta.url), "utf8");
  assert.match(feedService, /attachCanonicalSplitsForFeed/);
  assert.match(feedService, /split_lines:/);
  assert.match(feed, /Transaction Split/);
  assert.match(feed, /hasSavedSplit/);
  assert.match(page, /splitLines\.length} split lines/);
  assert.match(page, /Your split was preserved and nothing was marked Posted/);
});
