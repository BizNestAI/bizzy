import test from "node:test";
import assert from "node:assert/strict";
import { assertIanaTimezone, mutateReportingConfiguration, reportingConfigurationStatus, ReportingConfigurationError } from "../src/services/evidence/reportingConfigurationService.js";

test("configuration lifecycle reports each required verification stage", () => {
  assert.equal(reportingConfigurationStatus(null), "qbo_identity_required");
  const identity = { qbo_realm_id: "realm", provider_schema_version: "75", realm_verified_at: "now", status: "unconfigured" };
  assert.equal(reportingConfigurationStatus(identity, "realm"), "currency_verification_required");
  const currency = { ...identity, home_currency: "USD", currency_verified_at: "now" };
  assert.equal(reportingConfigurationStatus(currency, "realm"), "timezone_confirmation_required");
  assert.equal(reportingConfigurationStatus({ ...currency, reporting_timezone: "America/New_York", timezone_confirmed_at: "now", status: "verified", verified_at: "now" }, "realm"), "verified");
  assert.equal(reportingConfigurationStatus(identity, "other-realm"), "invalidated");
});

test("timezone confirmation uses the runtime IANA authority and rejects guesses", () => {
  assert.equal(assertIanaTimezone("America/Los_Angeles"), "America/Los_Angeles");
  assert.throws(() => assertIanaTimezone("Eastern Time"), (error) => error instanceof ReportingConfigurationError && error.code === "reporting_timezone_invalid");
  assert.throws(() => assertIanaTimezone(""), /reporting_timezone_required/);
});

test("configuration mutation is service RPC-only and validates authoritative inputs before calling it", async () => {
  const calls = [];
  const db = { rpc: async (name, args) => { calls.push([name, args]); return { data: { business_id: args.p_business_id, status: "unconfigured" }, error: null }; } };
  await mutateReportingConfiguration({ db, authorizedBusinessId: "biz", action: "verify_qbo_identity", requestId: "request", verificationSource: "qbo_company_info", providerRealmId: "realm", providerSchemaVersion: "75" });
  assert.equal(calls[0][0], "mutate_business_financial_reporting_config");
  assert.equal(calls[0][1].p_business_id, "biz");
  await assert.rejects(mutateReportingConfiguration({ db, authorizedBusinessId: "biz", action: "verify_currency", requestId: "request-2", verificationSource: "browser", providerCurrency: "USD" }), /authoritative_provider_source_required/);
  await assert.rejects(mutateReportingConfiguration({ db, authorizedBusinessId: "biz", action: "verify_currency", requestId: "request-3", verificationSource: "qbo_report_header", providerCurrency: "usd" }), /authoritative_currency_invalid/);
  await assert.rejects(mutateReportingConfiguration({ db, authorizedBusinessId: "biz", action: "confirm_timezone", requestId: "request-4", verificationSource: "browser_timezone", reportingTimezone: "UTC" }), /timezone_confirmation_source_invalid/);
});
