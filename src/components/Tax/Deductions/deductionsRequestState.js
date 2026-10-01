export function resolveScopedDeductionsRequestStatus({ requestStatus, scopeKey, enabled }) {
  if (requestStatus?.scopeKey === scopeKey) return requestStatus;
  const status = enabled ? "loading" : "idle";
  return { scopeKey, matrix: status, classification: status };
}

export function resolveDeductionsRenderState({
  sectionStatus = {},
  hasData = false,
  hasMatrixData = hasData,
  hasClassificationData = hasData,
  refreshing = false,
} = {}) {
  const matrix = sectionStatus.matrix || "idle";
  const classification = sectionStatus.classification || "idle";
  return {
    showInitialLoading: (!hasMatrixData && matrix === "loading") || (!hasClassificationData && classification === "loading"),
    showInitialError: (!hasMatrixData && matrix === "error") || (!hasClassificationData && classification === "error"),
    showAuthoritativeData: hasData,
    showUpdating: hasData && refreshing,
  };
}
