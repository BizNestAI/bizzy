import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import {
  buildLoanPaymentPurchasePayload,
  confirmLoanPaymentSplit,
  detectPossibleLoanPayment,
  findActiveLenderProfileForTransaction,
  getLoanPaymentIdentity,
  recordLoanPaymentRegularOverride,
  validateLoanPaymentSplit,
} from "../src/services/bookkeeping/loanPaymentWorkflow.js";
import { classifyTaxonomy } from "../src/services/bookkeeping/taxonomyClassifier.js";
import { getProtectedWorkflowReason } from "../src/services/bookkeeping/protectedWorkflow.js";

function read(rel) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const alliantTxn = {
  id: "alliant-1",
  business_id: "biz-1",
  name: "DEP-PYMT ALLIANT CU 1918 GEB",
  merchant_name: "Alliant CU",
  date: "2026-08-31",
  direction: "OUTFLOW",
  amount: -517.55,
  signed_amount: -517.55,
  pending: false,
};

test("Alliant payment is identified as a protected loan payment, not a routine expense", () => {
  const signal = detectPossibleLoanPayment(alliantTxn);
  assert.equal(signal.taxonomy_type, "loan_payment");
  assert.equal(signal.label, "Possible Loan Payment · Needs Review");
  assert.equal(signal.identity.normalized_lender, "alliant cu");

  const taxonomy = classifyTaxonomy(alliantTxn);
  assert.equal(taxonomy.type, "loan_payment");
  assert.match(taxonomy.notes, /protected split review/);
});

test("lender identity is tenant-safe and specific", () => {
  const providerIdentity = getLoanPaymentIdentity({ ...alliantTxn, merchant_entity_id: "plaid-alliant-merchant" });
  assert.equal(providerIdentity.match_specificity, "exact_provider_lender_id");
  assert.equal(providerIdentity.fingerprint, "provider:plaid-alliant-merchant");

  const weak = getLoanPaymentIdentity({ name: "ONLINE PAYMENT", direction: "OUTFLOW", amount: -100 });
  assert.equal(weak, null);
});

test("loan split requires integer cents that equal the posted outflow", () => {
  const accounts = new Map([
    ["liability-1", { id: "liability-1", type: "Long Term Liability" }],
    ["interest-1", { id: "interest-1", type: "Expense" }],
    ["fee-1", { id: "fee-1", type: "Other Expense" }],
  ]);

  const result = validateLoanPaymentSplit({
    transaction: alliantTxn,
    accountsById: accounts,
    split: {
      principal_amount_minor: 50000,
      principal_qbo_account_id: "liability-1",
      interest_amount_minor: 1655,
      interest_qbo_account_id: "interest-1",
      fee_lines: [{ amount_minor: 100, qbo_account_id: "fee-1" }],
    },
  });

  assert.equal(result.expected_amount_minor, 51755);
  assert.equal(result.lines.length, 3);
});

test("zero-interest payments and fee-only additions still validate by exact cents", () => {
  const result = validateLoanPaymentSplit({
    transaction: alliantTxn,
    split: {
      principal_amount_minor: 51700,
      principal_qbo_account_id: "liability-1",
      interest_amount_minor: 0,
      interest_qbo_account_id: null,
      fee_lines: [{ amount_minor: 55, qbo_account_id: "fee-1" }],
    },
  });
  assert.equal(result.expected_amount_minor, 51755);
  assert.deepEqual(result.lines.map((line) => line.role), ["principal", "fee"]);
});

test("learned lender helpers exist for tenant-scoped profile matching, confirmation, and override audit", () => {
  assert.equal(typeof findActiveLenderProfileForTransaction, "function");
  assert.equal(typeof confirmLoanPaymentSplit, "function");
  assert.equal(typeof recordLoanPaymentRegularOverride, "function");
});

test("loan split fails closed for pending, bad totals, or wrong QBO account type", () => {
  assert.throws(
    () => validateLoanPaymentSplit({
      transaction: { ...alliantTxn, pending: true },
      split: { principal_amount_minor: 51755, principal_qbo_account_id: "liability-1" },
    }),
    /pending_transaction_not_postable/
  );

  assert.throws(
    () => validateLoanPaymentSplit({
      transaction: alliantTxn,
      split: { principal_amount_minor: 51754, principal_qbo_account_id: "liability-1" },
    }),
    /loan_split_total_mismatch/
  );

  assert.throws(
    () => validateLoanPaymentSplit({
      transaction: alliantTxn,
      accountsById: new Map([["expense-1", { id: "expense-1", type: "Expense" }]]),
      split: { principal_amount_minor: 51755, principal_qbo_account_id: "expense-1" },
    }),
    /loan_principal_account_must_be_liability/
  );
});

test("confirmed loan split builds one QBO Purchase with principal and interest lines using posted date", () => {
  const payload = buildLoanPaymentPurchasePayload({
    transaction: alliantTxn,
    mapping: { qbo_account_id: "bank-1", qbo_account_type: "Bank" },
    requestId: "req-1",
    split: {
      principal_amount_minor: 50000,
      principal_qbo_account_id: "loan-liability",
      interest_amount_minor: 1755,
      interest_qbo_account_id: "interest-expense",
    },
  });

  assert.equal(payload.PaymentType, "Cash");
  assert.equal(payload.TxnDate, "2026-08-31");
  assert.equal(payload.Line.length, 2);
  assert.deepEqual(payload.Line.map((line) => line.Amount), [500, 17.55]);
  assert.equal(payload.Line[0].AccountBasedExpenseLineDetail.AccountRef.value, "loan-liability");
  assert.equal(payload.Line[1].AccountBasedExpenseLineDetail.AccountRef.value, "interest-expense");
});

test("protected workflow labels confirmed and unconfirmed loan payments", () => {
  assert.equal(getProtectedWorkflowReason({ meta: { taxonomy_type: "loan_payment" } }).label, "Loan Payment · Needs Split");
  assert.equal(
    getProtectedWorkflowReason({ meta: { taxonomy_type: "loan_payment", loan_payment_split_status: "confirmed" } }).label,
    "Loan Payment · Ready to post"
  );
});

test("posting worker has loan split guard before QBO writes and still blocks pending transactions", () => {
  const worker = read("src/jobs/booksPost.cron.js");
  assert.match(worker, /bank\.pending === true/);
  assert.match(worker, /if \(item\?\.meta\?\.taxonomy_type === "loan_payment"\)[\s\S]*?fetchConfirmedLoanPaymentSplit[\s\S]*?return;/);
  assert.match(worker, /postLoanPaymentSplitPurchase/);
  assert.match(worker, /fetchConfirmedLoanPaymentSplit/);
  assert.match(worker, /loan_payment_split_required/);
  assert.match(worker, /createQboPurchase\(qbo, payload\)/);
});

test("Books Review account dropdown exposes a manual loan split workflow safely", () => {
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
  const client = read("src/services/bookkeeping/bookkeepingClient.js");
  const approvals = read("src/api/bookkeeping/routes/bookkeeping.approvals.routes.js");
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");

  assert.match(feed, /Split as loan payment/);
  assert.match(feed, /onUseCreditCardPayment[\s\S]*Match as credit card payment[\s\S]*onUseLoanPayment[\s\S]*Split as loan payment/);
  assert.match(feed, /function isEligibleForManualLoanSplit/);
  assert.match(feed, /txn\.pending === true/);
  assert.match(feed, /status === "posted" \|\| txn\.qbo_txn_id/);
  assert.match(feed, /signedAmount < 0/);
  assert.match(feed, /workflow === "loan_payment"/);
  assert.match(feed, /function LoanPaymentSplitEditor/);
  assert.match(feed, /Loan Payment · Needs Split/);
  assert.match(feed, /Set up new loan/);
  assert.match(feed, /Liability account/);
  assert.match(feed, /Interest expense account/);
  assert.match(feed, /Confirm split/);
  assert.match(feed, /Treat as regular transaction/);
  assert.match(feed, /isLoanPrincipalAccountOption/);
  assert.match(feed, /longtermliability/);
  assert.match(feed, /othercurrentliability/);
  assert.match(feed, /isLoanInterestAccountOption/);
  assert.match(feed, /canConfirm[\s\S]*balanced/);
  assert.match(feed, /onConfirmLoanPaymentSplit/);
  assert.match(feed, /onTreatLoanPaymentAsRegular/);

  assert.match(client, /confirmLoanPaymentSplit/);
  assert.match(client, /treatLoanPaymentAsRegularTransaction/);
  assert.match(approvals, /loan-payments\/:transactionId\/confirm-split/);
  assert.match(approvals, /confirmLoanPaymentSplit/);
  assert.match(approvals, /taxonomy_type:\s*"loan_payment"/);
  assert.match(approvals, /loan_payment_split_status:\s*"confirmed"/);
  assert.match(approvals, /status:\s*"needs_review"/);
  assert.match(approvals, /post_after:\s*null/);
  assert.match(approvals, /loan-payments\/:transactionId\/treat-as-regular/);
  assert.match(page, /handleConfirmLoanPaymentSplit/);
  assert.match(page, /handleTreatLoanPaymentAsRegular/);
});

test("migration is additive and tenant scoped", () => {
  const migration = read("supabase/migrations/20261013_loan_payment_workflow.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.loan_lender_profiles/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.loan_payment_splits/i);
  assert.match(migration, /business_id uuid NOT NULL REFERENCES public\.business_profiles/i);
  assert.match(migration, /typical_payment_amount_minor bigint/i);
  assert.match(migration, /first_confirmed_at timestamptz/i);
  assert.match(migration, /last_confirmed_at timestamptz/i);
  assert.match(migration, /source_plaid_account_id uuid/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.loan_payment_audit_events/i);
  assert.match(migration, /FOREIGN KEY \(business_id, transaction_id\)/i);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.doesNotMatch(migration, /DROP TABLE|ALTER TABLE public\.bank_transactions DROP|DELETE FROM/i);
});
