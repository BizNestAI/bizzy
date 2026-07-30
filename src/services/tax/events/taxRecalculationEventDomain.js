export const TAX_RECALCULATION_EVENT_TYPES = Object.freeze({
  QBO_TRANSACTION_POSTED: "qbo_transaction_posted",
  QBO_TRANSACTION_VOIDED: "qbo_transaction_voided",
  QBO_TRANSACTION_FAILED_THEN_RESOLVED: "qbo_transaction_failed_then_resolved",
  POSTED_TRANSACTION_ARCHIVED: "posted_transaction_archived",
  POSTED_TRANSACTION_RESTORED: "posted_transaction_restored",
  TRANSACTION_CLASSIFIED: "transaction_classified",
  TRANSACTION_CLASSIFICATION_CONFIRMED: "transaction_classification_confirmed",
  TRANSACTION_CLASSIFICATION_OVERRIDDEN: "transaction_classification_overridden",
  TRANSACTION_CLASSIFICATION_EXCLUDED: "transaction_classification_excluded",
  TRANSACTION_CLASSIFICATION_RESTORED: "transaction_classification_restored",
  BULK_TAX_CLASSIFICATION_CHANGED: "bulk_tax_classification_changed",

  TAX_PROFILE_CREATED: "tax_profile_created",
  TAX_PROFILE_UPDATED: "tax_profile_updated",
  TAX_ENTITY_CHANGED: "tax_entity_changed",
  TAX_ELECTION_CHANGED: "tax_election_changed",
  TAX_FILING_STATUS_CHANGED: "tax_filing_status_changed",
  TAX_STATE_CHANGED: "tax_state_changed",
  TAX_ACCOUNTING_METHOD_CHANGED: "tax_accounting_method_changed",
  TAX_MEMORY_CREATED: "tax_memory_created",
  TAX_MEMORY_UPDATED: "tax_memory_updated",
  TAX_MEMORY_EXPIRED: "tax_memory_expired",

  TAX_PAYMENT_CREATED: "tax_payment_created",
  TAX_PAYMENT_UPDATED: "tax_payment_updated",
  TAX_PAYMENT_VOIDED: "tax_payment_voided",
  TAX_RESERVE_ACCOUNT_CREATED: "tax_reserve_account_created",
  TAX_RESERVE_ACCOUNT_UPDATED: "tax_reserve_account_updated",
  TAX_RESERVE_ACCOUNT_PRIMARY_CHANGED: "tax_reserve_account_primary_changed",
  TAX_RESERVE_BALANCE_REFRESHED: "tax_reserve_balance_refreshed",

  CASHFLOW_FORECAST_UPDATED: "cashflow_forecast_updated",
  FINANCIAL_SOURCE_SYNC_COMPLETED: "financial_source_sync_completed",
  QBO_SYNC_COMPLETED: "qbo_sync_completed",
  PLAID_SYNC_COMPLETED: "plaid_sync_completed",
  SOURCE_DATA_RECONCILIATION_CHANGED: "source_data_reconciliation_changed",

  FEDERAL_TAX_RULE_PUBLISHED: "federal_tax_rule_published",
  FEDERAL_TAX_RULE_UPDATED: "federal_tax_rule_updated",
  STATE_TAX_RULE_PUBLISHED: "state_tax_rule_published",
  STATE_TAX_RULE_UPDATED: "state_tax_rule_updated",
  TAX_DEDUCTION_RULE_PUBLISHED: "tax_deduction_rule_published",
  TAX_DEDUCTION_RULE_UPDATED: "tax_deduction_rule_updated",

  MANUAL_TAX_RECALCULATION_REQUESTED: "manual_tax_recalculation_requested",
  TAX_YEAR_ROLLOVER: "tax_year_rollover",
  TAX_ENGINE_VERSION_CHANGED: "tax_engine_version_changed",
  TAX_CALCULATION_MATERIALLY_CHANGED: "tax_calculation_materially_changed",
});

export const TAX_RECALCULATION_PRIORITIES = Object.freeze({
  CRITICAL: "critical",
  HIGH: "high",
  NORMAL: "normal",
  LOW: "low",
});

export const TAX_RECALCULATION_OUTCOMES = Object.freeze({
  RECALCULATE_NOW: "recalculate_now",
  DEBOUNCE: "debounce",
  QUEUE: "queue",
  SKIP_IMMATERIAL: "skip_immaterial",
  SKIP_DUPLICATE: "skip_duplicate",
  SKIP_UNSUPPORTED: "skip_unsupported",
  BLOCKED_SETUP: "blocked_setup",
  FAILED: "failed",
  COMPLETED: "completed",
});

export const TAX_RECALCULATION_REQUEST_STATUSES = Object.freeze({
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  SKIPPED: "skipped",
  FAILED: "failed",
  DEAD_LETTER: "dead_letter",
});

export const NON_RECALCULATION_EVENT_TYPES = new Set([
  "tax_calculation_completed",
  "tax_calculation_partial",
  "tax_calculation_failed",
  TAX_RECALCULATION_EVENT_TYPES.TAX_CALCULATION_MATERIALLY_CHANGED,
]);

export function isSupportedTaxRecalculationEvent(eventType) {
  return Object.values(TAX_RECALCULATION_EVENT_TYPES).includes(eventType);
}

export function isNonRecalculationEvent(eventType) {
  return NON_RECALCULATION_EVENT_TYPES.has(eventType);
}
