import { runMonthlyBriefSchedulerSweepOnce } from "../services/accounting/monthlyBriefSchedulerService.js";

/* global process */

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
let sweepTimer = null;
const schedulerHealth = {
  started: false,
  last_sweep_started_at: null,
  last_sweep_completed_at: null,
  last_sweep_result: null,
  businesses_examined: 0,
  jobs_queued: 0,
  jobs_reused: 0,
  jobs_completed: 0,
  jobs_failed: 0,
  last_error_code: null,
};

function safeErrorCode(err) {
  return String(err?.code || err?.name || "monthly_brief_sweep_failed")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80);
}

function configuredIntervalMs() {
  const value = Number(process.env.MONTHLY_FINANCIAL_PULSE_SWEEP_MS || DEFAULT_INTERVAL_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_INTERVAL_MS;
}

function isDisabled() {
  return String(process.env.DISABLE_BACKGROUND_WORKERS || "").toLowerCase() === "true"
    || String(process.env.DISABLE_MONTHLY_FINANCIAL_PULSE_CRON || "").toLowerCase() === "true";
}

export function getMonthlyFinancialPulseSchedulerHealth({ now = new Date() } = {}) {
  const intervalMs = configuredIntervalMs();
  const lastStarted = schedulerHealth.last_sweep_started_at
    ? new Date(schedulerHealth.last_sweep_started_at).getTime()
    : null;
  return {
    enabled: !isDisabled(),
    effectively_disabled: isDisabled() || !schedulerHealth.started,
    ...schedulerHealth,
    next_expected_sweep_at: lastStarted
      ? new Date(lastStarted + intervalMs).toISOString()
      : (!isDisabled() ? now.toISOString() : null),
    interval_ms: intervalMs,
  };
}

async function runObservedSweep() {
  schedulerHealth.last_sweep_started_at = new Date().toISOString();
  try {
    const result = await runMonthlyFinancialPulseSweepOnce();
    schedulerHealth.last_sweep_completed_at = new Date().toISOString();
    schedulerHealth.last_sweep_result = result?.ok === false ? "completed_with_failures" : "completed";
    schedulerHealth.businesses_examined = Number(result?.businesses || 0);
    schedulerHealth.jobs_queued = Number(result?.queued || 0);
    schedulerHealth.jobs_reused = Number(result?.reused || 0);
    schedulerHealth.jobs_completed = Number(result?.completed || 0);
    schedulerHealth.jobs_failed = Number(result?.failed || 0);
    schedulerHealth.last_error_code = result?.ok === false ? "monthly_brief_targets_failed" : null;
    return result;
  } catch (err) {
    schedulerHealth.last_sweep_completed_at = new Date().toISOString();
    schedulerHealth.last_sweep_result = "failed";
    schedulerHealth.last_error_code = safeErrorCode(err);
    throw err;
  }
}

export async function runMonthlyFinancialPulseSweepOnce() {
  return runMonthlyBriefSchedulerSweepOnce();
}

export function startMonthlyFinancialPulseCron() {
  if (isDisabled()) {
    console.info("[monthly-financial-pulse-cron] disabled via env");
    return;
  }
  if (sweepTimer) return;
  schedulerHealth.started = true;
  const intervalMs = configuredIntervalMs();
  console.info("[monthly-financial-pulse-cron] started", { interval_minutes: Math.round(intervalMs / 60000) });
  runObservedSweep()
    .then((result) => console.info("[monthly-financial-pulse-cron] sweep complete", result))
    .catch((err) => console.warn("[monthly-financial-pulse-cron] sweep failed", err?.message || err));
  sweepTimer = setInterval(() => {
    runObservedSweep()
      .then((result) => console.info("[monthly-financial-pulse-cron] sweep complete", result))
      .catch((err) => console.warn("[monthly-financial-pulse-cron] sweep failed", err?.message || err));
  }, intervalMs);
}

export default startMonthlyFinancialPulseCron;
