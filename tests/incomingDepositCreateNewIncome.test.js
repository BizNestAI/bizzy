import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const { recordIncomingDepositAsNewIncome, IncomingDepositMatchError } = await import("../src/services/bookkeeping/incomingDepositMatchService.js");
const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function dbFixture({ receipt = null } = {}) {
  const tables = {
    qbo_posted_transactions: receipt ? [receipt] : [],
    bank_transactions: [{ business_id: "biz-1", id: "payroll-1", plaid_account_id: "checking-1", amount: 2717.45, date: "2026-08-07", name: "PAYROLL TRANSTECH, INC. nis7 Patrick Gebhard ACH CREDIT", direction: "INFLOW" }],
    qbo_accounts_cache: [{ business_id: "biz-1", qbo_account_id: "sales", name: "Sales", account_type: "Income", active: true }],
    transaction_categorizations: [{ business_id: "biz-1", transaction_id: "payroll-1", status: "needs_review", meta: {} }],
  };
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.patch = null; }
    select() { return this; }
    eq(key, value) { this.filters.push((row) => String(row[key]) === String(value)); return this; }
    limit() { return this; }
    update(patch) { this.patch = patch; return this; }
    rows() { return (tables[this.table] || []).filter((row) => this.filters.every((filter) => filter(row))); }
    async maybeSingle() { return { data: this.rows()[0] || null, error: null }; }
    then(resolve) { this.rows().forEach((row) => Object.assign(row, this.patch || {})); return resolve({ data: this.rows(), error: null }); }
  }
  return { tables, from: (table) => new Query(table) };
}

test("unavailable match check requires attestation then reuses the ordinary idempotent income poster", async () => {
  const db = dbFixture();
  const discover = async () => ({ status: "match_check_unavailable", posting_eligibility: "blocked_match_check_unavailable" });
  await assert.rejects(
    recordIncomingDepositAsNewIncome({ db, businessId: "biz-1", bankTransactionId: "payroll-1", selectedQboAccountId: "sales", discover, postTransaction: async () => ({ ok: true }) }),
    (error) => error instanceof IncomingDepositMatchError && error.code === "duplicate_override_confirmation_required"
  );
  let calls = 0;
  const result = await recordIncomingDepositAsNewIncome({
    db, businessId: "biz-1", bankTransactionId: "payroll-1", selectedQboAccountId: "sales",
    duplicateOverrideConfirmed: true, actor: "user-1", idempotencyKey: "create-new-income:biz-1:payroll-1", discover,
    postTransaction: async (command) => { calls += 1; assert.equal(command.createNewIncomeOverride, true); return { ok: true, qbo_txn_id: "dep-1", qbo_txn_type: "Deposit" }; },
  });
  assert.equal(result.resolution, "create_new_income");
  assert.equal(calls, 1);
  const row = db.tables.transaction_categorizations[0];
  assert.equal(row.final_qbo_account_id, "sales");
  assert.equal(row.meta.incoming_deposit_resolution.duplicate_check_override, true);
});

test("confirmed candidate cannot be posted as new income and a durable receipt reconciles without QBO create", async () => {
  const db = dbFixture();
  let calls = 0;
  await assert.rejects(recordIncomingDepositAsNewIncome({
    db, businessId: "biz-1", bankTransactionId: "payroll-1", selectedQboAccountId: "sales", duplicateOverrideConfirmed: true,
    discover: async () => ({ status: "needs_confirmation", posting_eligibility: "blocked_confirmation_required" }),
    postTransaction: async () => { calls += 1; },
  }), (error) => error.code === "confirmed_qbo_duplicate_requires_match");
  assert.equal(calls, 0);

  const receiptDb = dbFixture({ receipt: { business_id: "biz-1", transaction_id: "payroll-1", status: "posted", qbo_txn_id: "existing-1", qbo_txn_type: "Deposit" } });
  const result = await recordIncomingDepositAsNewIncome({ db: receiptDb, businessId: "biz-1", bankTransactionId: "payroll-1", selectedQboAccountId: "sales", postTransaction: async () => { calls += 1; } });
  assert.equal(result.already_posted, true);
  assert.equal(result.qbo_txn_id, "existing-1");
  assert.equal(calls, 0);
});

test("Books Review exposes transaction-keyed create-new-income controls and explicit API resolution", () => {
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
  const client = read("src/services/bookkeeping/bookkeepingClient.js");
  const route = read("src/api/bookkeeping/routes/bookkeeping.incomingDepositMatches.routes.js");
  assert.match(feed, /Record as new income/);
  assert.match(feed, /Post as new income/);
  assert.match(feed, /I confirmed this income is not already recorded in QuickBooks/);
  assert.match(feed, /accounts=\{incomeAccounts\}/);
  assert.match(client, /resolution: "create_new_income"/);
  assert.match(route, /record-new-income/);
});
