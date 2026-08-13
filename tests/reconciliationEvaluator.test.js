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
