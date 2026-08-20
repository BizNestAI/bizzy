import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  applyActiveBookkeepingScope,
  getTransactionsOutsideActiveBookkeepingScope,
  isTransactionInActiveBookkeepingScope,
} from "../src/services/bookkeeping/bookkeepingScope.js";

const root = process.cwd();

test("bookkeeping scope preserves legacy behavior when start date is null", () => {
  assert.equal(isTransactionInActiveBookkeepingScope({ date: "2026-05-15" }, null), true);
  assert.deepEqual(getTransactionsOutsideActiveBookkeepingScope([{ id: "pre", date: "2026-05-15" }], null), []);
});

test("bookkeeping scope excludes pre-cutoff transactions and keeps post-cutoff transactions active", () => {
  const rows = [
    { id: "pre", date: "2026-06-30" },
    { id: "on", date: "2026-07-01" },
    { id: "post", date: "2026-07-02" },
  ];

  assert.equal(isTransactionInActiveBookkeepingScope(rows[0], "2026-07-01"), false);
  assert.equal(isTransactionInActiveBookkeepingScope(rows[1], "2026-07-01"), true);
  assert.equal(isTransactionInActiveBookkeepingScope(rows[2], "2026-07-01"), true);
  assert.deepEqual(getTransactionsOutsideActiveBookkeepingScope(rows, "2026-07-01").map((row) => row.id), ["pre"]);
});

test("active query helper applies date cutoff only when configured", () => {
  const withoutCutoff = new FakeQuery();
  assert.equal(applyActiveBookkeepingScope(withoutCutoff, null), withoutCutoff);
  assert.deepEqual(withoutCutoff.filters, []);

  const withCutoff = new FakeQuery();
  assert.equal(applyActiveBookkeepingScope(withCutoff, "2026-07-01"), withCutoff);
  assert.deepEqual(withCutoff.filters, [{ op: "gte", field: "date", value: "2026-07-01" }]);
});

test("approval and posting paths have hard pre-cutoff gates for direct transaction IDs", () => {
  const approvalsSource = readFileSync(join(root, "src/services/bookkeeping/bookkeepingApprovalService.js"), "utf8");
  const postingSource = readFileSync(join(root, "src/jobs/booksPost.cron.js"), "utf8");

  assert.match(approvalsSource, /getTransactionsOutsideActiveBookkeepingScope/);
  assert.match(approvalsSource, /transaction_before_bookkeeping_start_date/);
  assert.match(postingSource, /isTransactionInActiveBookkeepingScope/);
  assert.match(postingSource, /transaction_before_bookkeeping_start_date/);
  assert.match(postingSource, /status:\s*"ignored"/);
});

test("clarification answers cannot approve pre-cutoff transactions by direct ID", () => {
  const source = readFileSync(join(root, "src/services/bookkeeping/clarificationService.js"), "utf8");

  assert.match(source, /getBookkeepingStartDate/);
  assert.match(source, /isTransactionInActiveBookkeepingScope/);
  assert.match(source, /transaction_before_bookkeeping_start_date/);
  assert.match(source, /continue;/);
});

test("monthly review job-costing evidence applies active bookkeeping scope", () => {
  const source = readFileSync(join(root, "src/api/admin/monthlyReview.routes.js"), "utf8");

  assert.match(source, /async function buildJobCostingEvidence/);
  assert.match(source, /getBookkeepingStartDate\(supabase, businessId\)/);
  assert.match(source, /applyActiveBookkeepingScope\(query, bookkeepingStartDate\)/);
});

test("historical transfer and refund context is explicit and does not activate matched transactions", () => {
  const source = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.suggest.routes.js"), "utf8");

  assert.match(source, /allowHistoricalContext:\s*true/);
  assert.match(source, /historicalContextOnly/);
  assert.match(source, /transfer_pair_historical_context_only/);
  assert.match(source, /refund_original_historical_context_only/);
  assert.doesNotMatch(source, /transaction_id:\s*orig\.txnId/);
  assert.doesNotMatch(source, /transaction_id:\s*pair\.txnId/);
});

test("direct tax transaction detail has the same active-scope gate as aggregate tax queries", () => {
  const source = readFileSync(join(root, "src/services/tax/taxPostedTransaction.repository.js"), "utf8");

  assert.match(source, /export async function getPostedTransactionForTax/);
  assert.match(source, /getBookkeepingStartDate\(supabase, businessId\)/);
  assert.match(source, /isTransactionInActiveBookkeepingScope\(bankTransaction, bookkeepingStartDate\)/);
  assert.match(source, /transaction_before_bookkeeping_start_date/);
});

test("moving bookkeeping start date earlier requires explicit confirmation and does not mutate transactions", () => {
  const source = readFileSync(join(root, "src/pages/Settings/SettingsHome.jsx"), "utf8");

  assert.match(source, /nextStartDate < currentStartDate/);
  assert.match(source, /window\.confirm/);
  assert.match(source, /older imported transactions eligible for active review/);
  assert.doesNotMatch(source, /transaction_categorizations/);
  assert.doesNotMatch(source, /post_after/);
});

test("moving bookkeeping start date later remains an immediate narrowing change", () => {
  const source = readFileSync(join(root, "src/pages/Settings/SettingsHome.jsx"), "utf8");

  assert.match(source, /nextStartDate < currentStartDate/);
  assert.doesNotMatch(source, /nextStartDate > currentStartDate[\s\S]{0,120}window\.confirm/);
});

test("post-cutoff transactions still pass active categorization and posting guards", () => {
  const rows = [{ id: "post", date: "2026-07-01" }];
  assert.deepEqual(getTransactionsOutsideActiveBookkeepingScope(rows, "2026-07-01"), []);
  assert.equal(isTransactionInActiveBookkeepingScope(rows[0], "2026-07-01"), true);
});

class FakeQuery {
  constructor() {
    this.filters = [];
  }

  gte(field, value) {
    this.filters.push({ op: "gte", field, value });
    return this;
  }
}
