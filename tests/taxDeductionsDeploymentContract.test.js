import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  TAX_DEDUCTIONS_OVERVIEW_PROJECTION_VERSION,
  validateTaxDeductionsOverviewResponse,
} from "../src/services/tax/taxDeductionsOverviewContract.js";

const businessId = "11111111-1111-4111-8111-111111111111";

function currentResponse(overrides = {}) {
  return {
    ok: true,
    requestId: "request-current",
    data: {
      meta: { generatedAt: "2026-10-23T12:00:00.000Z" },
      totals: { estimatedDeductibleAmount: 8524 },
      categories: [],
      projection: {
        projectionId: "projection-1",
        projectionVersion: TAX_DEDUCTIONS_OVERVIEW_PROJECTION_VERSION,
        canonicalBusinessId: businessId,
        taxYear: 2026,
        refreshedAt: "2026-10-23T12:00:00.000Z",
        estimatedDeductibleAmount: 8524,
        evaluatedTransactionCount: 713,
        matrixIncludedCount: 689,
        outsideDeductionsCount: 24,
        questionsForYouGroupCount: 8,
        ...overrides,
      },
    },
  };
}

test("current frontend accepts the current backend deductions overview contract", () => {
  const overview = validateTaxDeductionsOverviewResponse(currentResponse(), { businessId, taxYear: 2026 });
  assert.equal(overview.projection.estimatedDeductibleAmount, 8524);
  assert.equal(overview.projection.questionsForYouGroupCount, 8);
});

test("old or incomplete backend responses fail with a bounded safe version code", () => {
  for (const response of [
    { ok: true, data: { totals: { estimatedDeductibleAmount: 8524 }, categories: [] }, requestId: "old-backend" },
    currentResponse({ projectionVersion: "tax-deductions-overview-v0" }),
    currentResponse({ estimatedDeductibleAmount: null }),
  ]) {
    assert.throws(
      () => validateTaxDeductionsOverviewResponse(response, { businessId, taxYear: 2026 }),
      (error) => error.code === "tax_deductions_overview_version_mismatch" && error.requestId != null
    );
  }
});

test("scope mismatches cannot overwrite the verified business-year overview", () => {
  assert.throws(
    () => validateTaxDeductionsOverviewResponse(currentResponse(), { businessId, taxYear: 2025 }),
    (error) => error.code === "tax_deductions_overview_version_mismatch"
  );
  assert.throws(
    () => validateTaxDeductionsOverviewResponse(currentResponse(), { businessId: "22222222-2222-4222-8222-222222222222", taxYear: 2026 }),
    (error) => error.code === "tax_deductions_overview_version_mismatch"
  );
});

test("Tax overview startup contract has its required migration-backed schema and mounted route", () => {
  const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const taxRouter = fs.readFileSync(new URL("../src/api/tax/index.js", import.meta.url), "utf8");
  const migrations = fs.readdirSync(new URL("../supabase/migrations", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => fs.readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8"))
    .join("\n");
  assert.match(server, /app\.use\("\/api\/tax"/);
  assert.match(taxRouter, /router\.use\("\/deductions", taxDeductionsRouter\)/);
  assert.match(migrations, /transaction_tax_classifications/i);
  assert.match(migrations, /tax_deduction_rules/i);
  assert.match(migrations, /get_tax_deduction_transaction_drilldown/i);
});

test("retry remains a deduplicated read-only operation", () => {
  const hook = fs.readFileSync(new URL("../src/hooks/tax/useTaxDeductions.js", import.meta.url), "utf8");
  const client = fs.readFileSync(new URL("../src/services/tax/taxApiClient.js", import.meta.url), "utf8");
  assert.match(hook, /if \(refreshInFlight\.current\) return refreshInFlight\.current/);
  assert.match(client, /if \(inflight\.has\(cacheKey\)\) return waitForCaller/);
  assert.doesNotMatch(hook, /prepareTaxClassifications\([^)]*refresh/);
  assert.doesNotMatch(hook, /runTaxClassification\([^)]*refresh/);
});
