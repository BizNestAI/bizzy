import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  __taxWorkspaceProjectionTestInternals as projection,
  reconcileTaxWorkspaceProjection,
} from "../src/services/tax/taxWorkspaceProjection.service.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("successful grouped apply refreshes the complete authoritative v2 workspace", () => {
  const hook = read("src/hooks/tax/useTaxDeductions.js");
  const confirm = hook.slice(hook.indexOf("confirmGroupedDeductionDecision:"), hook.indexOf("getGroupedDeductionDecisionOperation:"));
  assert.match(confirm, /load\(\{[^}]*refresh:\s*true/);
  assert.doesNotMatch(confirm, /refreshAuthoritativeQuestionSummary/);
});

test("v2 workspace and matrix cells reconcile live classifications over the immutable population baseline", () => {
  const route = read("src/api/tax/taxWorkspace.routes.js");
  const workspace = route.slice(route.indexOf('router.get("/workspace"'), route.indexOf('router.get("/workspace/transactions"'));
  const matrixCell = route.slice(route.indexOf('router.get("/workspace/matrix-cell"'), route.indexOf('router.post("/workspace/backfill"'));
  assert.match(workspace, /reconcileTaxWorkspaceProjection/);
  assert.match(matrixCell, /reconcileTaxWorkspaceProjection/);
  assert.match(workspace, /projectionVersion === TAX_WORKSPACE_PROJECTION_VERSION/);
});

test("normal v2 reconciliation uses one bounded classification snapshot and never runs projection-generation reads", () => {
  const service = read("src/services/tax/taxWorkspaceProjection.service.js");
  const reconciliation = service.slice(
    service.indexOf("export async function reconcileTaxWorkspaceProjection"),
    service.indexOf("async function buildCurrentTaxWorkspacePayload")
  );
  assert.match(reconciliation, /listTaxClassifications/);
  assert.doesNotMatch(reconciliation, /buildCurrentTaxWorkspacePayload/);
  assert.doesNotMatch(reconciliation, /listTaxPostingSourceRows/);
  assert.doesNotMatch(reconciliation, /getDeductionsOverview/);
  assert.doesNotMatch(reconciliation, /loadRows/);
});

test("a 714-row production-shaped workspace reconciles with one database read under the workspace deadline", async () => {
  const entries = Array.from({ length: 714 }, (_, index) => {
    const inMatrix = index < 690;
    return {
      id: `transaction-${index}`,
      outcome: "standard_rule_applied",
      actionOwner: "none",
      row: {
        transactionId: `transaction-${index}`,
        date: "2026-07-15",
        taxScopeDisposition: inMatrix ? "expense_cogs_in_matrix" : "posted_non_expense_outside_deductions",
        taxCategory: inMatrix ? "supplies" : "income",
        taxCategoryLabel: inMatrix ? "Supplies" : "Income",
        signedAmount: inMatrix ? -10 : 10,
        deductibleAmount: inMatrix ? 10 : 0,
      },
    };
  });
  const baseline = projection.buildPayload({
    overview: { projection: { completeness: "complete" }, warnings: [] },
    lifecycle: { entries, activeDecisionGroups: [] },
    businessId: "business-a",
    taxYear: 2026,
    sourceFingerprint: "c".repeat(64),
    generatedAt: "2026-10-30T12:00:00.000Z",
  });
  const classifications = entries.map((entry) => ({
    transaction_id: entry.id,
    transaction_date: entry.row.date,
    tax_category: entry.row.taxCategory,
    classification_status: "auto_classified",
    deductibility_status: entry.row.taxCategory === "income" ? "nondeductible" : "fully_deductible",
    deductible_percent: entry.row.taxCategory === "income" ? 0 : 100,
    book_amount: entry.row.signedAmount,
    deductible_amount: entry.row.deductibleAmount,
    source_qbo_account_id: entry.row.taxCategory,
    source_qbo_account_name: entry.row.taxCategoryLabel,
    rule_version: "v4",
  }));
  let reads = 0;
  const query = {
    select() { return this; }, eq() { return this; }, order() { return this; }, range() { return this; },
    then(resolve) { reads += 1; return Promise.resolve(resolve({ data: classifications, error: null })); },
  };
  const startedAt = performance.now();
  const reconciled = await reconcileTaxWorkspaceProjection({
    supabase: { from() { return query; } },
    record: { source_fingerprint: baseline.sourceFingerprint, projection_data: baseline },
    businessId: "business-a",
    taxYear: 2026,
  });
  assert.equal(reads, 1);
  assert.equal(reconciled.evaluatedTransactionCount, 714);
  assert.equal(reconciled.matrixIncludedCount, 690);
  assert.equal(reconciled.outsideDeductionsCount, 24);
  assert.ok(performance.now() - startedAt < 1_000);
});

test("saved decision with a failed workspace refresh remains saved and exposes a retry", () => {
  const dashboard = read("src/pages/Tax/TaxDashboard.jsx");
  assert.match(dashboard, /decision saved[^\n]*workspace refresh failed/i);
  assert.match(dashboard, /Retry workspace refresh/);
});

test("Phone Bill transition conserves 690 identities and moves five Utilities memberships from needs input to reviewed", () => {
  const entries = [];
  const add = (id, outcome, category = "supplies", amount = 10) => entries.push({
    id, outcome, actionOwner: outcome === "customer_input_required" ? "customer_fact_required" : "none",
    row: { transactionId: id, taxScopeDisposition: "expense_cogs_in_matrix", taxCategory: category,
      taxCategoryLabel: category === "utilities" ? "Utilities" : "Supplies", date: "2026-07-15",
      signedAmount: -amount, deductibleAmount: outcome === "customer_input_required" ? null : amount },
  });
  for (let index = 0; index < 276; index += 1) add(`estimated-${index}`, "standard_rule_applied");
  for (let index = 0; index < 43; index += 1) add(`reviewed-${index}`, "reviewed");
  const phoneIds = Array.from({ length: 5 }, (_, index) => `phone-${index}`);
  phoneIds.forEach((id, index) => add(id, "customer_input_required", "utilities", 50 + index));
  const otherQuestionIds = Array.from({ length: 310 }, (_, index) => `question-${index}`);
  otherQuestionIds.forEach((id, index) => add(id, "customer_input_required", index < 2 ? "utilities" : "supplies"));
  for (let index = 0; index < 56; index += 1) add(`other-input-${index}`, "ambiguous");
  assert.equal(entries.length, 690);

  const group = (id, ids) => ({ id, decisionType: "business_use_percent", qboAccountId: id,
    qboAccountName: id, semanticFingerprint: `semantic-${id}`, semanticManifest: { version: 1, id }, ruleVersions: ["v4"],
    transactionCount: ids.length, actionableTransactionCount: ids.length, months: ["2026-07"],
    actionableGrossAmountCents: ids.length * 1000, actionableEstimatedDeductibleAmountCents: 0,
    state: "needs_input", stableTransactionIds: { actionable: ids } });
  const counts = [171, 61, 61, 8, 4, 3, 2];
  let offset = 0;
  const otherGroups = counts.map((count, index) => {
    const ids = otherQuestionIds.slice(offset, offset + count); offset += count;
    return group(`other-${index}`, ids);
  });
  const overview = { meta: { generatedAt: "2026-10-30T12:00:00.000Z" }, projection: { completeness: "complete" }, warnings: [] };
  const before = projection.buildPayload({ overview, lifecycle: { entries, activeDecisionGroups: [group("phone", phoneIds), ...otherGroups] },
    businessId: "business-a", taxYear: 2026, sourceFingerprint: "a".repeat(64), generatedAt: overview.meta.generatedAt });

  const answeredEntries = entries.map((entry) => phoneIds.includes(entry.id)
    ? { ...entry, outcome: "reviewed", actionOwner: "none", row: { ...entry.row, deductibleAmount: -entry.row.signedAmount } }
    : entry);
  const after = projection.buildPayload({ overview, lifecycle: { entries: answeredEntries, activeDecisionGroups: otherGroups },
    businessId: "business-a", taxYear: 2026, sourceFingerprint: "b".repeat(64), generatedAt: overview.meta.generatedAt });

  assert.deepEqual([before.matrixIncludedCount, before.treatmentCounts.reviewed, before.treatmentCounts.needs_input,
    before.questionGroupCount, before.questionCoveredUniqueCount], [690, 43, 371, 8, 315]);
  assert.deepEqual([after.matrixIncludedCount, after.treatmentCounts.reviewed, after.treatmentCounts.needs_input,
    after.questionGroupCount, after.questionCoveredUniqueCount], [690, 48, 366, 7, 310]);
  const beforeUtilities = before.matrix.find((row) => row.categoryKey === "utilities").months["2026-07"];
  const afterUtilities = after.matrix.find((row) => row.categoryKey === "utilities").months["2026-07"];
  assert.deepEqual([beforeUtilities.reviewedTransactionCount, beforeUtilities.needsInputTransactionCount], [0, 7]);
  assert.deepEqual([afterUtilities.reviewedTransactionCount, afterUtilities.needsInputTransactionCount], [5, 2]);
  assert.equal(afterUtilities.reviewedDeductibleAmount, 260);
  assert.equal(afterUtilities.needsInputGrossExpense, 20);
  assert.doesNotThrow(() => projection.validatePayload(after));
});
