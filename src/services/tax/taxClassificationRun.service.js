import { createHash } from "node:crypto";
import {
  TAX_CLASSIFICATION_RUN_STATUSES,
  TAX_CLASSIFICATION_TRIGGER_SOURCES,
  normalizeTaxYear,
} from "./taxDomain.js";
import { TAX_CLASSIFICATION_ENGINE_VERSION } from "./taxEngineVersions.js";
import { getClassificationCoverage } from "./taxClassification.repository.js";
import {
  countPostedTransactionsForTax,
  listUnclassifiedPostedTransactions,
} from "./taxPostedTransaction.repository.js";
import { validationError } from "./taxErrors.js";

const ACTIVE_STATUSES = new Set([
  TAX_CLASSIFICATION_RUN_STATUSES.QUEUED,
  TAX_CLASSIFICATION_RUN_STATUSES.RUNNING,
  TAX_CLASSIFICATION_RUN_STATUSES.FAILED,
]);
const DEFAULT_MAX_ATTEMPTS = 5;
const FINGERPRINT_PAGE_SIZE = 250;

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
  const sourceFingerprint = await computeTaxClassificationSourceFingerprint({ supabase, businessId, taxYear: year });
  const rulesVersion = getTaxClassificationRulesVersion();
  const eligiblePostedCount = await countPostedTransactionsForTax({ supabase, businessId, taxYear: year });
  const unclassified = await listUnclassifiedPostedTransactions({ supabase, businessId, taxYear: year, limit: 1, offset: 0 });
  const unclassifiedCount = Number(unclassified?.counts?.unclassified || 0);

  if (eligiblePostedCount <= 0 || unclassifiedCount <= 0) {
    return {
      queued: false,
      outcome: "skip_no_unclassified_transactions",
      run: null,
      status: eligiblePostedCount <= 0 ? "no_posted_transactions" : "classification_complete",
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
      unclassifiedCount,
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
    unclassifiedCount,
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
  return { queued: false, outcome: "existing_active_run", run: existing };
}

export async function computeTaxClassificationSourceFingerprint({ supabase, businessId, taxYear } = {}) {
  const year = requireTaxYear(taxYear);
  const ids = [];
  let offset = 0;
  let unclassifiedCount = 0;
  while (true) {
    const listed = await listUnclassifiedPostedTransactions({
      supabase,
      businessId,
      taxYear: year,
      limit: FINGERPRINT_PAGE_SIZE,
      offset,
    });
    ids.push(...(listed.rows || []).map((row) => String(row.transactionId || row.transaction_id || "")).filter(Boolean));
    unclassifiedCount = Number(listed.counts?.unclassified ?? listed.totalCount ?? listed.count ?? ids.length);
    if ((listed.rows || []).length < FINGERPRINT_PAGE_SIZE || ids.length >= unclassifiedCount) break;
    offset += FINGERPRINT_PAGE_SIZE;
  }
  const payload = JSON.stringify({
    businessId,
    taxYear: year,
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

export async function getTaxClassificationLifecycleStatus({ supabase, businessId, taxYear } = {}) {
  const year = requireTaxYear(taxYear);
  const eligiblePostedCount = await countPostedTransactionsForTax({ supabase, businessId, taxYear: year });
  const coverage = await getClassificationCoverage({ supabase, businessId, taxYear: year, eligiblePostedCount });
  const [latestRun, activeRun] = await Promise.all([
    getLatestTaxClassificationRun({ supabase, businessId, taxYear: year }),
    getActiveTaxClassificationRun({ supabase, businessId, taxYear: year }),
  ]);
  const processingCount = activeRun
    ? Math.max(0, Number(activeRun.total_eligible || coverage.eligiblePostedCount || 0) - Number(activeRun.processed_count || 0))
    : 0;
  const failedCount = Number(coverage.failedCount || latestRun?.failed_count || 0);
  const normalizedCoverage = {
    ...coverage,
    eligiblePostedCount,
    processingCount,
    failedCount,
    latestRun: latestRun ? normalizeRun(latestRun) : null,
    activeRun: activeRun ? normalizeRun(activeRun) : null,
    lastRunAt: latestRun?.completed_at || latestRun?.failed_at || latestRun?.heartbeat_at || latestRun?.created_at || coverage.lastRunAt || null,
    rulesVersion: latestRun?.rules_version || getTaxClassificationRulesVersion(),
  };
  normalizedCoverage.classificationStatus = deriveLifecycleStatus({ coverage: normalizedCoverage, latestRun, activeRun });
  return normalizedCoverage;
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
  if (classificationStatus === "failed") return "classification_failed";
  return "classifications_required";
}

function deriveLifecycleStatus({ coverage, latestRun, activeRun }) {
  if (coverage.eligiblePostedCount <= 0) return "no_posted_transactions";
  if (activeRun?.status === TAX_CLASSIFICATION_RUN_STATUSES.QUEUED || activeRun?.status === TAX_CLASSIFICATION_RUN_STATUSES.FAILED) return "classification_queued";
  if (activeRun?.status === TAX_CLASSIFICATION_RUN_STATUSES.RUNNING) return "classifying";
  if (latestRun?.status === TAX_CLASSIFICATION_RUN_STATUSES.DEAD_LETTER || coverage.failedCount > 0) return "failed";
  if (coverage.needsReviewCount > 0) return "classification_review_required";
  if (coverage.unclassifiedCount > 0) return "ready_to_classify";
  return "classification_complete";
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
  const existing = runs.find((row) =>
    row.business_id === args.businessId &&
    Number(row.tax_year) === args.taxYear &&
    row.source_fingerprint === args.sourceFingerprint &&
    row.rules_version === args.rulesVersion &&
    ACTIVE_STATUSES.has(row.status)
  );
  if (existing) return { queued: false, outcome: "existing_active_run", run: normalizeRun(existing) };
  const row = runToDbRow(args);
  row.id = `tax-classification-run-${runs.length + 1}`;
  runs.push(row);
  return { queued: true, outcome: "queued", run: normalizeRun(row) };
}

function claimMemoryRuns({ supabase, workerId, batchSize, now }) {
  const runs = ensureRuns(supabase);
  const due = runs
    .filter((row) =>
      [TAX_CLASSIFICATION_RUN_STATUSES.QUEUED, TAX_CLASSIFICATION_RUN_STATUSES.FAILED].includes(row.status) &&
      String(row.process_after || "") <= now.toISOString() &&
      Number(row.attempt_count || 0) < Number(row.max_attempts || DEFAULT_MAX_ATTEMPTS)
    )
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
