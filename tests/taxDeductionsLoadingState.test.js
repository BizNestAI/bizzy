import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import {
  resolveDeductionsRenderState,
  resolveScopedDeductionsRequestStatus,
} from "../src/components/Tax/Deductions/deductionsRequestState.js";

test("a newly enabled scope is loading synchronously before its effect runs", () => {
  assert.deepEqual(
    resolveScopedDeductionsRequestStatus({
      requestStatus: { scopeKey: ":2026::enabled", matrix: "idle", classification: "idle" },
      scopeKey: "business-1:2026::enabled",
      enabled: true,
    }),
    { scopeKey: "business-1:2026::enabled", matrix: "loading", classification: "loading" }
  );
});

test("unresolved initial requests render loading rather than authoritative zero data", () => {
  assert.deepEqual(
    resolveDeductionsRenderState({
      sectionStatus: { matrix: "loading", classification: "loading" },
      hasData: false,
    }),
    { showInitialLoading: true, showInitialError: false, showAuthoritativeData: false, showUpdating: false }
  );
});

test("successful empty and nonempty responses do not render loading or error placeholders", () => {
  for (const hasData of [false, true]) {
    const state = resolveDeductionsRenderState({
      sectionStatus: { matrix: "success", classification: "success" },
      hasData,
    });
    assert.equal(state.showInitialLoading, false);
    assert.equal(state.showInitialError, false);
    assert.equal(state.showAuthoritativeData, hasData);
  }
});

test("a rejected initial request renders an error and never the zero-valued data surface", () => {
  assert.deepEqual(
    resolveDeductionsRenderState({
      sectionStatus: { matrix: "error", classification: "success" },
      hasData: false,
    }),
    { showInitialLoading: false, showInitialError: true, showAuthoritativeData: false, showUpdating: false }
  );
});

test("background refresh retains authoritative values and exposes an updating status", () => {
  assert.deepEqual(
    resolveDeductionsRenderState({
      sectionStatus: { matrix: "success", classification: "success" },
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
  assert.match(source, /motion-safe:animate-pulse/);
  assert.match(source, /motion-reduce:hidden/);
  assert.match(source, /initialDeductionsError \? \(/);
  assert.match(source, /matrix\.accounts\.length \? \(/);
  assert.match(source, /Existing deduction data remains on screen and may be stale/);
});
