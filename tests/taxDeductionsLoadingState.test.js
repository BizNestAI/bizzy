import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import {
  resolveDeductionsRenderState,
  resolveQuestionsPanelState,
  resolveScopedDeductionsRequestStatus,
  selectDeductionsWorkspaceError,
  withBoundedWorkspaceRead,
} from "../src/components/Tax/Deductions/deductionsRequestState.js";

test("frontend critical route is one projection read and detail paging is lazy", () => {
  const hook = fs.readFileSync(new URL("../src/hooks/tax/useTaxDeductions.js", import.meta.url), "utf8");
  const client = fs.readFileSync(new URL("../src/services/tax/taxApiClient.js", import.meta.url), "utf8");
  const initialEffect = hook.slice(hook.indexOf("useEffect(() => {", hook.indexOf("const retryQuestions")), hook.indexOf("useEffect(() => {", hook.indexOf("const retryQuestions") + 200));
  assert.match(hook, /getTaxWorkspace\(\{ businessId, year, refresh, signal \}\)/);
  assert.match(client, /\/api\/tax\/workspace\?/);
  assert.match(client, /TAX_WORKSPACE_READ_TIMEOUT_MS = 5_000/);
  assert.doesNotMatch(initialEffect, /loadSecondaryDetails/);
});

test("Questions for You keeps loading, empty, error, and populated states distinct", () => {
  assert.equal(resolveQuestionsPanelState({ status: "loading", authoritativeCount: 8, renderedCount: 0 }), "loading");
  assert.equal(resolveQuestionsPanelState({ status: "success", authoritativeCount: 0, renderedCount: 0, hasAuthoritativeDetails: true }), "ready_empty");
  assert.equal(resolveQuestionsPanelState({ status: "success", authoritativeCount: 8, renderedCount: 8, hasAuthoritativeDetails: true }), "ready_nonempty");
  assert.equal(resolveQuestionsPanelState({ status: "error", authoritativeCount: 8, renderedCount: 0 }), "error");
});

test("an older or incompatible zero-question detail projection cannot contradict a known badge count", () => {
  assert.equal(resolveQuestionsPanelState({
    status: "success",
    authoritativeCount: 8,
    renderedCount: 0,
    hasAuthoritativeDetails: true,
  }), "error");
});

test("a newly enabled scope is loading synchronously before its effect runs", () => {
  assert.deepEqual(
    resolveScopedDeductionsRequestStatus({
      requestStatus: { scopeKey: ":2026::enabled", overview: "idle", matrix: "idle", classification: "idle" },
      scopeKey: "business-1:2026::enabled",
      enabled: true,
    }),
    { scopeKey: "business-1:2026::enabled", overview: "loading", matrix: "loading", classification: "loading" }
  );
});

test("unresolved initial requests render loading rather than authoritative zero data", () => {
  assert.deepEqual(
    resolveDeductionsRenderState({
      sectionStatus: { overview: "loading", matrix: "loading", classification: "loading" },
      hasData: false,
    }),
    { state: "initial_loading", showInitialLoading: true, showInitialError: false, showAuthoritativeData: false, showUpdating: false }
  );
});

test("successful empty and nonempty authoritative workspaces do not render loading or error placeholders", () => {
  const state = resolveDeductionsRenderState({
    sectionStatus: { overview: "success", matrix: "success", classification: "success" },
    hasData: true,
    hasSummaryData: true,
  });
  assert.equal(state.showInitialLoading, false);
  assert.equal(state.showInitialError, false);
  assert.equal(state.showAuthoritativeData, true);
  assert.equal(state.state, "ready");
});

test("only a rejected authoritative overview renders the page-level error", () => {
  assert.deepEqual(
    resolveDeductionsRenderState({
      sectionStatus: { overview: "error", matrix: "success", classification: "success" },
      hasData: false,
    }),
    { state: "fatal_error", showInitialLoading: false, showInitialError: true, showAuthoritativeData: false, showUpdating: false }
  );
});

test("a transaction-detail failure cannot replace an available persisted summary", () => {
  assert.deepEqual(
    resolveDeductionsRenderState({
      sectionStatus: { overview: "success", matrix: "error", classification: "success" },
      hasData: true,
      hasSummaryData: true,
    }),
    { state: "partial_error", showInitialLoading: false, showInitialError: false, showAuthoritativeData: true, showUpdating: false }
  );
});

test("an overview failure retains its safe code and request id even when details succeed", () => {
  const overviewError = Object.assign(new Error("Tax request failed."), {
    code: "tax_deductions_overview_failed",
    requestId: "tax-request-123",
  });
  assert.equal(selectDeductionsWorkspaceError({
    overviewResult: { status: "rejected", reason: overviewError },
    allTransactionsResult: { status: "fulfilled", value: { rows: [] } },
    coverageResult: { status: "fulfilled", value: {} },
  }), overviewError);
});

test("pending canonical context stays in loading without showing a terminal error", () => {
  assert.deepEqual(
    resolveDeductionsRenderState({
      sectionStatus: { overview: "error", matrix: "error", classification: "error" },
      contextPending: true,
    }),
    { state: "bootstrapping_context", showInitialLoading: true, showInitialError: false, showAuthoritativeData: false, showUpdating: false }
  );
});

test("background refresh retains authoritative values and exposes an updating status", () => {
  assert.deepEqual(
    resolveDeductionsRenderState({
      sectionStatus: { overview: "success", matrix: "success", classification: "success" },
      hasData: true,
      refreshing: true,
    }),
    { state: "refreshing", showInitialLoading: false, showInitialError: false, showAuthoritativeData: true, showUpdating: true }
  );
});

test("idle initialization without a verified overview remains loading instead of rendering zero data", () => {
  for (const overview of ["idle", "loading"]) {
    const state = resolveDeductionsRenderState({
      sectionStatus: { overview, matrix: "idle", classification: "idle" },
      hasData: false,
      hasSummaryData: false,
    });
    assert.equal(state.state, "initial_loading");
    assert.equal(state.showAuthoritativeData, false);
  }
});

test("a verified overview renders while its optional matrix details continue loading", () => {
  assert.deepEqual(resolveDeductionsRenderState({
    sectionStatus: { overview: "success", matrix: "loading", classification: "loading" },
    hasData: true,
    hasSummaryData: true,
  }), {
    state: "ready",
    showInitialLoading: false,
    showInitialError: false,
    showAuthoritativeData: true,
    showUpdating: false,
  });
});

test("Tax Overview skeleton and empty state are gated and accessible", () => {
  const source = fs.readFileSync(new URL("../src/pages/Tax/TaxDashboard.jsx", import.meta.url), "utf8");
  assert.match(source, /initialDeductionsLoading \? \(\s*<DeductionsLoadingState/);
  assert.match(source, /role="status" aria-busy="true" aria-live="polite"/);
  assert.match(source, /Loading your \{year\} deductions…/);
  assert.match(source, /motion-safe:animate-spin motion-reduce:hidden/);
  assert.match(source, /motion-safe:animate-pulse/);
  assert.match(source, /motion-reduce:hidden/);
  assert.match(source, /initialDeductionsError \? \(/);
  assert.match(source, /matrix\.accounts\.length \? \(/);
  assert.match(source, /Existing deduction data remains on screen and may be stale/);
});

test("All Transactions shows an animated accessible loading state while its rows load", () => {
  const source = fs.readFileSync(new URL("../src/pages/Tax/TaxDashboard.jsx", import.meta.url), "utf8");
  const start = source.indexOf("function ClassificationWorkspaceTable");
  const end = source.indexOf("if (!rows.length)", start);
  const loadingState = source.slice(start, end);

  assert.match(loadingState, /if \(loading && !rows\.length\)/);
  assert.match(loadingState, /<Loader2[^>]+motion-safe:animate-spin motion-reduce:hidden/);
  assert.match(loadingState, /role="status"/);
  assert.match(loadingState, /aria-busy="true"/);
  assert.match(loadingState, /Loading All Transactions…/);
});

test("canonical context bootstrap is bounded and retryable", () => {
  const dashboard = fs.readFileSync(new URL("../src/pages/Tax/TaxDashboard.jsx", import.meta.url), "utf8");
  const businessContext = fs.readFileSync(new URL("../src/context/BusinessContext.jsx", import.meta.url), "utf8");
  assert.match(dashboard, /TAX_BOOTSTRAP_TIMEOUT_MS = 20_000/);
  assert.match(dashboard, /tax_context_bootstrap_timeout/);
  assert.match(dashboard, /bootstrapFailure \? \(/);
  assert.match(dashboard, /onRetry=\{retryTaxBootstrap\}/);
  assert.match(dashboard, /setBootstrapAttempt\(\(attempt\) => attempt \+ 1\)/);
  assert.match(dashboard, /\[contextPending, bootstrapAttempt\]/);
  assert.match(businessContext, /refreshBusinessContext/);
  assert.match(businessContext, /refreshGeneration/);
});

test("headline amount and question count come from one overview projection", () => {
  const source = fs.readFileSync(new URL("../src/pages/Tax/TaxDashboard.jsx", import.meta.url), "utf8");
  assert.match(source, /overviewProjection\?\.estimatedDeductibleAmount/);
  assert.match(source, /overviewProjection\?\.questionsForYouGroupCount/);
  assert.doesNotMatch(source, /const estimatedDeductibleExpenses = matrixTotals\./);
  assert.match(source, /Your last updated deductions summary is still shown/);
  assert.match(source, /Retry transaction details/);
});

test("initial workspace projection resolves without detail hydration while refresh remains atomic", () => {
  const source = fs.readFileSync(new URL("../src/hooks/tax/useTaxDeductions.js", import.meta.url), "utf8");
  const overviewCommit = source.indexOf("const overviewResult = await overviewPromise");
  assert.ok(overviewCommit > 0);
  assert.match(source, /getTaxWorkspace\(\{ businessId, year, refresh, signal \}\)/);
  assert.match(source, /if \(request === seq\.current\)/);
  assert.match(source, /if \(refreshInFlight\.current\) return refreshInFlight\.current/);
  assert.match(source, /reason\?\.code !== "request_aborted"/);
  assert.match(source, /setOverview\(compatibleOverview\)/);
  assert.doesNotMatch(source.slice(source.indexOf("const load = useCallback"), source.indexOf("const loadSecondaryDetails")), /fetchAllDeductionTransactions/);
});

test("cold-route context hydration starts the v2 read and every current terminal outcome leaves loading", () => {
  const source = fs.readFileSync(new URL("../src/hooks/tax/useTaxDeductions.js", import.meta.url), "utf8");
  const loadBlock = source.slice(source.indexOf("const load = useCallback"), source.indexOf("const loadSecondaryDetails"));
  const initialEffect = source.slice(source.indexOf("useEffect(() => {", source.indexOf("const retryQuestions")));

  assert.match(source, /const requestEnabled = enabled && Boolean\(businessId\)/);
  assert.match(source, /scopeKey = `\$\{businessId \|\| ""\}:\$\{year \|\| ""\}:\$\{asOfDate \|\| ""\}:\$\{enabled \? "enabled" : "disabled"\}`/);
  assert.match(initialEffect, /load\(\{ signal: controller\.signal, refresh: hasSavedOverview \}\)/);
  assert.match(initialEffect, /\[asOfDate, businessId, load, year\]/);
  assert.match(loadBlock, /if \(!enabled \|\| !businessId\) return null/);
  assert.match(loadBlock, /if \(request === seq\.current\)/);
  assert.match(loadBlock, /setRequestStatus\(\(current\) => \(\{ \.\.\.current, scopeKey, overview: "error" \}\)\)/);
  assert.doesNotMatch(loadBlock, /else if \(overviewResult\.reason\?\.code !== "request_aborted"\)/);
  assert.match(loadBlock, /finally \{\s*if \(request === seq\.current\) setLoading\(false\)/);
});

test("the bounded initial failure state exposes Retry through the same workspace read", () => {
  const dashboard = fs.readFileSync(new URL("../src/pages/Tax/TaxDashboard.jsx", import.meta.url), "utf8");
  const hook = fs.readFileSync(new URL("../src/hooks/tax/useTaxDeductions.js", import.meta.url), "utf8");

  assert.match(dashboard, /initialDeductionsError \? \(/);
  assert.match(dashboard, /onClick=\{refreshDeductions\}/);
  assert.match(dashboard, />\s*Retry\s*</);
  assert.match(hook, /refresh: \(options = \{\}\) => \{[\s\S]*load\(\{ \.\.\.options, refresh: true \}\)/);
  assert.doesNotMatch(hook, /refresh: \(options = \{\}\) => \{[\s\S]{0,500}(prepareTaxClassifications|runTaxClassification)/);
});

test("persisted projection renders the matrix without transaction hydration", () => {
  const source = fs.readFileSync(new URL("../src/pages/Tax/TaxDashboard.jsx", import.meta.url), "utf8");
  assert.match(source, /hasProjectedMatrix/);
  assert.match(source, /buildPersistedWorkspaceMatrix\(deductions\.workspaceProjection, year\)/);
  assert.match(source, /loading=\{matrixIsLoading\}/);
  assert.match(source, /!hasProjectedMatrix && !deductions\.allTransactions/);
  assert.match(source, /Transaction details are temporarily unavailable\./);
});

test("optional transaction populations never gate first valid overview paint", () => {
  const requestState = fs.readFileSync(new URL("../src/components/Tax/Deductions/deductionsRequestState.js", import.meta.url), "utf8");
  const hook = fs.readFileSync(new URL("../src/hooks/tax/useTaxDeductions.js", import.meta.url), "utf8");
  assert.equal(resolveDeductionsRenderState({
    sectionStatus: { overview: "success", matrix: "loading", classification: "loading" },
    hasData: true,
    hasSummaryData: true,
  }).state, "ready");
  assert.doesNotMatch(requestState, /hasCompletedWorkspace/);
  assert.match(hook, /Promise\.allSettled\(\[[\s\S]*load\(\{ signal: controller\.signal/);
});

test("headline transaction count comes from the validated overview and never from an unhydrated matrix", () => {
  const source = fs.readFileSync(new URL("../src/pages/Tax/TaxDashboard.jsx", import.meta.url), "utf8");
  assert.match(source, /authoritativeMatrixIncludedCount = Number\(overviewProjection\?\.matrixIncludedCount\)/);
  assert.match(source, /Based on \{authoritativeMatrixIncludedCount\} expense transaction/);
  assert.doesNotMatch(source, /Based on \{populationCounts\.matrixIncludedCount\}/);
});

test("Questions for You renders bounded projection cards and hydrates rows lazily", () => {
  const dashboard = fs.readFileSync(new URL("../src/pages/Tax/TaxDashboard.jsx", import.meta.url), "utf8");
  const hook = fs.readFileSync(new URL("../src/hooks/tax/useTaxDeductions.js", import.meta.url), "utf8");
  assert.match(hook, /getTaxWorkspace/);
  assert.match(hook, /const retryQuestions[\s\S]*fetchAllWorkspaceTransactions/);
  assert.match(hook, /useEffect\(\(\) => \{[\s\S]*load\(\{ signal: controller\.signal, refresh: hasSavedOverview \}\)/);
  assert.match(dashboard, /questionsPanelState === "loading"[\s\S]*QuestionsPanelLoading/);
  assert.match(dashboard, /Loading \$\{count\} questions…/);
  assert.match(dashboard, /Nothing needs your input right now\./);
  assert.match(dashboard, /We couldn’t load your questions\./);
  assert.match(dashboard, /ProjectedQuestionGroups/);
  assert.match(dashboard, /Optional row\/detail[\s\S]*must never replace or erase them/);
  assert.match(dashboard, /onOpen=\{\(group\) => setReviewDecision/);
  assert.doesNotMatch(dashboard, /deductions\.allTransactions\s*\? <AttentionReviewGroups/);
  assert.doesNotMatch(dashboard, /questionsPanelState === "loading"[\s\S]{0,300}customerQuestionSummaryText/);
});

test("question retry is scoped, single-flight, stale-safe, and read-only", () => {
  const hook = fs.readFileSync(new URL("../src/hooks/tax/useTaxDeductions.js", import.meta.url), "utf8");
  assert.match(hook, /if \(questionsRetryInFlight\.current\) return questionsRetryInFlight\.current/);
  assert.match(hook, /if \(request !== seq\.current\) return null/);
  const retryBlock = hook.slice(hook.indexOf("const retryQuestions"), hook.indexOf("useEffect(() =>", hook.indexOf("const retryQuestions")));
  assert.match(retryBlock, /fetchAllWorkspaceTransactions/);
  assert.doesNotMatch(retryBlock, /runTaxClassification|prepareTaxClassifications|confirmGroupedTaxDeductionDecision|saveTaxDeductionDecisionRule/);
});

test("workspace detail hydration has a bounded terminal timeout and remains retryable", async () => {
  await assert.rejects(
    () => withBoundedWorkspaceRead(
      (signal) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "request_aborted" })), { once: true });
      }),
      { timeoutMs: 5, timeoutCode: "tax_deductions_matrix_timeout" }
    ),
    (error) => error.code === "tax_deductions_matrix_timeout" && error.retryable === true
  );

  await assert.rejects(
    () => withBoundedWorkspaceRead(() => new Promise(() => {}), { timeoutMs: 5 }),
    (error) => error.code === "tax_deductions_detail_timeout" && error.retryable === true
  );

  const retried = await withBoundedWorkspaceRead(async () => ({ rows: [] }), { timeoutMs: 20 });
  assert.deepEqual(retried, { rows: [] });
});
