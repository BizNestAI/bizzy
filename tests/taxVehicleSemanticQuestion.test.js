import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildTaxQuestionIdentity } from "../src/services/tax/taxQuestionSemanticIdentity.js";
import { __testables as previewTestables } from "../src/services/tax/taxGroupedDecisionPreview.service.js";
import { computeClassificationAmounts } from "../src/services/tax/taxClassificationAmounts.js";
import { __taxWorkspaceProjectionTestInternals as projectionTestables } from "../src/services/tax/taxWorkspaceProjection.service.js";

const GAS = {
  transaction_id: "gas-regression-1",
  business_id: "business-regression",
  tax_year: 2026,
  book_amount: -34.83,
  source_qbo_account_id: "qbo-gas",
  source_qbo_account_name: "Fuel Expense",
  tax_category: "vehicle_expense",
  tax_treatment: { type: "vehicle_expense" },
  deductibility_status: "needs_review",
  deductible_percent: 0,
  classification_status: "needs_review",
  requires_review: true,
  user_override: false,
  cpa_override: false,
  rule_version: "bizzi-gl-2026-v4",
  metadata: {},
};

test("account-scoped vehicle question remains actionable without a vehicle profile", () => {
  const identity = buildTaxQuestionIdentity({
    businessId: GAS.business_id,
    taxYear: GAS.tax_year,
    decisionType: "vehicle_method",
    row: {
      qboAccountId: GAS.source_qbo_account_id,
      qboAccountName: GAS.source_qbo_account_name,
      taxCategory: GAS.tax_category,
      taxTreatment: GAS.tax_treatment.type,
      deductiblePercent: GAS.deductible_percent,
      deductibilityStatus: GAS.deductibility_status,
      metadata: GAS.metadata,
    },
  });
  assert.equal(identity.manifest.subject.kind, "vehicle_gl");
  assert.equal(identity.manifest.subject.key, "qbo-gas");

  const preview = previewTestables.customerPreview({
    id: "preview-gas",
    business_id: GAS.business_id,
    tax_year: GAS.tax_year,
    group_id: identity.id,
    decision_type: "vehicle_method",
    expires_at: "2026-10-30T12:05:00.000Z",
  }, [GAS], new Map([[GAS.transaction_id, {
    transactionId: GAS.transaction_id, date: "2026-07-14", description: "Fuel purchase", merchantName: "Fuel merchant",
    counterpartyName: null, signedAmount: GAS.book_amount, qboAccountId: GAS.source_qbo_account_id,
    qboAccountName: GAS.source_qbo_account_name, taxCategory: GAS.tax_category,
    classificationStatus: GAS.classification_status, requiresReview: GAS.requires_review,
  }]]));
  assert.equal(preview.actionableCount, 1, "the authoritative preview resolves without vehicle identity");

  assert.deepEqual(previewTestables.treatmentForAnswer(GAS, {
    answer: "vehicle_method",
    vehicleMethod: "standard_mileage",
  }), {
    taxCategory: "vehicle_expense",
    deductibilityStatus: "nondeductible",
    deductiblePercent: 0,
    taxTreatment: "vehicle_standard_mileage_no_separate_gas",
  });

  const dashboard = readFileSync("src/pages/Tax/TaxDashboard.jsx", "utf8");
  const groupedModal = dashboard.slice(dashboard.indexOf("function ReviewDecisionModal"), dashboard.indexOf("function GroupedDecisionPreviewState"));
  assert.doesNotMatch(groupedModal, /serverPreview\.actionableCount > 0 && action\.kind !== "vehicle_method"/);
  assert.doesNotMatch(groupedModal, /Vehicle setup is temporarily unavailable/);
});

for (const [name, input, expected] of [
  ["actual expenses at 100%", { vehicleMethod: "actual_expense", actualExpenseUse: "all_business" }, ["fully_deductible", 100, "vehicle_actual_expense_business_use"]],
  ["actual expenses at a mixed percentage", { vehicleMethod: "actual_expense", actualExpenseUse: "mixed_use", businessUsePercent: "62.25" }, ["partially_deductible", 62.25, "vehicle_actual_expense_business_use"]],
  ["actual expenses at 0%", { vehicleMethod: "actual_expense", actualExpenseUse: "not_business" }, ["nondeductible", 0, "vehicle_actual_expense_no_business_use"]],
]) test(`${name} has an explicit vehicle treatment`, () => {
  const result = previewTestables.treatmentForAnswer(GAS, { answer: "vehicle_method", ...input });
  assert.deepEqual([result.deductibilityStatus, result.deductiblePercent, result.taxTreatment], expected);
});

for (const percent of ["", "0", "100", "10.123", "abc"]) test(`mixed vehicle use rejects ${JSON.stringify(percent)}`, () => {
  assert.throws(
    () => previewTestables.treatmentForAnswer(GAS, { answer: "vehicle_method", vehicleMethod: "actual_expense", actualExpenseUse: "mixed_use", businessUsePercent: percent }),
    (error) => error.code === "invalid_vehicle_business_use_percent",
  );
});

for (const [name, input] of [
  ["standard mileage paired with 100%", { vehicleMethod: "standard_mileage", businessUsePercent: 100 }],
  ["standard mileage paired with an actual-expense use", { vehicleMethod: "standard_mileage", actualExpenseUse: "all_business" }],
  ["actual entirely-business paired with 50%", { vehicleMethod: "actual_expense", actualExpenseUse: "all_business", businessUsePercent: 50 }],
  ["actual not-business paired with 50%", { vehicleMethod: "actual_expense", actualExpenseUse: "not_business", businessUsePercent: 50 }],
]) test(`${name} fails closed`, () => {
  assert.throws(
    () => previewTestables.treatmentForAnswer(GAS, { answer: "vehicle_method", ...input }),
    (error) => error.code === "inconsistent_vehicle_decision",
  );
});

test("browser apply payload cannot supply treatment, scope, membership, subject, or authority", () => {
  const client = readFileSync("src/services/tax/taxApiClient.js", "utf8");
  const route = readFileSync("src/api/tax/taxClassificationReview.routes.js", "utf8");
  assert.match(client, /compact\(\{ previewId, answer, vehicleMethod, actualExpenseUse, businessUsePercent, personalExceptionIds \}\)/);
  assert.doesNotMatch(client, /compact\(\{[^}]*taxTreatment/);
  assert.doesNotMatch(route.slice(route.indexOf('router.post("/deduction-decisions/apply"')), /req\.body\?\.(?:taxTreatment|deductibilityStatus|deductiblePercent|targetTransactionIds|expectedPopulationTransactionIds|scope|groupId|vehicleSubject|authority)/);
});

test("mixed vehicle percentages preserve expense and refund signs in the signed projection contract", () => {
  const expense = computeClassificationAmounts({ signedAmount: -100, deductibilityStatus: "partially_deductible", deductiblePercent: 62.25, taxCategory: "vehicle_expense" });
  const refund = computeClassificationAmounts({ signedAmount: 20, deductibilityStatus: "partially_deductible", deductiblePercent: 62.25, taxCategory: "vehicle_expense" });
  const month = projectionTestables.aggregateMonth([
    { id: "expense", outcome: "reviewed", row: { signedAmount: expense.bookAmount, deductibleAmount: expense.deductibleAmount } },
    { id: "refund", outcome: "reviewed", row: { signedAmount: refund.bookAmount, deductibleAmount: refund.deductibleAmount } },
  ]);
  assert.equal(month.bookExpenseAmount, 80);
  assert.equal(month.reviewedDeductibleAmount, 49.8);
  assert.equal(month.deductibleAmount, 49.8);
});
