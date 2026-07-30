import { TAX_RECALCULATION_EVENT_TYPES as EVENTS, TAX_RECALCULATION_PRIORITIES } from "../events/taxRecalculationEventDomain.js";
import { handleTaxRecalculationEvent } from "../events/taxRecalculationTrigger.service.js";
import {
  DEFAULT_TAX_SCHEDULER_PAGE_SIZE,
  TAX_SCHEDULE_JOB_TYPES,
  TAX_SCHEDULER_ELIGIBILITY_REASONS,
  TAX_SCHEDULER_RUN_STATUSES,
  currentTaxYear,
  weekWindow,
} from "./taxScheduleDomain.js";
import { getBusinessesEligibleForTaxCalculation } from "./getBusinessesEligibleForTaxCalculation.js";
import { claimTaxSchedulerLock, createTaxSchedulerRun, finishTaxSchedulerRun } from "./taxSchedulerPersistence.js";

export async function runWeeklyTaxScheduler({
  supabase,
  scheduledFor = weekWindow(new Date()),
  taxYear = currentTaxYear(new Date(scheduledFor)),
  workerId = `tax-weekly:${process.env.HOSTNAME || "local"}:${process.pid || "pid"}`,
  pageSize = DEFAULT_TAX_SCHEDULER_PAGE_SIZE,
  now = new Date(),
  handleEvent = handleTaxRecalculationEvent,
  lockTtlSeconds,
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  const scheduled = scheduledFor instanceof Date ? scheduledFor : new Date(scheduledFor);
  const lock = await claimTaxSchedulerLock({
    supabase,
    jobType: TAX_SCHEDULE_JOB_TYPES.WEEKLY_FULL_RECALCULATION,
    scheduledFor: scheduled,
    workerId,
    lockTtlSeconds,
    metadata: { taxYear },
    now,
  });
  if (!lock.claimed) return { ok: true, skipped: true, reason: lock.reason, jobKey: lock.jobKey, requestsQueued: 0 };

  const run = await createTaxSchedulerRun({
    supabase,
    jobType: TAX_SCHEDULE_JOB_TYPES.WEEKLY_FULL_RECALCULATION,
    scheduledFor: scheduled,
    workerId,
    metadata: { taxYear, jobKey: lock.jobKey },
    now,
  });
  const summary = {
    ok: true,
    schedulerRunId: run.id,
    jobKey: lock.jobKey,
    businessesScanned: 0,
    businessesEligible: 0,
    requestsQueued: 0,
    businessesSkipped: 0,
    runsReused: 0,
    failures: 0,
    warnings: [],
    skipReasons: {},
  };

  try {
    for (let page = 0; ; page += 1) {
      const eligibility = await getBusinessesEligibleForTaxCalculation({
        supabase,
        taxYear,
        page,
        pageSize,
        now,
        freshnessHours: 0,
      });
      summary.businessesScanned += eligibility.businesses.length;
      for (const item of eligibility.businesses) {
        if (!item.eligible) {
          summary.businessesSkipped += 1;
          summary.skipReasons[item.reason] = (summary.skipReasons[item.reason] || 0) + 1;
          if (item.reason === TAX_SCHEDULER_ELIGIBILITY_REASONS.RECENT_RUN_FRESH) summary.runsReused += 1;
          continue;
        }
        summary.businessesEligible += 1;
        try {
          const queued = await handleEvent({
            supabase,
            force: false,
            now,
            event: weeklyCalculationEvent({ item, scheduled, now }),
          });
          if (queued?.queued) summary.requestsQueued += 1;
          else if (queued?.outcome === "skip_duplicate") summary.runsReused += 1;
        } catch (err) {
          summary.failures += 1;
          summary.warnings.push(safeWarning("weekly_queue_failed", item.businessId, err));
        }
      }
      if (!eligibility.hasMore) break;
    }

    await finishTaxSchedulerRun({
      supabase,
      runId: run.id,
      lockId: lock.lockId,
      patch: runPatch(summary, TAX_SCHEDULER_RUN_STATUSES.COMPLETED),
      now,
    });
    return summary;
  } catch (err) {
    summary.ok = false;
    summary.failures += 1;
    summary.warnings.push(safeWarning("weekly_scheduler_failed", null, err));
    await finishTaxSchedulerRun({
      supabase,
      runId: run.id,
      lockId: lock.lockId,
      patch: runPatch(summary, TAX_SCHEDULER_RUN_STATUSES.FAILED),
      now,
    });
    throw err;
  }
}

function weeklyCalculationEvent({ item, scheduled, now }) {
  return {
    eventId: `weekly_tax_full_recalculation:${item.businessId}:${item.taxYear}:${scheduled.toISOString().slice(0, 10)}`,
    eventType: EVENTS.FINANCIAL_SOURCE_SYNC_COMPLETED,
    businessId: item.businessId,
    taxYear: item.taxYear,
    occurredAt: now.toISOString(),
    source: "tax_scheduler_weekly",
    sourceRecordId: scheduled.toISOString().slice(0, 10),
    sourceTable: "tax_scheduler_runs",
    triggerPriority: TAX_RECALCULATION_PRIORITIES.NORMAL,
    materiality: { transactionCount: 0 },
    metadata: { schedulerJobType: TAX_SCHEDULE_JOB_TYPES.WEEKLY_FULL_RECALCULATION },
  };
}

function runPatch(summary, status) {
  return {
    status,
    businesses_scanned: summary.businessesScanned,
    businesses_eligible: summary.businessesEligible,
    requests_queued: summary.requestsQueued,
    businesses_skipped: summary.businessesSkipped,
    runs_reused: summary.runsReused,
    failures: summary.failures,
    warnings: summary.warnings,
    metadata: { skipReasons: summary.skipReasons, jobKey: summary.jobKey },
  };
}

function safeWarning(code, businessId, err) {
  return { code, businessId, message: String(err?.message || err || "unknown").slice(0, 500) };
}

export default runWeeklyTaxScheduler;
