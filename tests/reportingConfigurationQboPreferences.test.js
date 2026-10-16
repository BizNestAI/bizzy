import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  fetchQboReportingIdentity,
  ensureFinancialReportingConfiguration,
  initializeReportingAfterQboConnection,
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

test("tenant authority remains intact while prompt availability is server-owned", () => {
  const routes = readFileSync("src/api/gpt/brain/gpt.routes.js", "utf8");
  const settings = readFileSync("src/pages/Settings/SettingsHome.jsx", "utf8");
  const bar = readFileSync("src/components/Bizzy/BizzyChatBar.jsx", "utf8");
  assert.match(routes, /requireBusinessAccess\(\)/);
  assert.match(routes, /rejectAdminViewWrites\(\)/);
  assert.match(routes, /requireBusinessRole\(\['owner'\]\)/);
  assert.match(routes, /businessId: req\.business\.id/);
  assert.match(settings, /bizzy:financial-reporting-updated/);
  assert.doesNotMatch(bar, /reportingStatus\?\.ready/);
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

function automaticConfigurationDb({ config = null, realmId = "realm-1", state = "NC" } = {}) {
  const store = { config };
  const rpcCalls = [];
  const rows = { quickbooks_tokens: { realm_id: realmId, status: "active", is_active: true }, business_profiles: { state } };
  const db = {
    from(table) {
      const query = {
        select() { return query; }, eq() { return query; }, order() { return query; }, limit() { return query; },
        async maybeSingle() { return { data: table === "business_financial_reporting_config" ? store.config : rows[table] || null, error: null }; },
      };
      return query;
    },
    async rpc(name, args) {
      rpcCalls.push([name, args]);
      store.config = {
        status: args.p_provider_currency === "USD" ? "verified" : "unconfigured",
        qbo_realm_id: args.p_provider_realm_id,
        provider_schema_version: args.p_provider_schema_version,
        reporting_timezone: args.p_reporting_timezone,
        home_currency: args.p_provider_currency,
        realm_verified_at: "now", currency_verified_at: "now", timezone_confirmed_at: "now",
        verified_at: args.p_provider_currency === "USD" ? "now" : null, updated_at: "now",
      };
      return { data: store.config, error: null };
    },
  };
  return { db, rpcCalls, store };
}

test("an existing connected USD business initializes on first financial prompt without reconnecting", async () => {
  const { db, rpcCalls } = automaticConfigurationDb({ state: "NC" });
  const status = await ensureFinancialReportingConfiguration({
    db, businessId: "business-a", requestId: "11111111-1111-4111-8111-111111111111",
    verificationSource: "automatic_quick_prompt",
    verifyProvider: async ({ businessId }) => {
      assert.equal(businessId, "business-a");
      return { realmId: "realm-1", currency: "USD", currencySource: "qbo_preferences", schemaVersion: "75" };
    },
  });
  assert.equal(status.ready, true);
  assert.equal(status.accounting_basis, "Cash");
  assert.equal(status.reporting_timezone, "America/New_York");
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0][0], "initialize_business_financial_reporting_config");
  assert.equal(rpcCalls[0][1].p_business_id, "business-a");
  assert.equal(rpcCalls[0][1].p_verification_source, "automatic_quick_prompt");
});

test("post-OAuth initialization is best effort and cannot invalidate a successful connection", async () => {
  const calls = [];
  const logger = { warn(message, details) { calls.push([message, details]); } };
  const success = await initializeReportingAfterQboConnection({
    db: {}, businessId: "business-a", requestId: "22222222-2222-4222-8222-222222222222", logger,
    ensure: async (args) => ({ ready: true, source: args.verificationSource }),
  });
  assert.deepEqual(success, { ready: true, source: "automatic_qbo_connection" });
  const deferred = await initializeReportingAfterQboConnection({
    db: {}, businessId: "business-a", logger,
    ensure: async () => { throw new ReportingSetupError("quickbooks_rate_limited", 503); },
  });
  assert.equal(deferred, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].business_id, "business-a");
});

test("automatic initialization persists but refuses a verified non-USD home currency", async () => {
  const { db, rpcCalls, store } = automaticConfigurationDb({ state: "CA" });
  await assert.rejects(
    ensureFinancialReportingConfiguration({
      db, businessId: "business-a", requestId: "33333333-3333-4333-8333-333333333333",
      verifyProvider: async () => ({ realmId: "realm-1", currency: "CAD", currencySource: "qbo_preferences", schemaVersion: "75" }),
    }),
    (error) => error.code === "unsupported_reporting_currency" && error.status === 409,
  );
  assert.equal(rpcCalls.length, 1);
  assert.equal(store.config.home_currency, "CAD");
  assert.equal(store.config.status, "unconfigured");
  assert.equal(store.config.verified_at, null);
});

test("existing explicit reporting timezone short-circuits provider calls and is preserved", async () => {
  const existing = { status: "verified", verified_at: "now", qbo_realm_id: "realm-1", home_currency: "USD", reporting_timezone: "America/Los_Angeles", realm_verified_at: "now", currency_verified_at: "now", timezone_confirmed_at: "now", provider_schema_version: "75" };
  const { db, rpcCalls } = automaticConfigurationDb({ config: existing, state: "NC" });
  let providerCalls = 0;
  const status = await ensureFinancialReportingConfiguration({ db, businessId: "business-a", verifyProvider: async () => { providerCalls += 1; } });
  assert.equal(status.reporting_timezone, "America/Los_Angeles");
  assert.equal(providerCalls, 0);
  assert.equal(rpcCalls.length, 0);
});

test("concurrent existing-customer initialization converges on one business-scoped configuration", async () => {
  const { db, store } = automaticConfigurationDb({ state: "CA" });
  const verifyProvider = async () => ({ realmId: "realm-1", currency: "USD", currencySource: "qbo_preferences", schemaVersion: "75" });
  const [first, second] = await Promise.all([
    ensureFinancialReportingConfiguration({ db, businessId: "business-a", requestId: "44444444-4444-4444-8444-444444444444", verifyProvider }),
    ensureFinancialReportingConfiguration({ db, businessId: "business-a", requestId: "55555555-5555-4555-8555-555555555555", verifyProvider }),
  ]);
  assert.equal(first.ready, true);
  assert.equal(second.ready, true);
  assert.equal(store.config.qbo_realm_id, "realm-1");
  assert.equal(store.config.reporting_timezone, "America/Los_Angeles");
});

test("automatic initialization rejects provider identity from another tenant realm before persistence", async () => {
  const { db, rpcCalls } = automaticConfigurationDb({ realmId: "tenant-realm" });
  await assert.rejects(
    ensureFinancialReportingConfiguration({
      db, businessId: "business-a", requestId: "66666666-6666-4666-8666-666666666666",
      verifyProvider: async () => ({ realmId: "foreign-realm", currency: "USD", schemaVersion: "75" }),
    }),
    (error) => error.code === "qbo_company_identity_mismatch",
  );
  assert.equal(rpcCalls.length, 0);
});

test("automatic initialization migration is atomic, service-role-only, and preserves explicit timezone", () => {
  const migration = readFileSync("supabase/migrations/20261101117000_automatic_financial_reporting_initialization.sql", "utf8");
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /coalesce\(nullif\(btrim\(v_config\.reporting_timezone\)/);
  assert.match(migration, /on conflict\(business_id\) do update/);
  assert.match(migration, /revoke all on function public\.initialize_business_financial_reporting_config[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.initialize_business_financial_reporting_config[\s\S]*to service_role/);
});

test("financial chips stay clickable and prompt initialization precedes chat credit reservation", () => {
  const bar = readFileSync("src/components/Bizzy/BizzyChatBar.jsx", "utf8");
  const prompts = readFileSync("src/components/Bizzy/AskBizzyQuickPrompts.jsx", "utf8");
  const handler = readFileSync("src/api/gpt/brain/generateBizzyResponse.js", "utf8");
  assert.doesNotMatch(bar, /reportingStatus\?\.ready|financial_reporting_not_configured/);
  assert.doesNotMatch(prompts, /Finish Financial reporting setup in Settings/);
  assert.ok(handler.indexOf("ensureFinancialReportingConfiguration({") < handler.indexOf("reserveChatCredit(supabase"));
});
