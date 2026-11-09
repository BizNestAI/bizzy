/* global process */
export const PLAID_RECOVERY_CONTRACT = Object.freeze({
  defaultImportFreshnessHours: 26,
  reconciliationManifestTtlSeconds: 300,
  classifications: Object.freeze([
    "categorization_processing", "categorization_lease_active", "categorization_lease_stale", "unresolved_dead_letter",
    "needs_user_review", "excluded_or_personal", "matched_existing_qbo", "handled_without_posting",
    "existing_posted_receipt", "pending_qbo_receipt", "unknown_qbo_receipt", "failed_qbo_attempt",
    "possible_qbo_duplicate", "protected_workflow", "safe_for_reviewed_release", "evidence_changed",
  ]),
});

export function importFreshnessHours(value = process.env.PLAID_IMPORT_FRESHNESS_HOURS) {
  const hours = Number(value);
  return Number.isFinite(hours) && hours >= 1 && hours <= 168 ? hours : PLAID_RECOVERY_CONTRACT.defaultImportFreshnessHours;
}
