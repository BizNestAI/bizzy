import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import {
  resolveDeductionsRenderState,
  resolveScopedDeductionsRequestStatus,
  selectDeductionsWorkspaceError,
} from "../src/components/Tax/Deductions/deductionsRequestState.js";

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
    { showInitialLoading: true, showInitialError: false, showAuthoritativeData: false, showUpdating: false }
  );
});

test("successful empty and nonempty responses do not render loading or error placeholders", () => {
  for (const hasData of [false, true]) {
    const state = resolveDeductionsRenderState({
      sectionStatus: { overview: "success", matrix: "success", classification: "success" },
      hasData,
    });
    assert.equal(state.showInitialLoading, false);
    assert.equal(state.showInitialError, false);
    assert.equal(state.showAuthoritativeData, hasData);
  }
});

test("only a rejected authoritative overview renders the page-level error", () => {
  assert.deepEqual(
    resolveDeductionsRenderState({
      sectionStatus: { overview: "error", matrix: "success", classification: "success" },
      hasData: false,
    }),
    { showInitialLoading: false, showInitialError: true, showAuthoritativeData: false, showUpdating: false }
  );
});

test("a transaction-detail failure cannot replace an available persisted summary", () => {
  assert.deepEqual(
    resolveDeductionsRenderState({
      sectionStatus: { overview: "success", matrix: "error", classification: "success" },
      hasData: true,
      hasSummaryData: true,
    }),
    { showInitialLoading: false, showInitialError: false, showAuthoritativeData: true, showUpdating: false }
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
    { showInitialLoading: true, showInitialError: false, showAuthoritativeData: false, showUpdating: false }
  );
});

test("background refresh retains authoritative values and exposes an updating status", () => {
  assert.deepEqual(
    resolveDeductionsRenderState({
      sectionStatus: { overview: "success", matrix: "success", classification: "success" },
      hasData: true,
      refreshing: true,
    }),
    { showInitialLoading: false, showInitialError: false, showAuthoritativeData: true, showUpdating: true }
  );
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

test("headline amount and question count come from one overview projection", () => {
  const source = fs.readFileSync(new URL("../src/pages/Tax/TaxDashboard.jsx", import.meta.url), "utf8");
  assert.match(source, /overviewProjection\?\.estimatedDeductibleAmount/);
  assert.match(source, /overviewProjection\?\.questionsForYouGroupCount/);
  assert.doesNotMatch(source, /const estimatedDeductibleExpenses = matrixTotals\./);
  assert.match(source, /Your last updated deductions summary is still shown/);
  assert.match(source, /Retry transaction details/);
});

test("overview commits before detail hydration and refresh is single-flight", () => {
  const source = fs.readFileSync(new URL("../src/hooks/tax/useTaxDeductions.js", import.meta.url), "utf8");
  const overviewCommit = source.indexOf("const overviewResult = await overviewPromise");
  const detailCommit = source.indexOf("await Promise.all(detailPromises)");
  assert.ok(overviewCommit > 0 && detailCommit > overviewCommit);
  assert.match(source, /if \(request === seq\.current\)/);
  assert.match(source, /if \(refreshInFlight\.current\) return refreshInFlight\.current/);
  assert.match(source, /reason\?\.code !== "request_aborted"/);
});

test("cached overview shows a scoped loader until the deductions matrix hydrates", () => {
  const source = fs.readFileSync(new URL("../src/pages/Tax/TaxDashboard.jsx", import.meta.url), "utf8");
  assert.match(source, /matrixRequestStatus === "loading" && !deductions\.allTransactions/);
  assert.match(source, /loading=\{matrixIsLoading\}/);
  assert.match(source, /Loading monthly deductions…/);
  assert.match(source, /role="status" aria-busy="true" aria-live="polite"/);
});
