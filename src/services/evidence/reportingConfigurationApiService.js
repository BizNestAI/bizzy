import fetch from "node-fetch";
import { createHash, randomUUID } from "node:crypto";
import { qbApiBase, qboEnvName } from "../../utils/qboEnv.js";
import { withQuickBooksAuth } from "../quickbooksTokenService.js";
import { mutateReportingConfiguration, reportingConfigurationStatus } from "./reportingConfigurationService.js";
import { getSuggestedReportingTimezone } from "./reportingTimezoneSuggestions.js";

const PROVIDER_SCHEMA_VERSION = "75";

export async function getSanitizedReportingStatus({ db, businessId }) {
  const { data, error } = await db.from("business_financial_reporting_config").select("status,qbo_realm_id,provider_schema_version,reporting_timezone,home_currency,realm_verified_at,currency_verified_at,timezone_confirmed_at,verified_at,updated_at").eq("business_id", businessId).maybeSingle();
  if (error) return unavailableStatus("evidence_temporarily_unavailable");
  const status = reportingConfigurationStatus(data);
  return { ready: status === "verified", status: publicStatus(status), reason_code: reasonCode(status), reporting_timezone: data?.reporting_timezone || null, currency: data?.home_currency || null, accounting_basis: "Cash", realm_verified_at: data?.realm_verified_at || null, currency_verified_at: data?.currency_verified_at || null, timezone_confirmed_at: data?.timezone_confirmed_at || null, verified_at: data?.verified_at || null, updated_at: data?.updated_at || null, message: statusMessage(status) };
}

export async function ensureFinancialReportingConfiguration({
  db, businessId, requestId = randomUUID(), actorUserId = null, timezoneOverride = null,
  verificationSource = "automatic_quick_prompt", verifyProvider = verifyQboProviderIdentity,
}) {
  if (!businessId) throw new ReportingSetupError("authorized_business_required", 403);
  const [configResult, tokenResult, profileResult] = await Promise.all([
    db.from("business_financial_reporting_config").select("status,qbo_realm_id,provider_schema_version,reporting_timezone,home_currency,realm_verified_at,currency_verified_at,timezone_confirmed_at,verified_at,updated_at").eq("business_id", businessId).maybeSingle(),
    db.from("quickbooks_tokens").select("realm_id,company_id,qbo_env,status,is_active,last_connected_at,connected_at,created_at").eq("business_id", businessId).eq("qbo_env", qboEnvName).eq("status", "active").eq("is_active", true).order("last_connected_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
    db.from("business_profiles").select("state").eq("id", businessId).maybeSingle(),
  ]);
  if (configResult.error || tokenResult.error || profileResult.error) throw new ReportingSetupError("reporting_configuration_unavailable", 503);
  const activeRealmId = String(tokenResult.data?.realm_id || "").trim();
  if (!activeRealmId) throw new ReportingSetupError("quickbooks_not_connected", 409);
  const persistedCompanyId = String(tokenResult.data?.company_id || "").trim();
  if (persistedCompanyId && persistedCompanyId !== activeRealmId) {
    const details = identityMismatchDetails({ expected: activeRealmId, observed: persistedCompanyId, source: "persisted_qbo_connection" });
    console.warn("[financial reporting] QBO connection identity mismatch", details);
    throw new ReportingSetupError("qbo_company_identity_mismatch", 409, details);
  }
  const existing = configResult.data;
  const requestedTimezone = timezoneOverride ? assertServerIanaTimezone(timezoneOverride) : null;
  if (!requestedTimezone && existing?.status === "verified" && existing?.verified_at && existing?.qbo_realm_id === activeRealmId && existing?.home_currency === "USD" && existing?.reporting_timezone) {
    return getSanitizedReportingStatus({ db, businessId });
  }

  let provider;
  if (existing?.qbo_realm_id === activeRealmId && existing?.realm_verified_at && existing?.currency_verified_at && /^[A-Z]{3}$/.test(existing?.home_currency || "")) {
    provider = { realmId: activeRealmId, currency: existing.home_currency, schemaVersion: existing.provider_schema_version || PROVIDER_SCHEMA_VERSION };
  } else {
    provider = await verifyProvider({ businessId });
  }
  if (provider?.realmId !== activeRealmId) {
    const details = identityMismatchDetails({ expected: activeRealmId, observed: provider?.realmId, source: "provider_context" });
    console.warn("[financial reporting] QBO provider identity mismatch", details);
    throw new ReportingSetupError("qbo_company_identity_mismatch", 409, details);
  }
  if (!/^[A-Z]{3}$/.test(provider?.currency || "")) throw new ReportingSetupError("currency_verification_required", 409);

  const inferredTimezone = getSuggestedReportingTimezone(profileResult.data?.state);
  const reportingTimezone = requestedTimezone || existing?.reporting_timezone || inferredTimezone || "America/New_York";
  const timezoneSource = requestedTimezone
    ? "authorized_business_setting"
    : existing?.reporting_timezone
      ? "existing_reporting_timezone"
      : inferredTimezone
        ? "business_profile_inference"
        : "default_fallback";
  const { error } = await db.rpc("initialize_business_financial_reporting_config", {
    p_business_id: businessId,
    p_request_id: requestId,
    p_verification_source: verificationSource,
    p_provider_realm_id: provider.realmId,
    p_provider_schema_version: provider.schemaVersion || PROVIDER_SCHEMA_VERSION,
    p_provider_currency: provider.currency,
    p_reporting_timezone: reportingTimezone,
    p_timezone_source: timezoneSource,
    p_timezone_override: Boolean(requestedTimezone),
    p_actor_user_id: actorUserId,
  });
  if (error) throw error;
  const status = await getSanitizedReportingStatus({ db, businessId });
  if (provider.currency !== "USD") throw new ReportingSetupError("unsupported_reporting_currency", 409, { currency: provider.currency });
  return status;
}

export async function initializeReportingAfterQboConnection({
  db, businessId, requestId = randomUUID(), actorUserId = null, logger = console,
  ensure = ensureFinancialReportingConfiguration,
}) {
  try {
    return await ensure({ db, businessId, requestId, actorUserId, verificationSource: "automatic_qbo_connection" });
  } catch (error) {
    logger.warn?.("[QBO Auth] financial reporting initialization deferred", {
      business_id: businessId,
      code: error?.code || "reporting_configuration_unavailable",
      provider_status: error?.details?.provider_status || null,
    });
    return null;
  }
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

export async function fetchQboReportingIdentity({ realmId, accessToken, fetchImpl = fetch, logger = console }) {
  if (!realmId) throw new ReportingSetupError("qbo_verification_required", 409);
  const companyPayload = await fetchQboMetadataResource({ realmId, accessToken, resource: "companyinfo", path: `companyinfo/${realmId}`, fetchImpl });
  const companyInfo = companyPayload?.CompanyInfo;
  if (!companyInfo) throw new ReportingSetupError("qbo_company_info_missing", 409, { provider_resource: "companyinfo", failure_class: "metadata_missing" });
  // CompanyInfo.Id is the resource/entity identifier returned by QBO. The
  // authenticated OAuth realm remains the company identity and is enforced by
  // the realm-scoped request plus the business-scoped token/config checks.
  if (companyInfo.Id != null && String(companyInfo.Id) !== String(realmId)) {
    logger.info?.("[financial reporting] QBO CompanyInfo entity differs from OAuth realm", {
      provider_resource: "companyinfo",
      failure_class: "entity_id_differs_from_realm",
      realm_fingerprint: identityFingerprint(realmId),
      entity_fingerprint: identityFingerprint(companyInfo.Id),
    });
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }, signal: controller.signal });
  } catch (error) {
    throw new QboMetadataRequestError({ resource, cause: error });
  } finally {
    clearTimeout(timeout);
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

function identityFingerprint(value) {
  const normalized = String(value || "").trim();
  return normalized ? createHash("sha256").update(normalized).digest("hex").slice(0, 12) : null;
}

function identityMismatchDetails({ expected, observed, source }) {
  return {
    provider_resource: source,
    failure_class: "identity_mismatch",
    expected_realm_fingerprint: identityFingerprint(expected),
    observed_identity_fingerprint: identityFingerprint(observed),
  };
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
function reasonCode(status) { return status === "verified" ? null : status === "unsupported_currency" ? "unsupported_reporting_currency" : status === "qbo_identity_required" ? "qbo_verification_required" : status === "currency_verification_required" ? "currency_verification_required" : status === "timezone_confirmation_required" ? "reporting_timezone_required" : status === "invalidated" ? "configuration_invalidated" : "financial_reporting_not_configured"; }
function statusMessage(status) { return status === "verified" ? null : status === "unsupported_currency" ? "Bizzi financial reporting currently supports USD QuickBooks companies." : status === "qbo_identity_required" ? "QuickBooks verification is required." : status === "currency_verification_required" ? "QuickBooks currency verification is required." : status === "timezone_confirmation_required" ? "Bizzi is preparing financial reporting." : status === "invalidated" ? "Financial reporting must be re-verified after the QuickBooks company changed." : "Bizzi is preparing financial reporting."; }
function unavailableStatus(code) { return { ready: false, status: "temporarily_unavailable", reason_code: code, accounting_basis: "Cash", reporting_timezone: null, currency: null, message: "Financial reporting status is temporarily unavailable." }; }
function assertServerIanaTimezone(timezone) {
  const value = String(timezone || "").trim();
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date()); }
  catch { throw new ReportingSetupError("reporting_timezone_invalid", 400); }
  return value;
}
export class ReportingSetupError extends Error {
  constructor(code, status = 400, details = {}) { super(code); this.code = code; this.status = status; this.details = details; }
}
