import test from "node:test";
import assert from "node:assert/strict";
import {
  createTaxRlsFixtureContext,
  getTaxRlsIntegrationConfig,
  runHttpTenancyChecks,
  writeSkippedTaxRlsReport,
} from "./taxRlsHarness.js";

test("authenticated Tax HTTP APIs deny cross-tenant and internal-route access", async (t) => {
  const config = getTaxRlsIntegrationConfig();
  if (!config.runnable) {
    await writeSkippedTaxRlsReport("http_tenancy", config);
    t.skip(config.reason);
    return;
  }

  const ctx = await createTaxRlsFixtureContext(config);
  t.after(async () => {
    await ctx.cleanup();
  });

  const report = await runHttpTenancyChecks(ctx);
  assert.equal(
    report.failures.length,
    0,
    report.failures.map((failure) => `${failure.resource}:${failure.actor}:${failure.operation}:${failure.detail}`).join("\n")
  );
});
