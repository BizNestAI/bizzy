export const SAFE_RECONCILIATION_ERROR_MESSAGE =
  "An internal issue occurred during reconciliation. Bizzi will retry automatically.";

export function getSafeReconciliationErrorMessage(error, status, details) {
  if (status === "failed" || details?.error || error) {
    return SAFE_RECONCILIATION_ERROR_MESSAGE;
  }
  return SAFE_RECONCILIATION_ERROR_MESSAGE;
}

export function shouldShowReconciliationLogHint(error, status, details) {
  return Boolean(status === "failed" || details?.error || error);
}
