import {
  DEFAULT_TAX_SCHEDULER_LOCK_TTL_SECONDS,
  TAX_SCHEDULER_RUN_STATUSES,
  schedulerEnvironment,
  schedulerJobKey,
} from "./taxScheduleDomain.js";

export async function claimTaxSchedulerLock({
  supabase,
  jobType,
  scheduledFor,
  workerId,
  lockTtlSeconds = DEFAULT_TAX_SCHEDULER_LOCK_TTL_SECONDS,
  metadata = {},
  now = new Date(),
} = {}) {
  if (!supabase) throw new Error("Supabase client required");
  const scheduled = scheduledFor instanceof Date ? scheduledFor : new Date(scheduledFor);
  const jobKey = schedulerJobKey(jobType, scheduled, schedulerEnvironment());

  if (supabase.store) {
    supabase.store.scheduled_job_locks ||= [];
    const existing = supabase.store.scheduled_job_locks.find((row) => row.job_key === jobKey);
    const expired = existing && new Date(existing.locked_at || 0).getTime() < now.getTime() - lockTtlSeconds * 1000;
    if (!existing) {
      const row = {
        id: `sched_lock_${supabase.store.scheduled_job_locks.length + 1}`,
        job_key: jobKey,
        scheduled_for: scheduled.toISOString(),
        locked_at: now.toISOString(),
        locked_by: workerId,
        completed_at: null,
        status: TAX_SCHEDULER_RUN_STATUSES.RUNNING,
        metadata,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      };
      supabase.store.scheduled_job_locks.push(row);
      return { claimed: true, lockId: row.id, reason: "claimed", jobKey, row };
    }
    if (existing.status === TAX_SCHEDULER_RUN_STATUSES.COMPLETED) {
      return { claimed: false, lockId: existing.id, reason: "already_completed", jobKey, row: existing };
    }
    if (existing.status === TAX_SCHEDULER_RUN_STATUSES.RUNNING && !expired) {
      return { claimed: false, lockId: existing.id, reason: "already_running", jobKey, row: existing };
    }
    Object.assign(existing, {
      locked_at: now.toISOString(),
      locked_by: workerId,
      completed_at: null,
      status: TAX_SCHEDULER_RUN_STATUSES.RUNNING,
      metadata: { ...(existing.metadata || {}), ...metadata, reclaimed: true },
      updated_at: now.toISOString(),
    });
    return { claimed: true, lockId: existing.id, reason: expired ? "reclaimed" : "claimed", jobKey, row: existing };
  }

  if (typeof supabase.rpc === "function") {
    const { data, error } = await supabase.rpc("claim_scheduled_job_lock", {
      p_job_key: jobKey,
      p_scheduled_for: scheduled.toISOString(),
      p_locked_by: workerId,
      p_lock_ttl_seconds: lockTtlSeconds,
      p_metadata: metadata,
    });
    if (!error) {
      const row = Array.isArray(data) ? data[0] : data;
      return {
        claimed: Boolean(row?.claimed),
        lockId: row?.lock_id || null,
        reason: row?.reason || "unknown",
        jobKey,
      };
    }
  }

  return fallbackClaim({ supabase, jobKey, scheduled, workerId, metadata, now });
}

export async function createTaxSchedulerRun({
  supabase,
  jobType,
  scheduledFor,
  workerId,
  status = TAX_SCHEDULER_RUN_STATUSES.RUNNING,
  metadata = {},
  now = new Date(),
} = {}) {
  const row = {
    job_type: jobType,
    scheduled_for: (scheduledFor instanceof Date ? scheduledFor : new Date(scheduledFor)).toISOString(),
    started_at: now.toISOString(),
    completed_at: null,
    status,
    worker_id: workerId,
    businesses_scanned: 0,
    businesses_eligible: 0,
    requests_queued: 0,
    businesses_skipped: 0,
    runs_reused: 0,
    failures: 0,
    warnings: [],
    metadata,
    created_at: now.toISOString(),
  };
  if (supabase.store) {
    supabase.store.tax_scheduler_runs ||= [];
    row.id = `tax_sched_run_${supabase.store.tax_scheduler_runs.length + 1}`;
    supabase.store.tax_scheduler_runs.push(row);
    return row;
  }
  const { data, error } = await supabase.from("tax_scheduler_runs").insert(row).select("*").single();
  if (error) throw error;
  return data || row;
}

export async function finishTaxSchedulerRun({ supabase, runId, lockId, patch = {}, now = new Date() } = {}) {
  const runPatch = {
    ...patch,
    completed_at: now.toISOString(),
  };
  if (supabase.store) {
    const run = supabase.store.tax_scheduler_runs?.find((row) => row.id === runId);
    if (run) Object.assign(run, runPatch);
    const lock = supabase.store.scheduled_job_locks?.find((row) => row.id === lockId);
    if (lock) {
      lock.status = runPatch.status || TAX_SCHEDULER_RUN_STATUSES.COMPLETED;
      lock.completed_at = now.toISOString();
      lock.updated_at = now.toISOString();
      lock.metadata = { ...(lock.metadata || {}), schedulerRunId: runId };
    }
    return run || null;
  }
  if (runId) {
    await supabase.from("tax_scheduler_runs").update(runPatch).eq("id", runId);
  }
  if (lockId) {
    await supabase
      .from("scheduled_job_locks")
      .update({
        status: runPatch.status || TAX_SCHEDULER_RUN_STATUSES.COMPLETED,
        completed_at: now.toISOString(),
        updated_at: now.toISOString(),
        metadata: { schedulerRunId: runId },
      })
      .eq("id", lockId);
  }
  return null;
}

async function fallbackClaim({ supabase, jobKey, scheduled, workerId, metadata, now }) {
  const { data: existing } = await supabase.from("scheduled_job_locks").select("*").eq("job_key", jobKey).maybeSingle();
  if (existing?.status === TAX_SCHEDULER_RUN_STATUSES.COMPLETED) {
    return { claimed: false, lockId: existing.id, reason: "already_completed", jobKey };
  }
  if (existing?.status === TAX_SCHEDULER_RUN_STATUSES.RUNNING) {
    return { claimed: false, lockId: existing.id, reason: "already_running", jobKey };
  }
  const row = {
    job_key: jobKey,
    scheduled_for: scheduled.toISOString(),
    locked_at: now.toISOString(),
    locked_by: workerId,
    completed_at: null,
    status: TAX_SCHEDULER_RUN_STATUSES.RUNNING,
    metadata,
  };
  const { data, error } = await supabase.from("scheduled_job_locks").upsert(row, { onConflict: "job_key" }).select("*").maybeSingle();
  if (error) return { claimed: false, lockId: null, reason: "lock_claim_failed", jobKey, error };
  return { claimed: true, lockId: data?.id || null, reason: existing ? "reclaimed" : "claimed", jobKey };
}
