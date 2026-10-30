import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPECTED_TAX_WORKSPACE_V2_AMOUNT_CONTRACT,
  validateTaxWorkspaceV2AmountContract,
} from "../scripts/tax/taxWorkspaceV2AmountContract.js";

function correctedPayload() {
  return {
    amountContractVersion: "signed-treatment-amounts-v1",
    matrixIncludedCount: 690,
    estimatedDeductibleAmount: 8849.64,
    matrix: [{
      transactionCount: 690,
      months: {
        "2026-10": {
          transactionCount: 690,
          estimatedTransactionCount: 276,
          reviewedTransactionCount: 43,
          needsInputTransactionCount: 371,
          bookExpenseAmount: 33820.21,
          estimatedDeductibleAmount: 8491.04,
          reviewedDeductibleAmount: 358.60,
          deductibleAmount: 8849.64,
          needsInputGrossExpense: 23310.81,
          needsReviewAmount: 23310.81,
        },
      },
    }],
  };
}

test("corrected v2 canary amounts reconcile from signed persisted month aggregates", () => {
  assert.deepEqual(validateTaxWorkspaceV2AmountContract(correctedPayload()), {
    transactionCount: 690,
    estimatedDeductibleAmount: 8491.04,
    reviewedDeductibleAmount: 358.60,
    deductibleAmount: 8849.64,
    needsInputGrossExpense: 23310.81,
    bookExpenseAmount: 33820.21,
  });
  assert.equal(EXPECTED_TAX_WORKSPACE_V2_AMOUNT_CONTRACT.deductibleAmount, 8849.64);
});

test("amount validation fails closed for missing, non-finite, incorrectly signed, and non-reconciling fields", () => {
  const mutations = [
    (payload) => { delete payload.matrix[0].months["2026-10"].needsInputGrossExpense; },
    (payload) => { payload.matrix[0].months["2026-10"].bookExpenseAmount = Number.NaN; },
    (payload) => { payload.matrix[0].months["2026-10"].needsInputGrossExpense *= -1; payload.matrix[0].months["2026-10"].needsReviewAmount *= -1; },
    (payload) => { payload.matrix[0].months["2026-10"].reviewedDeductibleAmount += 1; },
    (payload) => { payload.matrix[0].months["2026-10"].transactionCount -= 1; },
  ];
  for (const mutate of mutations) {
    const payload = correctedPayload();
    mutate(payload);
    assert.throws(() => validateTaxWorkspaceV2AmountContract(payload), /AMOUNT CONTRACT FAILED/);
  }
});
