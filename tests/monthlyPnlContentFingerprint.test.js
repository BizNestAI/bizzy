import assert from "node:assert/strict";
import test from "node:test";
import { buildMonthlyPnlContentFingerprint } from "../src/services/accounting/monthlyPnlContentFingerprint.js";
import { projectMonthlyReportState } from "../src/services/accounting/monthlyReportStateService.js";

const snapshot = {
  id: "snapshot-a",
  business_id: "business-a",
  qbo_realm_id: "realm-a",
  accounting_method: "Cash",
  source_start_date: "2026-09-01",
  source_end_date: "2026-09-30",
  currency_code: "USD",
  revenue: 1000,
  cogs: 0,
  expenses: 250,
  net_profit: 750,
};
const accounts = [
  { qbo_account_id: "income", account_name: "Services", account_path: "Services", account_type: "Income", total_amount: 1000 },
  { qbo_account_id: "expense", account_name: "Software", account_path: "Software", account_type: "Expense", total_amount: 250 },
];
const transactions = [
  { qbo_txn_id: "1", qbo_txn_type: "Invoice", txn_date: "2026-09-02", qbo_account_id: "income", amount: 1000 },
  { qbo_txn_id: "2", qbo_txn_type: "Purchase", txn_date: "2026-09-03", qbo_account_id: "expense", amount: 250 },
];

const fp = (s = snapshot, a = accounts, t = transactions) => buildMonthlyPnlContentFingerprint({ snapshot: s, accounts: a, transactions: t }).fingerprint;

test("equivalent snapshots ignore UUID, refresh timestamps, property order, and row ordering", () => {
  const equivalent = { ...snapshot, id: "snapshot-b", pulled_at: "2026-10-15T15:00:00Z", created_at: "later" };
  assert.equal(fp(equivalent, [...accounts].reverse(), [...transactions].reverse()), fp());
  const state = projectMonthlyReportState({
    report: { storage_path: "report.pdf", monthly_review_published_at: "now", monthly_review_source_snapshot_id: "snapshot-a", monthly_review_source_fingerprint: fp() },
    sourceSnapshot: snapshot,
    currentSnapshot: equivalent,
    sourceFingerprint: fp(),
    currentFingerprint: fp(equivalent, [...accounts].reverse(), [...transactions].reverse()),
  });
  assert.equal(state.status, "published_current");
});

test("GL reclassification and material September amount/date/add/remove effects invalidate content", () => {
  const reclassified = [{ ...accounts[0], total_amount: 900 }, { ...accounts[1], total_amount: 350 }];
  assert.notEqual(fp(snapshot, reclassified), fp());
  const amountChangedSnapshot = { ...snapshot, expenses: 251, net_profit: 749 };
  const amountChangedAccounts = [accounts[0], { ...accounts[1], total_amount: 251 }];
  assert.notEqual(fp(amountChangedSnapshot, amountChangedAccounts), fp());
  const removedSnapshot = { ...snapshot, revenue: 0, net_profit: -250 };
  assert.notEqual(fp(removedSnapshot, accounts.slice(1)), fp());
  const addedSnapshot = { ...snapshot, expenses: 251, net_profit: 749 };
  assert.notEqual(fp(addedSnapshot, [...accounts, { qbo_account_id: "fees", account_name: "Fees", account_path: "Fees", account_type: "Expense", total_amount: 1 }]), fp());
});

test("basis, month, currency, realm, and business identities are isolated", () => {
  for (const patch of [
    { accounting_method: "Accrual" },
    { source_start_date: "2026-10-01", source_end_date: "2026-10-31" },
    { currency_code: "CAD" },
    { qbo_realm_id: "realm-b" },
    { business_id: "business-b" },
  ]) assert.notEqual(fp({ ...snapshot, ...patch }), fp());
});

test("an October-only transaction cannot invalidate unchanged September P&L content", () => {
  assert.equal(fp({ ...snapshot, provider_refreshed_at: "2026-10-16T00:00:00Z" }, accounts), fp());
});
