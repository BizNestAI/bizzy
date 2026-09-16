import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import {
  addCalendarDays,
  getAccountingDateFromBankTransaction,
  normalizePlaidAuthorizedDate,
  normalizePlaidPostedDate,
} from "../src/services/bookkeeping/accountingDatePolicy.js";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

function read(rel) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

function mappingDb(row = { qbo_account_id: "cc-1008", qbo_account_name: "Blue Cash", qbo_account_type: "CreditCard" }) {
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    limit: () => query,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return {
    from: () => query,
  };
}

test("accounting date is Plaid posted date, not authorized or processing dates", () => {
  const bankTxn = {
    date: "2026-09-07",
    authorized_date: "2026-09-05",
    created_at: "2026-09-10T14:22:00.000Z",
    posted_at: "2026-09-11T09:30:00.000Z",
  };

  assert.equal(getAccountingDateFromBankTransaction(bankTxn), "2026-09-07");
  assert.equal(normalizePlaidPostedDate("2026-09-07"), "2026-09-07");
  assert.equal(normalizePlaidAuthorizedDate("2026-09-05"), "2026-09-05");
});

test("missing Plaid posted date fails closed instead of falling back to timestamps", () => {
  assert.throws(
    () => getAccountingDateFromBankTransaction({
      authorized_date: "2026-09-05",
      created_at: "2026-09-10T14:22:00.000Z",
      updated_at: "2026-09-10T14:23:00.000Z",
    }),
    /missing_plaid_posted_date/
  );
});

test("calendar date math preserves date-only values", () => {
  assert.equal(addCalendarDays("2026-03-08", -1), "2026-03-07");
  assert.equal(addCalendarDays("2026-11-01", 1), "2026-11-02");
});

test("duplicate preflight queries QuickBooks around posted date only", async () => {
  const { runLiveDuplicatePreflight } = await import("../src/services/bookkeeping/qboDuplicatePreflightService.js");
  let capturedCriteria = null;
  const result = await runLiveDuplicatePreflight({
    businessId: "biz-1",
    db: mappingDb(),
    bankTxn: {
      plaid_account_id: "plaid-card",
      date: "2026-09-07",
      authorized_date: "2026-09-05",
      amount: -8,
      merchant_name: "Amazon Prime",
    },
    getQboClient: async () => ({
      findPurchases(criteria, cb) {
        capturedCriteria = criteria;
        cb(null, { QueryResponse: { Purchase: [] } });
      },
    }),
  });

  assert.equal(result.confidence, "NO_MATCH");
  assert.deepEqual(capturedCriteria.slice(0, 2), [
    { field: "TxnDate", operator: ">=", value: "2026-09-04" },
    { field: "TxnDate", operator: "<=", value: "2026-09-10" },
  ]);
});

test("duplicate preflight reports missing accounting date without calling QuickBooks", async () => {
  const { runLiveDuplicatePreflight } = await import("../src/services/bookkeeping/qboDuplicatePreflightService.js");
  let qboCalled = false;
  const result = await runLiveDuplicatePreflight({
    businessId: "biz-1",
    db: mappingDb(),
    bankTxn: {
      plaid_account_id: "plaid-card",
      authorized_date: "2026-09-05",
      amount: -8,
      merchant_name: "Amazon Prime",
    },
    getQboClient: async () => {
      qboCalled = true;
      return {};
    },
  });

  assert.equal(result.confidence, "MISSING_ACCOUNTING_DATE");
  assert.equal(result.reason, "missing_plaid_posted_date");
  assert.equal(qboCalled, false);
});

test("posting worker uses canonical accounting date and has no today fallback for QBO TxnDate", () => {
  const cron = read("src/jobs/booksPost.cron.js");

  assert.match(cron, /getAccountingDateFromBankTransaction\(bankTxn\)/);
  assert.match(cron, /markTransactionNonPostable\(item, "missing_plaid_posted_date"\)/);
  assert.doesNotMatch(cron, /bankTxn\.date \|\| new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
  assert.doesNotMatch(cron, /bankTxn\?\.date \|\| new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
});

test("Plaid ingestion names posted date separately from authorized date", () => {
  const plaidSync = read("src/services/plaid/plaidSyncService.js");

  assert.match(plaidSync, /date: normalizePlaidPostedDate\(tx\.date\)/);
  assert.match(plaidSync, /authorized_date: normalizePlaidAuthorizedDate\(tx\.authorized_date\)/);
  assert.doesNotMatch(plaidSync, /date: tx\.date \|\| null/);
});
