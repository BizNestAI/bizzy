import test from "node:test";
import assert from "node:assert/strict";

import {
  TAX_RECONCILIATION_INCOMPLETE_REASON_CODES,
  TAX_RECONCILIATION_BRIDGE_DISPOSITIONS,
  buildTaxReconciliationBridge,
  deriveTaxReconciliationScope,
  deriveTaxReconciliationDisposition,
} from "../src/services/tax/taxReconciliationBridge.js";

function taxRow(id, {
  date = "2026-05-15",
  isEligible = true,
  receipt = true,
  qboAccountId = "expense-account",
  qboAccountName = "Operating expense",
  qboAccountType = "Expense",
  qboAccountSubtype = "Other Business Expenses",
  qboTxnType = "Expense",
  taxonomyType = null,
  signedAmount = -25,
} = {}) {
  return {
    transactionId: id,
    transactionDate: date,
    isEligible,
    signedAmount,
    taxonomyType,
    qboAccountId,
    qboAccountName,
    qboAccountType,
    qboAccountSubtype,
    qboTxnType,
    categorizationQboTxnId: receipt ? `qbo-${id}` : null,
    qboReceiptStatus: receipt ? "posted" : null,
    qboReceiptTxnId: receipt ? `qbo-${id}` : null,
    qboReceiptTxnType: receipt ? qboTxnType : null,
    sourceTruth: { receiptBackedBizziPost: receipt },
  };
}

test("Tax/Reconciliations bridge proves the 709 = 685 + 24 population contract by stable identity", () => {
  const monthlyCounts = [
    ["2026-05", 66],
    ["2026-06", 152],
    ["2026-07", 154],
    ["2026-08", 126],
    ["2026-09", 136],
    ["2026-10", 75],
  ];
  const rows = [];
  let sequence = 0;
  for (const [month, count] of monthlyCounts) {
    for (let index = 0; index < count; index += 1) {
      sequence += 1;
      rows.push(taxRow(`posted-${sequence}`, { date: `${month}-15` }));
    }
  }

  // Replace 24 otherwise-expense rows with deliberately non-deduction QBO
  // dispositions. The source total and stable IDs stay unchanged.
  const outside = [
    ...Array.from({ length: 8 }, (_, index) => taxRow(`posted-${index + 1}`, { qboAccountId: `income-${index}`, qboAccountName: "Sales income", qboAccountType: "Income", qboTxnType: "Deposit", signedAmount: 100 })),
    ...Array.from({ length: 6 }, (_, index) => taxRow(`posted-${index + 9}`, { qboAccountId: `card-${index}`, qboAccountName: "Credit card", qboAccountType: "Credit Card", qboTxnType: "CreditCardPayment", taxonomyType: "cc_payment" })),
    ...Array.from({ length: 3 }, (_, index) => taxRow(`posted-${index + 15}`, { qboAccountId: `equity-${index}`, qboAccountName: "Owner draw", qboAccountType: "Equity" })),
    ...Array.from({ length: 2 }, (_, index) => taxRow(`posted-${index + 18}`, { qboAccountId: `refund-${index}`, qboAccountName: "Expense refund", qboAccountType: "Expense", qboTxnType: "RefundReceipt", signedAmount: 25 })),
    ...Array.from({ length: 3 }, (_, index) => taxRow(`posted-${index + 20}`, { qboAccountId: `asset-${index}`, qboAccountName: "Equipment asset", qboAccountType: "Fixed Asset" })),
    ...Array.from({ length: 2 }, (_, index) => taxRow(`posted-${index + 23}`, { qboAccountId: null, qboAccountName: null, qboAccountType: null })),
  ];
  const byId = new Map(outside.map((row) => [row.transactionId, row]));
  const sourceRows = rows.map((row) => byId.get(row.transactionId) || row);

  const bridge = buildTaxReconciliationBridge({ sourceRows });
  const { identity_comparison: identity, tax_scope: scope } = bridge;

  assert.equal(identity.reconciliations_posted_by_bizzi_count, 709);
  assert.equal(identity.tax_eligible_count, 709);
  assert.equal(identity.identity_match, true);
  assert.equal(scope.posted_transactions_evaluated_count, 709);
  assert.equal(scope.deductions_matrix_expense_count, 685);
  assert.equal(scope.posted_non_expense_outside_deductions_count, 24);
  assert.equal(scope.conservation_ok, true);
  assert.deepEqual(scope.dispositions, {
    expense_cogs_in_matrix: 685,
    income_outside_deductions: 8,
    transfer_or_card_payment_not_deduction: 6,
    owner_or_equity_not_deduction: 3,
    refund_credit_or_asset_not_deduction: 5,
    incomplete_or_unresolved: 2,
  });
  assert.equal(scope.months.reduce((sum, month) => sum + month.tax_evaluated_count, 0), 709);
  assert.equal(scope.months.reduce((sum, month) => sum + month.deductions_matrix_expense_count + month.posted_non_expense_outside_deductions_count, 0), 709);
});

test("Tax/Reconciliations bridge rejects equal aggregate counts with different stable transaction IDs", () => {
  const bridge = buildTaxReconciliationBridge({
    sourceRows: [
      taxRow("receipt-only", { isEligible: false }),
      taxRow("tax-only", { receipt: false, isEligible: true }),
    ],
  });

  assert.equal(bridge.identity_comparison.reconciliations_posted_by_bizzi_count, 1);
  assert.equal(bridge.identity_comparison.tax_eligible_count, 1);
  assert.equal(bridge.identity_comparison.identity_match, false);
  assert.equal(bridge.identity_comparison.only_reconciliations_count, 1);
  assert.equal(bridge.identity_comparison.only_tax_eligible_count, 1);
});

test("Tax/Reconciliations bridge keeps income, payments, refunds, owners, assets, and incomplete QBO evidence outside deductions", () => {
  assert.equal(
    deriveTaxReconciliationDisposition(taxRow("income", { qboAccountType: "Other Income", qboAccountName: "Interest income", signedAmount: 10 })),
    TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.INCOME_OUTSIDE_DEDUCTIONS
  );
  assert.equal(
    deriveTaxReconciliationDisposition(taxRow("payment", { qboAccountType: "Credit Card", qboAccountName: "Business card", taxonomyType: "credit_card_payment" })),
    TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.TRANSFER_OR_CARD_PAYMENT_NOT_DEDUCTION
  );
  assert.equal(
    deriveTaxReconciliationDisposition(taxRow("refund", { qboTxnType: "VendorCredit", signedAmount: 10 })),
    TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.REFUND_CREDIT_OR_ASSET_NOT_DEDUCTION
  );
  assert.equal(
    deriveTaxReconciliationDisposition(taxRow("owner", { qboAccountType: "Equity", qboAccountName: "Member contribution" })),
    TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.OWNER_OR_EQUITY_NOT_DEDUCTION
  );
  assert.equal(
    deriveTaxReconciliationDisposition(taxRow("asset", { qboAccountType: "Fixed Asset", qboAccountName: "Equipment" })),
    TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.REFUND_CREDIT_OR_ASSET_NOT_DEDUCTION
  );
  assert.equal(
    deriveTaxReconciliationDisposition(taxRow("incomplete", { qboAccountId: null, qboAccountName: null, qboAccountType: null })),
    TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.INCOMPLETE_OR_UNRESOLVED
  );
});

test("Tax/Reconciliations bridge gives genuinely incomplete QBO evidence a safe, specific reason", () => {
  const missingType = deriveTaxReconciliationScope(taxRow("missing-type", {
    qboAccountId: "expense-account",
    qboAccountName: "Software",
    qboAccountType: null,
  }));
  assert.deepEqual(missingType, {
    disposition: TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.INCOMPLETE_OR_UNRESOLVED,
    reasonCode: TAX_RECONCILIATION_INCOMPLETE_REASON_CODES.MISSING_DESTINATION_GL_TYPE,
  });

  const bridge = buildTaxReconciliationBridge({
    sourceRows: [taxRow("missing-type", {
      qboAccountId: "expense-account",
      qboAccountName: "Software",
      qboAccountType: null,
    })],
  });
  assert.deepEqual(bridge.tax_scope.incomplete_evidence_reasons, {
    [TAX_RECONCILIATION_INCOMPLETE_REASON_CODES.MISSING_DESTINATION_GL_TYPE]: 1,
  });
});
