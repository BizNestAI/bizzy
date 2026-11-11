import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const root = process.cwd();
const evaluatorSource = readFileSync(
  join(root, "src/services/bookkeeping/reconciliationEvaluator.js"),
  "utf8"
);
const { countRowsByPlaidAccount } = await import(
  "../src/services/bookkeeping/reconciliationEvaluator.js"
);

test("reconciliation pending aggregation does not use unsupported Supabase group()", () => {
  assert.doesNotMatch(evaluatorSource, /\.group\(/);
  assert.match(evaluatorSource, /\.select\("plaid_account_id"\)/);
  assert.match(evaluatorSource, /\.eq\("business_id", businessId\)/);
  assert.match(evaluatorSource, /\.eq\("pending", true\)/);
  assert.match(evaluatorSource, /\.range\(from, to\)/);
});

test("reconciliation pending aggregation counts rows by Plaid account", () => {
  const counts = countRowsByPlaidAccount([
    { plaid_account_id: "acct_1" },
    { plaid_account_id: "acct_2" },
    { plaid_account_id: "acct_1" },
    { plaid_account_id: null },
    {},
  ]);

  assert.equal(counts.get("acct_1"), 2);
  assert.equal(counts.get("acct_2"), 1);
  assert.equal(counts.has(null), false);
  assert.equal(counts.has(undefined), false);
});

test("evaluator records the bankBalance in reconciliation details without invoking a provider", async () => {
  const { runInNewContext } = await import("node:vm");
  const written = [];
  const supabase = { from(table) {
    const data = table === "plaid_accounts" ? [{ plaid_account_id: "acct", name: "Fixture", current_balance: 123.45 }] : [];
    const query = { then(resolve) { return Promise.resolve({ data, error: null }).then(resolve); }, maybeSingle: async () => ({ data: null, error: null }), upsert(rows) { written.push(...rows); return this; } };
    for (const method of ["select", "eq", "gte", "in", "is", "not", "range", "order", "limit"]) query[method] = () => query;
    return query;
  } };
  const source = evaluatorSource.replace(/^import .*;\n/gm, "").replace(/export default \{[\s\S]*?\};/g, "").replace(/export /g, "");
  const evaluate = runInNewContext(`${source}\nevaluateReconciliationStatus`, { supabase, process: { env: { NODE_ENV: "production" } }, console, getQboAccountForPlaidAccount: async () => null, fetchQboAccountBalance: () => { throw new Error("Provider forbidden"); }, getBookkeepingStartDate: async () => null, applyActiveBookkeepingScope: (query) => query });
  const result = await evaluate("fixture-business", { preferQboBalance: false });
  assert.equal(result.perAccount.length, 1);
  assert.equal(result.perAccount[0].details.bank_balance, 123.45);
  assert.equal(written[0].details.bank_balance, 123.45);
});
