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
  failExhaustedActiveTaxClassificationRuns,
  failTaxClassificationRun,
  getTaxClassificationLifecycleStatus,
  heartbeatTaxClassificationRun,
  requeueTaxClassificationRun,
} from "./taxClassificationRun.service.js";
import { classifyPostedTransactionsBatch } from "./taxClassificationEngine.js";
import { repairUnresolvedFallbackClassifications } from "./taxClassificationFallbackRepair.service.js";
import { listUnclassifiedPostedTransactions } from "./taxPostedTransaction.repository.js";
import { listDeductionRules } from "./taxDeductionRule.repository.js";
import { getTaxProfile } from "./taxProfile.service.js";
import { evaluateTaxCalculationPrerequisites } from "./taxCalculationPrerequisites.service.js";
import { handleTaxRecalculationEvent } from "./events/taxRecalculationTrigger.service.js";
import { TAX_RECALCULATION_EVENT_TYPES } from "./events/taxRecalculationEventDomain.js";
import { getBusinessesEligibleForTaxClassification } from "./taxClassificationRecovery.service.js";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_RUN_BATCH_SIZE = 5;
const DEFAULT_TRANSACTION_BATCH_SIZE = 100;
const DEFAULT_REQUEUE_DELAY_MS = 10_000;
const DEFAULT_MAX_BATCHES_PER_CLAIM = 10;

let timer = null;
let inFlight = false;
let kickInFlight = false;
let defaultSupabasePromise = null;

export function isTaxClassificationWorkerEnabled() {
  return parseTaxClassificationWorkerEnabled(process.env.TAX_CLASSIFICATION_WORKER_ENABLED).enabled;
}

export function parseTaxClassificationWorkerEnabled(value) {
  if (value == null || String(value).trim() === "") {
    return { enabled: true, source: "default", reason: "unset_defaults_enabled" };
  }
  const normalized = String(value).trim().toLowerCase();
  if (["false", "0", "no", "off", "disabled"].includes(normalized)) {
    return { enabled: false, source: "env", reason: "explicitly_disabled" };
  }
  if (["true", "1", "yes", "on", "enabled"].includes(normalized)) {
    return { enabled: true, source: "env", reason: "explicitly_enabled" };
  }
  return { enabled: true, source: "env", reason: "unrecognized_value_defaults_enabled" };
}

export function startTaxClassificationWorker({
  supabase = null,
  intervalMs = Number(process.env.TAX_CLASSIFICATION_WORKER_INTERVAL_MS || DEFAULT_INTERVAL_MS),
  workerId = `tax-classifier-${process.pid || "worker"}`,
} = {}) {
  const enabledConfig = parseTaxClassificationWorkerEnabled(process.env.TAX_CLASSIFICATION_WORKER_ENABLED);
  if (!enabledConfig.enabled) {
    console.log("[tax-classification-worker] disabled", { reason: enabledConfig.reason });
    return null;
  }
  if (timer) return timer;
  console.log("[tax-classification-worker] enabled", {
    reason: enabledConfig.reason,
    intervalMs: Math.max(5_000, intervalMs),
  });
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const resolvedSupabase = supabase || await getDefaultSupabase();
      const exhausted = await failExhaustedActiveTaxClassificationRuns({ supabase: resolvedSupabase });
      if (exhausted.length) {
        console.warn("[tax-classification-worker] exhausted active runs dead-lettered", {
          count: exhausted.length,
          runIds: exhausted.map((run) => run.id).filter(Boolean),
        });
      }
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
  kickInFlight = false;
}

export function requestTaxClassificationWorkerKick({
  supabase = null,
  workerId = `tax-classifier-kick-${process.pid || "worker"}`,
} = {}) {
  if (!isTaxClassificationWorkerEnabled() || kickInFlight) return Promise.resolve({ processed: 0, skipped: true });
  kickInFlight = true;
  return Promise.resolve()
    .then(async () => {
      const resolvedSupabase = supabase || await getDefaultSupabase();
      return processPendingTaxClassificationRuns({ supabase: resolvedSupabase, workerId, runBatchSize: 1 });
    })
    .catch((error) => {
      console.warn("[tax-classification-worker] kick failed", sanitizeWorkerError(error));
      return { processed: 0, failed: 1, error: sanitizeWorkerError(error) };
    })
    .finally(() => {
      kickInFlight = false;
    });
}

export async function enqueueRecoveryTaxClassificationRuns({ supabase, taxYear = null, limit = 50 } = {}) {
  const page = await getBusinessesEligibleForTaxClassification({ supabase, taxYear, pageSize: limit });
  const results = [];
  for (const business of page?.businesses || []) {
    if (business.eligible === false) continue;
    const businessId = business.businessId || business.business_id || business.profile?.business_id;
    const year = business.taxYear || business.tax_year || business.profile?.tax_year;
    if (!businessId || !year) continue;
    try {
      const lifecycle = business.lifecycle || await getTaxClassificationLifecycleStatus({ supabase, businessId, taxYear: year });
      if (lifecycle.classificationStatus !== "ready_to_classify") continue;
      const queued = await enqueueTaxClassificationRun({
        supabase,
        businessId,
        taxYear: year,
        triggerSource: TAX_CLASSIFICATION_TRIGGER_SOURCES.RECOVERY_SCAN,
        metadata: { source: "scheduled_recovery_scan" },
      });
      console.log("[tax-classification-worker] recovery enqueue", {
        businessId,
        taxYear: year,
        runId: queued.run?.id || null,
        outcome: queued.outcome,
        affectedTransactionCount: queued.run?.queued_count || queued.unclassifiedCount || 0,
      });
      results.push(queued);
    } catch (error) {
      console.warn("[tax-classification-worker] recovery enqueue failed", {
        businessId,
        taxYear: year,
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
  if (runs.length) {
    console.log("[tax-classification-worker] claimed", {
      workerId,
      runCount: runs.length,
      runIds: runs.map((run) => run.id).filter(Boolean),
    });
  }
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
    await validateDeductionRuleConfiguration({ supabase, businessId, taxYear });
    if ((run.metadata || run.meta)?.repairMode === "unresolved_fallback") {
      const repaired = await repairUnresolvedFallbackClassifications({
        supabase,
        businessId,
        taxYear,
        limit: Math.min(Math.max(Number(transactionBatchSize || DEFAULT_TRANSACTION_BATCH_SIZE), 1), DEFAULT_TRANSACTION_BATCH_SIZE),
        actorUserId: run.metadata?.actor_user_id || null,
      });
      const lifecycle = await getTaxClassificationLifecycleStatus({ supabase, businessId, taxYear });
      const remaining = Number(lifecycle.unresolvedCount || 0);
      const progress = {
        totalEligible: lifecycle.eligiblePostedCount,
        processedCount: Math.max(0, Number(lifecycle.evaluatedCount ?? lifecycle.classifiedCount ?? 0) + Number(lifecycle.failedCount || 0)),
        autoClassifiedCount: lifecycle.autoClassifiedCount,
        reviewRequiredCount: lifecycle.needsReviewCount,
        excludedCount: lifecycle.excludedCount,
        failedCount: repaired.failures,
        queuedCount: remaining,
      };
      if (remaining > 0 && repaired.attempted > 0 && repaired.calculated + repaired.meaningfulNeedsReview + repaired.excluded + repaired.failures > 0) {
        return requeueTaxClassificationRun({
          supabase,
          runId: run.id,
          progress,
          now,
          processAfter: new Date(now.getTime() + DEFAULT_REQUEUE_DELAY_MS),
        });
      }
      const terminalStatus = remaining > 0 || Number(lifecycle.needsReviewCount || 0) > 0 || repaired.failures > 0
        ? TAX_CLASSIFICATION_RUN_STATUSES.REVIEW_REQUIRED
        : TAX_CLASSIFICATION_RUN_STATUSES.COMPLETED;
      return completeTaxClassificationRun({ supabase, runId: run.id, status: terminalStatus, progress, now });
    }
    const batchLimit = Math.min(Math.max(Number(transactionBatchSize || DEFAULT_TRANSACTION_BATCH_SIZE), 1), DEFAULT_TRANSACTION_BATCH_SIZE);
    let selectedTotal = 0;
    for (let batchIndex = 0; batchIndex < DEFAULT_MAX_BATCHES_PER_CLAIM; batchIndex += 1) {
      const page = await listUnclassifiedPostedTransactions({
        supabase,
        businessId,
        taxYear,
        limit: batchLimit,
        offset: 0,
      });
      const ids = (page.rows || []).map((row) => row.transactionId).filter(Boolean);
      if (!ids.length) break;
      selectedTotal += ids.length;
      const batch = await classifyPostedTransactionsBatch({
        supabase,
        businessId,
        taxYear,
        transactionIds: ids,
        source: TAX_CLASSIFICATION_SOURCES.RULE_ENGINE,
      });
      assertBatchMadeProgress({ batch, selectedCount: ids.length, run });
      const batchLifecycle = await getTaxClassificationLifecycleStatus({ supabase, businessId, taxYear });
      const batchRemaining = Number(batchLifecycle.missingEvaluationCount ?? batchLifecycle.remainingCount ?? 0);
      await heartbeatTaxClassificationRun({
        supabase,
        runId: run.id,
        progress: progressFromLifecycle(batchLifecycle, batchRemaining),
        now: new Date(now.getTime() + batchIndex + 1),
      });
      if (batchRemaining <= 0) break;
    }
    if (selectedTotal <= 0 && (Number(run.queued_count || run.queuedCount || 0) > 0 || Number(run.total_eligible || run.totalEligible || 0) > 0)) {
      throw classificationWorkerInvariantError("candidate_snapshot_mismatch", "Classification run expected remaining transactions but selected none.", {
        selectedCount: 0,
        expectedRemaining: Number(run.queued_count || run.queuedCount || 0),
        totalEligible: Number(run.total_eligible || run.totalEligible || 0),
      });
    }
    const lifecycle = await getTaxClassificationLifecycleStatus({ supabase, businessId, taxYear });
    const remainingCandidateCount = Number(lifecycle.missingEvaluationCount ?? lifecycle.remainingCount ?? lifecycle.unclassifiedCount ?? 0);
    const progress = progressFromLifecycle(lifecycle, remainingCandidateCount);
    if (remainingCandidateCount > 0) {
      console.log("[tax-classification-worker] progress", {
        businessId,
        taxYear,
        runId: run.id,
        processed: progress.processedCount,
        remaining: remainingCandidateCount,
        autoClassified: progress.autoClassifiedCount,
        needsReview: progress.reviewRequiredCount,
      });
      return requeueTaxClassificationRun({
        supabase,
        runId: run.id,
        progress,
        now,
        processAfter: new Date(now.getTime() + DEFAULT_REQUEUE_DELAY_MS),
      });
    }
    const terminalStatus = Number(lifecycle.needsReviewCount || 0) > 0 || Number(lifecycle.unresolvedCount || 0) > 0
      ? TAX_CLASSIFICATION_RUN_STATUSES.REVIEW_REQUIRED
      : TAX_CLASSIFICATION_RUN_STATUSES.COMPLETED;
    const completed = await completeTaxClassificationRun({ supabase, runId: run.id, status: terminalStatus, progress, now });
    console.log("[tax-classification-worker] completed", {
      businessId,
      taxYear,
      runId: run.id,
      status: terminalStatus,
      processed: progress.processedCount,
      autoClassified: progress.autoClassifiedCount,
      needsReview: progress.reviewRequiredCount,
      excluded: progress.excludedCount,
      failed: progress.failedCount,
    });
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

function progressFromLifecycle(lifecycle, remainingCandidateCount) {
  return {
    totalEligible: lifecycle.eligiblePostedCount,
    processedCount: Math.max(0, Number(lifecycle.evaluatedCount ?? lifecycle.classifiedCount ?? 0) + Number(lifecycle.failedCount || 0)),
    autoClassifiedCount: lifecycle.autoClassifiedCount,
    reviewRequiredCount: lifecycle.needsReviewCount,
    excludedCount: lifecycle.excludedCount,
    failedCount: lifecycle.failedCount,
    queuedCount: remainingCandidateCount,
  };
}

async function validateDeductionRuleConfiguration({ supabase, businessId, taxYear }) {
  const profile = await getTaxProfile({ supabase, businessId, taxYear, includeBusinessDefaults: false });
  await listDeductionRules({
    supabase,
    businessId,
    taxYear,
    entityType: profile?.entity_type,
  });
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

function assertBatchMadeProgress({ batch, selectedCount, run }) {
  const persistedOrPreserved = Number(batch?.classified || 0) + Number(batch?.skippedConfirmed || 0);
  if (selectedCount > 0 && persistedOrPreserved <= 0 && Number(batch?.failed || 0) > 0) {
    const first = batch.errors?.[0] || {};
    throw classificationWorkerInvariantError(first.code || "classification_batch_all_failed", "Classification batch selected transactions but persisted no outcomes.", {
      selectedCount,
      failedCount: Number(batch.failed || 0),
      attempted: Number(batch.attempted || 0),
      runId: run?.id || null,
    });
  }
}

function classificationWorkerInvariantError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

async function getDefaultSupabase() {
  defaultSupabasePromise ||= import("../supabaseAdmin.js").then((module) => module.supabase);
  return defaultSupabasePromise;
}
