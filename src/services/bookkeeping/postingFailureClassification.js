const FAILURE_COPY = Object.freeze({
  qbo_transaction_rejected: ["QBO rejected transaction", "QuickBooks rejected the transaction details. Review the account and transaction type before retrying."],
  qbo_account_incompatible: ["QBO rejected account", "The selected QuickBooks account is not compatible with this transaction type."],
  qbo_authentication_failed: ["Reconnect QuickBooks", "The QuickBooks connection must be renewed before posting."],
  qbo_rate_limited: ["QBO temporarily unavailable", "QuickBooks is temporarily limiting requests; Bizzi will retry with backoff."],
  qbo_outcome_ambiguous: ["QBO result needs reconciliation", "The request outcome was not confirmed. Bizzi will reconcile before attempting another write."],
  qbo_posting_realm_mismatch: ["QuickBooks company mismatch", "The posting intent belongs to a different QuickBooks company and cannot be retried automatically."],
  qbo_succeeded_local_finalize_pending: ["Finalizing posted transaction", "QuickBooks accepted the transaction; Bizzi is safely completing the local record."],
  qbo_posting_receipt_update_failed: ["Saving QBO confirmation", "QuickBooks may have accepted the transaction. Bizzi must reconcile the result before retrying."],
  credit_card_inflow_resolution_required: ["Unsupported credit type", "Choose whether this credit is a refund, card payment, or statement credit before posting."],
  cc_payment_post_not_supported: ["Unsupported payment mapping", "This credit-card payment needs a confirmed account pair before posting."],
  cc_payment_mapping_not_safe: ["Payment accounts need review", "The source and destination accounts could not be verified safely."],
  cc_charge_post_not_supported: ["Unsupported card charge", "This card activity cannot be posted with the current account mapping."],
  possible_qbo_duplicate: ["Possible duplicate", "A possible existing QuickBooks transaction must be reviewed before posting."],
  existing_qbo_match_found: ["Existing QBO activity found", "An existing QuickBooks transaction must be linked or explicitly resolved before posting."],
  match_check_unavailable: ["Duplicate check unavailable", "Bizzi could not safely check QuickBooks for existing activity."],
  missing_source_qbo_account: ["Source account needs attention", "Connect this bank or card account to an active QuickBooks account."],
  missing_final_qbo_account: ["QBO account needs attention", "Choose an active QuickBooks account before posting."],
  posting_validation_failed: ["Posting validation failed", "The transaction did not pass the bookkeeping posting checks."],
  posting_internal_failure: ["Posting service error", "Bizzi could not complete the posting operation."],
});

const RETRYABLE_CODES = new Set([
  "qbo_rate_limited",
  "qbo_outcome_ambiguous",
  "qbo_succeeded_local_finalize_pending",
  "qbo_posting_receipt_update_failed",
  "posting_internal_failure",
  "qbo_client_unavailable",
  "acquire_posting_lock_rpc_failed",
  "claim_qbo_posting_intent_failed",
]);

const TERMINAL_CODES = new Set([
  "qbo_transaction_rejected",
  "qbo_account_incompatible",
  "qbo_authentication_failed",
  "qbo_posting_realm_mismatch",
  "credit_card_inflow_resolution_required",
  "cc_payment_post_not_supported",
  "cc_payment_mapping_not_safe",
  "cc_charge_post_not_supported",
  "possible_qbo_duplicate",
  "existing_qbo_match_found",
  "missing_source_qbo_account",
  "missing_final_qbo_account",
  "posting_validation_failed",
]);

function normalizedCode(value) {
  const raw = String(value || "posting_internal_failure").trim().toLowerCase();
  const code = raw.split(":", 1)[0];
  if (/rate.?limit|throttl/.test(raw)) return "qbo_rate_limited";
  if (/timeout|timed.?out|econnreset|socket hang up|etimedout/.test(raw)) return "qbo_outcome_ambiguous";
  if (/realm.*mismatch/.test(raw)) return "qbo_posting_realm_mismatch";
  if (/auth|token.*expir|unauthorized/.test(raw)) return "qbo_authentication_failed";
  if (/account.*(invalid|inactive|incompat)|invalid.*account/.test(raw)) return "qbo_account_incompatible";
  return code || "posting_internal_failure";
}

export function classifyPostingFailure(value, { retryable = null, qboWriteMayHaveOccurred = false } = {}) {
  const supplied = typeof value === "object" && value
    ? value.postingError || value
    : null;
  const code = normalizedCode(supplied?.internal_code || supplied?.code || supplied?.message || value);
  const copy = FAILURE_COPY[code] || ["Needs review", "Bizzi could not post this transaction to QuickBooks."];
  const provenRetryable = retryable ?? supplied?.retryable;
  return {
    code,
    label: copy[0],
    detail: supplied?.user_message || supplied?.userMessage || copy[1],
    retryable: provenRetryable === true || (provenRetryable == null && RETRYABLE_CODES.has(code)),
    terminal: TERMINAL_CODES.has(code) || provenRetryable === false,
    reconcile_before_retry: qboWriteMayHaveOccurred === true || supplied?.qbo_write_may_have_occurred === true || code === "qbo_outcome_ambiguous",
  };
}

export function formatPostingFailureLabel(value) {
  const failure = classifyPostingFailure(value);
  return `Posting failed · ${failure.label}`;
}

export default classifyPostingFailure;
