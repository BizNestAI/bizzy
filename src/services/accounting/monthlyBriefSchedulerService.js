import { supabase as defaultSupabase } from "../supabaseAdmin.js";
import { qboEnvName } from "../../utils/qboEnv.js";
import {
  generateFinancialPulseSnapshot,
  scheduledPulseTargetMonth,
} from "../../api/accounting/monthlyFinancialPulse.js";
import {
  getMonthlyHealthSummary,
  HEALTH_ACCOUNTING_METHOD,
} from "./healthMonthlySnapshotService.js";

const JOB_TABLE = "monthly_financial_pulse_jobs";
const PULSE_TABLE = "monthly_financial_pulse";
const DEFAULT_LOOKBACK_DAYS = 35;
const DEFAULT_STALE_RUNNING_MS = 2 * 60 * 60 * 1000;

function nyDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function dateKey({ year, month, day }) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function dueMonthlyBriefTargets({ now = new Date(), lookbackDays = DEFAULT_LOOKBACK_DAYS } = {}) {
  const targets = new Map();
  for (let i = 0; i <= lookbackDays; i += 1) {
    const date = addDays(now, -i);
    const target = scheduledPulseTargetMonth(date);
    if (!target) continue;
    const due = nyDateParts(date);
    const key = `${target.monthText}:${target.cadence}`;
    if (!targets.has(key)) {
      targets.set(key, {
        target_month: target.monthText,
        cadence: target.cadence,
        due_on: dateKey(due),
      });
    }
  }
  return Array.from(targets.values()).sort((a, b) => a.target_month.localeCompare(b.target_month));
}

export async function runMonthlyBriefSchedulerSweepOnce({
  db = defaultSupabase,
  now = new Date(),
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  generatePulse = generateFinancialPulseSnapshot,
} = {}) {
  const sweepId = `monthly-brief-${now.toISOString()}`;
  const targets = dueMonthlyBriefTargets({ now, lookbackDays });
  if (!targets.length) {
    console.info("[monthly-brief-scheduler] no due targets", { sweep_id: sweepId, now_utc: now.toISOString() });
    return { ok: true, sweep_id: sweepId, targets: 0, businesses: 0, completed: 0, waiting: 0, failed: 0, skipped: 0 };
  }

  console.info("[monthly-brief-scheduler] sweep started", {
    sweep_id: sweepId,
    now_utc: now.toISOString(),
    targets_due: targets.length,
    target_months: targets.map((target) => `${target.target_month}:${target.cadence}`),
  });

  const discovery = await discoverEligibleQboBusinesses({ db });
  const businesses = discovery.businesses || [];
  let completed = 0;
  let waiting = 0;
  let failed = 0;
  let skipped = discovery.skipped || 0;
  const failures = [];

  for (const business of businesses) {
    for (const target of targets) {
      try {
        const result = await ensureMonthlyBriefForTarget({ db, business, target, generatePulse, now });
        if (result.status === "completed" || result.status === "already_available") completed += 1;
        else if (result.status === "waiting_for_snapshot") waiting += 1;
        else if (result.status === "skipped_active" || result.status === "skipped_completed") skipped += 1;
        else if (result.status === "failed") {
          failed += 1;
          failures.push({ business_id: business.business_id, target, error: result.error || null });
        }
      } catch (err) {
        failed += 1;
        failures.push({ business_id: business.business_id, target, error: err?.message || String(err) });
        console.warn("[monthly-brief-scheduler] target failed", {
          sweep_id: sweepId,
          business_id: business.business_id,
          target_month: target.target_month,
          cadence: target.cadence,
          error: err?.message || String(err),
        });
      }
    }
  }

  const result = {
    ok: failed === 0,
    sweep_id: sweepId,
    targets: targets.length,
    businesses: businesses.length,
    discovered_businesses: discovery.discovered,
    completed,
    waiting,
    failed,
    skipped,
    failures,
  };
  console.info("[monthly-brief-scheduler] sweep finished", result);
  return result;
}

export async function discoverEligibleQboBusinesses({ db = defaultSupabase } = {}) {
  const { data: tokenRows, error } = await db
    .from("quickbooks_tokens")
    .select("business_id")
    .eq("qbo_env", qboEnvName)
    .eq("is_active", true)
    .eq("status", "active")
    .not("business_id", "is", null);
  if (error) throw new Error(`monthly_brief_active_business_lookup_failed: ${error.message || error}`);

  const businessIds = Array.from(new Set((tokenRows || []).map((row) => row?.business_id).filter(Boolean)));
  if (!businessIds.length) return { businesses: [], discovered: 0, skipped: 0 };

  const { data: profileRows, error: profileError } = await db
    .from("business_profiles")
    .select("id,user_id,business_name")
    .in("id", businessIds);
  if (profileError) throw new Error(`monthly_brief_business_owner_lookup_failed: ${profileError.message || profileError}`);

  const profileById = new Map((profileRows || []).map((row) => [row.id, row]));
  let skipped = 0;
  const businesses = [];

  for (const businessId of businessIds) {
    const profile = profileById.get(businessId);
    if (!profile?.user_id) {
      skipped += 1;
      console.warn("[monthly-brief-scheduler] skipping business without canonical owner", {
        business_id: businessId,
        reason: profile ? "missing_business_owner_user_id" : "missing_business_profile",
      });
      continue;
    }
    businesses.push({
      business_id: businessId,
      user_id: profile.user_id,
      business_name: profile.business_name || null,
    });
  }

  return { businesses, discovered: businessIds.length, skipped };
}

export async function ensureMonthlyBriefForTarget({
  db = defaultSupabase,
  business,
  target,
  generatePulse = generateFinancialPulseSnapshot,
  now = new Date(),
  staleRunningMs = DEFAULT_STALE_RUNNING_MS,
}) {
  const businessId = business?.business_id || business?.businessId;
  const userId = business?.user_id || business?.userId || null;
  if (!businessId) throw new Error("missing_business_id");
  if (!userId) throw new Error("missing_user_id");

  const existingPulse = await readPulse({ db, businessId, target });
  if (existingPulse?.status === "available") {
    await upsertJob({ db, businessId, userId, target, status: "completed", result: { pulse_id: existingPulse.id, reused: true } });
    return { status: "already_available", pulse_id: existingPulse.id };
  }

  const existingJob = await readJob({ db, businessId, target });
  if (existingJob?.status === "completed") {
    console.warn("[monthly-brief-scheduler] completed job has no readable pulse; retrying", {
      business_id: businessId,
      target_month: target.target_month,
      cadence: target.cadence,
      job_id: existingJob.id,
      pulse_id: existingJob.result?.pulse_id || null,
    });
  }
  if (existingJob?.status === "running" && !isStaleRunningJob(existingJob, now, staleRunningMs)) {
    return { status: "skipped_active", job_id: existingJob.id };
  }

  const job = await upsertJob({
    db,
    businessId,
    userId,
    target,
    status: "running",
    started: true,
    attempts: Number(existingJob?.attempts || 0) + 1,
    result: existingJob?.status === "running" ? { recovered_stale_running_job_id: existingJob.id } : {},
  });
  const { year, month } = partsFromMonthText(target.target_month);
  try {
    const summary = await getMonthlyHealthSummary({ db, businessId, year, month });
    if (!["available", "empty"].includes(summary?.data_status) || !summary?.snapshot?.id) {
      await upsertPulseStatus({
        db,
        businessId,
        userId,
        target,
        status: "waiting_for_snapshot",
        metadata: { reason: "current_cash_snapshot_required", data_status: summary?.data_status || null },
      });
      await upsertJob({
        db,
        businessId,
        userId,
        target,
        status: "waiting_for_snapshot",
        result: { reason: "current_cash_snapshot_required", data_status: summary?.data_status || null },
      });
      return { status: "waiting_for_snapshot" };
    }

    const pulse = await generatePulse({
      db,
      monthlyMetrics: {
        total_revenue: summary.metrics?.totalRevenue,
        total_expenses: summary.metrics?.totalExpenses,
        net_profit: summary.metrics?.netProfit,
        profit_margin: summary.metrics?.profitMargin,
        top_spending_category: summary.metrics?.top_spending_category || summary.metrics?.topSpendingCategory?.name || null,
        accounting_method: HEALTH_ACCOUNTING_METHOD,
        source_snapshot_id: summary.snapshot.id,
      },
      forecastData: {},
      priorMonthMetrics: summary.prior_month?.metrics || {},
      user_id: userId,
      business_id: businessId,
      month: target.target_month,
      cadence: target.cadence,
      sourceSnapshotId: summary.snapshot.id,
    });
    const saved = await readPulse({ db, businessId, target });
    if (!saved?.id) {
      throw new Error("monthly_brief_pulse_persistence_verification_failed");
    }
    if (saved.business_id !== businessId || String(saved.month).slice(0, 10) !== target.target_month || saved.cadence !== target.cadence) {
      throw new Error("monthly_brief_pulse_identity_verification_failed");
    }
    if (summary.snapshot.id && saved.source_snapshot_id && saved.source_snapshot_id !== summary.snapshot.id) {
      throw new Error("monthly_brief_pulse_source_snapshot_mismatch");
    }
    await upsertJob({
      db,
      businessId,
      userId,
      target,
      status: "completed",
      sourceSnapshotId: summary.snapshot.id,
      result: { pulse_id: saved.id, generated: Boolean(pulse), embedding_status: saved.generation_metadata?.embedding_status || null },
      finished: true,
    });
    return { status: "completed", pulse_id: saved.id };
  } catch (err) {
    await upsertPulseStatus({
      db,
      businessId,
      userId,
      target,
      status: "failed",
      metadata: { error: err?.message || String(err) },
    }).catch(() => {});
    await upsertJob({
      db,
      businessId,
      userId,
      target,
      status: "failed",
      error: err?.message || String(err),
      result: { error: err?.message || String(err), job_id: job?.id || null },
      finished: true,
    });
    return { status: "failed", error: err?.message || String(err) };
  }
}

async function readJob({ db, businessId, target }) {
  const { data, error } = await db
    .from(JOB_TABLE)
    .select("*")
    .eq("business_id", businessId)
    .eq("target_month", target.target_month)
    .eq("cadence", target.cadence)
    .maybeSingle();
  if (error) throw new Error(`monthly_brief_job_read_failed: ${error.message || error}`);
  return data || null;
}

function isStaleRunningJob(job, now = new Date(), staleRunningMs = DEFAULT_STALE_RUNNING_MS) {
  const startedAt = job?.started_at || job?.updated_at || job?.created_at;
  if (!startedAt) return true;
  const started = new Date(startedAt);
  if (Number.isNaN(started.getTime())) return true;
  return now.getTime() - started.getTime() > staleRunningMs;
}

async function upsertPulseStatus({ db, businessId, userId, target, status, metadata = {} }) {
  const { error } = await db
    .from(PULSE_TABLE)
    .upsert({
      business_id: businessId,
      user_id: userId,
      month: target.target_month,
      cadence: target.cadence,
      status,
      accounting_method: HEALTH_ACCOUNTING_METHOD,
      generated_at: null,
      data_through_date: target.target_month,
      generation_metadata: metadata,
      created_at: new Date().toISOString(),
      revenue_summary: null,
      spending_trend: null,
      variance_from_forecast: null,
      business_insights: [],
      motivational_message: null,
      embedding_text: null,
      embedding: null,
    }, { onConflict: "business_id,month,cadence" });
  if (error) throw new Error(`monthly_brief_status_upsert_failed: ${error.message || error}`);
}

async function readPulse({ db, businessId, target }) {
  const { data, error } = await db
    .from(PULSE_TABLE)
    .select("*")
    .eq("business_id", businessId)
    .eq("month", target.target_month)
    .eq("cadence", target.cadence)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`monthly_brief_read_failed: ${error.message || error}`);
  return data || null;
}

async function upsertJob({
  db,
  businessId,
  userId,
  target,
  status,
  sourceSnapshotId = null,
  error = null,
  result = {},
  started = false,
  finished = false,
  attempts = null,
}) {
  const now = new Date().toISOString();
  const payload = {
    business_id: businessId,
    user_id: userId,
    target_month: target.target_month,
    cadence: target.cadence,
    status,
    source_snapshot_id: sourceSnapshotId,
    accounting_method: HEALTH_ACCOUNTING_METHOD,
    due_on: target.due_on,
    last_error: error,
    result,
    updated_at: now,
  };
  if (started) payload.started_at = now;
  if (started && !finished) payload.finished_at = null;
  if (finished) payload.finished_at = now;
  if (attempts != null) payload.attempts = attempts;
  const { data, error: upsertError } = await db
    .from(JOB_TABLE)
    .upsert(payload, { onConflict: "business_id,target_month,cadence" })
    .select("*")
    .maybeSingle();
  if (upsertError) throw new Error(`monthly_brief_job_upsert_failed: ${upsertError.message || upsertError}`);
  return data || null;
}

function partsFromMonthText(monthText) {
  const [year, month] = String(monthText || "").split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month)) throw new Error("invalid_target_month");
  return { year, month };
}

export default {
  discoverEligibleQboBusinesses,
  dueMonthlyBriefTargets,
  ensureMonthlyBriefForTarget,
  runMonthlyBriefSchedulerSweepOnce,
};
