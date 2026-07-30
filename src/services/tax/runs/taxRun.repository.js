// /src/services/tax/runs/taxRun.repository.js
import { conflictError, notFoundError, validationError } from "../taxErrors.js";
import { normalizeDateOnly, normalizeTaxYear } from "../taxDomain.js";
import { COMPLETED_TAX_RUN_STATUSES, TAX_RUN_ERROR_CODES, TAX_RUN_STATUSES } from "./taxRunDomain.js";

export async function createTaxRunSkeleton({
  supabase,
  businessId,
  taxProfileId = null,
  taxYear,
  asOfDate,
  calculationType,
  triggerSource,
  calculationVersion,
  completionType,
  fingerprint,
  requestId = null,
  expectedComponentCount = 0,
  metadata = {},
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  if (!businessId) throw validationError("missing_business_id", "businessId is required.");
  const year = normalizeTaxYear(taxYear);
  if (!year) throw validationError("invalid_tax_year", "Invalid tax year.", { taxYear });
  const row = {
    business_id: businessId,
    tax_profile_id: taxProfileId,
    tax_year: year,
    as_of_date: normalizeDateOnly(asOfDate),
    status: TAX_RUN_STATUSES.RUNNING,
    calculation_type: calculationType,
    trigger_source: triggerSource,
    calculation_version: calculationVersion,
    calculation_fingerprint: fingerprint,
    request_id: requestId,
    expected_component_count: expectedComponentCount,
    persisted_component_count: 0,
    completion_type: completionType,
    calculation_payload_version: metadata.calculationPayloadVersion || calculationVersion,
    assumptions: metadata.assumptions || [],
    warnings: metadata.warnings || [],
    missing_inputs: metadata.missingInputs || [],
    source_freshness: metadata.sourceFreshness || {},
    started_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from("tax_calculation_runs").insert(row).select("*").single();
  if (error) throw validationError(TAX_RUN_ERROR_CODES.RUN_PERSISTENCE_FAILED, "Could not create tax calculation run.", { error: error.code || error.message });
  return data || row;
}

export async function getTaxRun({ supabase, businessId, runId } = {}) {
  const { data, error } = await supabase
    .from("tax_calculation_runs")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", runId)
    .maybeSingle();
  if (error) throw validationError("tax_run_lookup_failed", "Could not load tax run.", { runId });
  return data || null;
}

export async function getLatestTaxRun({ supabase, businessId, taxYear, statuses = COMPLETED_TAX_RUN_STATUSES } = {}) {
  let query = supabase
    .from("tax_calculation_runs")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", normalizeTaxYear(taxYear));
  if (statuses?.length && typeof query.in === "function") query = query.in("status", statuses);
  const { data, error } = await query
    .order("completed_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw validationError("latest_tax_run_lookup_failed", "Could not load latest tax run.", { businessId, taxYear });
  return data || null;
}

export async function findRunByFingerprint({ supabase, businessId, taxYear, fingerprint } = {}) {
  if (!fingerprint) return null;
  const { data, error } = await supabase
    .from("tax_calculation_runs")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", normalizeTaxYear(taxYear))
    .eq("calculation_fingerprint", fingerprint)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw validationError("tax_run_fingerprint_lookup_failed", "Could not check duplicate tax run.", { fingerprint });
  return data || null;
}

export async function markTaxRunFailed({ supabase, businessId, runId, errorCode, errorMessage } = {}) {
  const run = await getTaxRun({ supabase, businessId, runId });
  if (!run) throw notFoundError(TAX_RUN_ERROR_CODES.RUN_NOT_FOUND, "Tax run was not found.", { runId });
  assertMutableRun(run);
  const { data, error } = await supabase
    .from("tax_calculation_runs")
    .update({
      status: TAX_RUN_STATUSES.FAILED,
      error_code: errorCode || TAX_RUN_ERROR_CODES.CALCULATION_FAILED,
      error_message: errorMessage || "Tax calculation failed.",
      completed_at: new Date().toISOString(),
    })
    .eq("business_id", businessId)
    .eq("id", runId)
    .select("*")
    .single();
  if (error) throw validationError(TAX_RUN_ERROR_CODES.RUN_PERSISTENCE_FAILED, "Could not mark tax run failed.", { runId });
  return data;
}

export async function markTaxRunAbandoned({ supabase, businessId, runId, reason = TAX_RUN_ERROR_CODES.RUN_ABANDONED } = {}) {
  const run = await getTaxRun({ supabase, businessId, runId });
  if (!run) throw notFoundError(TAX_RUN_ERROR_CODES.RUN_NOT_FOUND, "Tax run was not found.", { runId });
  assertMutableRun(run);
  const { data, error } = await supabase
    .from("tax_calculation_runs")
    .update({
      status: TAX_RUN_STATUSES.ABANDONED,
      error_code: reason,
      error_message: "Tax run was abandoned before completion.",
      completed_at: new Date().toISOString(),
    })
    .eq("business_id", businessId)
    .eq("id", runId)
    .select("*")
    .single();
  if (error) throw validationError(TAX_RUN_ERROR_CODES.RUN_PERSISTENCE_FAILED, "Could not abandon tax run.", { runId });
  return data;
}

export async function supersedeTaxRun({ supabase, businessId, olderRunId, newerRunId, reason } = {}) {
  const row = {
    business_id: businessId,
    older_run_id: olderRunId,
    newer_run_id: newerRunId,
    relation_type: "supersedes",
    reason,
    created_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from("tax_calculation_run_links").insert(row).select("*").single();
  if (error) throw validationError(TAX_RUN_ERROR_CODES.RUN_SUPERSESSION_FAILED, "Could not record tax run supersession.", { olderRunId, newerRunId });
  return data || row;
}

export async function listTaxRuns({ supabase, businessId, taxYear, status, calculationType, triggerSource, limit = 50, offset = 0 } = {}) {
  let query = supabase.from("tax_calculation_runs").select("*").eq("business_id", businessId);
  if (taxYear != null) query = query.eq("tax_year", normalizeTaxYear(taxYear));
  if (status) query = query.eq("status", status);
  if (calculationType) query = query.eq("calculation_type", calculationType);
  if (triggerSource) query = query.eq("trigger_source", triggerSource);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .range(Number(offset || 0), Number(offset || 0) + Math.min(Number(limit || 50), 100) - 1);
  if (error) throw validationError("tax_runs_unavailable", "Tax runs are unavailable.", { businessId });
  return data || [];
}

export async function listRunningTaxRunsForCalculation({ supabase, businessId, taxYear, asOfDate, calculationType } = {}) {
  let query = supabase
    .from("tax_calculation_runs")
    .select("*")
    .eq("business_id", businessId)
    .eq("tax_year", normalizeTaxYear(taxYear))
    .eq("status", TAX_RUN_STATUSES.RUNNING);
  if (asOfDate) query = query.eq("as_of_date", normalizeDateOnly(asOfDate));
  if (calculationType) query = query.eq("calculation_type", calculationType);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(25);
  if (error) throw validationError("running_tax_runs_lookup_failed", "Could not load running tax runs.", { businessId, taxYear });
  return data || [];
}

function assertMutableRun(run) {
  if (COMPLETED_TAX_RUN_STATUSES.includes(run?.status)) {
    throw conflictError(TAX_RUN_ERROR_CODES.RUN_ALREADY_COMPLETED, "Completed tax runs are immutable.", { runId: run.id, status: run.status });
  }
}
