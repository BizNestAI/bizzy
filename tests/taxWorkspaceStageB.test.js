import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
const client = read("src/services/tax/taxApiClient.js");
const hook = read("src/hooks/tax/useTaxDeductions.js");
const dashboard = read("src/pages/Tax/TaxDashboard.jsx");
const workspaceRoute = read("src/api/tax/taxWorkspace.routes.js");
const projectionService = read("src/services/tax/taxWorkspaceProjection.service.js");
const detailService = read("src/services/tax/taxDeductionsApi.service.js");

test("Stage B requests v2 explicitly while server default remains v1", () => {
  assert.match(client, /const projectionVersion = "tax-workspace-v2";[\s\S]*\/api\/tax\/workspace\?/);
  assert.match(workspaceRoute, /req\.query\.projectionVersion \|\| TAX_WORKSPACE_LEGACY_PROJECTION_VERSION/);
  assert.match(workspaceRoute, /TAX_WORKSPACE_LEGACY_PROJECTION_VERSION, TAX_WORKSPACE_PROJECTION_VERSION/);
  assert.match(projectionService, /if \(!payload \|\| payload\.projectionVersion !== TAX_WORKSPACE_PROJECTION_VERSION\) return payload/);
});

test("persisted v2 projection remains the matrix and question authority after detail loading", () => {
  assert.match(dashboard, /if \(hasProjectedMatrix\) return buildPersistedWorkspaceMatrix\(deductions\.workspaceProjection, year\)/);
  assert.doesNotMatch(dashboard, /if \(!deductions\.allTransactions && hasProjectedMatrix\)/);
  assert.match(dashboard, /const projectedQuestionGroups = deductions\.workspaceProjection\?\.questionGroups \|\| \[\]/);
  assert.match(dashboard, /projectedQuestionGroups\.length\} questions covering \{questionCoveredUniqueCount\} unique transactions/);
  assert.doesNotMatch(dashboard, /deductions\.allTransactions\s*\? <AttentionReviewGroups/);
});

test("All Transactions is projection-scoped and fails closed unless all unique evaluated identities arrive", () => {
  assert.match(client, /\/api\/tax\/workspace\/transactions\?/);
  assert.match(client, /projectionVersion, limit: clampTaxDetailLimit\(limit\), offset/);
  assert.match(hook, /fetchAllWorkspaceTransactions/);
  assert.match(hook, /new Set\(rows\.map\(stableTaxRowId\)\.filter\(Boolean\)\)\.size/);
  assert.match(hook, /tax_workspace_transaction_population_mismatch/);
  assert.match(workspaceRoute, /identityEvidence\?\.evaluated/);
  assert.match(detailService, /sourceById\.size !== uniqueIdentities\.size/);
  assert.match(detailService, /classificationStatus: classification\?\.classification_status \|\| "unclassified"/);
  assert.match(detailService, /taxDataReasonCode: classification \? null : "tax_mapping_required"/);
});

test("Stage B does not initially hydrate legacy rows and optional failures cannot erase projection summaries", () => {
  const initialLoad = hook.slice(hook.indexOf("const load = useCallback"), hook.indexOf("const loadSecondaryDetails"));
  assert.match(initialLoad, /getTaxWorkspace/);
  assert.doesNotMatch(initialLoad, /getTaxDeductionTransactions|getTaxWorkspaceTransactions|loadSecondaryDetails/);
  assert.match(dashboard, /questionsRequestStatus = deductions\.workspaceProjection \? "success"/);
  assert.match(dashboard, /questionsPanelState = resolveQuestionsPanelState/);
  assert.match(dashboard, /workspaceView !== "all_transactions"/);
});

test("Stage B reconciliation copy and accepted projection counts are explicit", () => {
  assert.match(dashboard, /posted transactions evaluated · \{authoritativeMatrixIncludedCount\} deductible-expense transactions included · \{outsideDeductionsCount\} outside deductions/);
  const accepted = {
    evaluatedTransactionCount: 714,
    matrixIncludedCount: 690,
    outsideDeductionsCount: 24,
    treatmentCounts: { estimated: 276, reviewed: 43, needs_input: 371 },
    questionGroupCount: 15,
    questionCoveredUniqueCount: 315,
  };
  assert.equal(accepted.evaluatedTransactionCount, accepted.matrixIncludedCount + accepted.outsideDeductionsCount);
  assert.equal(Object.values(accepted.treatmentCounts).reduce((sum, count) => sum + count, 0), accepted.matrixIncludedCount);
});

test("workspace detail normalization preserves reconciliation metadata without exposing manifests", () => {
  assert.match(client, /return \{[\s\S]*\.\.\.page,[\s\S]*rows: normalizedRows/);
  assert.match(client, /page\?\.population\?\.projectionVersion !== projectionVersion/);
  assert.match(detailService, /population: \{[\s\S]*projectionVersion: "tax-workspace-v2"[\s\S]*evaluatedUniqueCount/);
  assert.doesNotMatch(detailService.slice(detailService.indexOf("function projectionEvaluatedTransactionRow"), detailService.indexOf("function compareProjectionSourceRows")), /identityEvidence|identityManifest|raw:/);
});

test("bounded requests and sequence guards protect hard refresh, SPA return, and rapid tab switching", () => {
  assert.match(hook, /withBoundedWorkspaceRead/);
  assert.match(hook, /if \(request !== seq\.current\) return null/);
  assert.match(hook, /if \(questionsRetryInFlight\.current\) return questionsRetryInFlight\.current/);
  assert.match(hook, /return \(\) => controller\.abort\(\)/);
  assert.match(hook, /setWorkspaceProjection\(null\)/);
  assert.match(hook, /if \(!overviewRef\.current\) setLoading\(true\)/);
});

test("workspace browser route retains tenant, entitlement, and read-only boundaries", () => {
  const detailRoute = workspaceRoute.slice(workspaceRoute.indexOf('router.get("/workspace/transactions"'), workspaceRoute.indexOf('router.post("/workspace/backfill"'));
  assert.match(detailRoute, /assertTaxBusinessAccess/);
  assert.match(detailRoute, /businessHasPaidEntitlement/);
  assert.match(detailRoute, /projectionVersion !== TAX_WORKSPACE_PROJECTION_VERSION/);
  assert.doesNotMatch(detailRoute, /\.insert\(|\.update\(|\.upsert\(|\.delete\(|persist_tax_workspace_projection/);
  assert.doesNotMatch(client, /identityEvidence|identityManifest|service_role/);
});

test("matrix cell detail is projection-scoped, partitioned server-side, and read-only", () => {
  const detailRoute = workspaceRoute.slice(workspaceRoute.indexOf('router.get("/workspace/matrix-cell"'), workspaceRoute.indexOf('router.post("/workspace/backfill"'));
  assert.match(detailRoute, /assertTaxBusinessAccess/);
  assert.match(detailRoute, /businessHasPaidEntitlement/);
  assert.match(detailRoute, /String\(record\.id\) !== projectionId/);
  assert.match(detailRoute, /evidence\.categories/);
  assert.match(detailRoute, /evidence\.months/);
  assert.match(detailRoute, /evidence\.treatments/);
  assert.match(detailRoute, /listProjectionEvaluatedTransactions/);
  assert.match(detailRoute, /delete safeRow\.rule_version/);
  assert.doesNotMatch(detailRoute, /req\.(body|params).*transaction|\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
});
