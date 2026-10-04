const SECRET_KEY = /(authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|cookie)/i;

function safeValue(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 5) return "[truncated]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => safeValue(entry, depth + 1, seen));
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET_KEY.test(key))
    .slice(0, 50)
    .map(([key, entry]) => [key, safeValue(entry, depth + 1, seen)]));
}

function firstString(...values) {
  for (const value of values.flat(Infinity)) {
    if (typeof value === "string" && value.trim() && value.trim() !== "[object Object]") return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

export function normalizePostingError(error, context = {}) {
  const source = error?.response?.data ?? error?.body ?? error?.data ?? error;
  const fault = source?.Fault || source?.fault || error?.Fault || error?.fault || null;
  const providerError = fault?.Error?.[0] || fault?.error?.[0] || source?.Error?.[0] || source?.error?.[0] || null;
  const providerStatus = Number(error?.response?.status || error?.statusCode || context.providerHttpStatus) || null;
  const providerCode = firstString(providerError?.code, providerError?.Code, error?.code);
  const providerDetail = firstString(providerError?.Detail, providerError?.detail, source?.detail, error?.detail);
  const providerMessage = firstString(providerError?.Message, providerError?.message, source?.message, error?.message);
  const providerCorrelationId = firstString(error?.response?.headers?.intuit_tid, error?.response?.headers?.["intuit-tid"], error?.intuit_tid, source?.intuit_tid, context.providerCorrelationId);
  const text = firstString(providerDetail, providerMessage, typeof source === "string" ? source : null, "Unexpected posting failure");
  const lower = `${providerCode || ""} ${text || ""}`.toLowerCase();
  const timedOut = /(timeout|timed out|econnreset|socket hang up|etimedout)/.test(lower);
  const authFailed = providerStatus === 401 || providerStatus === 403 || /(authentication|unauthorized|token expired)/.test(lower);
  const rateLimited = providerStatus === 429 || /(rate limit|throttl)/.test(lower);
  const explicitProviderRejection = Boolean(fault || providerError) && !timedOut && !authFailed && !rateLimited;

  let code = firstString(context.internalCode, error?.internalCode, error?.code, "posting_internal_failure");
  let httpStatus = Number(error?.httpStatus || error?.status) || 500;
  let userMessage = "Bizzi could not post this transaction to QuickBooks.";
  // `null` means the caller must classify an internal/transport failure. Using
  // false as the default incorrectly dead-lettered every unrecognized transient
  // database or worker error after its first attempt.
  let retryable = null;
  let qboWriteMayHaveOccurred = context.qboWriteStarted === true;
  if (explicitProviderRejection) {
    code = "qbo_transaction_rejected";
    httpStatus = 422;
    userMessage = /transaction amount that is 0 or greater/i.test(providerDetail || providerMessage || "") && context.entityType === "CreditCardCredit"
      ? "QuickBooks rejected the merchant refund amount. Nothing was posted; review the selected expense account and try again."
      : providerDetail?.includes("Add a line item")
      ? "QuickBooks rejected the deposit because it did not contain a valid line item."
      : "QuickBooks rejected this transaction. Review its account and transaction details, then try again.";
    qboWriteMayHaveOccurred = false;
    retryable = false;
  } else if (authFailed) {
    code = "qbo_authentication_failed";
    httpStatus = 401;
    userMessage = "QuickBooks must be reconnected before this transaction can be posted.";
    qboWriteMayHaveOccurred = false;
    retryable = false;
  } else if (rateLimited) {
    code = "qbo_rate_limited";
    httpStatus = 503;
    userMessage = "QuickBooks is temporarily limiting requests. Try again shortly.";
    retryable = true;
    qboWriteMayHaveOccurred = false;
  } else if (timedOut) {
    code = "qbo_outcome_ambiguous";
    httpStatus = 502;
    userMessage = "QuickBooks did not confirm whether the transaction was created. Bizzi will reconcile it before another attempt.";
    qboWriteMayHaveOccurred = true;
  } else if (lower.includes("match_check_unavailable")) {
    code = "match_check_unavailable";
    httpStatus = 409;
    userMessage = "Bizzi could not check QuickBooks for an existing transaction.";
    qboWriteMayHaveOccurred = false;
    retryable = false;
  } else if (lower.includes("existing_qbo_match_found") || lower.includes("possible_qbo_duplicate")) {
    code = "qbo_duplicate_found";
    httpStatus = 409;
    userMessage = "Bizzi found a possible existing QuickBooks transaction and did not create a duplicate.";
    qboWriteMayHaveOccurred = false;
    retryable = false;
  } else if (lower.includes("credit_card_inflow_resolution_required") || lower.includes("credit_card_inflow_requires_review")) {
    code = "credit_card_inflow_resolution_required";
    httpStatus = 409;
    userMessage = "Identify this credit as a merchant refund, credit-card payment, or cash back/statement credit before posting.";
    qboWriteMayHaveOccurred = false;
    retryable = false;
  } else if (context.stage && context.qboWriteStarted !== true) {
    code = firstString(context.internalCode, "posting_validation_failed");
    httpStatus = 422;
    userMessage = "Bizzi could not validate this transaction for QuickBooks.";
    qboWriteMayHaveOccurred = false;
    retryable = false;
  }
  return {
    code, internal_code: code, message: text, user_message: userMessage,
    provider: context.provider || "quickbooks", provider_http_status: providerStatus,
    provider_error_code: providerCode, provider_message: providerMessage, provider_detail: providerDetail,
    provider_element: firstString(providerError?.element, providerError?.Element),
    provider_correlation_id: providerCorrelationId, provider_fault_type: firstString(fault?.type, fault?.Type),
    entity_type: context.entityType || null, workflow_stage: context.stage || "unknown",
    qbo_write_may_have_occurred: qboWriteMayHaveOccurred, retryable,
    reference_id: context.referenceId || error?.qbo_request_id || error?.child_operation_id || null,
    http_status: httpStatus, sanitized_error: safeValue(source),
  };
}

export function createPostingError(error, context = {}) {
  const normalized = normalizePostingError(error, context);
  const wrapped = new Error(normalized.code);
  wrapped.name = "PostingError";
  wrapped.status = normalized.http_status;
  wrapped.internalCode = normalized.code;
  wrapped.userMessage = normalized.user_message;
  wrapped.postingError = normalized;
  wrapped.qbo_request_id = normalized.reference_id;
  wrapped.qbo_write_may_have_occurred = normalized.qbo_write_may_have_occurred;
  wrapped.cause = error;
  return wrapped;
}
