const CLARIFICATION_SUBMIT_ERROR_MESSAGES = {
  invalid_answer_length: "Use 2 to 200 characters for the answer.",
  not_pending: "This request has already been answered or closed. Refresh and try again.",
  transaction_not_needs_review: "This transaction is no longer awaiting review.",
  canonical_transaction_not_found: "This transaction could not be found. Refresh and try again.",
  plaid_accounting_review_required: "This bank transaction needs an internal account review before it can be answered.",
  pending_transaction_not_postable: "This transaction is still pending at the bank. Please wait 1-2 business days.",
  clarification_update_failed: "We could not save that answer. Try again.",
  clarification_update_not_confirmed: "We could not confirm that answer was saved. Try again.",
  clarification_create_failed: "We could not create the request record. Try again.",
  not_found_or_mismatch: "This request no longer matches the transaction. Refresh and try again.",
  transaction_before_bookkeeping_start_date: "This transaction is outside the active bookkeeping period.",
  clarifications_submit_failed: "We could not submit the answer. Try again.",
};

export function humanizeClarificationSubmitError(code) {
  return CLARIFICATION_SUBMIT_ERROR_MESSAGES[String(code || "").trim()] || CLARIFICATION_SUBMIT_ERROR_MESSAGES.clarifications_submit_failed;
}

export function isClarificationAnswerPersisted(row = {}) {
  return row?.success === true && row?.persisted === true && row?.status === "answered";
}

export function getPersistedClarificationRequestIds(result = {}) {
  return new Set(
    (Array.isArray(result?.rows) ? result.rows : [])
      .filter(isClarificationAnswerPersisted)
      .map((row) => String(row.request_id || row.persisted_request_id || ""))
      .filter(Boolean)
  );
}

export function summarizeClarificationSubmitFailure(resultOrError = {}) {
  const body = resultOrError?.body || resultOrError;
  const rows = Array.isArray(body?.rows) ? body.rows : Array.isArray(resultOrError?.rows) ? resultOrError.rows : [];
  const firstFailed = rows.find((row) => !isClarificationAnswerPersisted(row));
  return humanizeClarificationSubmitError(firstFailed?.error || body?.error || resultOrError?.code || resultOrError?.message);
}

