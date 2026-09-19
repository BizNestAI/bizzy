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
  markLoanPaymentSplitPosted,
  recordLoanPaymentRegularOverride,
  validateLoanPaymentSplit,
} from "../src/services/bookkeeping/loanPaymentWorkflow.js";
import {
  buildSplitTransactionQboPayload,
  confirmSplitTransaction,
  validateSplitTransaction,
} from "../src/services/bookkeeping/splitTransactionWorkflow.js";
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

test("general split transaction validates exact cents and builds one QBO split purchase", () => {
  const accounts = new Map([
    ["repairs-1", { id: "repairs-1", type: "Expense", name: "Repairs" }],
    ["supplies-1", { id: "supplies-1", type: "Expense", name: "Supplies" }],
  ]);
  const split = {
    lines: [
      { description: "Repairs", amount_minor: 30000, qbo_account_id: "repairs-1" },
      { description: "Supplies", amount_minor: 21755, qbo_account_id: "supplies-1" },
    ],
  };
  const validation = validateSplitTransaction({ transaction: alliantTxn, split, accountsById: accounts });
  assert.equal(validation.expected_amount_minor, 51755);
  assert.equal(validation.lines.length, 2);

  assert.throws(
    () => validateSplitTransaction({ transaction: alliantTxn, split: { lines: [split.lines[0]] }, accountsById: accounts }),
    /split_transaction_requires_two_lines/
  );
  assert.throws(
    () => validateSplitTransaction({ transaction: alliantTxn, split: { lines: [{ ...split.lines[0], amount_minor: 51755 }, { description: "Missing", amount_minor: 0 }] }, accountsById: accounts }),
    /split_transaction_requires_two_lines/
  );
  assert.throws(
    () => validateSplitTransaction({ transaction: alliantTxn, split: { lines: [{ ...split.lines[0], amount_minor: 30000 }, { description: "No account", amount_minor: 21755 }] }, accountsById: accounts }),
    /split_transaction_line_missing_account/
  );

  const payload = buildSplitTransactionQboPayload({
    transaction: alliantTxn,
    mapping: { qbo_account_id: "bank-1", qbo_account_type: "Bank" },
    requestId: "req-split-1",
    split,
  });
  assert.equal(payload.Line.length, 2);
  assert.deepEqual(payload.Line.map((line) => line.Amount), [300, 217.55]);
});

test("general split confirmation persists allocation without lender learning", async () => {
  const db = createLoanWorkflowDbStub();
  const result = await confirmSplitTransaction({
    db,
    businessId: "biz-1",
    transaction: alliantTxn,
    accountsById: new Map([
      ["repairs-1", { id: "repairs-1", type: "Expense", name: "Repairs" }],
      ["supplies-1", { id: "supplies-1", type: "Expense", name: "Supplies" }],
    ]),
    split: {
      lines: [
        { description: "Repairs", amount_minor: 30000, qbo_account_id: "repairs-1" },
        { description: "Supplies", amount_minor: 21755, qbo_account_id: "supplies-1" },
      ],
    },
  });
  assert.equal(result.split.status, "confirmed");
  assert.equal(result.split.lines.length, 2);
  assert.equal(db.inserts.some((entry) => entry.table === "transaction_splits"), true);
  assert.equal(db.inserts.some((entry) => entry.table === "loan_lender_profiles"), false);
});

test("learned lender helpers exist for tenant-scoped profile matching, confirmation, and override audit", () => {
  assert.equal(typeof findActiveLenderProfileForTransaction, "function");
  assert.equal(typeof confirmLoanPaymentSplit, "function");
  assert.equal(typeof markLoanPaymentSplitPosted, "function");
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

  assert.throws(
    () => validateLoanPaymentSplit({
      transaction: alliantTxn,
      accountsById: new Map([["other-liability", { id: "other-liability", type: "Long Term Liability" }]]),
      split: { principal_amount_minor: 51755, principal_qbo_account_id: "missing-liability" },
    }),
    /loan_split_line_account_not_found/
  );

  assert.throws(
    () => validateLoanPaymentSplit({
      transaction: alliantTxn,
      split: {
        principal_amount_minor: 50000,
        principal_qbo_account_id: "liability-1",
        interest_amount_minor: 1755,
        interest_qbo_account_id: null,
      },
    }),
    /loan_split_line_missing_account/
  );
});

function createLoanWorkflowDbStub() {
  const inserts = [];
  const updates = [];
  const audits = [];
  return {
    inserts,
    updates,
    audits,
    from(table) {
      const state = { table, op: "select", payload: null };
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        insert(payload) {
          state.op = "insert";
          state.payload = payload;
          inserts.push({ table, payload });
          if (table === "loan_payment_audit_events") audits.push(payload);
          return chain;
        },
        update(payload) {
          state.op = "update";
          state.payload = payload;
          updates.push({ table, payload });
          return chain;
        },
        maybeSingle: async () => {
          if (state.table === "loan_lender_profiles" && state.op === "insert") return { data: { id: "profile-1", ...state.payload }, error: null };
          if (state.table === "loan_lender_profiles" && state.op === "update") return { data: { id: "profile-existing", ...state.payload }, error: null };
          if (state.table === "loan_payment_splits" && state.op === "insert") return { data: { id: "split-1", ...state.payload }, error: null };
          if (state.table === "transaction_splits" && state.op === "insert") return { data: { id: "txn-split-1", ...state.payload }, error: null };
          if (state.table === "loan_payment_audit_events") return { data: { id: "audit-1" }, error: null };
          return { data: null, error: null };
        },
      };
      return chain;
    },
  };
}

test("loan split confirmation learns lender defaults from transaction identity without visible loan fields", async () => {
  const db = createLoanWorkflowDbStub();

  const result = await confirmLoanPaymentSplit({
    db,
    businessId: "biz-1",
    transaction: { ...alliantTxn, merchant_entity_id: "plaid-alliant-merchant", plaid_account_id: "plaid-account-1" },
    accountsById: new Map([
      ["liability-1", { id: "liability-1", type: "Long Term Liability" }],
      ["interest-1", { id: "interest-1", type: "Expense" }],
      ["fee-1", { id: "fee-1", type: "Expense" }],
    ]),
    split: {
      principal_amount_minor: 50000,
      principal_qbo_account_id: "liability-1",
      interest_amount_minor: 1655,
      interest_qbo_account_id: "interest-1",
      fee_lines: [{ label: "Fee", amount_minor: 100, qbo_account_id: "fee-1" }],
    },
  });

  assert.equal(result.lenderProfile.id, "profile-1");
  assert.equal(result.lenderProfile.provider_merchant_id, "plaid-alliant-merchant");
  assert.equal(result.lenderProfile.default_principal_qbo_account_id, "liability-1");
  assert.equal(result.lenderProfile.default_interest_qbo_account_id, "interest-1");
  assert.equal(result.lenderProfile.default_fee_qbo_account_id, "fee-1");
  assert.equal(result.split.lender_profile_id, "profile-1");
  assert.equal(result.split.meta.lender_learning_skipped, false);
  assert.ok(db.audits.some((audit) => audit.event_type === "lender_profile_created"));
  assert.ok(db.audits.some((audit) => audit.event_type === "split_confirmed"));
});

test("loan split confirmation still succeeds and audits skipped learning when identity is insufficient", async () => {
  const db = createLoanWorkflowDbStub();

  const result = await confirmLoanPaymentSplit({
    db,
    businessId: "biz-1",
    transaction: {
      id: "weak-1",
      name: "ONLINE PAYMENT",
      merchant_name: "",
      direction: "OUTFLOW",
      amount: -100,
      signed_amount: -100,
      pending: false,
      date: "2026-08-31",
    },
    accountsById: new Map([["liability-1", { id: "liability-1", type: "Long Term Liability" }]]),
    split: {
      principal_amount_minor: 10000,
      principal_qbo_account_id: "liability-1",
      interest_amount_minor: 0,
      interest_qbo_account_id: null,
      fee_lines: [],
    },
  });

  assert.equal(result.lenderProfile, null);
  assert.equal(result.split.lender_profile_id, null);
  assert.equal(result.split.meta.lender_learning_skipped, true);
  assert.equal(result.split.meta.lender_learning_skip_reason, "insufficient_transaction_identity");
  assert.equal(db.inserts.some((entry) => entry.table === "loan_lender_profiles"), false);
  assert.ok(db.audits.some((audit) => audit.event_type === "lender_profile_learning_skipped"));
  assert.ok(db.audits.some((audit) => audit.event_type === "split_confirmed"));
});

test("manual first-time loan split can still provide loan-specific identity without classifier recognition", async () => {
  const db = {
    from(table) {
      const state = { table, op: "select", payload: null };
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        insert(payload) {
          state.op = "insert";
          state.payload = payload;
          return chain;
        },
        update(payload) {
          state.op = "update";
          state.payload = payload;
          return chain;
        },
        maybeSingle: async () => {
          if (state.table === "loan_lender_profiles" && state.op === "insert") return { data: { id: "profile-1", ...state.payload }, error: null };
          if (state.table === "loan_payment_splits" && state.op === "insert") return { data: { id: "split-1", ...state.payload }, error: null };
          if (state.table === "loan_payment_audit_events") return { data: { id: "audit-1" }, error: null };
          return { data: null, error: null };
        },
      };
      return chain;
    },
  };

  const result = await confirmLoanPaymentSplit({
    db,
    businessId: "biz-1",
    transaction: { ...alliantTxn, name: "ONLINE PAYMENT 1918", merchant_name: "" },
    accountsById: new Map([
      ["liability-1", { id: "liability-1", type: "Long Term Liability" }],
      ["interest-1", { id: "interest-1", type: "Expense" }],
    ]),
    split: {
      lender_name: "Alliant Credit Union",
      loan_name: "Alliant Auto Loan - ending 1918",
      reference_last_four: "1918",
      expected_cadence: "monthly",
      principal_amount_minor: 50000,
      principal_qbo_account_id: "liability-1",
      interest_amount_minor: 1755,
      interest_qbo_account_id: "interest-1",
      remember_profile: true,
    },
  });

  assert.equal(result.lenderProfile.id, "profile-1");
  assert.equal(result.lenderProfile.lender_display_name, "Alliant Auto Loan - ending 1918");
  assert.equal(result.lenderProfile.meta.loan_name, "Alliant Auto Loan - ending 1918");
  assert.equal(result.split.meta.reference_last_four, "1918");
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
  assert.match(worker, /postSplitTransactionPurchase/);
  assert.match(worker, /fetchConfirmedSplitTransaction/);
  assert.match(worker, /markSplitTransactionPosted/);
});

test("Books Review account dropdown exposes a manual loan split workflow safely", () => {
  const feed = read("src/components/Accounting/BookkeepingFeed.jsx");
  const mirror = read("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx");
  const modal = read("src/components/Accounting/SplitTransactionModal.jsx");
  const monthlyReview = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  const client = read("src/services/bookkeeping/bookkeepingClient.js");
  const approvals = read("src/api/bookkeeping/routes/bookkeeping.approvals.routes.js");
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  const splitService = read("src/services/bookkeeping/splitTransactionWorkflow.js");
  const migration = read("supabase/migrations/20261014_transaction_split_workflow.sql");

  assert.match(feed, /Split transaction/);
  assert.match(feed, /Split as loan payment/);
  assert.match(feed, /onUseCreditCardPayment[\s\S]*Match as credit card payment[\s\S]*onUseSplitTransaction[\s\S]*Split transaction[\s\S]*onUseLoanPayment[\s\S]*Split as loan payment/);
  assert.match(feed, /function isEligibleForManualLoanSplit/);
  assert.match(feed, /function isEligibleForManualSplit/);
  assert.match(feed, /txn\.pending === true/);
  assert.match(feed, /status === "posted" \|\| txn\.qbo_txn_id/);
  assert.match(feed, /signedAmount < 0/);
  assert.match(feed, /workflow === "loan_payment"/);
  assert.match(feed, /SplitTransactionModal/);
  assert.match(feed, /buildInitialSplitTransactionDraft\("general", txn, accounts\)/);
  assert.match(feed, /buildInitialLoanSplitDraft\(txn, accounts\)/);
  assert.match(feed, /onConfirmLoanPaymentSplit/);
  assert.match(feed, /onConfirmSplitTransaction/);
  assert.match(feed, /onTreatLoanPaymentAsRegular/);
  assert.doesNotMatch(feed, /function LoanPaymentSplitEditor/);
  assert.doesNotMatch(feed, /min-w-\[420px\] max-w-\[680px\]/);

  assert.match(mirror, /BookkeepingTransactionMirrorRow/);
  assert.match(mirror, /onUseCreditCardPayment[\s\S]*onUseSplitTransaction[\s\S]*onUseLoanPayment/);
  assert.match(mirror, /onUseLoanPayment=\{canUseLoanSplit \? startLoanSplit : null\}/);
  assert.match(mirror, /SplitTransactionModal/);
  assert.match(mirror, /buildInitialSplitTransactionDraft\("general", row, accounts\)/);
  assert.match(mirror, /buildInitialLoanSplitDraft\(row, accounts\)/);
  assert.doesNotMatch(mirror, /LoanPaymentSplitEditor/);
  assert.doesNotMatch(mirror, /Split loan payment[\s\S]*Principal[\s\S]*Interest/);
  assert.doesNotMatch(mirror, /function findDefaultInterestAccountId/);
  assert.match(mirror, /isEligibleForMirrorLoanSplit/);
  assert.match(mirror, /row\.pending === true/);
  assert.match(mirror, /status === "posted" \|\| row\.qbo_txn_id/);
  assert.match(mirror, /isOutflow/);
  assert.match(mirror, /!isActionBusy\("approve"\)/);
  assert.match(mirror, /Loan split review/);
  assert.match(monthlyReview, /handleMirrorConfirmLoanPaymentSplit/);
  assert.match(monthlyReview, /handleMirrorConfirmSplitTransaction/);
  assert.match(monthlyReview, /handleMirrorTreatLoanPaymentAsRegular/);
  assert.match(monthlyReview, /onConfirmLoanPaymentSplit=\{handleMirrorConfirmLoanPaymentSplit\}/);
  assert.match(monthlyReview, /onConfirmSplitTransaction=\{handleMirrorConfirmSplitTransaction\}/);
  assert.match(monthlyReview, /onTreatLoanPaymentAsRegular=\{handleMirrorTreatLoanPaymentAsRegular\}/);

  assert.match(modal, /export default function SplitTransactionModal/);
  assert.match(modal, /mode = "general"/);
  assert.match(modal, /Loan payment/);
  assert.match(modal, /Split transaction/);
  assert.match(modal, /ReactDOM\.createPortal/);
  assert.match(modal, /document\.body/);
  assert.match(modal, /role="dialog"/);
  assert.match(modal, /aria-modal="true"/);
  assert.match(modal, /w-\[min\(900px,calc\(100vw-32px\)\)\]/);
  assert.match(modal, /max-h-\[calc\(100vh-48px\)\]/);
  assert.match(modal, /items-center justify-center/);
  assert.match(modal, /min-h-0 flex-1 overflow-y-auto/);
  assert.match(modal, /shrink-0 border-t/);
  assert.match(modal, /z-\[10020\]/);
  assert.doesNotMatch(modal, /absolute right-0 top-0/);
  assert.doesNotMatch(modal, /max-w-\[min\(700px,92vw\)\]/);
  assert.match(modal, /Transaction total/);
  assert.match(modal, /Allocated/);
  assert.match(modal, /Remaining/);
  assert.doesNotMatch(modal, /Loan details/);
  assert.doesNotMatch(modal, /Set up new loan/);
  assert.doesNotMatch(modal, /Lender name/);
  assert.doesNotMatch(modal, /Loan name\/identifier/);
  assert.doesNotMatch(modal, /Last four\/reference/);
  assert.doesNotMatch(modal, /Expected cadence/);
  assert.doesNotMatch(modal, /Remember this loan and description/);
  assert.match(modal, /Payment allocation/);
  assert.match(modal, /QuickBooks account/);
  assert.match(modal, /Add another line/);
  assert.match(modal, /Payment fully allocated/);
  assert.match(modal, /Allocation exceeds the payment by/);
  assert.match(modal, /remains to be allocated/);
  assert.match(modal, /Enter at least two allocation lines/);
  assert.match(modal, /Select a QuickBooks account for every nonzero line/);
  assert.match(modal, /Confirm split/);
  assert.match(modal, /Saving\.\.\./);
  assert.match(modal, /setSaving\(true\)/);
  assert.match(modal, /disabled=\{!canConfirm\}/);
  assert.match(modal, /remainingMinor === 0/);
  assert.match(modal, /nonzeroLines\.length >= 2/);
  assert.match(modal, /findSafeDefaultInterestAccountId/);
  assert.match(modal, /isExactInterestExpenseAccount/);
  assert.doesNotMatch(modal, /find\(\(account\) => isLoanInterestAccountOption\(account\)\)/);
  assert.doesNotMatch(modal, /Alcohol\/Nightlife/);

  assert.match(client, /confirmSplitTransaction/);
  assert.match(client, /confirmLoanPaymentSplit/);
  assert.match(client, /treatLoanPaymentAsRegularTransaction/);
  assert.match(approvals, /transactions\/:transactionId\/confirm-split/);
  assert.match(approvals, /confirmSplitTransaction/);
  assert.match(approvals, /taxonomy_type:\s*"split_transaction"/);
  assert.match(approvals, /loan-payments\/:transactionId\/confirm-split/);
  assert.match(approvals, /confirmLoanPaymentSplit/);
  assert.match(approvals, /taxonomy_type:\s*"loan_payment"/);
  assert.match(approvals, /loan_payment_split_status:\s*"confirmed"/);
  assert.match(approvals, /status:\s*"needs_review"/);
  assert.match(approvals, /post_after:\s*null/);
  assert.match(approvals, /transaction_already_posted/);
  assert.match(approvals, /loan-payments\/:transactionId\/treat-as-regular/);
  assert.match(page, /handleConfirmSplitTransaction/);
  assert.match(page, /handleConfirmLoanPaymentSplit/);
  assert.match(page, /handleTreatLoanPaymentAsRegular/);
  assert.match(splitService, /export function validateSplitTransaction/);
  assert.match(splitService, /export async function confirmSplitTransaction/);
  assert.match(splitService, /buildSplitTransactionQboPayload/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.transaction_splits/i);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS transaction_splits_one_confirmed_per_txn_idx/i);
});

test("posting worker marks confirmed loan split posted only after QBO receipt", () => {
  const worker = read("src/jobs/booksPost.cron.js");
  assert.match(worker, /recordQboPostingSuccess/);
  assert.match(worker, /markLoanPaymentSplitPosted/);
  assert.match(worker, /postedAt:\s*postedIso/);
  const successIndex = worker.indexOf("recordQboPostingSuccess");
  const splitPostedIndex = worker.indexOf("markLoanPaymentSplitPosted", successIndex);
  assert.ok(successIndex >= 0 && splitPostedIndex > successIndex);
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
