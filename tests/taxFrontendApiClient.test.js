/* global global */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

global.window = {
  __VITE: {
    VITE_SUPABASE_URL: "https://example.supabase.co",
    VITE_SUPABASE_ANON_KEY: "anon-key",
  },
  location: { hostname: "localhost" },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
};

const authMod = await import("../src/services/api/authenticatedFetch.js");
const taxClient = await import("../src/services/tax/taxApiClient.js");
const normalizer = await import("../src/services/tax/normalizeTaxOverview.js");

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

test("authenticatedFetch uses Supabase session token and does not scan localStorage", async () => {
  const calls = [];
  global.localStorage = new Proxy({}, {
    get() {
      throw new Error("localStorage scanned");
    },
  });
  authMod.__setAuthenticatedFetchTestDeps({
    getApiBase: () => "https://api.example.test",
    supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "session-token" } } }) } },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true, data: { ok: 1 } });
    },
  });

  const result = await authMod.authenticatedFetch("/api/tax/overview");
  assert.deepEqual(result, { ok: true, data: { ok: 1 } });
  assert.equal(calls[0].url, "https://api.example.test/api/tax/overview");
  assert.equal(calls[0].init.headers.get("Authorization"), "Bearer session-token");
});

test("authenticatedFetch parses canonical and transitional errors without token leakage", async () => {
  authMod.__setAuthenticatedFetchTestDeps({
    getApiBase: () => "https://api.example.test",
    supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "secret-token" } } }) } },
    fetchImpl: async () => jsonResponse({
      ok: false,
      error: { code: "bad_tax_request", message: "Bearer secret-token should hide", details: { field: "year" } },
    }, { status: 422, headers: { "x-request-id": "req-1" } }),
  });
  await assert.rejects(
    () => authMod.authenticatedFetch("/api/tax/overview"),
    (err) => {
      assert.equal(err.code, "bad_tax_request");
      assert.equal(err.status, 422);
      assert.equal(err.requestId, "req-1");
      assert.equal(err.message.includes("secret-token"), false);
      return true;
    }
  );

  authMod.__setAuthenticatedFetchTestDeps({
    getApiBase: () => "https://api.example.test",
    supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
    fetchImpl: async () => jsonResponse({ ok: false, error: "missing_business_id", message: "businessId required" }, { status: 400 }),
  });
  await assert.rejects(
    () => authMod.authenticatedFetch("/api/tax/overview"),
    (err) => {
      assert.equal(err.code, "missing_business_id");
      assert.equal(err.message, "businessId required");
      return true;
    }
  );
});

test("authenticatedFetch supports AbortSignal and blob exports", async () => {
  authMod.__setAuthenticatedFetchTestDeps({
    getApiBase: () => "https://api.example.test",
    supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
    fetchImpl: async (_url, init) => {
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response(new Blob(["a,b\n1,2"]), {
        status: 200,
        headers: {
          "content-type": "text/csv",
          "content-disposition": "attachment; filename=\"deductions.csv\"",
        },
      });
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => authMod.authenticatedFetch("/api/tax/overview", { signal: controller.signal }), { code: "request_aborted" });

  const result = await authMod.authenticatedFetch("/api/tax/deductions/export", { responseType: "blob" });
  assert.equal(result.filename, "deductions.csv");
  assert.equal(result.contentType, "text/csv");
  assert.equal(await result.blob.text(), "a,b\n1,2");
});

test("tax client serializes overview query and validates include values", async () => {
  const calls = [];
  authMod.__setAuthenticatedFetchTestDeps({
    getApiBase: () => "https://api.example.test",
    supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } },
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse({
        ok: true,
        data: {
          meta: { taxYear: 2026, status: "completed" },
          readiness: { status: "ready" },
          summary: { projectedTotalTax: null },
          safeHarbor: { status: "unavailable" },
          warnings: [],
          assumptions: [],
        },
      });
    },
  });
  const data = await taxClient.getTaxOverview({
    businessId: "biz-1",
    year: 2026,
    asOfDate: "2026-07-14",
    include: ["explanations", "components"],
  });
  const url = new URL(calls[0]);
  assert.equal(url.pathname, "/api/tax/overview");
  assert.equal(url.searchParams.get("businessId"), "biz-1");
  assert.equal(url.searchParams.get("refresh"), null);
  assert.equal(url.searchParams.get("include"), "components,explanations");
  assert.equal(data.summary.projectedTotalTax, null);

  await assert.rejects(
    () => taxClient.getTaxOverview({ businessId: "biz-1", include: ["rawPayloads"] }),
    /Unsupported tax include/
  );
});

test("tax client keeps Tax Profile identity in query params and mutable body allowlisted", async () => {
  const calls = [];
  authMod.__setAuthenticatedFetchTestDeps({
    getApiBase: () => "https://api.example.test",
    supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } },
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
      return jsonResponse({ ok: true, data: { profile: { id: "profile-1" }, completeness: {}, readiness: {} } });
    },
  });

  await taxClient.updateTaxProfile({
    businessId: "biz-1",
    year: 2026,
    patch: {
      businessId: "other-business",
      business_id: "other-business",
      year: 2025,
      tax_year: 2025,
      userId: "other-user",
      entity_type: "sole_proprietor",
      filing_status: "single",
      primary_tax_state: "NC",
      prior_year_total_tax: "",
    },
  });

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/tax/profile");
  assert.equal(url.searchParams.get("businessId"), "biz-1");
  assert.equal(url.searchParams.get("year"), "2026");
  assert.deepEqual(calls[0].body, {
    entity_type: "sole_proprietor",
    filing_status: "single",
    primary_tax_state: "NC",
    prior_year_total_tax: "",
  });
});

test("tax client clamps Tax detail page sizes to the server maximum", async () => {
  const calls = [];
  authMod.__setAuthenticatedFetchTestDeps({
    getApiBase: () => "https://api.example.test",
    supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } },
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse({ ok: true, data: { rows: [], pagination: { total: 0, limit: 200, offset: 0 } } });
    },
  });

  await taxClient.getTaxDeductionTransactions({ businessId: "biz-1", year: 2026, limit: 250, offset: 0 });
  await taxClient.getTaxPostedTransactions({ businessId: "biz-1", year: 2026, limit: 250, offset: 0 });

  assert.equal(new URL(calls[0]).searchParams.get("limit"), "200");
  assert.equal(new URL(calls[1]).searchParams.get("limit"), "200");
});

test("tax client sends tax payment idempotency key in header and body", async () => {
  const calls = [];
  authMod.__setAuthenticatedFetchTestDeps({
    getApiBase: () => "https://api.example.test",
    supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } },
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return jsonResponse({ ok: true, data: { payment: { id: "pay-1", amount: 25 }, created: true, reused: false } });
    },
  });

  const result = await taxClient.createTaxPayment({
    businessId: "biz-1",
    year: 2026,
    idempotencyKey: "payment-submit-1",
    payment: { amount: 25, jurisdiction: "federal", paymentType: "estimated_payment" },
  });

  assert.equal(result.id, "pay-1");
  assert.equal(result.mutation.created, true);
  assert.equal(calls[0].init.headers.get("Idempotency-Key"), "payment-submit-1");
  assert.equal(calls[0].body.idempotencyKey, "payment-submit-1");
});

test("normalizeTaxOverview preserves nulls, zeros, unavailable, arrays, and partial status", () => {
  const { data } = normalizer.normalizeTaxOverview({
    meta: { status: "partial", taxYear: 2026 },
    readiness: { status: "partial" },
    summary: { projectedTotalTax: null, projectedStateTax: 0 },
    safeHarbor: { status: "unavailable" },
    reserve: { status: "setup_incomplete" },
  });
  assert.equal(data.meta.status, "partial");
  assert.equal(data.summary.projectedTotalTax, null);
  assert.equal(data.summary.projectedStateTax, 0);
  assert.equal(data.safeHarbor.status, "unavailable");
  assert.equal(data.safeHarbor.requiredAnnual, null);
  assert.equal(data.reserve.reserveBalance, null);
  assert.deepEqual(data.warnings, []);
  assert.deepEqual(data.assumptions, []);
});

test("active Tax compatibility hooks do not scan tokens or write tax tables directly", () => {
  const liability = readFileSync("src/hooks/useTaxLiability.js", "utf8");
  const deductions = readFileSync("src/hooks/useDeductionsMatrix.js", "utf8");
  const panel = readFileSync("src/components/Tax/TaxLiabilityPanel.jsx", "utf8");
  assert.match(liability, /useTaxOverview/);
  assert.doesNotMatch(liability + deductions + panel, /sb-.*auth-token|getAccessToken|supabase\.from\(["']tax_/);
  assert.doesNotMatch(liability + deductions, /fetch\(/);
  assert.match(panel, /createTaxPayment/);
});
