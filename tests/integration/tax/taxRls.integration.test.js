import test from "node:test";
import assert from "node:assert/strict";
import {
  createTaxRlsFixtureContext,
  getTaxRlsIntegrationConfig,
  runDirectSupabaseRlsChecks,
  writeSkippedTaxRlsReport,
} from "./taxRlsHarness.js";

test("real Supabase user sessions enforce Tax RLS and immutable history", async (t) => {
  const config = getTaxRlsIntegrationConfig();
  if (!config.runnable) {
    await writeSkippedTaxRlsReport("direct_supabase", config);
    t.skip(config.reason);
    return;
  }

  const ctx = await createTaxRlsFixtureContext(config);
  t.after(async () => {
    await ctx.cleanup();
  });

  const report = await runDirectSupabaseRlsChecks(ctx);
  assert.equal(
    report.failures.length,
    0,
    report.failures.map((failure) => `${failure.resource}:${failure.actor}:${failure.operation}:${failure.detail}`).join("\n")
  );
});
