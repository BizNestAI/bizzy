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
  await mutateReportingConfiguration({ db, authorizedBusinessId: businessId, action: "verify_currency", requestId: derivedRequestId(requestId, "currency"), actorUserId, verificationSource: "qbo_company_info", providerRealmId: provider.realmId, providerCurrency: provider.currency });
  await mutateReportingConfiguration({ db, authorizedBusinessId: businessId, action: "confirm_timezone", requestId: derivedRequestId(requestId, "timezone"), actorUserId, verificationSource: "authorized_business_setting", reportingTimezone: timezone });
  await mutateReportingConfiguration({ db, authorizedBusinessId: businessId, action: "activate", requestId: derivedRequestId(requestId, "activate"), actorUserId, verificationSource: "service_activation" });
  return getSanitizedReportingStatus({ db, businessId });
}

export async function verifyQboProviderIdentity({ businessId, fetchImpl = fetch }) {
  return withQuickBooksAuth(businessId, async (accessToken, context) => {
    if (!context?.realmId) throw new ReportingSetupError("qbo_verification_required", 409);
    const url = new URL(`${qbApiBase}/v3/company/${context.realmId}/companyinfo/${context.realmId}`);
    url.searchParams.set("minorversion", PROVIDER_SCHEMA_VERSION);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
    if (!response.ok) throw new ReportingSetupError("reporting_verification_temporarily_unavailable", 503);
    const info = (await response.json())?.CompanyInfo;
    const currency = String(info?.CurrencyPrefs?.HomeCurrency?.value || info?.CurrencyPrefs?.HomeCurrency || info?.HomeCurrency || "").toUpperCase();
    if (!currency) throw new ReportingSetupError("currency_verification_required", 409);
    return { realmId: context.realmId, currency, schemaVersion: PROVIDER_SCHEMA_VERSION };
  });
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
export class ReportingSetupError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }
