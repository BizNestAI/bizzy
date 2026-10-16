import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  fetchQboReportingIdentity,
  parseQboHomeCurrency,
  ReportingSetupError,
  verifyAndActivateReportingConfiguration,
  verifyQboProviderIdentity,
} from "../src/services/evidence/reportingConfigurationApiService.js";

const jsonResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  async text() { return JSON.stringify(payload); },
});

function metadataFetch({ currency = "USD", preferenceShape = "ref", failure = null } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/companyinfo/")) {
      return jsonResponse(200, { CompanyInfo: { Id: "realm-1", CompanyName: "Example Co" } });
    }
    if (failure) return jsonResponse(failure.status, failure.payload || { Fault: { Error: [{ code: failure.code }] } });
    const HomeCurrency = preferenceShape === "string" ? currency : preferenceShape === "missing" ? undefined : { value: currency };
    return jsonResponse(200, { Preferences: { CurrencyPrefs: { HomeCurrency } } });
  };
  return { calls, fetchImpl };
}

test("authoritative QBO Preferences verifies USD without reading currency from CompanyInfo", async () => {
  const { calls, fetchImpl } = metadataFetch({ currency: "usd" });
  const result = await fetchQboReportingIdentity({ realmId: "realm-1", accessToken: "secret", fetchImpl });
  assert.deepEqual(result, { realmId: "realm-1", currency: "USD", currencySource: "qbo_preferences", schemaVersion: "75" });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /companyinfo\/realm-1/);
  assert.match(calls[1], /\/preferences\?/);
  assert.ok(calls.every((url) => url.includes("minorversion=75")));
});

test("authoritative QBO Preferences preserves a non-USD home currency", async () => {
  const { fetchImpl } = metadataFetch({ currency: "CAD", preferenceShape: "string" });
  const result = await fetchQboReportingIdentity({ realmId: "realm-1", accessToken: "secret", fetchImpl });
  assert.equal(result.currency, "CAD");
});

test("missing or malformed Preferences currency fails closed and never defaults to USD", async () => {
  assert.equal(parseQboHomeCurrency({ Preferences: { CurrencyPrefs: {} } }), null);
  assert.equal(parseQboHomeCurrency({ Preferences: { CurrencyPrefs: { HomeCurrency: { value: "US" } } } }), null);
  const { fetchImpl } = metadataFetch({ preferenceShape: "missing" });
  await assert.rejects(
    fetchQboReportingIdentity({ realmId: "realm-1", accessToken: "secret", fetchImpl }),
    (error) => error instanceof ReportingSetupError && error.code === "currency_verification_required" && error.details.provider_resource === "preferences",
  );
});

test("QBO provider statuses and fault codes remain available for auth retry and diagnostics", async () => {
  for (const expected of [401, 429, 503]) {
    const { fetchImpl } = metadataFetch({ failure: { status: expected, code: `fault-${expected}` } });
    await assert.rejects(
      fetchQboReportingIdentity({ realmId: "realm-1", accessToken: "secret", fetchImpl }),
      (error) => error.status === expected && error.providerStatus === expected && error.providerFaultCode === `fault-${expected}`,
    );
  }
});

test("expired access credentials can be refreshed once before Preferences verification succeeds", async () => {
  let attempts = 0;
  const authenticate = async (_businessId, operation) => {
    try {
      attempts += 1;
      return await operation("expired", { realmId: "realm-1" });
    } catch (error) {
      assert.equal(error.status, 401);
      attempts += 1;
      return operation("refreshed", { realmId: "realm-1" });
    }
  };
  const fetchImpl = async (url, init) => {
    if (init.headers.Authorization === "Bearer expired") return jsonResponse(401, { Fault: { Error: [{ code: "3200" }] } });
    if (String(url).includes("/companyinfo/")) return jsonResponse(200, { CompanyInfo: { Id: "realm-1" } });
    return jsonResponse(200, { Preferences: { CurrencyPrefs: { HomeCurrency: { value: "USD" } } } });
  };
  const result = await verifyQboProviderIdentity({ businessId: "biz", fetchImpl, authenticate });
  assert.equal(attempts, 2);
  assert.equal(result.currency, "USD");
});

test("revoked credentials, rate limits, and provider outages receive safe classifications", async () => {
  const cases = [
    [401, "quickbooks_needs_reconnect", 409],
    [429, "quickbooks_rate_limited", 503],
    [503, "reporting_verification_temporarily_unavailable", 503],
  ];
  for (const [providerStatus, code, status] of cases) {
    const authenticate = async (_businessId, operation) => operation("token", { realmId: "realm-1" });
    const { fetchImpl } = metadataFetch({ failure: { status: providerStatus, code: "provider-code" } });
    await assert.rejects(
      verifyQboProviderIdentity({ businessId: "biz", fetchImpl, authenticate }),
      (error) => error.code === code && error.status === status && error.details.provider_status === providerStatus,
    );
  }
});

test("successful activation remains Cash-authoritative, ordered, idempotent, and Preferences-sourced", async () => {
  const calls = [];
  const config = { status: "verified", qbo_realm_id: "realm-1", provider_schema_version: "75", reporting_timezone: "America/New_York", home_currency: "USD", realm_verified_at: "r", currency_verified_at: "c", timezone_confirmed_at: "t", verified_at: "v", updated_at: "u" };
  const db = {
    from() { return { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: config, error: null }; } }; },
    async rpc(name, args) { calls.push([name, args]); return { data: config, error: null }; },
  };
  const args = { db, businessId: "biz", timezone: "America/New_York", requestId: "request-1", actorUserId: "owner", verifyProvider: async () => ({ realmId: "realm-1", currency: "USD", currencySource: "qbo_preferences", schemaVersion: "75" }) };
  const first = await verifyAndActivateReportingConfiguration(args);
  const second = await verifyAndActivateReportingConfiguration(args);
  assert.equal(first.accounting_basis, "Cash");
  assert.equal(first.ready, true);
  assert.equal(second.ready, true);
  assert.deepEqual(calls.slice(0, 4).map(([, value]) => value.p_action), ["verify_qbo_identity", "verify_currency", "confirm_timezone", "activate"]);
  assert.deepEqual(calls.slice(0, 4).map(([, value]) => value.p_request_id), calls.slice(4).map(([, value]) => value.p_request_id));
  assert.equal(calls[1][1].p_verification_source, "qbo_preferences");
});

test("tenant authority and no-reload quick-prompt update contracts remain intact", () => {
  const routes = readFileSync("src/api/gpt/brain/gpt.routes.js", "utf8");
  const settings = readFileSync("src/pages/Settings/SettingsHome.jsx", "utf8");
  const bar = readFileSync("src/components/Bizzy/BizzyChatBar.jsx", "utf8");
  assert.match(routes, /requireBusinessAccess\(\)/);
  assert.match(routes, /rejectAdminViewWrites\(\)/);
  assert.match(routes, /requireBusinessRole\(\['owner'\]\)/);
  assert.match(routes, /businessId: req\.business\.id/);
  assert.match(settings, /bizzy:financial-reporting-updated/);
  assert.match(bar, /addEventListener\("bizzy:financial-reporting-updated"/);
  assert.match(bar, /event\?\.detail\?\.businessId === businessId/);
  assert.match(bar, /const ready = reportingStatus\?\.ready === true/);
});

test("qbo_preferences provenance migration is additive and preserves existing sources and records", () => {
  const migration = readFileSync("supabase/migrations/20261101116000_reporting_configuration_qbo_preferences_source.sql", "utf8");
  assert.match(migration, /create or replace function public\.mutate_business_financial_reporting_config/);
  assert.match(migration, /'qbo_company_info','qbo_preferences','qbo_report_header'/);
  assert.doesNotMatch(migration, /drop table|truncate|delete from|update public\.business_financial_reporting_config_audit/i);
});

test("legacy monthly normalization does not invent a verified USD currency", () => {
  const ingestion = readFileSync("src/services/bookkeeping/qboMonthlyPnlIngestionService.js", "utf8");
  const snapshot = readFileSync("src/services/bookkeeping/qboMonthlyPnlSnapshotService.js", "utf8");
  const fingerprint = readFileSync("src/services/accounting/monthlyPnlContentFingerprint.js", "utf8");
  assert.doesNotMatch(ingestion, /header\?\.Currency \|\| header\?\.currency \|\| "USD"/);
  assert.doesNotMatch(ingestion, /summary\.currency_code \|\| "USD"/);
  assert.doesNotMatch(snapshot, /financial_content\?\.currency_code \|\| "USD"/);
  assert.doesNotMatch(fingerprint, /financial_content\?\.currency_code \|\| "USD"/);
});
