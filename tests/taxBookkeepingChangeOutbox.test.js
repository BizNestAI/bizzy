import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { processTaxBookkeepingChangeOutbox } from "../src/services/tax/processTaxBookkeepingChangeOutbox.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("outbox RPC serializes the named signature declared by its migration", async () => {
  const migration = read("supabase/migrations/20261101170000_tax_bookkeeping_change_outbox.sql");
  assert.match(migration, /claim_tax_bookkeeping_change_outbox\(\s*p_worker_id text, p_batch_size integer default 10, p_now timestamptz default now\(\)/);
  const now = new Date("2026-11-03T12:00:00.000Z");
  let calls = 0;
  const supabase = createClient("https://example.supabase.co", "test-service-key", {
    global: { fetch: async (url, options) => {
      calls += 1;
      assert.equal(new URL(url).pathname, "/rest/v1/rpc/claim_tax_bookkeeping_change_outbox");
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { p_worker_id: "worker-test", p_batch_size: 7, p_now: now.toISOString() });
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    } },
  });
  assert.deepEqual(await processTaxBookkeepingChangeOutbox({ supabase, workerId: "worker-test", batchSize: 7, now }),
    { processed: 0, completed: 0, failed: 0 });
  assert.equal(calls, 1);
});

test("bookkeeping account changes enqueue a tenant-scoped durable event in the same database transaction", () => {
  const migration = read("supabase/migrations/20261101170000_tax_bookkeeping_change_outbox.sql");
  assert.match(migration, /after update of final_qbo_account_id, final_qbo_account_name/);
  assert.match(migration, /new\.business_id/);
  assert.match(migration, /new\.transaction_id/);
  assert.match(migration, /source_revision/);
  assert.match(migration, /unique.*event_key|event_key text not null unique/i);
  assert.match(migration, /attempt_count/);
  assert.match(migration, /last_error_code/);
  assert.match(migration, /dead_letter/);
  assert.match(migration, /force row level security/);
  assert.match(migration, /for update skip locked/);
});

test("outbox replay is safely retryable and preserves exact business, year, transaction, and revision scope", async () => {
  const row = {
    id: "event-1", business_id: "business-a", transaction_id: "transaction-a", tax_year: 2026,
    source_revision: "revision-a", status: "pending", attempt_count: 0, max_attempts: 8,
    process_after: "2026-11-01T00:00:00.000Z",
  };
  const supabase = { store: { tax_bookkeeping_change_outbox: [row] } };
  const calls = [];
  const first = await processTaxBookkeepingChangeOutbox({
    supabase, workerId: "worker-a", now: new Date("2026-11-01T01:00:00.000Z"),
    synchronize: async (scope) => calls.push(scope),
  });
  assert.deepEqual(first, { processed: 1, completed: 1, failed: 0 });
  assert.deepEqual(calls.map(({ businessId, taxYear, entityId, metadata }) => ({ businessId, taxYear, entityId, metadata })), [{
    businessId: "business-a", taxYear: 2026, entityId: "transaction-a",
    metadata: { source: "tax_bookkeeping_change_outbox", sourceRevision: "revision-a" },
  }]);
  assert.equal(row.status, "completed");
  const replay = await processTaxBookkeepingChangeOutbox({ supabase, workerId: "worker-b", now: new Date("2026-11-01T02:00:00.000Z"), synchronize: async () => assert.fail("completed event replayed") });
  assert.equal(replay.processed, 0);
});

test("failed outbox work remains durable with bounded backoff and dead-letter state", async () => {
  const row = {
    id: "event-2", business_id: "business-a", transaction_id: "transaction-a", tax_year: 2026,
    source_revision: "revision-b", status: "pending", attempt_count: 0, max_attempts: 2,
    process_after: "2026-11-01T00:00:00.000Z",
  };
  const supabase = { store: { tax_bookkeeping_change_outbox: [row] } };
  const fail = async () => { throw Object.assign(new Error("temporary"), { code: "temporary_failure" }); };
  await processTaxBookkeepingChangeOutbox({ supabase, workerId: "worker-a", now: new Date("2026-11-01T01:00:00.000Z"), synchronize: fail });
  assert.equal(row.status, "failed");
  assert.equal(row.last_error_code, "temporary_failure");
  await processTaxBookkeepingChangeOutbox({ supabase, workerId: "worker-a", now: new Date(row.process_after), synchronize: fail });
  assert.equal(row.status, "dead_letter");
  assert.equal(row.attempt_count, 2);
});

test("manual Tax Refresh schedules source-revision keyed recovery and bounded client polling", () => {
  const route = read("src/api/tax/taxWorkspace.routes.js");
  const client = read("src/services/tax/taxApiClient.js");
  const hook = read("src/hooks/tax/useTaxDeductions.js");
  assert.match(route, /router\.post\("\/workspace\/refresh"/);
  assert.match(route, /computeTaxClassificationSourceFingerprint/);
  assert.match(route, /sourceRevision/);
  assert.match(client, /scheduleTaxWorkspaceRefresh/);
  assert.match(hook, /setRebuildPending\(true\)/);
  assert.match(hook, /Date\.now\(\) - startedAt >= 60_000/);
  assert.match(hook, /setRefreshError/);
});
