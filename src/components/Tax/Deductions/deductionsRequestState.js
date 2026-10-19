export function resolveScopedDeductionsRequestStatus({ requestStatus, scopeKey, enabled }) {
  if (requestStatus?.scopeKey === scopeKey) return requestStatus;
  const status = enabled ? "loading" : "idle";
  return { scopeKey, overview: status, matrix: status, classification: status };
}

export function resolveDeductionsRenderState({
  sectionStatus = {},
  hasData = false,
  hasSummaryData = hasData,
  contextPending = false,
  refreshing = false,
} = {}) {
  const overview = sectionStatus.overview || "idle";
  return {
    showInitialLoading: contextPending || (!hasSummaryData && overview === "loading"),
    showInitialError: !contextPending && !hasSummaryData && overview === "error",
    showAuthoritativeData: hasData,
    showUpdating: hasData && refreshing,
  };
}
