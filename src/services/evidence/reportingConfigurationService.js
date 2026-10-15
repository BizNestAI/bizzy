const ACTIONS = new Set(["verify_qbo_identity", "verify_currency", "confirm_timezone", "activate", "invalidate"]);
const PROVIDER_SOURCES = new Set(["qbo_company_info", "qbo_report_header"]);

export class ReportingConfigurationError extends Error {
  constructor(code, status = 400, details = {}) { super(code); this.code = code; this.status = status; this.details = details; }
}

export function reportingConfigurationStatus(row, activeRealmId = null) {
  if (row?.status === "invalidated" || (row?.qbo_realm_id && activeRealmId && row.qbo_realm_id !== activeRealmId)) return "invalidated";
  if (!row?.qbo_realm_id || !row?.realm_verified_at || !row?.provider_schema_version) return "qbo_identity_required";
  if (!row?.home_currency || !row?.currency_verified_at) return "currency_verification_required";
  if (!row?.reporting_timezone || !row?.timezone_confirmed_at) return "timezone_confirmation_required";
  return row?.status === "verified" && row?.verified_at ? "verified" : "timezone_confirmation_required";
}

export async function mutateReportingConfiguration({
  db, authorizedBusinessId, action, requestId, actorUserId = null, verificationSource,
  providerRealmId = null, providerSchemaVersion = null, providerCurrency = null, reportingTimezone = null,
}) {
  if (!authorizedBusinessId) throw new ReportingConfigurationError("authorized_business_required", 403);
  if (!ACTIONS.has(action)) throw new ReportingConfigurationError("unsupported_configuration_action");
  if (!requestId) throw new ReportingConfigurationError("configuration_request_id_required");
  if (action === "verify_qbo_identity") {
    requireProviderSource(verificationSource);
    if (!String(providerSchemaVersion || "").trim()) throw new ReportingConfigurationError("provider_schema_version_required");
  } else if (action === "verify_currency") {
    requireProviderSource(verificationSource);
    const currency = String(providerCurrency || "").trim();
    if (!/^[A-Z]{3}$/.test(currency)) throw new ReportingConfigurationError("authoritative_currency_invalid");
  } else if (action === "confirm_timezone") {
    if (verificationSource !== "authorized_business_setting") throw new ReportingConfigurationError("timezone_confirmation_source_invalid");
    assertIanaTimezone(reportingTimezone);
  }
  const { data, error } = await db.rpc("mutate_business_financial_reporting_config", {
    p_business_id: authorizedBusinessId, p_action: action, p_request_id: requestId,
    p_verification_source: String(verificationSource || (action === "invalidate" ? "service_invalidation" : "service_activation")).trim(),
    p_provider_realm_id: providerRealmId, p_provider_schema_version: providerSchemaVersion,
    p_provider_currency: providerCurrency, p_reporting_timezone: reportingTimezone, p_actor_user_id: actorUserId,
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}
function requireProviderSource(source) { if (!PROVIDER_SOURCES.has(source)) throw new ReportingConfigurationError("authoritative_provider_source_required"); }
export function assertIanaTimezone(timezone) {
  if (!String(timezone || "").trim()) throw new ReportingConfigurationError("reporting_timezone_required");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date()); }
  catch { throw new ReportingConfigurationError("reporting_timezone_invalid"); }
  return timezone;
}
