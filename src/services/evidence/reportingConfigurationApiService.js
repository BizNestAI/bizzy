import fetch from "node-fetch";
import { createHash } from "node:crypto";
import { qbApiBase } from "../../utils/qboEnv.js";
import { withQuickBooksAuth } from "../quickbooksTokenService.js";
import { mutateReportingConfiguration, reportingConfigurationStatus } from "./reportingConfigurationService.js";

const PROVIDER_SCHEMA_VERSION = "75";

export async function getSanitizedReportingStatus({ db, businessId }) {
  const { data, error } = await db.from("business_financial_reporting_config").select("status,qbo_realm_id,provider_schema_version,reporting_timezone,home_currency,realm_verified_at,currency_verified_at,timezone_confirmed_at,verified_at,updated_at").eq("business_id", businessId).maybeSingle();
  if (error) return unavailableStatus("evidence_temporarily_unavailable");
  const status = reportingConfigurationStatus(data);
  return { ready: status === "verified", status: publicStatus(status), reason_code: reasonCode(status), reporting_timezone: data?.reporting_timezone || null, currency: data?.home_currency || null, accounting_basis: "Cash", realm_verified_at: data?.realm_verified_at || null, currency_verified_at: data?.currency_verified_at || null, timezone_confirmed_at: data?.timezone_confirmed_at || null, verified_at: data?.verified_at || null, updated_at: data?.updated_at || null, message: statusMessage(status) };
}

export async function verifyAndActivateReportingConfiguration({ db, businessId, timezone, requestId, actorUserId, verifyProvider = verifyQboProviderIdentity }) {
  const provider = await verifyProvider({ businessId });
  if (!provider?.realmId || !/^[A-Z]{3}$/.test(provider?.currency || "")) throw new ReportingSetupError("qbo_verification_required", 409);
  await mutateReportingConfiguration({ db, authorizedBusinessId: businessId, action: "verify_qbo_identity", requestId: derivedRequestId(requestId, "realm"), actorUserId, verificationSource: "qbo_company_info", providerRealmId: provider.realmId, providerSchemaVersion: provider.schemaVersion || PROVIDER_SCHEMA_VERSION });
  await mutateReportingConfiguration({ db, authorizedBusinessId: businessId, action: "verify_currency", requestId: derivedRequestId(requestId, "currency"), actorUserId, verificationSource: provider.currencySource || "qbo_preferences", providerRealmId: provider.realmId, providerCurrency: provider.currency });
  await mutateReportingConfiguration({ db, authorizedBusinessId: businessId, action: "confirm_timezone", requestId: derivedRequestId(requestId, "timezone"), actorUserId, verificationSource: "authorized_business_setting", reportingTimezone: timezone });
  await mutateReportingConfiguration({ db, authorizedBusinessId: businessId, action: "activate", requestId: derivedRequestId(requestId, "activate"), actorUserId, verificationSource: "service_activation" });
  return getSanitizedReportingStatus({ db, businessId });
}

export async function verifyQboProviderIdentity({ businessId, fetchImpl = fetch, authenticate = withQuickBooksAuth }) {
  try {
    return await authenticate(businessId, async (accessToken, context) => {
      if (!context?.realmId) throw new ReportingSetupError("qbo_verification_required", 409);
      return fetchQboReportingIdentity({ realmId: context.realmId, accessToken, fetchImpl });
    });
  } catch (error) {
    if (error instanceof ReportingSetupError) throw error;
    if (error instanceof QboMetadataRequestError) {
      const details = error.diagnosticDetails();
      if ([401, 403].includes(error.providerStatus)) throw new ReportingSetupError("quickbooks_needs_reconnect", 409, details);
      if (error.providerStatus === 429) throw new ReportingSetupError("quickbooks_rate_limited", 503, details);
      throw new ReportingSetupError("reporting_verification_temporarily_unavailable", 503, details);
    }
    const code = String(error?.code || error?.message || "");
    if (code.includes("quickbooks_not_connected") || code.includes("quickbooks_needs_reconnect")) {
      throw new ReportingSetupError("quickbooks_needs_reconnect", 409, { failure_class: "credentials" });
    }
    throw new ReportingSetupError("reporting_verification_temporarily_unavailable", 503, { failure_class: "transport" });
  }
}

export async function fetchQboReportingIdentity({ realmId, accessToken, fetchImpl = fetch }) {
  if (!realmId) throw new ReportingSetupError("qbo_verification_required", 409);
  const companyPayload = await fetchQboMetadataResource({ realmId, accessToken, resource: "companyinfo", path: `companyinfo/${realmId}`, fetchImpl });
  const companyInfo = companyPayload?.CompanyInfo;
  if (!companyInfo) throw new ReportingSetupError("qbo_company_info_missing", 409, { provider_resource: "companyinfo", failure_class: "metadata_missing" });
  if (companyInfo.Id != null && String(companyInfo.Id) !== String(realmId)) {
    throw new ReportingSetupError("qbo_company_identity_mismatch", 409, { provider_resource: "companyinfo", failure_class: "identity_mismatch" });
  }

  const preferencesPayload = await fetchQboMetadataResource({ realmId, accessToken, resource: "preferences", path: "preferences", fetchImpl });
  const currency = parseQboHomeCurrency(preferencesPayload);
  if (!currency) {
    throw new ReportingSetupError("currency_verification_required", 409, { provider_resource: "preferences", failure_class: "metadata_missing" });
  }
  return { realmId: String(realmId), currency, currencySource: "qbo_preferences", schemaVersion: PROVIDER_SCHEMA_VERSION };
}

export function parseQboHomeCurrency(payload) {
  const homeCurrency = payload?.Preferences?.CurrencyPrefs?.HomeCurrency;
  const raw = typeof homeCurrency === "string" ? homeCurrency : homeCurrency?.value;
  const currency = String(raw || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

async function fetchQboMetadataResource({ realmId, accessToken, resource, path, fetchImpl }) {
  const url = new URL(`${qbApiBase}/v3/company/${realmId}/${path}`);
  url.searchParams.set("minorversion", PROVIDER_SCHEMA_VERSION);
  let response;
  try {
    response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  } catch (error) {
    throw new QboMetadataRequestError({ resource, cause: error });
  }
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    throw new QboMetadataRequestError({
      resource,
      providerStatus: response.status,
      providerFaultCode: qboFaultCode(payload),
    });
  }
  if (!payload || typeof payload !== "object") {
    throw new QboMetadataRequestError({ resource, providerStatus: response.status, providerFaultCode: "invalid_json" });
  }
  return payload;
}

function qboFaultCode(payload) {
  return String(payload?.Fault?.Error?.[0]?.code || payload?.Fault?.type || "").slice(0, 80) || null;
}

class QboMetadataRequestError extends Error {
  constructor({ resource, providerStatus = null, providerFaultCode = null, cause = null }) {
    super("qbo_metadata_request_failed");
    this.code = "qbo_metadata_request_failed";
    this.status = providerStatus;
    this.providerStatus = providerStatus;
    this.providerResource = resource;
    this.providerFaultCode = providerFaultCode;
    this.cause = cause;
  }
  diagnosticDetails() {
    return {
      provider_resource: this.providerResource,
      provider_status: this.providerStatus,
      provider_fault_code: this.providerFaultCode,
      failure_class: this.providerStatus == null ? "transport" : "provider_response",
    };
  }
}

function derivedRequestId(requestId, action) {
  const hex = createHash("sha256").update(`${requestId}:${action}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4"; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0,8).join("")}-${hex.slice(8,12).join("")}-${hex.slice(12,16).join("")}-${hex.slice(16,20).join("")}-${hex.slice(20).join("")}`;
}
function publicStatus(status) { return status === "verified" ? "financial_reporting_ready" : status === "invalidated" ? "configuration_invalidated" : status; }
function reasonCode(status) { return status === "verified" ? null : status === "qbo_identity_required" ? "qbo_verification_required" : status === "currency_verification_required" ? "currency_verification_required" : status === "timezone_confirmation_required" ? "reporting_timezone_required" : status === "invalidated" ? "configuration_invalidated" : "financial_reporting_not_configured"; }
function statusMessage(status) { return status === "verified" ? null : status === "qbo_identity_required" ? "QuickBooks verification is required." : status === "currency_verification_required" ? "QuickBooks currency verification is required." : status === "timezone_confirmation_required" ? "Choose a reporting timezone in Settings." : status === "invalidated" ? "Financial reporting must be re-verified after the QuickBooks company changed." : "Finish Financial reporting setup in Settings to use this question."; }
function unavailableStatus(code) { return { ready: false, status: "temporarily_unavailable", reason_code: code, accounting_basis: "Cash", reporting_timezone: null, currency: null, message: "Financial reporting status is temporarily unavailable." }; }
export class ReportingSetupError extends Error {
  constructor(code, status = 400, details = {}) { super(code); this.code = code; this.status = status; this.details = details; }
}
