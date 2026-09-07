import { createHash } from "node:crypto";
import {
  TAX_CLASSIFICATION_RUN_STATUSES,
  TAX_CLASSIFICATION_TRIGGER_SOURCES,
  normalizeTaxYear,
} from "./taxDomain.js";
import { TAX_CLASSIFICATION_ENGINE_VERSION } from "./taxEngineVersions.js";
import { getClassificationCoverage } from "./taxClassification.repository.js";
import {
  getTaxClassificationSourceSnapshot,
} from "./taxPostedTransaction.repository.js";
import { validationError } from "./taxErrors.js";

const ACTIVE_STATUSES = new Set([
  TAX_CLASSIFICATION_RUN_STATUSES.QUEUED,
  TAX_CLASSIFICATION_RUN_STATUSES.RUNNING,
]);
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_POLL_AFTER_MS = 2_000;
const SLOW_RUN_MS = 2 * 60 * 1000;
const STALE_RUN_MS = 5 * 60 * 1000;
const RECOVERABLE_ACTIVE_STATUSES = new Set([
  TAX_CLASSIFICATION_RUN_STATUSES.QUEUED,
  TAX_CLASSIFICATION_RUN_STATUSES.RUNNING,
]);

export function getTaxClassificationRulesVersion() {
  return TAX_CLASSIFICATION_ENGINE_VERSION;
}

export async function enqueueTaxClassificationRun({
  supabase,
  businessId,
  taxYear,
  triggerSource = TAX_CLASSIFICATION_TRIGGER_SOURCES.SYSTEM,
  actorUserId = null,
  sourceRecordId = null,
  metadata = {},
  now = new Date(),
} = {}) {
  const year = requireTaxYear(taxYear);
  const snapshot = await getTaxClassificationSourceSnapshot({ supabase, businessId, taxYear: year });
  const sourceFingerprint = computeTaxClassificationSnapshotFingerprint({ businessId, taxYear: year, snapshot });
  const rulesVersion = getTaxClassificationRulesVersion();
  const eligiblePostedCount = Number(snapshot.eligiblePostedCount || 0);
  const candidateCount = Number(snapshot.candidateCount ?? snapshot.transactionIds?.length ?? 0);
  const unclassifiedCount = Number(snapshot.unclassifiedCount ?? candidateCount ?? 0);
  const unresolvedCount = Number(snapshot.unresolvedCount || 0);

  if (eligiblePostedCount <= 0 || candidateCount <= 0) {
    return {
      queued: false,
      outcome: unresolvedCount > 0 ? "skip_unresolved_fallback_rows_require_reclassification" : "skip_no_unclassified_transactions",
      run: null,
      status: eligiblePostedCount <= 0
        ? "no_posted_transactions"
        : unresolvedCount > 0
          ? "classifications_required"
          : "classification_complete",
      eligiblePostedCount,
      unclassifiedCount,
      candidateCount,
      unresolvedCount,
    };
  }

  const suppressed = await getSuppressedMatchingTaxClassificationRun({
    supabase,
    businessId,
    taxYear: year,
    sourceFingerprint,
    rulesVersion,
  });
  if (suppressed) {
    return {
      queued: false,
      outcome: "suppressed_repeated_failure",
      run: suppressed,
      status: "classification_failed",
      eligiblePostedCount,
      unclassifiedCount,
    };
  }

  if (isMemorySupabase(supabase)) {
    return enqueueMemoryRun({
      supabase,
      businessId,
      taxYear: year,
      triggerSource,
      actorUserId,
      sourceRecordId,
      metadata,
      now,
      sourceFingerprint,
      rulesVersion,
      eligiblePostedCount,
      unclassifiedCount: candidateCount,
    });
  }

  const row = runToDbRow({
    businessId,
    taxYear: year,
    triggerSource,
    actorUserId,
    sourceRecordId,
    metadata,
    now,
    sourceFingerprint,
    rulesVersion,
    eligiblePostedCount,
    unclassifiedCount: candidateCount,
  });
  const { data, error } = await supabase
    .from("tax_classification_runs")
    .insert(row)
    .select("*")
    .single();
  if (!error) return { queued: true, outcome: "queued", run: data || row };
  if (String(error.code || "") !== "23505") throw error;

  const existing = await getActiveTaxClassificationRun({
    supabase,
    businessId,
    taxYear: year,
    sourceFingerprint,
    rulesVersion,
  });
  if (existing) return { queued: false, outcome: "existing_active_run", run: existing };
  const failed = await getMatchingTaxClassificationRun({
    supabase,
    businessId,
    taxYear: year,
    sourceFingerprint,
    rulesVersion,
    statuses: [TAX_CLASSIFICATION_RUN_STATUSES.FAILED],
  });
  if (failed && Number(failed.attempt_count || 0) < Number(failed.max_attempts || DEFAULT_MAX_ATTEMPTS)) {
    const retried = await updateRun({
      supabase,
      runId: failed.id,
      patch: {
        status: TAX_CLASSIFICATION_RUN_STATUSES.QUEUED,
        locked_at: null,
        locked_by: null,
        failed_at: null,
        dead_lettered_at: null,
        last_error_code: null,
        last_error_message: null,
        process_after: now.toISOString(),
        heartbeat_at: now.toISOString(),
      },
    });
    return { queued: true, outcome: "retried_failed_run", run: retried };
  }
  return { queued: false, outcome: "existing_unretryable_run", run: failed || null };
}

export async function computeTaxClassificationSourceFingerprint({ supabase, businessId, taxYear } = {}) {
  const year = requireTaxYear(taxYear);
  const snapshot = await getTaxClassificationSourceSnapshot({ supabase, businessId, taxYear: year });
  return computeTaxClassificationSnapshotFingerprint({ businessId, taxYear: year, snapshot });
}

export function computeTaxClassificationSnapshotFingerprint({ businessId, taxYear, snapshot = {} } = {}) {
  const ids = (snapshot.transactionIds || snapshot.rows?.map((row) => row.transactionId || row.transaction_id) || [])
    .map((id) => String(id || ""))
    .filter(Boolean);
  const unclassifiedCount = Number(snapshot.unclassifiedCount ?? ids.length);
  const payload = JSON.stringify({
    businessId,
    taxYear,
    rulesVersion: getTaxClassificationRulesVersion(),
    count: unclassifiedCount || ids.length,
    ids: ids.sort(),
  });
  return sha256(payload);
}

export async function getLatestTaxClassificationRun({ supabase, businessId, taxYear } = {}) {
  const year = requireTaxYear(taxYear);
  if (isMemorySupabase(supabase)) {
    return (supabase.store.tax_classification_runs || [])
      .filter((row) => row.business_id === businessId && Number(row.tax_year) === year)
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) || String(b.id || "").localeCompare(String(a.id || "")))[0] || null;
  }
  const { data, error } = await supabase
    .from("tax_classification_runs")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", year)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function getActiveTaxClassificationRun({
  supabase,
  businessId,
  taxYear,
  sourceFingerprint = null,
  rulesVersion = null,
} = {}) {
  const year = requireTaxYear(taxYear);
  if (isMemorySupabase(supabase)) {
    return (supabase.store.tax_classification_runs || []).find((row) =>
      row.business_id === businessId &&
      Number(row.tax_year) === year &&
      (!sourceFingerprint || row.source_fingerprint === sourceFingerprint) &&
      (!rulesVersion || row.rules_version === rulesVersion) &&
      ACTIVE_STATUSES.has(row.status)
    ) || null;
  }
  let query = supabase
    .from("tax_classification_runs")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", year)
    .in("status", [...ACTIVE_STATUSES])
    .order("created_at", { ascending: false })
    .limit(1);
  if (sourceFingerprint) query = query.eq("source_fingerprint", sourceFingerprint);
  if (rulesVersion) query = query.eq("rules_version", rulesVersion);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function getMatchingTaxClassificationRun({
  supabase,
  businessId,
  taxYear,
  sourceFingerprint = null,
  rulesVersion = null,
  statuses = [],
} = {}) {
  const year = requireTaxYear(taxYear);
  const statusSet = new Set((statuses || []).filter(Boolean));
  if (isMemorySupabase(supabase)) {
    return (supabase.store.tax_classification_runs || [])
      .filter((row) =>
        row.business_id === businessId &&
        Number(row.tax_year) === year &&
        (!sourceFingerprint || row.source_fingerprint === sourceFingerprint) &&
        (!rulesVersion || row.rules_version === rulesVersion) &&
        (!statusSet.size || statusSet.has(row.status))
      )
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) || String(b.id || "").localeCompare(String(a.id || "")))[0] || null;
  }
  let query = supabase
    .from("tax_classification_runs")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", year)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1);
  if (sourceFingerprint) query = query.eq("source_fingerprint", sourceFingerprint);
  if (rulesVersion) query = query.eq("rules_version", rulesVersion);
  if (statusSet.size) query = query.in("status", [...statusSet]);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function getSuppressedMatchingTaxClassificationRun({
  supabase,
  businessId,
  taxYear,
  sourceFingerprint,
  rulesVersion,
} = {}) {
  const run = await getMatchingTaxClassificationRun({
    supabase,
    businessId,
    taxYear,
    sourceFingerprint,
    rulesVersion,
    statuses: [TAX_CLASSIFICATION_RUN_STATUSES.DEAD_LETTER],
  });
  if (!run || !isSuppressibleFailureCode(run.last_error_code || run.lastErrorCode)) return null;
  return run;
}

export async function getTaxClassificationLifecycleStatus({ supabase, businessId, taxYear } = {}) {
  const year = requireTaxYear(taxYear);
  const [sourceSnapshot, latestRun, activeRun] = await Promise.all([
    getTaxClassificationSourceSnapshot({ supabase, businessId, taxYear: year }),
    getLatestTaxClassificationRun({ supabase, businessId, taxYear: year }),
    getActiveTaxClassificationRun({ supabase, businessId, taxYear: year }),
  ]);
  const eligiblePostedCount = Number(sourceSnapshot.eligiblePostedCount || 0);
  const coverage = await getClassificationCoverage({ supabase, businessId, taxYear: year, eligiblePostedCount });
  const staleAwareCoverage = {
    ...coverage,
    classifiedCount: sourceSnapshot.classifiedCount,
    unclassifiedCount: sourceSnapshot.unclassifiedCount,
    unresolvedCount: sourceSnapshot.unresolvedCount ?? coverage.unresolvedCount ?? 0,
    missingEvaluationCount: sourceSnapshot.candidateCount ?? coverage.missingEvaluationCount ?? 0,
  };
  const job = buildTaxClassificationJobStatus({ run: activeRun || latestRun, coverage: staleAwareCoverage, now: new Date() });
  const processingCount = activeRun?.status === TAX_CLASSIFICATION_RUN_STATUSES.RUNNING && !hasExhaustedAttempts(activeRun)
    ? Math.max(0, Number(activeRun.queued_count || 0))
    : 0;
  const failedCount = Number(coverage.failedCount || latestRun?.failed_count || 0);
  const normalizedCoverage = {
    ...staleAwareCoverage,
    eligiblePostedCount,
    processingCount,
    remainingCount: activeRun ? job.remaining : sourceSnapshot.candidateCount,
    failedCount,
    jobStatus: job,
    latestRun: latestRun ? normalizeRun(latestRun) : null,
    activeRun: activeRun ? normalizeRun(activeRun) : null,
    lastRunAt: latestRun?.completed_at || latestRun?.failed_at || latestRun?.heartbeat_at || latestRun?.created_at || coverage.lastRunAt || null,
    rulesVersion: latestRun?.rules_version || getTaxClassificationRulesVersion(),
  };
  normalizedCoverage.classificationStatus = deriveLifecycleStatus({ coverage: normalizedCoverage, latestRun, activeRun });
  return normalizedCoverage;
}

export async function getTaxClassificationJobStatus({ supabase, businessId, taxYear } = {}) {
  const year = requireTaxYear(taxYear);
  const [activeRun, latestRun] = await Promise.all([
    getActiveTaxClassificationRun({ supabase, businessId, taxYear: year }),
    getLatestTaxClassificationRun({ supabase, businessId, taxYear: year }),
  ]);
  if (activeRun || latestRun) {
    const sourceSnapshot = await getTaxClassificationSourceSnapshot({ supabase, businessId, taxYear: year });
    const coverage = await getClassificationCoverage({
      supabase,
      businessId,
      taxYear: year,
      eligiblePostedCount: Number(sourceSnapshot.eligiblePostedCount || 0),
    });
    const reconciledCoverage = {
      ...coverage,
      classifiedCount: sourceSnapshot.classifiedCount,
      unclassifiedCount: sourceSnapshot.unclassifiedCount,
    };
    return buildTaxClassificationJobStatus({ run: activeRun || latestRun, coverage: reconciledCoverage });
  }
  const lifecycle = await getTaxClassificationLifecycleStatus({ supabase, businessId, taxYear: year });
  return lifecycle.jobStatus || buildTaxClassificationJobStatus({ run: null, coverage: lifecycle });
}

export async function claimTaxClassificationRuns({ supabase, workerId, batchSize = 5, now = new Date() } = {}) {
  if (isMemorySupabase(supabase)) return claimMemoryRuns({ supabase, workerId, batchSize, now });
  const { data, error } = await supabase.rpc("claim_tax_classification_runs", {
    p_worker_id: workerId,
    p_batch_size: batchSize,
    p_now: now.toISOString(),
  });
  if (error) throw error;
  return data || [];
}

export async function requeueTaxClassificationRun({ supabase, runId, progress = {}, processAfter = new Date(), now = new Date() } = {}) {
  return updateRun({ supabase, runId, patch: {
    status: TAX_CLASSIFICATION_RUN_STATUSES.QUEUED,
    locked_at: null,
    locked_by: null,
    heartbeat_at: now.toISOString(),
    process_after: processAfter.toISOString(),
    ...progressPatch(progress),
  } });
}

export async function heartbeatTaxClassificationRun({ supabase, runId, progress = {}, now = new Date() } = {}) {
  return updateRun({ supabase, runId, patch: {
    status: TAX_CLASSIFICATION_RUN_STATUSES.RUNNING,
    heartbeat_at: now.toISOString(),
    ...progressPatch(progress),
  } });
}

export async function completeTaxClassificationRun({ supabase, runId, status, progress = {}, now = new Date() } = {}) {
  const terminalStatus = status === TAX_CLASSIFICATION_RUN_STATUSES.REVIEW_REQUIRED
    ? TAX_CLASSIFICATION_RUN_STATUSES.REVIEW_REQUIRED
    : TAX_CLASSIFICATION_RUN_STATUSES.COMPLETED;
  return updateRun({ supabase, runId, patch: {
    status: terminalStatus,
    locked_at: null,
    locked_by: null,
    heartbeat_at: now.toISOString(),
    completed_at: now.toISOString(),
    ...progressPatch(progress),
  } });
}

export async function failTaxClassificationRun({ supabase, runId, error, retryAt = null, now = new Date() } = {}) {
  const run = await findRun({ supabase, runId });
  const exhausted = Number(run?.attempt_count || 0) >= Number(run?.max_attempts || DEFAULT_MAX_ATTEMPTS);
  const status = exhausted ? TAX_CLASSIFICATION_RUN_STATUSES.DEAD_LETTER : TAX_CLASSIFICATION_RUN_STATUSES.FAILED;
  return updateRun({ supabase, runId, patch: {
    status,
    locked_at: null,
    locked_by: null,
    heartbeat_at: now.toISOString(),
    failed_at: now.toISOString(),
    dead_lettered_at: exhausted ? now.toISOString() : null,
    process_after: retryAt ? retryAt.toISOString() : now.toISOString(),
    last_error_code: sanitizeErrorCode(error),
    last_error_message: "Tax classification run failed.",
  } });
}

export function mapClassificationStatusToCalculationBlocker(classificationStatus) {
  if (classificationStatus === "classification_complete") return null;
  if (classificationStatus === "classification_review_required") return "classification_review_required";
  if (classificationStatus === "classification_queued" || classificationStatus === "classifying") return "classification_in_progress";
  if (classificationStatus === "classification_failed" || classificationStatus === "failed") return "classification_failed";
  return "classifications_required";
}

function deriveLifecycleStatus({ coverage, latestRun, activeRun }) {
  if (coverage.eligiblePostedCount <= 0) return "no_posted_transactions";
  if (activeRun && hasExhaustedAttempts(activeRun)) return "classification_failed";
  if (activeRun?.status === TAX_CLASSIFICATION_RUN_STATUSES.QUEUED) return "classification_queued";
  if (activeRun?.status === TAX_CLASSIFICATION_RUN_STATUSES.RUNNING) return "classifying";
  if ([TAX_CLASSIFICATION_RUN_STATUSES.FAILED, TAX_CLASSIFICATION_RUN_STATUSES.DEAD_LETTER].includes(latestRun?.status) || coverage.failedCount > 0) return "classification_failed";
  if (coverage.needsReviewCount > 0) return "classification_review_required";
  if (coverage.unclassifiedCount > 0) return "ready_to_classify";
  return "classification_complete";
}

export function buildTaxClassificationJobStatus({ run, coverage = {}, now = new Date() } = {}) {
  const normalizedRun = normalizeRun(run);
  const total = Math.max(0, Number(
    normalizedRun?.totalEligible
    ?? normalizedRun?.total_eligible
    ?? coverage.eligiblePostedCount
    ?? coverage.eligible_posted_count
    ?? 0
  ));
  const coverageProcessed = Number(coverage.evaluatedCount ?? coverage.classifiedCount ?? 0) + Number(coverage.failedCount || 0);
  const runProcessed = normalizedRun?.processedCount ?? normalizedRun?.processed_count ?? null;
  const hasCoverageAuthority = Number.isFinite(Number(coverage.eligiblePostedCount ?? coverage.eligible_posted_count));
  const processed = Math.min(total, Math.max(0, Number(
    hasCoverageAuthority ? coverageProcessed : runProcessed ?? 0
  )));
  const remaining = Math.max(0, Number(
    hasCoverageAuthority
      ? coverage.missingEvaluationCount ?? coverage.missing_evaluation_count ?? coverage.remainingCount ?? coverage.remaining_count ?? coverage.unclassifiedCount ?? coverage.unclassified_count ?? (total - processed)
      : normalizedRun?.queuedCount ?? normalizedRun?.queued_count ?? (total - processed)
  ));
  const rawStatus = normalizedRun?.status || null;
  const isRunning = rawStatus === TAX_CLASSIFICATION_RUN_STATUSES.RUNNING;
  const isQueued = rawStatus === TAX_CLASSIFICATION_RUN_STATUSES.QUEUED;
  const isExhausted = hasExhaustedAttempts(normalizedRun);
  const lastHeartbeatAt = normalizedRun?.heartbeatAt || normalizedRun?.heartbeat_at || normalizedRun?.locked_at || normalizedRun?.startedAt || null;
  const runAgeMs = elapsedMs(normalizedRun?.startedAt || normalizedRun?.queuedAt || normalizedRun?.created_at, now);
  const heartbeatAgeMs = elapsedMs(lastHeartbeatAt, now);
  const isSlow = Number.isFinite(runAgeMs) && runAgeMs >= SLOW_RUN_MS && [TAX_CLASSIFICATION_RUN_STATUSES.QUEUED, TAX_CLASSIFICATION_RUN_STATUSES.RUNNING].includes(rawStatus);
  const isStalled = isRunning && Number.isFinite(heartbeatAgeMs) && heartbeatAgeMs >= STALE_RUN_MS;
  const isDelayed = isQueued && isSlow && !isExhausted;
  const status = publicJobStatus(rawStatus, coverage, { isDelayed, isStalled, isExhausted });
  return {
    jobId: normalizedRun?.id || null,
    status,
    rawStatus,
    total,
    processed,
    remaining,
    autoClassified: Math.max(0, Number(normalizedRun?.autoClassifiedCount ?? normalizedRun?.auto_classified_count ?? coverage.autoClassifiedCount ?? 0)),
    needsReview: Math.max(0, Number(normalizedRun?.reviewRequiredCount ?? normalizedRun?.review_required_count ?? coverage.needsReviewCount ?? 0)),
    unresolved: Math.max(0, Number(coverage.unresolvedCount ?? coverage.unresolved_count ?? 0)),
    excluded: Math.max(0, Number(normalizedRun?.excludedCount ?? normalizedRun?.excluded_count ?? coverage.excludedCount ?? 0)),
    failed: Math.max(0, Number(normalizedRun?.failedCount ?? normalizedRun?.failed_count ?? coverage.failedCount ?? 0)),
    queuedAt: normalizedRun?.queuedAt || normalizedRun?.queued_at || null,
    startedAt: normalizedRun?.startedAt || normalizedRun?.started_at || null,
    heartbeatAt: normalizedRun?.heartbeatAt || normalizedRun?.heartbeat_at || null,
    completedAt: normalizedRun?.completedAt || normalizedRun?.completed_at || null,
    failedAt: normalizedRun?.failedAt || normalizedRun?.failed_at || null,
    errorCode: normalizedRun?.lastErrorCode || normalizedRun?.last_error_code || (isExhausted ? "classification_attempts_exhausted" : null),
    canRetry: (status === "failed" || isStalled) && !isExhausted,
    isSlow,
    isDelayed,
    isExhausted,
    isStalled,
    pollAfterMs: status === "queued" ? DEFAULT_POLL_AFTER_MS : ["processing", "delayed", "stalled"].includes(status) ? 3000 : null,
  };
}

function publicJobStatus(rawStatus, coverage = {}, timing = {}) {
  if (timing.isExhausted && RECOVERABLE_ACTIVE_STATUSES.has(rawStatus)) return "failed";
  if (timing.isStalled) return "stalled";
  if (timing.isDelayed) return "delayed";
  if (rawStatus === TAX_CLASSIFICATION_RUN_STATUSES.QUEUED) return "queued";
  if (rawStatus === TAX_CLASSIFICATION_RUN_STATUSES.RUNNING) return "processing";
  if (Number(coverage.missingEvaluationCount ?? coverage.missing_evaluation_count ?? coverage.unclassifiedCount ?? 0) > 0) return "not_started";
  if (rawStatus === TAX_CLASSIFICATION_RUN_STATUSES.REVIEW_REQUIRED) return "completed_with_review";
  if (rawStatus === TAX_CLASSIFICATION_RUN_STATUSES.COMPLETED) return "completed";
  if ([TAX_CLASSIFICATION_RUN_STATUSES.FAILED, TAX_CLASSIFICATION_RUN_STATUSES.DEAD_LETTER].includes(rawStatus)) return "failed";
  if (Number(coverage.eligiblePostedCount || 0) > 0) return Number(coverage.needsReviewCount || 0) > 0 ? "completed_with_review" : "completed";
  return "not_started";
}

function hasExhaustedAttempts(run) {
  if (!run || !RECOVERABLE_ACTIVE_STATUSES.has(run.status)) return false;
  const attempts = Number(run.attemptCount ?? run.attempt_count ?? 0);
  const maxAttempts = Number(run.maxAttempts ?? run.max_attempts ?? DEFAULT_MAX_ATTEMPTS);
  return Number.isFinite(attempts) && Number.isFinite(maxAttempts) && maxAttempts > 0 && attempts >= maxAttempts;
}

function isSuppressibleFailureCode(code) {
  return [
    "candidate_snapshot_mismatch",
    "classification_batch_all_failed",
    "invalid_default_deductible_percent",
    "tax_deduction_rules_query_failed",
  ].includes(String(code || ""));
}

export async function failExhaustedActiveTaxClassificationRuns({ supabase, now = new Date(), limit = 25 } = {}) {
  if (isMemorySupabase(supabase)) {
    const runs = ensureRuns(supabase);
    const exhausted = runs
      .filter((row) => RECOVERABLE_ACTIVE_STATUSES.has(row.status) && hasExhaustedAttempts(row))
      .slice(0, Math.max(1, Number(limit || 1)));
    for (const row of exhausted) {
      Object.assign(row, {
        status: TAX_CLASSIFICATION_RUN_STATUSES.DEAD_LETTER,
        locked_at: null,
        locked_by: null,
        failed_at: row.failed_at || now.toISOString(),
        dead_lettered_at: row.dead_lettered_at || now.toISOString(),
        heartbeat_at: row.heartbeat_at || now.toISOString(),
        last_error_code: row.last_error_code || "classification_attempts_exhausted",
        last_error_message: row.last_error_message || "Tax classification run exhausted retry attempts.",
        updated_at: now.toISOString(),
      });
    }
    return exhausted.map(normalizeRun);
  }
  const { data: candidates, error: selectError } = await supabase
    .from("tax_classification_runs")
    .select("id,status,attempt_count,max_attempts")
    .in("status", [...RECOVERABLE_ACTIVE_STATUSES])
    .order("updated_at", { ascending: true })
    .limit(Math.max(1, Number(limit || 1)) * 2);
  if (selectError) throw selectError;
  const ids = (candidates || [])
    .filter((row) => hasExhaustedAttempts(row))
    .slice(0, Math.max(1, Number(limit || 1)))
    .map((row) => row.id)
    .filter(Boolean);
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from("tax_classification_runs")
    .update({
      status: TAX_CLASSIFICATION_RUN_STATUSES.DEAD_LETTER,
      locked_at: null,
      locked_by: null,
      failed_at: now.toISOString(),
      dead_lettered_at: now.toISOString(),
      last_error_code: "classification_attempts_exhausted",
      last_error_message: "Tax classification run exhausted retry attempts.",
    })
    .in("id", ids)
    .select("*");
  if (error) throw error;
  return (data || []).map(normalizeRun);
}

function elapsedMs(value, now) {
  if (!value) return null;
  const started = Date.parse(value);
  const current = Date.parse(new Date(now).toISOString());
  if (!Number.isFinite(started) || !Number.isFinite(current)) return null;
  return Math.max(0, current - started);
}

function progressPatch(progress = {}) {
  const out = {};
  const map = {
    totalEligible: "total_eligible",
    queuedCount: "queued_count",
    processedCount: "processed_count",
    autoClassifiedCount: "auto_classified_count",
    reviewRequiredCount: "review_required_count",
    excludedCount: "excluded_count",
    failedCount: "failed_count",
  };
  for (const [input, column] of Object.entries(map)) {
    if (Number.isFinite(Number(progress[input]))) out[column] = Number(progress[input]);
  }
  return out;
}

async function updateRun({ supabase, runId, patch }) {
  if (isMemorySupabase(supabase)) {
    const run = await findRun({ supabase, runId });
    if (!run) throw validationError("classification_run_not_found", "Tax classification run was not found.");
    Object.assign(run, patch, { updated_at: patch.updated_at || new Date().toISOString() });
    return normalizeRun(run);
  }
  const { data, error } = await supabase
    .from("tax_classification_runs")
    .update(patch)
    .eq("id", runId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function findRun({ supabase, runId }) {
  if (isMemorySupabase(supabase)) return (supabase.store.tax_classification_runs || []).find((row) => row.id === runId) || null;
  const { data, error } = await supabase.from("tax_classification_runs").select("*").eq("id", runId).maybeSingle();
  if (error) throw error;
  return data || null;
}

function enqueueMemoryRun(args) {
  const runs = ensureRuns(args.supabase);
  const suppressed = runs.find((row) =>
    row.business_id === args.businessId &&
    Number(row.tax_year) === args.taxYear &&
    row.source_fingerprint === args.sourceFingerprint &&
    row.rules_version === args.rulesVersion &&
    row.status === TAX_CLASSIFICATION_RUN_STATUSES.DEAD_LETTER &&
    isSuppressibleFailureCode(row.last_error_code)
  );
  if (suppressed) {
    return { queued: false, outcome: "suppressed_repeated_failure", run: normalizeRun(suppressed) };
  }
  const existing = runs.find((row) =>
    row.business_id === args.businessId &&
    Number(row.tax_year) === args.taxYear &&
    row.source_fingerprint === args.sourceFingerprint &&
    row.rules_version === args.rulesVersion &&
    ACTIVE_STATUSES.has(row.status)
  );
  if (existing) return { queued: false, outcome: "existing_active_run", run: normalizeRun(existing) };
  const failed = runs.find((row) =>
    row.business_id === args.businessId &&
    Number(row.tax_year) === args.taxYear &&
    row.source_fingerprint === args.sourceFingerprint &&
    row.rules_version === args.rulesVersion &&
    row.status === TAX_CLASSIFICATION_RUN_STATUSES.FAILED
  );
  if (failed && Number(failed.attempt_count || 0) < Number(failed.max_attempts || DEFAULT_MAX_ATTEMPTS)) {
    Object.assign(failed, {
      status: TAX_CLASSIFICATION_RUN_STATUSES.QUEUED,
      locked_at: null,
      locked_by: null,
      failed_at: null,
      dead_lettered_at: null,
      last_error_code: null,
      last_error_message: null,
      process_after: new Date(args.now).toISOString(),
      heartbeat_at: new Date(args.now).toISOString(),
      updated_at: new Date(args.now).toISOString(),
    });
    return { queued: true, outcome: "retried_failed_run", run: normalizeRun(failed) };
  }
  const row = runToDbRow(args);
  row.id = `tax-classification-run-${runs.length + 1}`;
  runs.push(row);
  return { queued: true, outcome: "queued", run: normalizeRun(row) };
}

function claimMemoryRuns({ supabase, workerId, batchSize, now }) {
  const runs = ensureRuns(supabase);
  const currentIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  const due = runs
    .filter((row) => {
      const attemptsRemaining = Number(row.attempt_count || 0) < Number(row.max_attempts || DEFAULT_MAX_ATTEMPTS);
      const queuedOrRetryable = [TAX_CLASSIFICATION_RUN_STATUSES.QUEUED, TAX_CLASSIFICATION_RUN_STATUSES.FAILED].includes(row.status) &&
        String(row.process_after || "") <= currentIso &&
        (!row.locked_at || String(row.locked_at) < staleBefore);
      const staleRunning = row.status === TAX_CLASSIFICATION_RUN_STATUSES.RUNNING &&
        row.locked_at &&
        String(row.locked_at) < staleBefore;
      return attemptsRemaining && (queuedOrRetryable || staleRunning);
    })
    .sort((a, b) => String(a.process_after || "").localeCompare(String(b.process_after || "")) || String(a.created_at || "").localeCompare(String(b.created_at || "")))
    .slice(0, Math.max(1, Number(batchSize || 1)));
  for (const row of due) {
    row.status = TAX_CLASSIFICATION_RUN_STATUSES.RUNNING;
    row.locked_at = now.toISOString();
    row.locked_by = workerId;
    row.started_at ||= now.toISOString();
    row.heartbeat_at = now.toISOString();
    row.attempt_count = Number(row.attempt_count || 0) + 1;
  }
  return due.map(normalizeRun);
}

function runToDbRow({
  businessId,
  taxYear,
  triggerSource,
  actorUserId,
  sourceRecordId,
  metadata,
  now,
  sourceFingerprint,
  rulesVersion,
  eligiblePostedCount,
  unclassifiedCount,
}) {
  const iso = new Date(now).toISOString();
  return {
    business_id: businessId,
    tax_year: taxYear,
    trigger_source: triggerSource,
    status: TAX_CLASSIFICATION_RUN_STATUSES.QUEUED,
    total_eligible: Number(eligiblePostedCount || 0),
    queued_count: Number(unclassifiedCount || 0),
    processed_count: 0,
    auto_classified_count: 0,
    review_required_count: 0,
    excluded_count: 0,
    failed_count: 0,
    source_fingerprint: sourceFingerprint,
    rules_version: rulesVersion,
    attempt_count: 0,
    max_attempts: DEFAULT_MAX_ATTEMPTS,
    process_after: iso,
    queued_at: iso,
    metadata: sanitizeMetadata({ ...metadata, actor_user_id: actorUserId, source_record_id: sourceRecordId }),
    created_at: iso,
    updated_at: iso,
  };
}

function normalizeRun(row) {
  if (!row) return null;
  return {
    ...row,
    id: row.id,
    businessId: row.business_id,
    taxYear: row.tax_year,
    triggerSource: row.trigger_source,
    totalEligible: row.total_eligible,
    queuedCount: row.queued_count,
    processedCount: row.processed_count,
    autoClassifiedCount: row.auto_classified_count,
    reviewRequiredCount: row.review_required_count,
    excludedCount: row.excluded_count,
    failedCount: row.failed_count,
    rulesVersion: row.rules_version,
    sourceFingerprint: row.source_fingerprint,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    deadLetteredAt: row.dead_lettered_at,
    lastErrorCode: row.last_error_code,
  };
}

function ensureRuns(supabase) {
  supabase.store.tax_classification_runs ||= [];
  return supabase.store.tax_classification_runs;
}

function isMemorySupabase(supabase) {
  return Boolean(supabase?.store);
}

function sanitizeMetadata(metadata = {}) {
  const out = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (/token|secret|payload|description|memo|agi|withholding/i.test(key)) continue;
    if (value == null || ["string", "number", "boolean"].includes(typeof value)) out[key] = value;
  }
  return out;
}

export function sanitizeErrorCode(error) {
  return String(error?.code || error?.name || "classification_run_failed").replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 96);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function requireTaxYear(value) {
  const year = normalizeTaxYear(value);
  if (!year) throw validationError("invalid_tax_year", "Tax year must be between 2000 and 2100.", { field: "taxYear" });
  return year;
}
