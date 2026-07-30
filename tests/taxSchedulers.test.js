import assert from "node:assert/strict";
import { test } from "node:test";
import { runDailyTaxScheduler } from "../src/services/tax/scheduling/runDailyTaxScheduler.js";
import { runWeeklyTaxScheduler } from "../src/services/tax/scheduling/runWeeklyTaxScheduler.js";
import { runTaxDeadlineScan } from "../src/services/tax/scheduling/runTaxDeadlineScan.js";
import { runTaxReserveFreshnessScan } from "../src/services/tax/scheduling/runTaxReserveFreshnessScan.js";
import { claimTaxSchedulerLock } from "../src/services/tax/scheduling/taxSchedulerPersistence.js";
import { TAX_SCHEDULE_JOB_TYPES } from "../src/services/tax/scheduling/taxScheduleDomain.js";
import { assertInternalSchedulerAccess } from "../src/api/tax/taxSchedulerAuth.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const BUSINESS_2 = "22222222-2222-4222-8222-222222222222";
const TAX_YEAR = 2026;

test("daily scheduler queues eligible businesses and skips fresh unchanged runs", async () => {
  const supabase = makeSupabase({
    business_profiles: [business(BUSINESS_ID), business(BUSINESS_2)],
    tax_profiles: [profile(BUSINESS_ID), profile(BUSINESS_2)],
    qbo_posted_transactions: [posted(BUSINESS_ID), posted(BUSINESS_2)],
    tax_calculation_runs: [completedRun(BUSINESS_2, "2026-07-14T03:00:00.000Z")],
  });

  const result = await runDailyTaxScheduler({
    supabase,
    scheduledFor: date("2026-07-14T00:00:00Z"),
    taxYear: TAX_YEAR,
    now: date("2026-07-14T12:00:00Z"),
    runDeadlineScan: async () => ({ actionableCount: 0 }),
    runReserveScan: async () => ({ queued: false }),
  });

  assert.equal(result.businessesScanned, 2);
  assert.equal(result.businessesEligible, 1);
  assert.equal(result.requestsQueued, 1);
  assert.equal(result.skipReasons.recent_run_fresh, 1);
  assert.equal(supabase.store.tax_recalculation_requests[0].trigger_source, "daily_cron");
});

test("incomplete profile is skipped as setup state, not scheduler failure", async () => {
  const supabase = makeSupabase({
    business_profiles: [business(BUSINESS_ID)],
    tax_profiles: [{ ...profile(BUSINESS_ID), filing_status: "unknown", profile_status: "incomplete" }],
    qbo_posted_transactions: [posted(BUSINESS_ID)],
  });

  const result = await runDailyTaxScheduler({
    supabase,
    scheduledFor: date("2026-07-14T00:00:00Z"),
    taxYear: TAX_YEAR,
    now: date("2026-07-14T12:00:00Z"),
  });

  assert.equal(result.failures, 0);
  assert.equal(result.requestsQueued, 0);
  assert.equal(result.skipReasons.profile_incomplete, 1);
});

test("one business queue failure does not stop the whole daily batch", async () => {
  const supabase = makeSupabase({
    business_profiles: [business(BUSINESS_ID), business(BUSINESS_2)],
    tax_profiles: [profile(BUSINESS_ID), profile(BUSINESS_2)],
    qbo_posted_transactions: [posted(BUSINESS_ID), posted(BUSINESS_2)],
  });
  let calls = 0;
  const result = await runDailyTaxScheduler({
    supabase,
    scheduledFor: date("2026-07-14T00:00:00Z"),
    taxYear: TAX_YEAR,
    now: date("2026-07-14T12:00:00Z"),
    handleEvent: async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary queue failure");
      return { queued: true };
    },
    runDeadlineScan: async () => ({ actionableCount: 0 }),
    runReserveScan: async () => ({ queued: false }),
  });

  assert.equal(result.businessesEligible, 2);
  assert.equal(result.failures, 1);
  assert.equal(result.requestsQueued, 1);
});

test("weekly scheduler uses weekly cron source and does not force duplicate runs", async () => {
  const supabase = makeSupabase({
    business_profiles: [business(BUSINESS_ID)],
    tax_profiles: [profile(BUSINESS_ID)],
    qbo_posted_transactions: [posted(BUSINESS_ID)],
  });

  const result = await runWeeklyTaxScheduler({
    supabase,
    scheduledFor: date("2026-07-13T00:00:00Z"),
    taxYear: TAX_YEAR,
    now: date("2026-07-14T12:00:00Z"),
  });

  assert.equal(result.requestsQueued, 1);
  assert.equal(supabase.store.tax_recalculation_requests[0].trigger_source, "weekly_cron");
  assert.equal(supabase.store.tax_recalculation_requests[0].event_type, "financial_source_sync_completed");
});

test("scheduler lock blocks concurrent worker and recovers stale lock", async () => {
  const supabase = makeSupabase();
  const scheduledFor = date("2026-07-14T00:00:00Z");
  const first = await claimTaxSchedulerLock({
    supabase,
    jobType: TAX_SCHEDULE_JOB_TYPES.DAILY_CALCULATION,
    scheduledFor,
    workerId: "worker-a",
    now: date("2026-07-14T00:00:00Z"),
    lockTtlSeconds: 60,
  });
  const second = await claimTaxSchedulerLock({
    supabase,
    jobType: TAX_SCHEDULE_JOB_TYPES.DAILY_CALCULATION,
    scheduledFor,
    workerId: "worker-b",
    now: date("2026-07-14T00:00:10Z"),
    lockTtlSeconds: 60,
  });
  const stale = await claimTaxSchedulerLock({
    supabase,
    jobType: TAX_SCHEDULE_JOB_TYPES.DAILY_CALCULATION,
    scheduledFor,
    workerId: "worker-c",
    now: date("2026-07-14T00:02:00Z"),
    lockTtlSeconds: 60,
  });

  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(second.reason, "already_running");
  assert.equal(stale.claimed, true);
  assert.equal(stale.reason, "reclaimed");
});

test("daily scheduler paginates over many businesses", async () => {
  const ids = Array.from({ length: 5 }, (_, index) => `${index + 1}`.repeat(32).slice(0, 36));
  const supabase = makeSupabase({
    business_profiles: ids.map((id) => business(id)),
    tax_profiles: ids.map((id) => profile(id)),
    qbo_posted_transactions: ids.map((id) => posted(id)),
  });

  const result = await runDailyTaxScheduler({
    supabase,
    scheduledFor: date("2026-07-14T00:00:00Z"),
    taxYear: TAX_YEAR,
    pageSize: 2,
    now: date("2026-07-14T12:00:00Z"),
    runDeadlineScan: async () => ({ actionableCount: 0 }),
    runReserveScan: async () => ({ queued: false }),
  });

  assert.equal(result.businessesScanned, 5);
  assert.equal(result.requestsQueued, 5);
  assert.equal(supabase.store.tax_recalculation_requests.length, 5);
});

test("deadline scan uses canonical deadline data and detects overdue without hardcoded dates", async () => {
  const supabase = makeSupabase({
    tax_calculation_runs: [{
      business_id: BUSINESS_ID,
      tax_year: TAX_YEAR,
      status: "completed",
      completed_at: "2026-07-10T00:00:00.000Z",
      deadlines: [{ id: "deadline-1", name: "Estimated payment", dueDate: "2026-07-01", amount: 500 }],
    }],
  });

  const result = await runTaxDeadlineScan({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: TAX_YEAR,
    now: date("2026-07-14T12:00:00Z"),
  });

  assert.equal(result.actionableCount, 1);
  assert.equal(result.deadlines[0].status, "overdue");
  assert.equal(result.insightContexts[0].sourceEventId.includes("deadline-1"), true);
});

test("reserve scan keeps missing reserve account null and does not queue fake zero reserve", async () => {
  const supabase = makeSupabase({ tax_reserve_accounts: [] });
  const result = await runTaxReserveFreshnessScan({
    supabase,
    businessId: BUSINESS_ID,
    taxYear: TAX_YEAR,
    now: date("2026-07-14T12:00:00Z"),
  });

  assert.equal(result.reserveReady, false);
  assert.equal(result.currentReserve, null);
  assert.equal(result.queued, false);
  assert.equal(result.reason, "reserve_account_missing");
});

test("ordinary users cannot invoke internal scheduler route without secret", () => {
  const previous = process.env.TAX_SCHEDULER_INTERNAL_SECRET;
  process.env.TAX_SCHEDULER_INTERNAL_SECRET = "secret";
  assert.throws(() => assertInternalSchedulerAccess({ headers: {} }), /Internal scheduler access required/);
  assert.equal(assertInternalSchedulerAccess({ headers: { "x-internal-cron-secret": "secret" } }), true);
  process.env.TAX_SCHEDULER_INTERNAL_SECRET = previous;
});

function makeSupabase(store = {}) {
  return {
    store: {
      tax_recalculation_requests: [],
      tax_calculation_runs: [],
      tax_scheduler_runs: [],
      scheduled_job_locks: [],
      tax_reserve_accounts: [],
      ...store,
    },
  };
}

function business(id) {
  return { id, owner_user_id: `${id}-owner`, status: "active", is_active: true };
}

function profile(businessId) {
  return {
    id: `${businessId}-profile`,
    business_id: businessId,
    tax_year: TAX_YEAR,
    entity_type: "sole_proprietor",
    tax_election: "sole_proprietor",
    filing_status: "single",
    primary_tax_state: "NC",
    accounting_method: "cash",
    profile_status: "active",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
}

function posted(businessId) {
  return { id: `${businessId}-txn`, business_id: businessId, tax_year: TAX_YEAR, date: "2026-07-01", amount: 100 };
}

function completedRun(businessId, completedAt) {
  return { id: `${businessId}-run`, business_id: businessId, tax_year: TAX_YEAR, status: "completed", completed_at: completedAt };
}

function date(value) {
  return new Date(value);
}
