export const TAX_SCHEDULE_JOB_TYPES = Object.freeze({
  DAILY_FRESHNESS_SCAN: "daily_tax_freshness_scan",
  DAILY_CALCULATION: "daily_tax_calculation",
  DAILY_DEADLINE_SCAN: "daily_tax_deadline_scan",
  DAILY_RESERVE_REFRESH: "daily_tax_reserve_refresh",
  WEEKLY_FULL_RECALCULATION: "weekly_tax_full_recalculation",
  WEEKLY_QUALITY_SCAN: "weekly_tax_quality_scan",
  ANNUAL_YEAR_ROLLOVER: "annual_tax_year_rollover",
});

export const TAX_SCHEDULER_RUN_STATUSES = Object.freeze({
  RUNNING: "running",
  COMPLETED: "completed",
  SKIPPED: "skipped",
  FAILED: "failed",
  EXPIRED: "expired",
});

export const TAX_SCHEDULER_ELIGIBILITY_REASONS = Object.freeze({
  ELIGIBLE: "eligible",
  PROFILE_INCOMPLETE: "profile_incomplete",
  NO_POSTED_TRANSACTIONS: "no_posted_transactions",
  UNSUPPORTED_ENTITY: "unsupported_entity",
  RULES_MISSING: "rules_missing",
  SOURCE_STALE: "source_stale",
  RECENT_RUN_FRESH: "recent_run_fresh",
  CALCULATION_RUNNING: "calculation_running",
  DISABLED: "disabled",
  NO_BUSINESS_OWNER: "no_business_owner",
});

export const TAX_SCHEDULER_TRIGGER_SOURCES = Object.freeze({
  DAILY_CRON: "daily_cron",
  WEEKLY_CRON: "weekly_cron",
});

export const DEFAULT_TAX_SCHEDULER_PAGE_SIZE = 100;
export const DEFAULT_TAX_SCHEDULER_LOCK_TTL_SECONDS = 2 * 60 * 60;
export const DEFAULT_RECENT_RUN_FRESH_HOURS = 18;
export const DEFAULT_RESERVE_STALE_HOURS = 24;

export function currentTaxYear(date = new Date()) {
  return date.getUTCFullYear();
}

export function dayWindow(date = new Date()) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function weekWindow(date = new Date()) {
  const d = dayWindow(date);
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

export function schedulerEnvironment() {
  return process.env.TAX_SCHEDULER_ENV || process.env.NODE_ENV || "development";
}

export function schedulerJobKey(jobType, scheduledFor, environment = schedulerEnvironment()) {
  const when = scheduledFor instanceof Date ? scheduledFor.toISOString() : new Date(scheduledFor).toISOString();
  return `tax:${environment}:${jobType}:${when}`;
}

export function isTaxSchedulerEnabled(env = process.env) {
  const explicit = String(env.TAX_SCHEDULER_ENABLED || "").trim().toLowerCase();
  if (["true", "1", "yes"].includes(explicit)) return true;
  if (["false", "0", "no"].includes(explicit)) return false;
  return env.NODE_ENV === "production";
}
