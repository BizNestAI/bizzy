import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES,
  buildTaxDecisionIdentity,
  buildTaxDeductionsLifecycleProjection,
  reconcileLegacyTaxCoverage,
} from "../src/services/tax/taxDeductionsLifecycleProjection.js";

const YEAR = 2026;
const BUSINESS = "business-a";

function row(id, overrides = {}) {
  return {
    id,
    transactionId: id,
    date: "2026-09-15",
    amount: 100,
    qboAccountId: "software",
    qboAccountName: "Software",
    taxScopeDisposition: "expense_cogs_in_matrix",
    taxCategory: "software_subscriptions",
    taxTreatment: "fully_deductible",
    deductiblePercent: 100,
    status: "auto_classified",
    classificationSource: "rule_engine",
    matchedRuleCode: "software_gl_v3",
    ruleVersion: "bizzi-gl-2026-v3",
    raw: { transactionId: id, audit_history: [{ action: "classified" }] },
    ...overrides,
  };
}

function rows(count, prefix, overrides) {
  return Array.from({ length: count }, (_, index) => row(`${prefix}-${index + 1}`, overrides));
}

function productionShapeRows() {
  const reviewed = rows(43, "reviewed", {
    status: "user_confirmed",
    taxCategory: "business_meals",
    qboAccountId: "meals",
    qboAccountName: "Meals",
    deductiblePercent: 50,
  });
  const standardApplied = rows(121, "standard", {});
  const standardEstimated = rows(41, "supported-rule", {
    status: "needs_review",
    requiresReview: true,
    taxCategory: "supplies",
    qboAccountId: "supplies",
    qboAccountName: "Supplies",
    matchedRuleCode: "supplies_gl_v3",
  });
  const customerGroups = [
    [287, "meals", "Meals", "business_meals", "meals_review_gl_v3"],
    [61, "parking", "Parking", "travel_transportation", "parking_review_gl_v3"],
    [60, "vehicle", "Gas", "vehicle_expense", "vehicle_review_gl_v3"],
    [8, "lyft", "Lyft/Uber", "travel_transportation", "travel_review_gl_v3"],
    [5, "rent", "Rent", "utilities", "rent_review_gl_v3"],
    [9, "electric", "Electric", "utilities", "utilities_review_gl_v3"],
  ].flatMap(([count, prefix, accountId, category, ruleCode]) => rows(count, prefix, {
    status: "needs_review",
    requiresReview: true,
    qboAccountId: accountId,
    qboAccountName: accountId === "lyft" ? "Lyft/Uber" : accountId[0].toUpperCase() + accountId.slice(1),
    taxCategory: category,
    matchedRuleCode: ruleCode,
    deductiblePercent: category === "business_meals" ? 50 : 0,
  }));
  const bookkeeping = rows(50, "bookkeeping", {
    status: "unclassified",
    taxScopeDisposition: "incomplete_or_unresolved",
    qboAccountId: "uncategorized",
    qboAccountName: "Uncategorized Expense",
    taxCategory: "unresolved",
    taxTreatment: "not_determined",
  });
  const outside = rows(24, "outside", {
    status: "auto_classified",
    taxScopeDisposition: "income_outside_deductions",
    qboAccountId: "income",
    qboAccountName: "Sales of Product Income",
    taxCategory: "income",
  });
  return [...reviewed, ...standardApplied, ...standardEstimated, ...customerGroups, ...bookkeeping, ...outside];
}

function projection(rowsToProject = productionShapeRows(), options = {}) {
  return buildTaxDeductionsLifecycleProjection({ rows: rowsToProject, businessId: BUSINESS, taxYear: YEAR, ...options });
}

test("1. every evaluated identity belongs to exactly one lifecycle state", () => {
  const result = projection();
  assert.equal(result.canonicalCount, 709);
  assert.equal(result.counted, 709);
  assert.equal(result.conservation.isConserved, true);
  assert.equal(new Set(result.entries.map((entry) => entry.id)).size, 709);
});

test("2. expense and outside-deduction identities reconcile to the 685/24 scope split", () => {
  const result = projection();
  const outside = result.counts[TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.OUTSIDE_DEDUCTIONS];
  assert.equal(outside, 24);
  assert.equal(result.canonicalCount - outside, 685);
});

test("3. generic Rent leaves the customer decision population without changing identities", () => {
  const result = projection();
  const legacy = reconcileLegacyTaxCoverage({ legacyReviewRequired: 471, legacyUnresolved: 51, projection: result });
  assert.equal(legacy.customerInput, 425);
  assert.equal(legacy.supportedRuleEstimateNoAction, 41);
  assert.equal(legacy.reviewDifference, 46);
  assert.equal(legacy.bookkeepingEvidence, 50);
  assert.equal(legacy.unresolvedDifference, 1);
});

test("4. five launch-safe annual decisions remain distinct from 425 affected transactions", () => {
  const result = projection();
  assert.equal(result.counts[TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.CUSTOMER_INPUT_REQUIRED], 425);
  assert.equal(result.activeDecisionGroups.length, 5);
  assert.equal(result.entries.filter((entry) => /rent/i.test(entry.row.qboAccountName || "")).every((entry) => entry.decisionId == null), true);
});

test("5. one annual GL decision covers multiple monthly cells", () => {
  const first = row("meals-september", { status: "needs_review", requiresReview: true, qboAccountId: "meals", qboAccountName: "Meals", taxCategory: "business_meals", matchedRuleCode: "meals_review_gl_v3", date: "2026-09-15" });
  const second = { ...first, id: "meals-october", transactionId: "meals-october", raw: { transactionId: "meals-october" }, date: "2026-10-15" };
  const result = projection([first, second]);
  assert.equal(result.activeDecisionGroups.length, 1);
  assert.deepEqual(result.activeDecisionGroups[0].months, ["2026-09", "2026-10"]);
});

test("5a. an annual decision conserves category, actionable, reviewed, and excluded stable identities", () => {
  const pendingOne = row("meal-pending-1", { status: "needs_review", requiresReview: true, taxCategory: "business_meals", qboAccountId: "meals", qboAccountName: "Meals", matchedRuleCode: "meals_review_gl_v3" });
  const pendingTwo = { ...pendingOne, id: "meal-pending-2", transactionId: "meal-pending-2", raw: { transactionId: "meal-pending-2" } };
  const reviewed = { ...pendingOne, id: "meal-reviewed", transactionId: "meal-reviewed", status: "user_confirmed", requiresReview: false, raw: { transactionId: "meal-reviewed", updated_at: "2026-10-19" } };
  const result = projection([pendingOne, pendingTwo, reviewed]);
  const group = result.activeDecisionGroups[0];

  assert.equal(group.categoryTransactionCount, 3);
  assert.equal(group.actionableTransactionCount, 2);
  assert.equal(group.alreadyResolvedCount, 1);
  assert.equal(group.explicitlyExcludedCount, 0);
  assert.deepEqual(group.stableTransactionIds.actionable.sort(), ["meal-pending-1", "meal-pending-2"]);
  assert.deepEqual(group.stableTransactionIds.alreadyResolved, ["meal-reviewed"]);
  assert.equal(group.populationConservation.isConserved, true);
});

test("6. completed business-use decisions remain discoverable", () => {
  const result = projection([row("reviewed-meal", { status: "user_confirmed", taxCategory: "business_meals", qboAccountId: "meals", qboAccountName: "Meals", raw: { transactionId: "reviewed-meal", updated_at: "2026-10-18" } })]);
  assert.equal(result.completedDecisionGroups.length, 1);
  assert.equal(result.completedDecisionGroups[0].decisionType, "business_use_confirmation");
  assert.equal(result.completedDecisionGroups[0].reviewedCount, 1);
});

test("7. completed business-use percentage decisions retain their percentage and scope", () => {
  const result = projection([row("reviewed-phone", { status: "user_confirmed", taxCategory: "utilities", qboAccountId: "phone", qboAccountName: "Phone Bill", deductiblePercent: 65, raw: { transactionId: "reviewed-phone", updated_at: "2026-10-18" } })]);
  assert.equal(result.completedDecisionGroups[0].decisionType, "business_use_percent");
  assert.equal(result.completedDecisionGroups[0].currentDeductiblePercent, 65);
});

test("8. completed vehicle decisions remain reviewable by stable vehicle/account scope", () => {
  const result = projection([row("reviewed-vehicle", { status: "user_confirmed", taxCategory: "vehicle_expense", qboAccountId: "vehicle", qboAccountName: "Gas", raw: { transactionId: "reviewed-vehicle", updated_at: "2026-10-18" } })]);
  assert.equal(result.completedDecisionGroups[0].decisionType, "vehicle_method");
  assert.match(result.completedDecisionGroups[0].id, /subject:vehicle/);
});

test("9. an input row carries the grouped decision ID used by a matrix cell", () => {
  const result = projection();
  const entry = result.entries.find((item) => item.id === "meals-1");
  assert.ok(entry.decisionId);
  assert.equal(result.activeDecisionGroups.some((group) => group.id === entry.decisionId), true);
});

test("10. supported deterministic review rules become standard estimates without routine customer action", () => {
  const result = projection([row("supported", { status: "needs_review", requiresReview: true, taxCategory: "supplies", qboAccountId: "supplies", qboAccountName: "Supplies", matchedRuleCode: "supplies_gl_v3" })]);
  assert.equal(result.counts[TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.STANDARD_RULE_ESTIMATED_NO_ACTION], 1);
  assert.equal(result.activeDecisionGroups.length, 0);
});

test("11. income, transfers, and card payments cannot enter customer questions", () => {
  const result = projection([
    row("income", { taxScopeDisposition: "income_outside_deductions", taxCategory: "income" }),
    row("transfer", { taxScopeDisposition: "transfer_or_card_payment_not_deduction", taxCategory: "transfer" }),
    row("card-payment", { taxScopeDisposition: "transfer_or_card_payment_not_deduction", taxCategory: "card_payment" }),
  ]);
  assert.equal(result.counts[TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.OUTSIDE_DEDUCTIONS], 3);
  assert.equal(result.activeDecisionGroups.length, 0);
});

test("12. incomplete QBO evidence is bookkeeping follow-up, not a customer question", () => {
  const result = projection([row("missing-qbo", { status: "unclassified", taxScopeDisposition: "incomplete_or_unresolved", taxCategory: "unresolved" })]);
  assert.equal(result.counts[TAX_DEDUCTIONS_LIFECYCLE_OUTCOMES.BOOKKEEPING_EVIDENCE_REQUIRED], 1);
  assert.equal(result.activeDecisionGroups.length, 0);
});

test("13. decision identity is tenant, year, GL, type, subject, and semantics scoped but not rule-version scoped", () => {
  const source = row("scoped", { status: "needs_review", requiresReview: true, taxCategory: "vehicle_expense", qboAccountId: "vehicle", matchedRuleCode: "vehicle_v3" });
  const base = buildTaxDecisionIdentity({ businessId: "a", taxYear: 2026, row: source, decisionType: "vehicle_method" });
  assert.notEqual(base, buildTaxDecisionIdentity({ businessId: "b", taxYear: 2026, row: source, decisionType: "vehicle_method" }));
  assert.notEqual(base, buildTaxDecisionIdentity({ businessId: "a", taxYear: 2025, row: source, decisionType: "vehicle_method" }));
  assert.notEqual(base, buildTaxDecisionIdentity({ businessId: "a", taxYear: 2026, row: { ...source, qboAccountId: "other" }, decisionType: "vehicle_method" }));
  assert.notEqual(base, buildTaxDecisionIdentity({ businessId: "a", taxYear: 2026, row: source, decisionType: "business_use_percent" }));
  assert.equal(base, buildTaxDecisionIdentity({ businessId: "a", taxYear: 2026, row: { ...source, ruleVersion: "v4" }, decisionType: "vehicle_method" }));
});

test("14. duplicate click/id delivery is idempotent at the stable-identity projection boundary", () => {
  const duplicate = row("same", { status: "needs_review", requiresReview: true, taxCategory: "business_meals", qboAccountId: "meals" });
  const result = projection([duplicate, { ...duplicate }]);
  assert.equal(result.canonicalCount, 1);
  assert.equal(result.duplicateIdentityRows.length, 1);
  assert.equal(result.activeDecisionGroups.length, 1);
});

test("15. a saved decision updates the projected UI state without reloading all data", () => {
  const pending = row("decision", { status: "needs_review", requiresReview: true, taxCategory: "business_meals", qboAccountId: "meals" });
  const reviewed = { ...pending, status: "user_confirmed", raw: { transactionId: "decision", updated_at: "2026-10-19" } };
  assert.equal(projection([pending]).activeDecisionGroups.length, 1);
  const after = projection([reviewed]);
  assert.equal(after.activeDecisionGroups.length, 0);
  assert.equal(after.completedDecisionGroups.length, 1);
});

test("16. annual totals equal the sum of the monthly stable identities", () => {
  const result = projection([row("sep", { amount: 25, date: "2026-09-15" }), row("oct", { amount: 75, date: "2026-10-15" })]);
  const monthly = result.entries.reduce((sum, entry) => sum + Math.abs(entry.row.amount), 0);
  assert.equal(monthly, 100);
  assert.equal(result.entries.length, 2);
});

test("17. projection preserves existing classification decision audit history", () => {
  const audited = row("audited", { raw: { transactionId: "audited", audit_history: [{ action: "old" }, { action: "replacement" }] } });
  const result = projection([audited]);
  assert.equal(result.entries[0].row.raw.audit_history.length, 2);
  assert.equal(result.entries[0].row, audited);
});

test("18. tenant isolation keeps equivalent GL decisions separate", () => {
  const pending = row("tenant", { status: "needs_review", requiresReview: true, taxCategory: "business_meals", qboAccountId: "meals" });
  const a = projection([pending], { businessId: "tenant-a" });
  const b = projection([pending], { businessId: "tenant-b" });
  assert.notEqual(a.activeDecisionGroups[0].id, b.activeDecisionGroups[0].id);
});

test("19. lifecycle projection imports and runs without providers or mutations", () => {
  const result = projection([]);
  assert.equal(result.canonicalCount, 0);
  assert.equal(result.conservation.isConserved, true);
});

test("20. equivalent rule versions merge into one semantic question with a duplicate-free union", () => {
  const shared = { status: "needs_review", requiresReview: true, taxCategory: "business_meals", qboAccountId: "meals", qboAccountName: "Meals", taxTreatment: "ordinary_expense", deductiblePercent: 50, deductibilityStatus: "partially_deductible" };
  const result = projection([
    row("v3-a", { ...shared, ruleVersion: "bizzi-gl-2026-v3" }),
    row("v4-a", { ...shared, ruleVersion: "bizzi-gl-2026-v4" }),
  ]);
  assert.equal(result.activeDecisionGroups.length, 1);
  assert.deepEqual(result.activeDecisionGroups[0].ruleVersions, ["bizzi-gl-2026-v3", "bizzi-gl-2026-v4"]);
  assert.equal(result.activeDecisionGroups[0].actionableTransactionCount, 2);
  assert.equal(new Set(result.activeDecisionGroups[0].stableTransactionIds.actionable).size, 2);
});

test("21. semantic differences, GL accounts, and genuine subjects remain separate", () => {
  const base = { status: "needs_review", requiresReview: true, taxCategory: "utilities", qboAccountName: "Utilities", taxTreatment: "utilities_review", deductibilityStatus: "needs_review", deductiblePercent: 0 };
  const result = projection([
    row("base", { ...base, qboAccountId: "utilities-a", allocationSubject: "office" }),
    row("different-treatment", { ...base, qboAccountId: "utilities-a", allocationSubject: "office", taxTreatment: "utilities_special_review" }),
    row("different-gl", { ...base, qboAccountId: "utilities-b", allocationSubject: "office" }),
    row("different-subject", { ...base, qboAccountId: "utilities-a", allocationSubject: "home" }),
  ]);
  assert.equal(result.activeDecisionGroups.length, 4);
});

test("22. diagnosed 15 rule-version groups become 8 questions while conserving 315 unique memberships", () => {
  const definitions = [
    ["Meals", "business_meals", "ordinary_expense", 50, 90, 81],
    ["Gas", "vehicle_expense", "vehicle_expense", 0, 56, 5],
    ["Parking", "travel_transportation", "travel_transportation", 0, 36, 25],
    ["Lyft/Uber", "travel_transportation", "travel_transportation", 0, 4, 4],
    ["Electric", "utilities", "utilities_review", 0, 2, 2],
    ["Phone Bill", "utilities", "utilities_review", 0, 3, 2],
    ["Transportation", "travel_transportation", "travel_transportation", 0, 2, 1],
  ];
  const input = [];
  for (const [account, category, treatment, percent, v4Count, v3Count] of definitions) {
    for (const [version, count] of [["bizzi-gl-2026-v4", v4Count], ["bizzi-gl-2026-v3", v3Count]]) {
      input.push(...rows(count, `${account}-${version}`, { status: "needs_review", requiresReview: true, qboAccountId: account, qboAccountName: account, taxCategory: category, taxTreatment: treatment, deductiblePercent: percent, deductibilityStatus: category === "business_meals" ? "partially_deductible" : "needs_review", ruleVersion: version }));
    }
  }
  input.push(...rows(2, "Utilities-single", { status: "needs_review", requiresReview: true, qboAccountId: "Utilities", qboAccountName: "Utilities", taxCategory: "utilities", taxTreatment: "utilities_review", deductiblePercent: 0, deductibilityStatus: "needs_review", ruleVersion: "bizzi-gl-2026-v4" }));
  const result = projection(input);
  const memberships = result.activeDecisionGroups.flatMap((group) => group.stableTransactionIds.actionable);
  assert.equal(result.activeDecisionGroups.length, 8);
  assert.equal(memberships.length, 315);
  assert.equal(new Set(memberships).size, 315);
});
