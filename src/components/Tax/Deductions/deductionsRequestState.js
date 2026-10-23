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

export function selectDeductionsWorkspaceError({ overviewResult, allTransactionsResult, coverageResult } = {}) {
  if (overviewResult?.status === "rejected" && overviewResult.reason?.code !== "request_aborted") {
    return overviewResult.reason;
  }
  const primaryResults = [overviewResult, allTransactionsResult, coverageResult].filter(Boolean);
  const allPrimaryResourcesFailed = primaryResults.length > 0
    && primaryResults.every((result) => result.status === "rejected");
  if (!allPrimaryResourcesFailed) return null;
  return primaryResults.find((result) => result.reason?.code !== "request_aborted")?.reason || null;
}

export function resolveQuestionsPanelState({
  status = "idle",
  authoritativeCount = null,
  renderedCount = 0,
  hasAuthoritativeDetails = false,
} = {}) {
  if (status === "error") return "error";
  if (status !== "success" || !hasAuthoritativeDetails) return "loading";
  const expected = Number(authoritativeCount);
  const rendered = Number(renderedCount);
  if (Number.isFinite(expected) && expected !== rendered) return "error";
  return rendered > 0 ? "ready_nonempty" : "ready_empty";
}
