import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isCostTransaction,
  isRevenueTransaction,
} from "../src/services/jobCosting/accountClassification.js";

describe("job costing account classification", () => {
  test("prefers structured account type over transaction direction for revenue", () => {
    const transaction = { direction: "OUTFLOW", amount: -100 };
    const categorization = {
      final_qbo_account_name: "Miscellaneous",
      qbo_account_type: "Income",
    };

    assert.equal(isRevenueTransaction(transaction, categorization), true);
    assert.equal(isCostTransaction(transaction, categorization), false);
  });

  test("prefers structured account type over transaction direction for costs", () => {
    const transaction = { direction: "INFLOW", amount: 100 };
    const categorization = {
      final_qbo_account_name: "Customer Refund",
      account_type: "Cost of Goods Sold",
    };

    assert.equal(isCostTransaction(transaction, categorization), true);
    assert.equal(isRevenueTransaction(transaction, categorization), false);
  });

  test("falls back to existing direction and account-name heuristics", () => {
    assert.equal(isRevenueTransaction({ direction: "INFLOW" }, {}), true);
    assert.equal(isCostTransaction({ direction: "OUTFLOW" }, {}), true);
    assert.equal(isRevenueTransaction({}, { final_qbo_account_name: "Construction Income" }), true);
    assert.equal(isCostTransaction({}, { final_qbo_account_name: "Materials COGS" }), true);
  });
});
