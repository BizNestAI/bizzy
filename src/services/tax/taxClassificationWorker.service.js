/* global process */
import {
  TAX_CLASSIFICATION_RUN_STATUSES,
  TAX_CLASSIFICATION_SOURCES,
  TAX_CLASSIFICATION_TRIGGER_SOURCES,
  TAX_TRIGGER_SOURCES,
} from "./taxDomain.js";
import {
  claimTaxClassificationRuns,
  completeTaxClassificationRun,
  enqueueTaxClassificationRun,
  failTaxClassificationRun,
  getTaxClassificationLifecycleStatus,
  requeueTaxClassificationRun,
} from "./taxClassificationRun.service.js";
import { classifyPostedTransactionsBatch } from "./taxClassificationEngine.js";
import { listUnclassifiedPostedTransactions } from "./taxPostedTransaction.repository.js";
import { evaluateTaxCalculationPrerequisites } from "./taxCalculationPrerequisites.service.js";
import { handleTaxRecalculationEvent } from "./events/taxRecalculationTrigger.service.js";
import { TAX_RECALCULATION_EVENT_TYPES } from "./events/taxRecalculationEventDomain.js";
import { getBusinessesEligibleForTaxCalculation } from "./scheduling/getBusinessesEligibleForTaxCalculation.js";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_RUN_BATCH_SIZE = 5;
const DEFAULT_TRANSACTION_BATCH_SIZE = 100;
const DEFAULT_REQUEUE_DELAY_MS = 10_000;

let timer = null;
let inFlight = false;
let defaultSupabasePromise = null;

export function isTaxClassificationWorkerEnabled() {
  return process.env.TAX_CLASSIFICATION_WORKER_ENABLED !== "false";
}

export function startTaxClassificationWorker({
  supabase = null,
  intervalMs = Number(process.env.TAX_CLASSIFICATION_WORKER_INTERVAL_MS || DEFAULT_INTERVAL_MS),
  workerId = `tax-classifier-${process.pid || "worker"}`,
} = {}) {
  if (!isTaxClassificationWorkerEnabled()) {
    console.log("[tax-classification-worker] disabled");
    return null;
  }
  if (timer) return timer;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const resolvedSupabase = supabase || await getDefaultSupabase();
      await enqueueRecoveryTaxClassificationRuns({ supabase: resolvedSupabase });
      const result = await processPendingTaxClassificationRuns({ supabase: resolvedSupabase, workerId });
      if (result.processed) {
        console.log("[tax-classification-worker] sweep", {
          processed: result.processed,
          completed: result.completed,
          reviewRequired: result.reviewRequired,
          failed: result.failed,
        });
      }
    } catch (error) {
      console.warn("[tax-classification-worker] sweep failed", sanitizeWorkerError(error));
    } finally {
      inFlight = false;
    }
  };
  timer = setInterval(tick, Math.max(5_000, intervalMs));
  timer.unref?.();
  tick();
  return timer;
}

export function stopTaxClassificationWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  inFlight = false;
}

export async function enqueueRecoveryTaxClassificationRuns({ supabase, taxYear = null, limit = 50 } = {}) {
  const page = await getBusinessesEligibleForTaxCalculation({ supabase, taxYear, pageSize: limit });
  const results = [];
  for (const business of page?.businesses || []) {
    if (business.eligible === false && business.reason !== "recent_run_fresh") continue;
    const profile = business.profile || business.taxProfile || business;
    if (!profile?.business_id || !profile?.tax_year) continue;
    try {
      const lifecycle = await getTaxClassificationLifecycleStatus({ supabase, businessId: profile.business_id, taxYear: profile.tax_year });
      if (lifecycle.classificationStatus !== "ready_to_classify") continue;
      const queued = await enqueueTaxClassificationRun({
        supabase,
        businessId: profile.business_id,
        taxYear: profile.tax_year,
        triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.RECOVERY_SCAN,
        metadata: { source: "scheduled_recovery_scan" },
      });
      results.push(queued);
    } catch (error) {
      console.warn("[tax-classification-worker] recovery enqueue failed", {
        businessId: profile.business_id,
        taxYear: profile.tax_year,
        code: error?.code || error?.name || "classification_recovery_failed",
      });
    }
  }
  return results;
}

export async function processPendingTaxClassificationRuns({
  supabase,
  workerId = `tax-classifier-${process.pid || "worker"}`,
  runBatchSize = DEFAULT_RUN_BATCH_SIZE,
  transactionBatchSize = Number(process.env.TAX_CLASSIFICATION_BATCH_SIZE || DEFAULT_TRANSACTION_BATCH_SIZE),
  now = new Date(),
} = {}) {
  const runs = await claimTaxClassificationRuns({ supabase, workerId, batchSize: runBatchSize, now });
  const results = [];
  for (const run of runs) {
    results.push(await processOneTaxClassificationRun({ supabase, run, transactionBatchSize, now }));
  }
  return {
    processed: results.length,
    completed: results.filter((row) => row.status === TAX_CLASSIFICATION_RUN_STATUSES.COMPLETED).length,
    reviewRequired: results.filter((row) => row.status === TAX_CLASSIFICATION_RUN_STATUSES.REVIEW_REQUIRED).length,
    failed: results.filter((row) => [TAX_CLASSIFICATION_RUN_STATUSES.FAILED, TAX_CLASSIFICATION_RUN_STATUSES.DEAD_LETTER].includes(row.status)).length,
    results,
  };
}

export async function processOneTaxClassificationRun({ supabase, run, transactionBatchSize = DEFAULT_TRANSACTION_BATCH_SIZE, now = new Date() } = {}) {
  const businessId = run.business_id || run.businessId;
  const taxYear = run.tax_year || run.taxYear;
  try {
    const page = await listUnclassifiedPostedTransactions({
      supabase,
      businessId,
      taxYear,
      limit: Math.min(Math.max(Number(transactionBatchSize || DEFAULT_TRANSACTION_BATCH_SIZE), 1), DEFAULT_TRANSACTION_BATCH_SIZE),
      offset: 0,
    });
    const ids = (page.rows || []).map((row) => row.transactionId).filter(Boolean);
    if (ids.length) {
      await classifyPostedTransactionsBatch({
        supabase,
        businessId,
        taxYear,
        transactionIds: ids,
        source: TAX_CLASSIFICATION_SOURCES.RULE_ENGINE,
      });
    }
    const lifecycle = await getTaxClassificationLifecycleStatus({ supabase, businessId, taxYear });
    const progress = {
      totalEligible: lifecycle.eligiblePostedCount,
      processedCount: Math.max(0, Number(lifecycle.classifiedCount || 0) + Number(lifecycle.excludedCount || 0) + Number(lifecycle.failedCount || 0)),
      autoClassifiedCount: lifecycle.autoClassifiedCount,
      reviewRequiredCount: lifecycle.needsReviewCount,
      excludedCount: lifecycle.excludedCount,
      failedCount: lifecycle.failedCount,
      queuedCount: lifecycle.unclassifiedCount,
    };
    if (lifecycle.unclassifiedCount > 0) {
      return requeueTaxClassificationRun({
        supabase,
        runId: run.id,
        progress,
        now,
        processAfter: new Date(now.getTime() + DEFAULT_REQUEUE_DELAY_MS),
      });
    }
    const terminalStatus = lifecycle.needsReviewCount > 0
      ? TAX_CLASSIFICATION_RUN_STATUSES.REVIEW_REQUIRED
      : TAX_CLASSIFICATION_RUN_STATUSES.COMPLETED;
    const completed = await completeTaxClassificationRun({ supabase, runId: run.id, status: terminalStatus, progress, now });
    if (terminalStatus === TAX_CLASSIFICATION_RUN_STATUSES.COMPLETED) {
      await enqueueCalculationIfReady({ supabase, businessId, taxYear, runId: run.id, now });
    }
    return completed;
  } catch (error) {
    return failTaxClassificationRun({
      supabase,
      runId: run.id,
      error,
      now,
      retryAt: new Date(now.getTime() + Math.min(60_000 * 2 ** Math.min(Number(run.attempt_count || 1), 6), 60 * 60 * 1000)),
    });
  }
}

async function enqueueCalculationIfReady({ supabase, businessId, taxYear, runId, now }) {
  const prerequisites = await evaluateTaxCalculationPrerequisites({
    supabase,
    businessId,
    taxYear,
    asOfDate: now.toISOString().slice(0, 10),
  });
  if (!prerequisites.ready) return { queued: false, blocker: prerequisites.blocker };
  return handleTaxRecalculationEvent({
    supabase,
    event: {
      eventType: TAX_RECALCULATION_EVENT_TYPES.TRANSACTION_CLASSIFIED,
      businessId,
      taxYear,
      source: "tax_classification_worker",
      sourceRecordId: runId,
      sourceTable: "tax_classification_runs",
      triggerSource: TAX_TRIGGER_SOURCES.CLASSIFICATION_CHANGED,
      metadata: { classificationRunId: runId },
    },
  });
}

function sanitizeWorkerError(error) {
  return {
    code: error?.code || error?.name || "tax_classification_worker_failed",
    message: "Tax classification worker failed.",
  };
}

async function getDefaultSupabase() {
  defaultSupabasePromise ||= import("../supabaseAdmin.js").then((module) => module.supabase);
  return defaultSupabasePromise;
}
