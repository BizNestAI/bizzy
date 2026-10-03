const CACHE_REASONS = new Set([
  "qbo_match_cache_never_synced",
  "qbo_match_cache_stale",
  "qbo_match_cache_freshness_unknown",
  "qbo_match_cache_unavailable",
  "qbo_match_evidence_columns_unavailable",
]);

const QBO_UNAVAILABLE_REASONS = new Set([
  "qbo_match_cache_latest_sync_failed",
  "qbo_match_cache_latest_sync_not_successful",
  "qbo_match_cache_sync_in_progress",
]);

export function canonicalIncomingDepositLookupOutcome(result = {}) {
  const reasons = new Set(result.reason_codes || []);
  if (result.status === "needs_confirmation") return "candidate_found";
  if (result.status === "ambiguous") {
    return Number(result.independent_candidate_count || 0) > 1
      ? "multiple_candidates_found"
      : "candidate_found";
  }
  if (result.status === "candidate" || result.status === "no_match") {
    return "no_existing_qbo_payment_or_deposit_found";
  }
  if ([...reasons].some((reason) => CACHE_REASONS.has(reason))) return "cached_data_stale_or_missing";
  if ([...reasons].some((reason) => QBO_UNAVAILABLE_REASONS.has(reason))) return "qbo_data_unavailable";
  return result.status === "match_check_unavailable" ? "database_failure" : "candidate_found";
}

export function incomingDepositLookupFailure(error = {}) {
  const code = String(error.code || error.error || error.name || "");
  if (code === "AbortError" || code === "TimeoutError" || code === "REQUEST_TIMEOUT" || /timed out/i.test(String(error.message || ""))) {
    return { outcome: "request_timed_out", message: "The QuickBooks match check timed out. Try again." };
  }
  if (code === "AUTH_INVALID" || String(error.message || "") === "AUTH_INVALID") {
    return { outcome: "qbo_data_unavailable", message: "Your session could not be verified. Refresh the page and try again." };
  }
  return { outcome: "database_failure", message: "The QuickBooks match check could not be completed. Try again." };
}
