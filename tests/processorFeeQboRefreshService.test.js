/* global process */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const { fetchAllPurchasePages, queryPurchasePage } = await import("../src/services/bookkeeping/processorFeeQboRefreshService.js");
const root = process.cwd();

function response(rows, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => ({ QueryResponse: { Purchase: rows } }) };
}

test("targeted Purchase refresh follows every QBO pagination page", async () => {
  const starts = [];
  const first = Array.from({ length: 1000 }, (_, index) => ({ Id: String(index + 1), TotalAmt: 8.4 }));
  const fetchImpl = async (url) => {
    const start = Number(new URL(url).searchParams.get("query").match(/STARTPOSITION (\d+)/)[1]);
    starts.push(start);
    return response(start === 1 ? first : [{ Id: "1001", TotalAmt: 18.9 }]);
  };
  const result = await fetchAllPurchasePages({ realmId: "realm-1", accessToken: "token", dateFrom: "2026-09-04", dateTo: "2026-09-20", fetchImpl });
  assert.equal(result.complete, true);
  assert.equal(result.pages, 2);
  assert.equal(result.purchases.length, 1001);
  assert.deepEqual(starts, [1, 1001]);
});

test("an intermediate Purchase page failure is explicit and never authoritative", async () => {
  const first = Array.from({ length: 1000 }, (_, index) => ({ Id: String(index + 1) }));
  let calls = 0;
  await assert.rejects(
    () => fetchAllPurchasePages({
      realmId: "realm-1", accessToken: "token", dateFrom: "2026-09-04", dateTo: "2026-09-20",
      fetchImpl: async () => (++calls === 1 ? response(first) : response([], { ok: false, status: 503 })),
    }),
    (error) => error.code === "qbo_purchase_query_failed" && error.details.page_start === 1001
  );
});

test("targeted query is bounded to the candidate date window", async () => {
  let query = "";
  await queryPurchasePage({
    realmId: "realm-1", accessToken: "token", dateFrom: "2026-09-04", dateTo: "2026-09-10", startPosition: 1,
    fetchImpl: async (url) => { query = new URL(url).searchParams.get("query"); return response([]); },
  });
  assert.match(query, /from Purchase/i);
  assert.match(query, /TxnDate >= '2026-09-04'/);
  assert.match(query, /TxnDate <= '2026-09-10'/);
});

test("Retry uses the refresh endpoint and exposes loading without Record New Fee", () => {
  const route = readFileSync(join(root, "src/api/bookkeeping/routes/bookkeeping.incomingDepositMatches.routes.js"), "utf8");
  const client = readFileSync(join(root, "src/services/bookkeeping/bookkeepingClient.js"), "utf8");
  const page = readFileSync(join(root, "src/pages/accounting/BookkeepingCleanup.jsx"), "utf8");
  const feed = readFileSync(join(root, "src/components/Accounting/BookkeepingFeed.jsx"), "utf8");
  assert.match(route, /incoming-deposit-matches\/:transactionId\/refresh/);
  assert.match(route, /refreshProcessorFeeQboEvidence[\s\S]*discoverIncomingDepositQboMatch/);
  assert.match(client, /refreshIncomingDepositMatch/);
  assert.match(page, /unavailable[\s\S]*refreshIncomingDepositMatch/);
  assert.match(feed, /Refreshing QuickBooks…/);
  assert.match(feed, /state\.unavailable[\s\S]*Try again[\s\S]*processorState === "no_existing_qbo_match"[\s\S]*Record New Fee/);
  assert.match(feed, /ordinary_income_posting_blocked: "Posting blocked"/);
});
