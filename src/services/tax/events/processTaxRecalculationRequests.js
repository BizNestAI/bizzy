import { runCanonicalTaxCalculation } from "../orchestrator/taxOrchestrator.js";
import { getLatestTaxRun } from "../runs/taxRun.repository.js";
import { compareTaxRuns } from "../runs/taxRunComparison.service.js";
import { TAX_CALCULATION_TYPES, TAX_TRIGGER_SOURCES } from "../taxDomain.js";
import { emitTaxDataChanged } from "../taxChangeEvents.js";
import {
  TAX_RECALCULATION_OUTCOMES,
  TAX_RECALCULATION_REQUEST_STATUSES,
} from "./taxRecalculationEventDomain.js";
import { isMaterialChangeComparison } from "./taxRecalculationPolicy.js";
import { recordRecalculationOutcome } from "./taxRecalculationTrigger.service.js";

let deps = {
  runCanonicalTaxCalculation,
  getLatestTaxRun,
  compareTaxRuns,
  emitTaxDataChanged,
};

export function __setTaxRecalculationWorkerTestDeps(next = {}) {
  deps = { ...deps, ...next };
}

export async function processPendingTaxRecalculationRequests({
  supabase,
  workerId = `tax-recalc-${process.pid || "worker"}`,
  batchSize = 10,
  now = new Date(),
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  const claimed = await claimDueRequests({ supabase, workerId, batchSize, now });
  const results = [];
  for (const request of claimed) {
    results.push(await processOneRequest({ supabase, request, workerId, now }));
  }
  return {
    processed: results.length,
    completed: results.filter((row) => row.status === TAX_RECALCULATION_REQUEST_STATUSES.COMPLETED).length,
    skipped: results.filter((row) => row.status === TAX_RECALCULATION_REQUEST_STATUSES.SKIPPED).length,
    failed: results.filter((row) => row.status === TAX_RECALCULATION_REQUEST_STATUSES.FAILED || row.status === TAX_RECALCULATION_REQUEST_STATUSES.DEAD_LETTER).length,
    results,
  };
}

export async function getTaxRecalculationDiagnostics({ supabase, businessId = null, taxYear = null, now = new Date() } = {}) {
  const allRows = supabase.store?.tax_recalculation_requests || await selectAllRequestsBestEffort(supabase);
  const rows = allRows
    .filter((row) => !businessId || row.business_id === businessId)
    .filter((row) => !taxYear || Number(row.tax_year) === Number(taxYear));
  const pending = rows.filter((row) => row.status === TAX_RECALCULATION_REQUEST_STATUSES.PENDING);
  const processing = rows.filter((row) => row.status === TAX_RECALCULATION_REQUEST_STATUSES.PROCESSING);
  const failed = rows.filter((row) => row.status === TAX_RECALCULATION_REQUEST_STATUSES.FAILED);
  const dead = rows.filter((row) => row.status === TAX_RECALCULATION_REQUEST_STATUSES.DEAD_LETTER);
  const coalesced = rows.reduce((sum, row) => sum + Math.max(0, Number(row.metadata?.coalescedEventCount || 1) - 1), 0);
  return {
    pendingCount: pending.length,
    processingCount: processing.length,
    failedCount: failed.length,
    deadLetterCount: dead.length,
    eventsCoalesced: coalesced,
    oldestPendingAgeSeconds: ageSeconds(pending.map((row) => row.created_at), now),
    staleProcessingCount: processing.filter((row) => isStaleLock(row, now)).length,
    runsReused: rows.filter((row) => row.outcome === TAX_RECALCULATION_OUTCOMES.SKIP_DUPLICATE || row.metadata?.reusedExistingRun).length,
    runsCreated: rows.filter((row) => row.calculation_run_id && !row.metadata?.reusedExistingRun).length,
  };
}

async function processOneRequest({ supabase, request, workerId, now }) {
  const logContext = { requestId: request.id, eventId: request.event_id, businessId: request.business_id, taxYear: request.tax_year };
  try {
    const previousRun = await deps.getLatestTaxRun({ supabase, businessId: request.business_id, taxYear: request.tax_year });
    const result = await deps.runCanonicalTaxCalculation({
      supabase,
      businessId: request.business_id,
      taxYear: request.tax_year,
      asOfDate: now.toISOString().slice(0, 10),
      calculationType: TAX_CALCULATION_TYPES.FULL_ESTIMATE,
      triggerSource: request.trigger_source || TAX_TRIGGER_SOURCES.SYSTEM,
      userId: request.metadata?.userId || null,
      persistRun: true,
      force: request.event_type === "manual_tax_recalculation_requested",
      requestId: request.id,
    });
    const currentRunId = result?.meta?.runId || null;
    const reusedExistingRun = result?.meta?.reusedExistingRun === true || previousRun?.id === currentRunId;
    let materialChange = null;
    if (!reusedExistingRun && previousRun && currentRunId) {
      const currentRun = await deps.getLatestTaxRun({ supabase, businessId: request.business_id, taxYear: request.tax_year });
      materialChange = deps.compareTaxRuns({ previousRun, currentRun });
      if (isMaterialChangeComparison(materialChange)) {
        deps.emitTaxDataChanged({
          businessId: request.business_id,
          taxYear: request.tax_year,
          changeType: "tax_calculation_materially_changed",
          entityId: currentRunId,
          userId: request.metadata?.userId || null,
          metadata: {
            previousRunId: previousRun.id,
            currentRunId,
            materialChange: true,
            changedAmounts: materialChange.changes,
            newWarnings: materialChange.changedWarnings,
            resolvedWarnings: materialChange.resolvedWarnings,
            generatedAt: new Date().toISOString(),
          },
        });
      }
    }
    const row = await recordRecalculationOutcome({
      supabase,
      requestId: request.id,
      status: reusedExistingRun ? TAX_RECALCULATION_REQUEST_STATUSES.SKIPPED : TAX_RECALCULATION_REQUEST_STATUSES.COMPLETED,
      outcome: reusedExistingRun ? TAX_RECALCULATION_OUTCOMES.SKIP_DUPLICATE : TAX_RECALCULATION_OUTCOMES.COMPLETED,
      calculationRunId: currentRunId,
      metadata: {
        ...(request.metadata || {}),
        workerId,
        reusedExistingRun,
        materialChange,
        completedLogContext: logContext,
      },
    });
    return row;
  } catch (error) {
    const nextAttemptCount = Math.max(1, Number(request.attempt_count || 0));
    const dead = nextAttemptCount >= Number(request.max_attempts || 5);
    const retryAt = new Date(now.getTime() + Math.min(60_000 * 2 ** Math.min(nextAttemptCount, 6), 60 * 60 * 1000)).toISOString();
    const patch = {
      status: dead ? TAX_RECALCULATION_REQUEST_STATUSES.DEAD_LETTER : TAX_RECALCULATION_REQUEST_STATUSES.FAILED,
      outcome: TAX_RECALCULATION_OUTCOMES.FAILED,
      attempt_count: nextAttemptCount,
      process_after: retryAt,
      locked_at: null,
      locked_by: null,
      error_code: error.code || "tax_recalculation_failed",
      error_message: String(error.message || "Tax recalculation failed.").slice(0, 1000),
      updated_at: new Date().toISOString(),
    };
    return updateRequest({ supabase, requestId: request.id, patch });
  }
}

async function claimDueRequests({ supabase, workerId, batchSize, now }) {
  if (typeof supabase.rpc === "function" && !supabase.store) {
    try {
      const { data, error } = await supabase.rpc("claim_tax_recalculation_requests", {
        p_worker_id: workerId,
        p_batch_size: batchSize,
        p_now: now.toISOString(),
      });
      if (!error && Array.isArray(data)) return data;
    } catch {
      // Fall through to portable claim.
    }
  }
  if (supabase.store?.tax_recalculation_requests) {
    const rows = supabase.store.tax_recalculation_requests
      .filter((row) => isClaimable(row, now))
      .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || new Date(a.process_after) - new Date(b.process_after))
      .slice(0, batchSize);
    for (const row of rows) {
      row.status = TAX_RECALCULATION_REQUEST_STATUSES.PROCESSING;
      row.locked_at = now.toISOString();
      row.locked_by = workerId;
      row.attempt_count = Number(row.attempt_count || 0) + 1;
      row.updated_at = now.toISOString();
    }
    return rows.map((row) => ({ ...row }));
  }
  const { data, error } = await supabase
    .from("tax_recalculation_requests")
    .select("*")
    .in("status", [TAX_RECALCULATION_REQUEST_STATUSES.PENDING, TAX_RECALCULATION_REQUEST_STATUSES.FAILED])
    .lte("process_after", now.toISOString())
    .order("process_after", { ascending: true })
    .limit(batchSize);
  if (error) throw error;
  const claimed = [];
  for (const row of data || []) {
    const { data: updated, error: updateError } = await supabase
      .from("tax_recalculation_requests")
      .update({
        status: TAX_RECALCULATION_REQUEST_STATUSES.PROCESSING,
        locked_at: now.toISOString(),
        locked_by: workerId,
        attempt_count: Number(row.attempt_count || 0) + 1,
        updated_at: now.toISOString(),
      })
      .eq("id", row.id)
      .in("status", [TAX_RECALCULATION_REQUEST_STATUSES.PENDING, TAX_RECALCULATION_REQUEST_STATUSES.FAILED])
      .select("*")
      .maybeSingle();
    if (!updateError && updated) claimed.push(updated);
  }
  return claimed;
}

function isClaimable(row, now) {
  const due = new Date(row.process_after).getTime() <= now.getTime();
  const pending = [TAX_RECALCULATION_REQUEST_STATUSES.PENDING, TAX_RECALCULATION_REQUEST_STATUSES.FAILED].includes(row.status);
  return pending && due && Number(row.attempt_count || 0) < Number(row.max_attempts || 5);
}

async function updateRequest({ supabase, requestId, patch }) {
  if (supabase.store?.tax_recalculation_requests) {
    const row = supabase.store.tax_recalculation_requests.find((item) => item.id === requestId);
    if (row) Object.assign(row, patch);
    return row || null;
  }
  const { data, error } = await supabase
    .from("tax_recalculation_requests")
    .update(patch)
    .eq("id", requestId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function selectAllRequestsBestEffort(supabase) {
  const { data } = await supabase.from("tax_recalculation_requests").select("*").limit(1000);
  return data || [];
}

function isStaleLock(row, now) {
  const locked = new Date(row.locked_at || 0).getTime();
  return Number.isFinite(locked) && now.getTime() - locked > 30 * 60 * 1000;
}

function priorityRank(priority) {
  return { low: 1, normal: 2, high: 3, critical: 4 }[priority] || 0;
}

function ageSeconds(values, now) {
  const timestamps = values.map((value) => new Date(value).getTime()).filter(Number.isFinite);
  if (!timestamps.length) return 0;
  return Math.max(0, Math.round((now.getTime() - Math.min(...timestamps)) / 1000));
}
