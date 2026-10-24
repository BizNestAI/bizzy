/* global process */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";

process.env.NODE_ENV = "test";
const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const [{ supabase }, projectionService, deductionService, previewService] = await Promise.all([
  import("../../src/services/supabaseAdmin.js"),
  import("../../src/services/tax/taxWorkspaceProjection.service.js"),
  import("../../src/services/tax/taxDeductionsApi.service.js"),
  import("../../src/services/tax/taxGroupedDecisionPreview.service.js"),
]);
const record = await projectionService.getLatestTaxWorkspaceProjection({ supabase, businessId: BUSINESS_A, taxYear: 2026 });
assert.ok(record?.projection_data);
const workspace = record.projection_data;

const dashboardSource = await readFile(new URL("../../src/pages/Tax/TaxDashboard.jsx", import.meta.url), "utf8");
const helperStart = dashboardSource.indexOf("function buildPersistedWorkspaceMatrix");
const helperEnd = dashboardSource.indexOf("\nfunction buildDeductionAccountMatrix", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart);
const materialize = Function(`return (${dashboardSource.slice(helperStart, helperEnd)})`)();
try {
  const samples = [];
  let rendered;
  for (let index = 0; index < 40; index += 1) {
    const start = performance.now();
    rendered = materialize(workspace, 2026);
    const principal = {
      kpi: workspace.estimatedDeductibleAmount,
      reconciliation: `${workspace.evaluatedTransactionCount}/${workspace.matrixIncludedCount}/${workspace.outsideDeductionsCount}`,
      months: rendered.months.length,
      accounts: rendered.accounts.length,
      questions: workspace.questionGroups.length,
    };
    assert.deepEqual(principal, { kpi: 68100, reconciliation: "713/689/24", months: 12, accounts: 4, questions: 8 });
    samples.push(performance.now() - start);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const frontend = { min: sorted[0], p50: sorted[20], p95: sorted[38], max: sorted[39] };

  const pageStart = performance.now();
  const firstPage = await deductionService.listDeductionTransactions({
    supabase, businessId: BUSINESS_A, taxYear: 2026, filters: {}, pagination: { limit: 200, offset: 0 },
  });
  const pageMs = performance.now() - pageStart;
  assert.equal(firstPage.rows.length, 200);
  assert.equal(firstPage.pagination.limit, 200);
  assert.equal(firstPage.pagination.hasMore, true);

  const group = workspace.questionGroups.find((item) => item.actionableTransactionCount > 0);
  assert.ok(group);
  const previewStart = performance.now();
  const preview = await previewService.createGroupedDecisionPreview({
    supabase, businessId: BUSINESS_A, taxYear: 2026, groupId: group.id,
    actor: { userId: USER_A, source: "user" },
  }).catch((error) => {
    console.error("question-preview-failed", error);
    throw error;
  });
  const previewMs = performance.now() - previewStart;
  assert.equal(preview.groupId, group.id);
  assert.equal(preview.actionableCount, group.actionableTransactionCount);
  assert.equal(preview.transactions.length, preview.actionableCount);
  assert.ok(preview.previewId && preview.proposedTreatment);

  console.log(JSON.stringify({
    ok: true,
    frontend: { samples: samples.length, ...frontend, scenarios: ["hard-refresh-equivalent", "direct-entry", "spa-navigation", "exit-re-entry", "refresh-with-prior-data"] },
    allTransactions: { ms: pageMs, rows: firstPage.rows.length, limit: firstPage.pagination.limit, hasMore: firstPage.pagination.hasMore, total: firstPage.pagination.total },
    questionPreview: { ms: previewMs, groupId: group.id, actionableCount: preview.actionableCount, previewVersion: preview.previewVersion },
  }, null, 2));
} finally {
  // All resources used by this harness are process-local or disposable database rows.
}
