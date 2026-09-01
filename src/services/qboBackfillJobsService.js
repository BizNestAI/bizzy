// src/services/qboBackfillJobsService.js
// Lightweight helper for creating/updating QBO backfill job rows.
/* global process */

import { supabase } from "./supabaseAdmin.js";
import { qboEnvName } from "../utils/qboEnv.js";

const TABLE = "qbo_backfill_jobs";

function cleanPatch(patch = {}) {
  const out = {};
  Object.entries(patch || {}).forEach(([k, v]) => {
    if (v !== undefined) out[k] = v;
  });
  return out;
}

export async function createJob({
  business_id,
  months_requested,
  months_total,
  start_year = null,
  start_month = null,
  status = "queued",
  source = null,
  accounting_method = "Cash",
  force = false,
  expected_months = [],
  started_by = null,
  job_type = "health_snapshot_backfill",
}) {
  if (!business_id) throw new Error("business_id required");
  const firstMonth = expected_months[0] || null;
  const lastMonth = expected_months[expected_months.length - 1] || null;
  const payload = {
    business_id,
    qbo_env: qboEnvName,
    months_total: months_total ?? months_requested ?? null,
    months_done: 0,
    months_attempted: 0,
    months_succeeded: 0,
    months_failed: 0,
    months_skipped: 0,
    status,
    anchor_year: start_year,
    anchor_month: start_month,
    window_start_month: firstMonth,
    window_end_month: lastMonth,
    job_type,
    source,
    accounting_method,
    force: Boolean(force),
    expected_months,
    succeeded_months: [],
    skipped_months: [],
    failed_months: [],
    result_details: [],
    last_month_processed: null,
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    last_error: null,
    last_log: null,
    started_by,
  };
  if (process.env.NODE_ENV !== "production") {
    console.info("[qboBackfillJobs] insert keys", Object.keys(payload));
  }
  const { data, error } = await supabase.from(TABLE).insert(payload).select().single();
  if (error) throw new Error(`[qboBackfillJobs] create failed: ${error.message || error}`);
  return data;
}

export async function updateJob({ id, patch }) {
  if (!id) throw new Error("id required");
  const body = cleanPatch(patch);
  const { data, error } = await supabase
    .from(TABLE)
    .update(body)
    .eq("id", id)
    .select()
    .maybeSingle();
  if (error) throw new Error(`[qboBackfillJobs] update failed: ${error.message || error}`);
  return data;
}

export async function getJobById(id) {
  if (!id) throw new Error("id required");
  const { data, error } = await supabase.from(TABLE).select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`[qboBackfillJobs] lookup failed: ${error.message || error}`);
  return data || null;
}

export async function getLatestJob({ business_id, status = null }) {
  if (!business_id) throw new Error("business_id required");
  let query = supabase
    .from(TABLE)
    .select("*")
    .eq("business_id", business_id)
    .eq("qbo_env", qboEnvName);
  if (status) query = query.eq("status", status);
  const { data, error } = await query
    .order("started_at", { ascending: false, nullsLast: true })
    .order("created_at", { ascending: false, nullsLast: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`[qboBackfillJobs] latest lookup failed: ${error.message || error}`);
  return data || null;
}

export async function getLatestActiveJob({ business_id, job_type = "health_snapshot_backfill" }) {
  if (!business_id) throw new Error("business_id required");
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("business_id", business_id)
    .eq("qbo_env", qboEnvName)
    .eq("job_type", job_type)
    .in("status", ["queued", "running"])
    .order("started_at", { ascending: false, nullsLast: true })
    .order("created_at", { ascending: false, nullsLast: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`[qboBackfillJobs] active lookup failed: ${error.message || error}`);
  return data || null;
}

export async function appendLog({ id, message }) {
  if (!id) throw new Error("id required");
  try {
    return await updateJob({
      id,
      patch: { last_log: message || null },
    });
  } catch {
    return null;
  }
}

export default {
  createJob,
  updateJob,
  getLatestJob,
  getLatestActiveJob,
  getJobById,
  appendLog,
};
