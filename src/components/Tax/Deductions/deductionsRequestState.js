export function resolveScopedDeductionsRequestStatus({ requestStatus, scopeKey, enabled }) {
  if (requestStatus?.scopeKey === scopeKey) return requestStatus;
  const status = enabled ? "loading" : "idle";
  return { scopeKey, overview: status, matrix: status, classification: status };
}

export const TAX_WORKSPACE_DETAIL_TIMEOUT_MS = 20_000;

export async function withBoundedWorkspaceRead(operation, {
  signal,
  timeoutMs = TAX_WORKSPACE_DETAIL_TIMEOUT_MS,
  timeoutCode = "tax_deductions_detail_timeout",
} = {}) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener?.("abort", abortFromParent, { once: true });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error("Tax transaction details timed out."), {
        code: timeoutCode,
        retryable: true,
      }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", abortFromParent);
  }
}

export function resolveDeductionsRenderState({
  sectionStatus = {},
  hasData = false,
  hasSummaryData = hasData,
  contextPending = false,
  refreshing = false,
} = {}) {
  const overview = sectionStatus.overview || "idle";
  const matrix = sectionStatus.matrix || "idle";
  const hasPartialWorkspace = hasSummaryData && matrix === "error";
  const state = contextPending
    ? "bootstrapping_context"
    : !hasSummaryData && overview === "error"
      ? "fatal_error"
      : !hasSummaryData
        ? "initial_loading"
        : refreshing
          ? "refreshing"
          : hasPartialWorkspace
            ? "partial_error"
            : "ready";
  return {
    state,
    showInitialLoading: state === "bootstrapping_context" || state === "initial_loading",
    showInitialError: state === "fatal_error",
    showAuthoritativeData: hasData && hasSummaryData,
    showUpdating: hasSummaryData && state === "refreshing",
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
