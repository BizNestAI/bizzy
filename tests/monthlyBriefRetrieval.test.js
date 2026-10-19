import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* global process */

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
process.env.OPENAI_API_KEY ||= "test-openai-key";

const {
  createMonthlyBriefLookupHandler,
  selectLatestAvailableAutomaticPulse,
  selectPreferredAvailablePulse,
} = await import("../src/api/accounting/pulse.js");
const {
  MONTHLY_BRIEF_STATES,
  fetchMonthlyBriefLookup,
  monthlyBriefErrorState,
  parseMonthlyBriefResponse,
} = await import("../src/components/Accounting/monthlyBriefState.js");

const septemberMid = fixture({ id: "sep-mid", month: "2026-09-01", cadence: "mid_month", generated_at: "2026-09-15T08:47:12Z" });
const septemberFinal = fixture({ id: "sep-final", month: "2026-09-01", cadence: "final", generated_at: "2026-10-01T04:00:38Z" });
const octoberMid = fixture({ id: "oct-mid", month: "2026-10-01", cadence: "mid_month", generated_at: "2026-10-15T04:05:04Z" });

test("September final deterministically wins over September mid-month and October", () => {
  assert.equal(selectPreferredAvailablePulse([octoberMid, septemberMid, septemberFinal]).id, "sep-final");
});

test("latest automatic brief ranks logical cadence slots, not late creation time", () => {
  const lateAugust = fixture({ id: "aug-late", month: "2026-08-01", cadence: "final", generated_at: "2026-10-20T00:00:00Z" });
  const octoberFinal = fixture({ id: "oct-final", month: "2026-10-01", cadence: "final", generated_at: "2026-11-01T05:00:00Z" });
  assert.equal(selectLatestAvailableAutomaticPulse([septemberMid]).id, "sep-mid");
  assert.equal(selectLatestAvailableAutomaticPulse([septemberMid, septemberFinal]).id, "sep-final");
  assert.equal(selectLatestAvailableAutomaticPulse([septemberFinal, octoberMid]).id, "oct-mid");
  assert.equal(selectLatestAvailableAutomaticPulse([octoberMid, octoberFinal]).id, "oct-final");
  assert.equal(selectLatestAvailableAutomaticPulse([lateAugust, octoberMid]).id, "oct-mid");
});

test("latest selection excludes failed, manual, Accrual, and malformed rows", () => {
  const invalid = [
    fixture({ id: "failed-oct", month: "2026-10-01", cadence: "mid_month", status: "failed" }),
    fixture({ id: "manual-oct", month: "2026-10-01", cadence: "manual" }),
    fixture({ id: "accrual-oct", month: "2026-10-01", cadence: "mid_month", accounting_method: "Accrual" }),
    { ...fixture({ id: "malformed-oct", month: "2026-10-01", cadence: "mid_month" }), revenue_summary: null },
  ];
  assert.equal(selectLatestAvailableAutomaticPulse([...invalid, septemberFinal]).id, "sep-final");
});

test("latest route returns October independently of a selected September chart period", async () => {
  const db = fakeDb([septemberMid, septemberFinal, octoberMid]);
  const result = await invoke(createMonthlyBriefLookupHandler({ db, latest: true }), {
    query: { year: "2026", month: "9", business_id: "attacker-business" },
    business: { id: "canonical-business" },
    auth: { businessId: "canonical-business", userId: "canonical-user" },
  });
  assert.equal(result.body.brief.id, "oct-mid");
  assert.equal(result.body.brief.reporting_month, "2026-10-01");
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(db.filters.month, undefined);
});

test("authenticated canonical September lookup returns final and ignores client tenant redirection", async () => {
  const db = fakeDb([septemberMid, septemberFinal, octoberMid]);
  const response = await invoke(createMonthlyBriefLookupHandler({ db }), {
    query: { year: "2026", month: "9", business_id: "attacker-business" },
    business: { id: "canonical-business" },
    auth: { businessId: "canonical-business", userId: "canonical-user" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "available");
  assert.equal(response.body.brief.id, "sep-final");
  assert.equal(response.body.brief.reporting_month, "2026-09-01");
  assert.deepEqual(db.filters.business_id, ["canonical-business"]);
  assert.deepEqual(db.filters.month, ["2026-09-01"]);
  assert.deepEqual(db.filters.status, ["available"]);
});

test("legitimate absence is explicit and database failure is never absence", async () => {
  const missing = await invoke(createMonthlyBriefLookupHandler({ db: fakeDb([]) }), canonicalRequest());
  assert.deepEqual({ ok: missing.body.ok, status: missing.body.status, brief: missing.body.brief }, {
    ok: true,
    status: "not_generated",
    brief: null,
  });

  const failed = await invoke(createMonthlyBriefLookupHandler({ db: fakeDb([], new Error("database unavailable")) }), canonicalRequest());
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.status, "request_failed");
  assert.equal(failed.body.error, "monthly_brief_lookup_failed");
  assert.equal(failed.body.brief, undefined);
});

test("missing canonical context and invalid periods are context failures", async () => {
  const handler = createMonthlyBriefLookupHandler({ db: fakeDb([]) });
  const missing = await invoke(handler, { query: { year: "2026", month: "9" } });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.status, "context_unavailable");
  const invalid = await invoke(handler, { ...canonicalRequest(), query: { year: "2026", month: "13" } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.error, "invalid_reporting_period");
});

test("component response parser has explicit available, absence, malformed, and failure states", () => {
  const available = parseMonthlyBriefResponse({
    ok: true,
    status: "available",
    request_id: "request-available",
    brief: {
      id: "sep-final",
      reporting_month: "2026-09-01",
      cadence: "final",
      accounting_method: "Cash",
      generated_at: "2026-10-01T04:00:38Z",
      data_through_date: null,
      content: { revenue_summary: "Synthetic summary", business_insights: [] },
    },
  });
  assert.equal(available.status, MONTHLY_BRIEF_STATES.AVAILABLE);
  assert.equal(available.brief.cadence, "final");

  const absent = parseMonthlyBriefResponse({ ok: true, status: "not_generated", brief: null, request_id: "request-absent" });
  assert.equal(absent.status, MONTHLY_BRIEF_STATES.NOT_GENERATED);
  assert.throws(() => parseMonthlyBriefResponse({ ok: true, brief: null }), /malformed_monthly_brief_response/);
  assert.equal(monthlyBriefErrorState("request-failed").status, MONTHLY_BRIEF_STATES.REQUEST_FAILED);
});

test("lookup retry repeats only GET and recovers from HTTP failure", async () => {
  const calls = [];
  const responses = [
    response(500, { ok: false, status: "request_failed", error: "monthly_brief_lookup_failed", request_id: "request-500" }),
    response(200, {
      ok: true,
      status: "available",
      request_id: "request-retry",
      brief: {
        id: "sep-final",
        reporting_month: "2026-09-01",
        cadence: "final",
        accounting_method: "Cash",
        content: { revenue_summary: "Synthetic summary", business_insights: [] },
      },
    }),
  ];
  const mockFetch = async (url, options) => {
    calls.push({ url, method: options.method });
    return responses.shift();
  };
  await assert.rejects(() => fetchMonthlyBriefLookup({ apiFetch: mockFetch, url: "/api/accounting/pulse?year=2026&month=9" }));
  const retried = await fetchMonthlyBriefLookup({ apiFetch: mockFetch, url: "/api/accounting/pulse?year=2026&month=9" });
  assert.equal(retried.brief.id, "sep-final");
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET"]);
});

test("component source guards request races and retry remains a lookup-only GET", () => {
  const source = readFileSync("src/components/Accounting/MonthlyBriefCard.jsx", "utf8");
  assert.match(source, /requestGeneration\.current/);
  assert.match(source, /generation === requestGeneration\.current/);
  assert.match(source, /new AbortController\(\)/);
  const stateSource = readFileSync("src/components/Accounting/monthlyBriefState.js", "utf8");
  assert.match(stateSource, /method: "GET"/);
  assert.doesNotMatch(source, /pulse\/generate/);
  assert.doesNotMatch(source, /window\.location\.reload/);
  assert.match(stateSource, /Bizzi couldn’t load your latest monthly brief\. Your saved brief may still be available\./);
  assert.match(source, /\/api\/accounting\/pulse\/latest/);
  assert.doesNotMatch(source, /useFinancialPeriod/);
});

test("lookup source has no provider or chat-credit operation", () => {
  const source = readFileSync("src/api/accounting/pulse.js", "utf8");
  const start = source.indexOf("export function createMonthlyBriefLookupHandler");
  const end = source.indexOf("router.get(\"/\"", start);
  const lookup = source.slice(start, end);
  assert.doesNotMatch(lookup, /OpenAI|generateFinancialPulseSnapshot|chat[_-]?credit|embeddings\.create|completions\.create/i);
});

function fixture(overrides) {
  return {
    business_id: "canonical-business",
    status: "available",
    accounting_method: "Cash",
    created_at: overrides.generated_at,
    data_through_date: null,
    revenue_summary: "Synthetic summary",
    spending_trend: "Synthetic trend",
    variance_from_forecast: "Synthetic variance",
    business_insights: ["Synthetic insight"],
    motivational_message: "Synthetic message",
    ...overrides,
  };
}

function canonicalRequest() {
  return {
    query: { year: "2026", month: "9" },
    business: { id: "canonical-business" },
    auth: { businessId: "canonical-business", userId: "canonical-user" },
  };
}

function fakeDb(rows, failure = null) {
  const filters = {};
  const query = {
    select() { return this; },
    eq(column, value) { (filters[column] ||= []).push(value); return this; },
    then(resolve) { resolve(failure ? { data: null, error: failure } : { data: rows, error: null }); },
  };
  return { filters, from() { return query; } };
}

async function invoke(handler, request) {
  const req = {
    method: "GET",
    headers: {},
    monthlyBriefLookup: { request_id: "request-test" },
    header(name) { return this.headers[String(name).toLowerCase()] || null; },
    ...request,
  };
  const response = {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler(req, response);
  return response;
}

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return name.toLowerCase() === "content-type" ? "application/json" : payload.request_id; } },
    async json() { return payload; },
  };
}
