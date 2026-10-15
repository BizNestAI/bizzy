import { apiUrl, safeFetch } from "../../utils/safeFetch.js";

export async function getReportingConfigurationStatus(businessId) {
  if (!businessId) return { status: "temporarily_unavailable", ready: false, reason_code: "business_required" };
  const url = new URL(apiUrl("/api/gpt/reporting-status"));
  url.searchParams.set("business_id", businessId);
  return safeFetch(url.toString(), { headers: { "x-business-id": businessId } });
}

export async function configureFinancialReporting({ businessId, timezone, requestId }) {
  return safeFetch(apiUrl("/api/gpt/reporting-configuration"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-business-id": businessId, "x-idempotency-key": requestId },
    body: { business_id: businessId, reporting_timezone: timezone, request_id: requestId },
  });
}
