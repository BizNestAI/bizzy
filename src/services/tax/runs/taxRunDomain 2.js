// /src/services/tax/runs/taxRunDomain.js

const freeze = (value) => Object.freeze(value);

export const TAX_RUN_STATUSES = freeze({
  RUNNING: "running",
  COMPLETED: "completed",
  PARTIAL: "partial",
  FAILED: "failed",
  SUPERSEDED: "superseded",
  ABANDONED: "abandoned",
});

export const TAX_RUN_TRIGGER_SOURCES = freeze({
  MANUAL: "manual",
  PAGE_REFRESH: "page_refresh",
  DAILY_CRON: "daily_cron",
  WEEKLY_CRON: "weekly_cron",
  PLAID_SYNC: "plaid_sync",
  QBO_SYNC: "qbo_sync",
  BOOKS_POSTED: "books_posted",
  CLASSIFICATION_CHANGED: "classification_changed",
  TAX_PROFILE_CHANGED: "tax_profile_changed",
  TAX_MEMORY_CHANGED: "tax_memory_changed",
  TAX_PAYMENT_CHANGED: "tax_payment_changed",
  FORECAST_CHANGED: "forecast_changed",
  ADMIN: "admin",
  SYSTEM: "system",
});

export const TAX_RUN_ERROR_CODES = freeze({
  RUN_PERSISTENCE_FAILED: "run_persistence_failed",
  RUN_COMPONENT_PERSISTENCE_FAILED: "run_component_persistence_failed",
  RUN_CONFLICT: "run_conflict",
  RUN_ALREADY_COMPLETED: "run_already_completed",
  RUN_NOT_FOUND: "run_not_found",
  RUN_ABANDONED: "run_abandoned",
  RUN_SUPERSESSION_FAILED: "run_supersession_failed",
  CALCULATION_FAILED: "calculation_failed",
  INVALID_RUN_STATUS: "invalid_run_status",
  INCOMPLETE_COMPONENT_SET: "incomplete_component_set",
  DUPLICATE_RUN_REQUEST: "duplicate_run_request",
  STALE_SOURCE_DATA: "stale_source_data",
});

export const TAX_RUN_COMPLETION_TYPES = freeze({
  AUTHORITATIVE: "authoritative",
  PARTIAL: "partial",
  DIAGNOSTIC: "diagnostic",
  SCENARIO: "scenario",
});

export const TAX_RUN_SUPERSESSION_REASONS = freeze({
  NEWER_CALCULATION: "newer_calculation",
  SOURCE_DATA_CHANGED: "source_data_changed",
  PROFILE_CHANGED: "profile_changed",
  RULES_CHANGED: "rules_changed",
  MANUAL_OVERRIDE: "manual_override",
  CORRECTION: "correction",
  ADMIN_RECALCULATION: "admin_recalculation",
});

export const COMPLETED_TAX_RUN_STATUSES = freeze([
  TAX_RUN_STATUSES.COMPLETED,
  TAX_RUN_STATUSES.PARTIAL,
]);

export function isTerminalRunStatus(status) {
  return [
    TAX_RUN_STATUSES.COMPLETED,
    TAX_RUN_STATUSES.PARTIAL,
    TAX_RUN_STATUSES.FAILED,
    TAX_RUN_STATUSES.ABANDONED,
  ].includes(status);
}
