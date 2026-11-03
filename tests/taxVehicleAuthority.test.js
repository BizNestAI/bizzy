import assert from "node:assert/strict";
import test from "node:test";
import { buildClassificationOverrideBatchItems } from "../src/services/tax/taxClassificationOverride.service.js";
import { classifyNormalizedTransaction } from "../src/services/tax/taxClassificationEngine.js";
import { taxClassificationBucketForDeductions } from "../src/services/tax/taxDeductionsLifecycleProjection.js";
const electionScope = { businessId: "business", taxYear: 2026, vehicleId: "vehicle", date: "2026-06-15", vehicleElectionEvidence: { id: "confirmed-election", businessId: "business", taxYear: 2026, vehicleId: "vehicle", method: "standard_mileage", status: "active", electedBy: "owner", electedAt: "2026-01-01T00:00:00Z", effectiveStart: "2026-01-01", effectiveEnd: "2026-12-31" } };
const row = { id: "classification", transaction_id: "txn", business_id: "business", tax_year: 2026, book_amount: -50, tax_category: "vehicle_expense", classification_status: "needs_review", requires_review: true, tax_treatment: { type: "vehicle_expense" }, metadata: {}, updated_at: "2026-11-03" };
test("automation cannot mint user override provenance", () => {
  assert.throws(() => buildClassificationOverrideBatchItems({ transactionIds: ["txn"], currentRows: [row], input: { reason: "automated classification", deductiblePercent: 0, deductibilityStatus: "nondeductible" }, actor: { role: "system", source: "rule_engine" }, taxYear: 2026 }), (error) => error.code === "manual_actor_required");
});
test("protected unresolved suggestion is not counted as reviewed", () => {
  assert.equal(taxClassificationBucketForDeductions({ ...row, taxScopeDisposition: "expense_cogs_in_matrix", userOverride: true, source: "rule_engine" }), "needs_review");
});
test("Gas cannot finalize from an unrelated automatic rule without a vehicle election", async () => {
  const result = await classifyNormalizedTransaction({ businessId: "11111111-1111-4111-8111-111111111111", taxYear: 2026,
    transaction: { transactionId: "txn", transactionDate: "2026-10-01", signedAmount: -50, absoluteAmount: 50, direction: "OUTFLOW", qboAccountName: "Gas", bookkeepingCategory: "Gas", qboAccountId: "gas", metadata: {} },
    profile: { entity_type: "sole_proprietor" }, memories: [], rules: [{ id: "gas-rule", rule_code: "legacy", scope: "global", tax_year: 2026, jurisdiction: "federal", bookkeeping_category: "Gas", tax_category: "vehicle_expense", deductibility_status: "fully_deductible", default_deductible_percent: 100, treatment: { type: "ordinary_expense" }, requires_review: false, priority: 1, is_active: true, match_conditions: {} }] });
  assert.equal(result.classificationStatus, "needs_review");
  assert.equal(result.deductibleAmount, 0);
  assert.equal(result.taxTreatment.type, "vehicle_expense");
});

test("forced classification cannot overwrite a protected unresolved manual row", async () => {
  const { upsertTaxClassification } = await import("../src/services/tax/taxClassification.repository.js");
  const existing = { ...row, user_override: true };
  const supabase = { from() { const q = { select() { return this; }, eq() { return this; }, maybeSingle() { return { data: existing }; }, upsert() { throw new Error("automation attempted a protected write"); } }; return q; } };
  const result = await upsertTaxClassification({ supabase, classification: { businessId: "business", transactionId: "txn", taxYear: 2026, classificationStatus: "needs_review", source: "rule_engine" }, force: true });
  assert.equal(result.skipped, true);
  assert.equal(result.row, existing);
});
test("ordinary Gas edit cannot bypass the controlled vehicle preview to create a 100% deduction", () => {
  assert.throws(() => buildClassificationOverrideBatchItems({ transactionIds: ["txn"], currentRows: [{ ...row, tax_treatment: "vehicle_standard_mileage_no_separate_gas", classification_status: "user_confirmed", user_override: true }],
    input: { reason: "Change my prior decision", allowUserConfirmedEdit: true, taxCategory: "vehicle_expense", deductiblePercent: 100, deductibilityStatus: "fully_deductible", taxTreatment: "vehicle_actual_expense_business_use" }, actor: { userId: "owner", role: "user", source: "user" }, taxYear: 2026 }), (error) => error.code === "vehicle_change_requires_preview");
});
test("classifier persistence cannot mint manual status even when its source claims user", async () => {
  const { upsertTaxClassification } = await import("../src/services/tax/taxClassification.repository.js");
  const supabase = { from() { return { select() { return this; }, eq() { return this; }, maybeSingle() { return { data: null }; }, upsert() { throw new Error("manual provenance reached persistence"); } }; } };
  await assert.rejects(upsertTaxClassification({ supabase, classification: { businessId: "business", transactionId: "txn", taxYear: 2026, classificationStatus: "user_confirmed", source: "user" } }), (error) => error.code === "manual_provenance_forbidden");
});

test("persisted mileage matrix uses covered-by-mileage provenance, with zero separate expense deduction", async () => {
  const { __taxWorkspaceProjectionTestInternals: projection } = await import("../src/services/tax/taxWorkspaceProjection.service.js");
  const month = projection.aggregateMonth([{ id: "std", outcome: "reviewed", row: { ...electionScope, taxCategory: "vehicle_expense", taxTreatment: "vehicle_standard_mileage_no_separate_gas", status: "user_confirmed", signedAmount: -51, deductibleAmount: 0, deductiblePercent: 0, userOverride: true } }]);
  assert.equal(month.reviewedTreatmentLabel, "Reviewed — covered by standard mileage");
  assert.equal(month.standardMileageTransactionCount, 1);
  assert.equal(month.deductibleAmount, 0);
  assert.equal(month.reviewedTransactionCount, 1);
});

test("covered-by-mileage labels survive canonical JSON treatment mapping", async () => {
  const { mapDeductionTransactionRow } = await import("../src/components/Tax/Deductions/deductionsWorkspaceViewModel.js");
  const { __taxWorkspaceProjectionTestInternals: projection } = await import("../src/services/tax/taxWorkspaceProjection.service.js");
  const mapped = mapDeductionTransactionRow({ ...row, ...electionScope, transaction_id: "std", tax_treatment: { type: "vehicle_standard_mileage_no_separate_gas" }, classification_status: "user_confirmed", requires_review: false, user_override: true, deductibility_status: "nondeductible", deductible_percent: 0, deductible_amount: 0, taxScopeDisposition: "expense_cogs_in_matrix" });
  const month = projection.aggregateMonth([{ id: "std", outcome: "reviewed", row: mapped }]);
  assert.equal(month.reviewedTreatmentLabel, "Reviewed — covered by standard mileage");
  assert.equal(month.standardMileageTransactionCount, 1);
});
