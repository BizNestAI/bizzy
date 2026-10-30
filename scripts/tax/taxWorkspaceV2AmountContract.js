export const EXPECTED_TAX_WORKSPACE_V2_AMOUNT_CONTRACT = Object.freeze({
  amountContractVersion: "signed-treatment-amounts-v1",
  estimatedDeductibleAmount: 8491.04,
  reviewedDeductibleAmount: 358.60,
  deductibleAmount: 8849.64,
  needsInputGrossExpense: 23310.81,
  bookExpenseAmount: 33820.21,
});

export function validateTaxWorkspaceV2AmountContract(payload, expected = EXPECTED_TAX_WORKSPACE_V2_AMOUNT_CONTRACT) {
  assert(payload?.amountContractVersion === expected.amountContractVersion, "amount contract version mismatch");
  assert(Array.isArray(payload?.matrix), "matrix must be an array");

  const totals = emptyTotals();
  for (const category of payload.matrix) {
    assert(category && typeof category === "object" && !Array.isArray(category), "matrix category must be an object");
    assert(category.months && typeof category.months === "object" && !Array.isArray(category.months), "matrix category months must be an object");
    let categoryTransactionCount = 0;
    for (const month of Object.values(category.months)) {
      assert(month && typeof month === "object" && !Array.isArray(month), "matrix month must be an object");
      for (const field of AMOUNT_FIELDS) assertFiniteOwn(month, field);
      for (const field of COUNT_FIELDS) assertNonnegativeIntegerOwn(month, field);

      const treatmentCount = month.estimatedTransactionCount + month.reviewedTransactionCount + month.needsInputTransactionCount;
      assert(treatmentCount === month.transactionCount, "monthly treatment counts do not reconcile");
      assert(sameCents(month.deductibleAmount, month.estimatedDeductibleAmount + month.reviewedDeductibleAmount), "monthly deduction amounts do not reconcile");
      assert(sameCents(month.needsReviewAmount, month.needsInputGrossExpense), "monthly signed awaiting-input aliases do not reconcile");

      categoryTransactionCount += month.transactionCount;
      for (const field of AMOUNT_FIELDS) totals[field] += month[field];
      totals.transactionCount += month.transactionCount;
    }
    assert(categoryTransactionCount === category.transactionCount, "category monthly transaction count does not reconcile to YTD");
  }

  for (const field of AMOUNT_FIELDS) totals[field] = cents(totals[field]);
  assert(totals.transactionCount === payload.matrixIncludedCount, "matrix monthly transaction count does not reconcile");
  assert(sameCents(totals.deductibleAmount, totals.estimatedDeductibleAmount + totals.reviewedDeductibleAmount), "YTD deduction amounts do not reconcile");
  assert(sameCents(payload.estimatedDeductibleAmount, totals.deductibleAmount), "top estimate does not reconcile to signed monthly deductions");

  for (const field of ["estimatedDeductibleAmount", "reviewedDeductibleAmount", "deductibleAmount", "needsInputGrossExpense", "bookExpenseAmount"]) {
    assertFiniteOwn(expected, field);
    assert(sameCents(totals[field], expected[field]), `${field} does not match the expected canary aggregate`);
  }

  return Object.freeze({
    transactionCount: totals.transactionCount,
    estimatedDeductibleAmount: totals.estimatedDeductibleAmount,
    reviewedDeductibleAmount: totals.reviewedDeductibleAmount,
    deductibleAmount: totals.deductibleAmount,
    needsInputGrossExpense: totals.needsInputGrossExpense,
    bookExpenseAmount: totals.bookExpenseAmount,
  });
}

const AMOUNT_FIELDS = Object.freeze([
  "bookExpenseAmount",
  "deductibleAmount",
  "estimatedDeductibleAmount",
  "reviewedDeductibleAmount",
  "needsInputGrossExpense",
  "needsReviewAmount",
]);

const COUNT_FIELDS = Object.freeze([
  "transactionCount",
  "estimatedTransactionCount",
  "reviewedTransactionCount",
  "needsInputTransactionCount",
]);

function emptyTotals() {
  return Object.fromEntries([...AMOUNT_FIELDS, "transactionCount"].map((field) => [field, 0]));
}

function assertFiniteOwn(value, field) {
  assert(Object.prototype.hasOwnProperty.call(value || {}, field), `${field} is missing`);
  assert(typeof value[field] === "number" && Number.isFinite(value[field]), `${field} must be a finite signed number`);
}

function assertNonnegativeIntegerOwn(value, field) {
  assert(Object.prototype.hasOwnProperty.call(value || {}, field), `${field} is missing`);
  assert(Number.isInteger(value[field]) && value[field] >= 0, `${field} must be a nonnegative integer`);
}

function sameCents(left, right) {
  return cents(left) === cents(right);
}

function cents(value) {
  return Math.round(Number(value) * 100) / 100;
}

function assert(condition, message) {
  if (!condition) throw new Error(`TAX WORKSPACE V2 AMOUNT CONTRACT FAILED: ${message}`);
}
