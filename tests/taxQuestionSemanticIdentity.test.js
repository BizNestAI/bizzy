import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTaxQuestionIdentity } from "../src/services/tax/taxQuestionSemanticIdentity.js";

const BUSINESS = "business-production-shape";
const YEAR = 2026;

const cases = [
  ["Meals", "business_use_confirmation", "business_meals", { taxTreatment: "ordinary_expense", deductibilityStatus: "partially_deductible", deductiblePercent: 50 }, { taxTreatment: "ordinary_expense", deductibilityStatus: "partially_deductible", deductiblePercent: 50 }],
  ["Gas", "vehicle_method", "vehicle_expense", { taxTreatment: "needs_review", deductibilityStatus: "", deductiblePercent: 0 }, { taxTreatment: "vehicle_expense", deductibilityStatus: "needs_review", deductiblePercent: 0 }],
  ["Parking", "business_use_confirmation", "travel_transportation", { taxTreatment: "needs_review", deductibilityStatus: "", deductiblePercent: 0 }, { taxTreatment: "travel_transportation", deductibilityStatus: "needs_review", deductiblePercent: 0 }],
  ["Lyft/Uber", "business_use_confirmation", "travel_transportation", { taxTreatment: "needs_review", deductibilityStatus: "", deductiblePercent: 0 }, { taxTreatment: "travel_transportation", deductibilityStatus: "needs_review", deductiblePercent: 0 }],
  ["Phone Bill", "business_use_percent", "utilities", { taxTreatment: "needs_review", deductibilityStatus: "", deductiblePercent: 0 }, { taxTreatment: "utilities_review", deductibilityStatus: "needs_review", deductiblePercent: 0 }],
  ["Electric", "business_use_percent", "utilities", { taxTreatment: "needs_review", deductibilityStatus: "", deductiblePercent: 0 }, { taxTreatment: "utilities_review", deductibilityStatus: "needs_review", deductiblePercent: 0 }],
  ["Transportation", "business_use_confirmation", "travel_transportation", { taxTreatment: "needs_review", deductibilityStatus: "", deductiblePercent: 0 }, { taxTreatment: "travel_transportation", deductibilityStatus: "needs_review", deductiblePercent: 0 }],
  ["Utilities", "business_use_percent", "utilities", { taxTreatment: "needs_review", deductibilityStatus: "", deductiblePercent: 0 }, { taxTreatment: "utilities_review", deductibilityStatus: "needs_review", deductiblePercent: 0 }],
];

test("production-shaped projection and live preview rows share one canonical semantic identity", () => {
  const memberships = new Set();
  for (const [label, decisionType, taxCategory, projected, live] of cases) {
    const common = { qboAccountId: `gl-${label}`, qboAccountName: label, taxCategory };
    const stored = buildTaxQuestionIdentity({ businessId: BUSINESS, taxYear: YEAR, decisionType, row: { ...common, ...projected } });
    const recomputed = buildTaxQuestionIdentity({ businessId: BUSINESS, taxYear: YEAR, decisionType, row: { ...common, ...live } });
    assert.equal(recomputed.id, stored.id, `${label} preview identity must resolve its persisted question`);
    memberships.add(stored.id);
  }
  assert.equal(memberships.size, 8);
});

test("semantic identity still fails closed across GL, subject, authority-relevant treatment, and category changes", () => {
  const base = buildTaxQuestionIdentity({ businessId: BUSINESS, taxYear: YEAR, decisionType: "business_use_percent", row: { qboAccountId: "utilities", taxCategory: "utilities", taxTreatment: "utilities_review", deductibilityStatus: "needs_review", deductiblePercent: 0, allocationSubject: "office" } }).id;
  for (const row of [
    { qboAccountId: "other", taxCategory: "utilities", taxTreatment: "utilities_review", deductibilityStatus: "needs_review", deductiblePercent: 0, allocationSubject: "office" },
    { qboAccountId: "utilities", taxCategory: "utilities", taxTreatment: "utilities_review", deductibilityStatus: "needs_review", deductiblePercent: 0, allocationSubject: "home" },
    { qboAccountId: "utilities", taxCategory: "utilities", taxTreatment: "special_allocation", deductibilityStatus: "partially_deductible", deductiblePercent: 25, allocationSubject: "office" },
    { qboAccountId: "utilities", taxCategory: "other", taxTreatment: "utilities_review", deductibilityStatus: "needs_review", deductiblePercent: 0, allocationSubject: "office" },
  ]) assert.notEqual(buildTaxQuestionIdentity({ businessId: BUSINESS, taxYear: YEAR, decisionType: "business_use_percent", row }).id, base);
});
