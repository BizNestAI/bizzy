import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { __taxWorkspaceProjectionTestInternals as projection } from "../src/services/tax/taxWorkspaceProjection.service.js";

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
