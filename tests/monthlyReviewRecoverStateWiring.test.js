import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  describeMonthlyReviewRecovery,
  runMonthlyReviewTransactionRecovery,
} from "../src/services/bookkeeping/monthlyReviewRecoveryClient.js";

test("one recovery click posts exactly one scoped transaction then refreshes persisted feeds", async () => {
  const events = [];
  const requests = [];
  const outcome = await runMonthlyReviewTransactionRecovery({
    request: async (url, init) => {
      events.push("request:start");
      requests.push({ url, init });
      await Promise.resolve();
      events.push("request:complete");
      return { ok: true, scheduled: 1, review_required: 0, skipped: 0, conflicted: 0, reasons: { manual_approval_scheduled: 1 } };
    },
    runId: "run-1",
    businessId: "business-1",
    transactionId: "transaction-1",
    refreshPersistedFeeds: async () => events.push("refresh"),
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/admin/monthly-review/runs/run-1/bookkeeping/recover-handled-posting-dispositions");
  assert.deepEqual(requests[0].init, {
    method: "POST",
    body: { business_id: "business-1", transaction_ids: ["transaction-1"] },
  });
  assert.deepEqual(events, ["request:start", "request:complete", "refresh"]);
  assert.match(outcome.message, /rescheduled/i);
  assert.doesNotMatch(requests[0].url, /\/lock(?:\?|$)/);
});

test("a failed recovery is visible and never refreshes feeds", async () => {
  let refreshed = false;
  await assert.rejects(
    runMonthlyReviewTransactionRecovery({
      request: async () => { throw Object.assign(new Error("Recovery failed safely"), { body: { error: "active_operation" } }); },
      runId: "run-1",
      businessId: "business-1",
      transactionId: "transaction-1",
      refreshPersistedFeeds: async () => { refreshed = true; },
    }),
    /Recovery failed safely/
  );
  assert.equal(refreshed, false);
});

test("recovery response copy distinguishes every bounded outcome", () => {
  assert.match(describeMonthlyReviewRecovery({ review_required: 1, reasons: { inflow_resolution_required: 1 } }), /returned to Needs Review.*inflow resolution required/i);
  assert.match(describeMonthlyReviewRecovery({ skipped: 1, reasons: { active_operation: 1 } }), /still blocked.*active operation/i);
  assert.match(describeMonthlyReviewRecovery({ examined: 0, reasons: { not_candidate: 1 } }), /unchanged.*not candidate/i);
});

test("rendered control prevents default navigation and uses the dedicated recovery handler", () => {
  const table = readFileSync("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx", "utf8");
  const page = readFileSync("src/pages/Admin/MonthlyReviewConsole.jsx", "utf8");
  assert.match(table, /type="button"[\s\S]*onClick=\{\(event\) => onRecover\?\.\(event, row\)\}/);
  assert.match(page, /event\?\.preventDefault\?\.\(\)/);
  assert.match(page, /event\?\.stopPropagation\?\.\(\)/);
  assert.match(page, /onRecover=\{recoverBookkeepingFeedRow\}/);
  assert.match(page, /loadBookkeepingFeed\("handled", \{ reset: true \}\)/);
  assert.match(page, /loadBookkeepingFeed\("needs_review", \{ reset: true \}\)/);
});
