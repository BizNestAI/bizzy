import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

test("monthly Plaid population excludes superseded pending replacements without dropping legitimate rows", async () => {
  const { removeSupersededPendingPlaidRows } = await import("../src/api/admin/monthlyReview.routes.js");
  const rows = [
    {
      id: "pending-apple",
      plaid_transaction_id: "pending-plaid-1",
      pending: true,
      date: "2026-08-12",
      amount: -21.62,
    },
    {
      id: "posted-apple",
      plaid_transaction_id: "posted-plaid-1",
      pending_transaction_id: "pending-plaid-1",
      pending: false,
      date: "2026-08-12",
      amount: -21.62,
    },
    {
      id: "pending-shell",
      plaid_transaction_id: "pending-plaid-2",
      pending: true,
      date: "2026-08-13",
      amount: -42,
    },
    {
      id: "posted-standalone",
      plaid_transaction_id: "posted-plaid-2",
      pending: false,
      date: "2026-08-14",
      amount: -10,
    },
  ];

  const filtered = removeSupersededPendingPlaidRows(rows);
  assert.deepEqual(filtered.map((row) => row.id), ["posted-apple", "pending-shell", "posted-standalone"]);
});

test("monthly Plaid trace rows use actual GL and QBO lifecycle for all canonical states", async () => {
  const { buildAuthoritativePlaidTraceRow } = await import("../src/api/admin/monthlyReview.routes.js");
  const labels = new Map([["plaid-cc", "Blue Cash Everyday® ••••1008"]]);
  const accountById = new Map([["acct-software", { id: "acct-software", name: "Software" }]]);

  const row = buildAuthoritativePlaidTraceRow({
    row: {
      id: "txn-1",
      plaid_account_id: "plaid-cc",
      plaid_transaction_id: "plaid-txn-1",
      date: "2026-08-19",
      name: "RAILWAY",
      merchant_name: "Railway",
      signed_amount: -5,
      pending: false,
    },
    cat: {
      status: "approved",
      final_qbo_account_id: "acct-software",
      final_qbo_account_name: "Software",
      qbo_txn_id: null,
      post_error: null,
      meta: {},
    },
    plaidAccountLabels: labels,
    accountById,
    accountByName: new Map(),
    reconciliationItem: null,
  });

  assert.equal(row.transaction_id, "txn-1");
  assert.equal(row.bank_account, "Blue Cash Everyday® ••••1008");
  assert.equal(row.bizzi_gl_account, "Software");
  assert.equal(row.qbo_lifecycle_status.key, "handled_not_posted");
});

test("monthly review source ledger has independent authoritative Plaid Rows population", () => {
  const route = read("src/api/admin/monthlyReview.routes.js");
  const loadBody = route.slice(route.indexOf("async function loadAuthoritativeMonthlyPlaidTransactions"), route.indexOf("export function removeSupersededPendingPlaidRows"));

  assert.match(loadBody, /\.from\("bank_transactions"\)/);
  assert.match(loadBody, /\.eq\("business_id", businessId\)/);
  assert.match(loadBody, /\.eq\("is_archived", false\)/);
  assert.match(loadBody, /\.not\("plaid_transaction_id", "is", null\)/);
  assert.match(loadBody, /\.not\("plaid_account_id", "is", null\)/);
  assert.match(loadBody, /\.gte\("date", start\)/);
  assert.match(loadBody, /\.lt\("date", end\)/);
  assert.doesNotMatch(loadBody, /applyActiveBookkeepingScope/);
  assert.match(route, /reconciliationTrace = authoritativePlaidRows/);
  assert.match(route, /plaid_count \+= 1/);
});
