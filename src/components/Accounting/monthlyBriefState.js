export const MONTHLY_BRIEF_STATES = Object.freeze({
  LOADING: "loading",
  AVAILABLE: "available",
  NOT_GENERATED: "not_generated",
  REQUEST_FAILED: "request_failed",
  CONTEXT_UNAVAILABLE: "context_unavailable",
  AUTHENTICATION_PENDING: "authentication_pending",
});

export function parseMonthlyBriefResponse(payload) {
  if (!payload || payload.ok !== true || typeof payload.request_id !== "string") {
    throw new Error("malformed_monthly_brief_response");
  }
  if (payload.status === MONTHLY_BRIEF_STATES.NOT_GENERATED && payload.brief === null) {
    return { status: MONTHLY_BRIEF_STATES.NOT_GENERATED, brief: null, requestId: payload.request_id };
  }
  if (payload.status !== MONTHLY_BRIEF_STATES.AVAILABLE || !payload.brief || !payload.brief.content) {
    throw new Error("malformed_monthly_brief_response");
  }
  const brief = payload.brief;
  if (!brief.id || !brief.reporting_month || !["final", "mid_month", "manual"].includes(brief.cadence)) {
    throw new Error("malformed_monthly_brief_response");
  }
  return {
    status: MONTHLY_BRIEF_STATES.AVAILABLE,
    requestId: payload.request_id,
    brief: {
      id: brief.id,
      month: brief.reporting_month,
      cadence: brief.cadence,
      accountingMethod: brief.accounting_method || null,
      generatedAt: brief.generated_at || null,
      dataThroughDate: brief.data_through_date || null,
      revenueSummary: brief.content.revenue_summary || "",
      spendingTrend: brief.content.spending_trend || "",
      varianceFromForecast: brief.content.variance_from_forecast || "",
      businessInsights: Array.isArray(brief.content.business_insights) ? brief.content.business_insights : [],
      motivationalMessage: brief.content.motivational_message || "",
    },
  };
}

export function monthlyBriefErrorState(requestId = null) {
  return {
    status: MONTHLY_BRIEF_STATES.REQUEST_FAILED,
    brief: null,
    requestId,
    error: "Bizzi couldn’t load your latest monthly brief. Your saved brief may still be available.",
  };
}

export async function fetchMonthlyBriefLookup({ apiFetch, url, signal }) {
  const response = await apiFetch(url, { method: "GET", signal });
  const requestId = response.headers.get("x-request-id") || null;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw Object.assign(new Error("non_json_monthly_brief_response"), { requestId });
  }
  const payload = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(payload?.error || `monthly_brief_http_${response.status}`), {
      requestId: payload?.request_id || requestId,
    });
  }
  return parseMonthlyBriefResponse(payload);
}
