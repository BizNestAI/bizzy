/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { Buffer } from "node:buffer";
import express from "express";

process.env.TAX_RULE_CACHE_DISABLED = "true";
process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const { default: taxRouter } = await import("../src/api/tax/index.js");
const { __setTaxCalculateLiabilityTestDeps } = await import("../src/api/tax/calculateTaxLiability.js");
const { buildTaxRunFingerprint } = await import("../src/services/tax/runs/taxRunFingerprint.js");
const { TAX_ORCHESTRATOR_ENGINE_VERSION } = await import("../src/services/tax/taxEngineVersions.js");

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
const MISSING_BUSINESS_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("GET /api/tax/overview requires auth and business authorization", async () => {
  const app = createApp(baseStore());
  const missing = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}`);
  const invalid = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}`, { token: "bad" });
  const valid = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}&year=2026&refresh=true`, { token: "valid-user" });
  const denied = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}&year=2026`, { token: "other-user" });
  const missingBusiness = await request(app, `/api/tax/overview?businessId=${MISSING_BUSINESS_ID}&year=2026`, { token: "valid-user" });

  assert.equal(missing.statusCode, 401);
  assert.equal(invalid.statusCode, 401);
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.body.ok, true);
  assert.equal(denied.statusCode, 403);
  assert.equal(missingBusiness.statusCode, 404);
});

test("GET /api/tax/overview reuses stored runs and refresh uses fingerprint policy", async () => {
  const store = baseStore();
  const app = createApp(store);
  const first = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}&year=2026&asOfDate=2026-12-31&refresh=true`, { token: "valid-user" });
  const latest = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}&year=2026`, { token: "valid-user" });
  const refreshAgain = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}&year=2026&asOfDate=2026-12-31&refresh=true`, { token: "valid-user" });

  assert.equal(first.statusCode, 200);
  assert.equal(store.tax_calculation_runs.length, 1);
  assert.equal(latest.statusCode, 200);
  assert.equal(latest.body.data.meta.runId, first.body.data.meta.runId);
  assert.equal(latest.body.data.meta.reusedExistingRun, true);
  assert.equal(refreshAgain.statusCode, 200);
  assert.equal(refreshAgain.body.data.meta.runId, first.body.data.meta.runId);
  assert.equal(store.tax_calculation_runs.filter((row) => ["completed", "partial"].includes(row.status)).length, 1);
});

test("GET /api/tax/overview recalculates when requested through-date is newer than latest run", async () => {
  const store = baseStore();
  const app = createApp(store);
  const first = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}&year=2026&asOfDate=2026-07-20&refresh=true`, { token: "valid-user" });
  const nextDay = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}&year=2026&asOfDate=2026-07-21`, { token: "valid-user" });

  assert.equal(first.statusCode, 200);
  assert.equal(nextDay.statusCode, 200);
  assert.notEqual(nextDay.body.data.meta.runId, first.body.data.meta.runId);
  assert.equal(nextDay.body.data.meta.asOfDate, "2026-07-21");
  assert.equal(nextDay.body.data.meta.reusedExistingRun, false);
  assert.equal(store.tax_calculation_runs.filter((row) => ["completed", "partial"].includes(row.status)).length, 2);
});

test("GET /api/tax/overview refresh abandons stale identical running runs", async () => {
  const store = baseStore();
  const fingerprint = buildTaxRunFingerprint({
    businessId: BUSINESS_ID,
    taxYear: 2026,
    asOfDate: "2026-12-31",
    calculationType: "full_estimate",
    projectionMethod: "blended",
    projectionScenario: "base",
    triggerSource: "page_refresh",
    profileVersion: "profile-1",
    sourceFreshness: {},
    engineVersions: { orchestrator: TAX_ORCHESTRATOR_ENGINE_VERSION },
    ruleVersions: {},
    manualOverrides: null,
  });
  store.tax_calculation_runs.push({
    id: "stale-run",
    business_id: BUSINESS_ID,
    tax_year: 2026,
    as_of_date: "2026-12-31",
    status: "running",
    calculation_type: "full_estimate",
    trigger_source: "page_refresh",
    calculation_fingerprint: fingerprint,
    started_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
  });
  const app = createApp(store);
  const res = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}&year=2026&asOfDate=2026-12-31&refresh=true`, { token: "valid-user" });

  assert.equal(res.statusCode, 200);
  assert.equal(store.tax_calculation_runs.find((row) => row.id === "stale-run").status, "abandoned");
  assert.ok(store.tax_calculation_runs.some((row) => row.id !== "stale-run" && ["completed", "partial"].includes(row.status)));
});

test("GET /api/tax/overview validates query params, version, booleans, and includes", async () => {
  const app = createApp(baseStore());
  const invalidUuid = await request(app, "/api/tax/overview?businessId=bad&year=2026", { token: "valid-user" });
  const invalidYear = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}&year=1999`, { token: "valid-user" });
  const invalidDate = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}&asOfDate=07-01-2026`, { token: "valid-user" });
  const invalidRefresh = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}&refresh=yes`, { token: "valid-user" });
  const invalidVersion = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}&apiVersion=2025-01`, { token: "valid-user" });
  const unknownInclude = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}&include=rawPayloads`, { token: "valid-user" });
  const tooMany = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}&include=components,explanations,confidenceFactors,deductions,reserveHistory,paymentDetails,deadlines`, { token: "valid-user" });

  assert.equal(is4xx(invalidUuid.statusCode), true);
  assert.equal(is4xx(invalidYear.statusCode), true);
  assert.equal(is4xx(invalidDate.statusCode), true);
  assert.equal(is4xx(invalidRefresh.statusCode), true);
  assert.equal(is4xx(invalidVersion.statusCode), true);
  assert.equal(is4xx(unknownInclude.statusCode), true);
  assert.equal(is4xx(tooMany.statusCode), true);
  assert.equal(unknownInclude.body.errorDetail.code, "unknown_tax_api_include");
});

test("GET /api/tax/overview returns stable canonical contract with null/unavailable semantics", async () => {
  const store = baseStore({
    state_tax_rule_configs: [],
    tax_rule_configs: federalRules().filter((row) => !["estimated_tax_safe_harbor", "estimated_tax_due_dates"].includes(row.rule_type)),
  });
  const app = createApp(store);
  const res = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}&year=2026&asOfDate=2026-12-31&refresh=true`, { token: "valid-user" });

  assert.equal(res.statusCode, 200);
  const data = res.body.data;
  for (const key of ["meta", "readiness", "summary", "profile", "actuals", "projection", "federal", "state", "payments", "safeHarbor", "reserve", "deadlines", "confidence", "warnings", "assumptions", "unsupportedItems", "supportedButDeferred", "explanationSummary", "links"]) {
    assert.ok(Object.hasOwn(data, key), `missing ${key}`);
  }
  assert.equal(data.meta.apiVersion, "2026-01");
  assert.equal(data.meta.payloadVersion, "tax-calculation-v1");
  assert.equal(data.meta.status, "partial");
  assert.equal(data.summary.projectedStateTax, null);
  assert.equal(data.state.totalStateTax, null);
  assert.equal(data.safeHarbor.status, "unavailable");
  assert.equal(data.safeHarbor.combined.requiredAnnual, null);
  assert.equal(Array.isArray(data.safeHarbor.federal.quarterSchedule), true);
  assert.equal(data.safeHarbor.federal.quarterSchedule.length, 0);
  assert.equal(data.reserve.currentReserve, null);
  assert.equal(data.reserve.reserveGap, null);
  assert.equal(data.readiness.estimateReady, true);
  assert.equal(data.readiness.reserveReady, false);
  assert.ok(data.readiness.setupState.actions.length > 0);
  assert.ok(data.warnings.some((warning) => ["state_rule_missing", "federal_safe_harbor_rule_missing"].includes(warning.code)));
});

test("GET /api/tax/overview include controls keep default bounded and expose safe details when requested", async () => {
  const store = baseStore();
  const app = createApp(store);
  const base = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}&year=2026&refresh=true`, { token: "valid-user" });
  const detailed = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}&year=2026&refresh=true&include=components,explanations,confidenceFactors,ruleSupport,paymentDetails,reserveHistory`, { token: "valid-user" });
  const text = JSON.stringify(detailed.body);

  assert.equal(base.statusCode, 200);
  assert.equal(base.body.data.components, undefined);
  assert.equal(detailed.statusCode, 200);
  assert.ok(Array.isArray(detailed.body.data.components));
  assert.ok(detailed.body.data.explanations);
  assert.ok(Array.isArray(detailed.body.data.confidence.factors));
  assert.ok(detailed.body.data.ruleSupport);
  assert.ok(detailed.body.data.paymentDetails);
  assert.equal(detailed.body.data.reserveHistory.reason, "fetch_separately");
  assert.equal(text.includes("raw_secret"), false);
  assert.equal(text.includes("qbo_secret"), false);
  assert.equal(text.includes("access_token"), false);
  assert.equal(text.includes("private system prompt"), false);
  assert.equal(text.includes("stack"), false);
  assert.equal(text.includes(OTHER_BUSINESS_ID), false);
});

test("GET /api/tax/overview core totals reconcile with legacy calculate-tax-liability", async () => {
  const store = baseStore({ tax_reserve_accounts: [reserveAccount({ manual_balance: 500 })] });
  const app = createApp(store);
  const overview = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}&year=2026&asOfDate=2026-12-31&refresh=true`, { token: "valid-user" });
  const legacy = await request(app, "/api/tax/calculate-tax-liability", {
    method: "POST",
    token: "valid-user",
    body: { businessId: BUSINESS_ID, year: 2026, asOfDate: "2026-12-31" },
  });

  assert.equal(overview.statusCode, 200);
  assert.equal(legacy.statusCode, 200, JSON.stringify(legacy.body));
  assert.equal(legacy.body.data.meta.source, "canonical");
  assert.equal(overview.body.data.summary.projectedTotalTax, legacy.body.data.summary.annualEstimate);
  assert.equal(overview.body.data.summary.taxPaidAndWithheldYtd, legacy.body.data.summary.ytdPaid);
  assert.equal(overview.body.data.summary.remainingProjectedLiability, legacy.body.data.summary.balanceDue);
  assert.equal(overview.body.data.summary.taxableIncomeYtd, legacy.body.data.summary.profitYTD);
  assert.equal(overview.body.data.summary.recommendedReserve, legacy.body.data.summary.recommendedReserve);
  assert.equal(overview.body.data.summary.confidenceScore, legacy.body.data.confidence.score);
});

test("legacy overview trend labels reconstructed past periods instead of calling them actual", async () => {
  const app = createApp(baseStore());
  const legacy = await request(app, "/api/tax/calculate-tax-liability", {
    method: "POST",
    token: "valid-user",
    body: { businessId: BUSINESS_ID, year: 2026, asOfDate: "2026-06-15" },
  });
  const periods = new Set(legacy.body.data.trend.map((row) => row.periodType));
  assert.equal(legacy.statusCode, 200);
  assert.equal(periods.has("actual"), false);
  assert.equal(periods.has("modeled_reconstructed"), true);
  assert.equal(periods.has("current_partial"), true);
  assert.equal(periods.has("projected"), true);
  assert.equal(legacy.body.data.trend.some((row) => row.method === "elapsed_time_allocation"), true);
});

test("canonical overview exposes cumulative tax trend without duplicate current months", async () => {
  const app = createApp(baseStore());
  const overview = await request(app, `/api/tax/overview?businessId=${BUSINESS_ID}&year=2026&asOfDate=2026-06-15&refresh=true`, { token: "valid-user" });
  const trend = overview.body.data.projection.taxTrend;
  assert.equal(overview.statusCode, 200);
  assert.equal(Array.isArray(trend), true);
  assert.equal(trend.length, 12);
  assert.equal(new Set(trend.map((row) => row.month)).size, 12);
  assert.equal(trend.filter((row) => row.isCurrent).length, 1);
  assert.equal(trend.find((row) => row.isCurrent).month, "2026-06");
  assert.equal(trend.some((row) => row.periodType === "actual"), false);
  assert.equal(trend.some((row) => row.periodType === "modeled_reconstructed"), true);
  assert.equal(trend.some((row) => row.periodType === "current_partial"), true);
  assert.equal(trend.some((row) => row.periodType === "projected"), true);
  assert.equal(trend.some((row) => row.method === "elapsed_time_allocation"), false);
  assert.equal(trend.find((row) => row.isCurrent).workpaperDeepLink.includes("/workpaper?section=through_date_tax"), true);
  assert.equal(typeof trend.at(-1).projectedYearEndTax, "number");
  assert.equal(trend.at(-1).projectedYearEndTax, overview.body.data.summary.projectedTotalTax);
});

function createApp(store) {
  const app = express();
  const supabase = makeSupabase(store);
  app.use(express.json());
  app.locals.supabase = supabase;
  __setTaxCalculateLiabilityTestDeps({ supabase });
  app.use("/api/tax", authStub, taxRouter);
  return app;
}

function is4xx(statusCode) {
  return statusCode >= 400 && statusCode < 500;
}

function authStub(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth) return res.status(401).json({ ok: false, error: "Unauthorized: missing token" });
  if (auth === "Bearer valid-user") {
    req.user = { id: USER_ID };
    return next();
  }
  if (auth === "Bearer other-user") {
    req.user = { id: OTHER_USER_ID };
    return next();
  }
  return res.status(401).json({ ok: false, error: "Unauthorized: invalid token" });
}

async function request(app, path, { method = "GET", token = null, body = null } = {}) {
  const chunks = [];
  const requestBody = body ? JSON.stringify(body) : "";
  const req = new Readable({
    read() {
      if (requestBody) this.push(requestBody);
      this.push(null);
    },
  });
  req.method = method;
  req.url = path;
  req.headers = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(requestBody),
  };
  if (token) req.headers.authorization = `Bearer ${token}`;

  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  res.headers = {};
  res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value; };
  res.getHeader = (key) => res.headers[key.toLowerCase()];
  res.removeHeader = (key) => {
    delete res.headers[String(key).toLowerCase()];
  };
  res.write = (chunk) => {
    if (chunk) chunks.push(Buffer.from(chunk));
    return true;
  };
  res.end = (chunk) => {
    if (chunk) chunks.push(Buffer.from(chunk));
    res.emit("finish");
  };
  res.statusCode = 200;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => {
    res.setHeader("content-type", "application/json");
    chunks.push(Buffer.from(JSON.stringify(payload)));
    res.end();
    return res;
  };
  res.send = (payload) => {
    chunks.push(Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)));
    res.end();
    return res;
  };
  res.sendStatus = (code) => {
    res.statusCode = code;
    res.end();
    return res;
  };

  await new Promise((resolve, reject) => {
    res.on("finish", resolve);
    res.on("error", reject);
    app.handle(req, res, reject);
  });
  const text = Buffer.concat(chunks).toString("utf8");
  return { statusCode: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null, text };
}

function baseStore(overrides = {}) {
  const bank = [
    bankTxn({ id: "income", signed_amount: 120000, direction: "INFLOW", raw: { secret: "raw_secret", access_token: "token" } }),
    bankTxn({ id: "cogs", signed_amount: -20000, direction: "OUTFLOW" }),
    bankTxn({ id: "expense", signed_amount: -30000, direction: "OUTFLOW" }),
    bankTxn({ id: "other-income", business_id: OTHER_BUSINESS_ID, signed_amount: 999999, direction: "INFLOW" }),
  ];
  return {
    business_profiles: [
      { id: BUSINESS_ID, user_id: USER_ID },
      { id: OTHER_BUSINESS_ID, user_id: OTHER_USER_ID },
    ],
    bank_transactions: bank,
    transaction_categorizations: bank.map((row) => cat({ business_id: row.business_id, transaction_id: row.id })),
    qbo_posted_transactions: [{ id: "qbo-1", business_id: BUSINESS_ID, transaction_id: "income", qbo_txn_id: "qbo", status: "posted", response: { secret: "qbo_secret" } }],
    transaction_tax_classifications: [
      classification({ id: "c-income", transaction_id: "income", book_amount: 120000, tax_category: "income", deductible_amount: 0 }),
      classification({ id: "c-cogs", transaction_id: "cogs", book_amount: -20000, tax_category: "cost_of_goods_sold", deductible_amount: 20000, classification_status: "user_confirmed" }),
      classification({ id: "c-expense", transaction_id: "expense", book_amount: -30000, tax_category: "office_expense", deductible_amount: 30000, classification_status: "user_confirmed" }),
      classification({ id: "c-other", business_id: OTHER_BUSINESS_ID, transaction_id: "other-income", book_amount: 999999, tax_category: "income", deductible_amount: 0 }),
    ],
    tax_adjustments: [],
    tax_profiles: [profile(), profile({ id: "other-profile", business_id: OTHER_BUSINESS_ID })],
    tax_profile_memory: [],
    financial_metrics: [],
    cashflow_forecast: [],
    monthly_forecast: [],
    tax_rule_configs: federalRules(),
    state_tax_rule_configs: [stateRule()],
    tax_payments: [
      payment({ id: "fed-est", jurisdiction: "federal", payment_type: "estimated_payment", amount: 1000 }),
      payment({ id: "state-est", jurisdiction: "state", state_code: "NC", payment_type: "estimated_payment", amount: 300 }),
      payment({ id: "state-wh", jurisdiction: "state", state_code: "NC", payment_type: "withholding", amount: 200 }),
    ],
    tax_calculation_runs: [],
    tax_calculation_components: [],
    tax_calculation_run_links: [],
    tax_reserve_accounts: [],
    tax_reserve_snapshots: [],
    tax_review_tasks: [],
    ...overrides,
  };
}

function profile(overrides = {}) {
  return {
    id: "profile-1",
    business_id: BUSINESS_ID,
    tax_year: 2026,
    entity_type: "single_member_llc",
    tax_election: "disregarded_entity",
    filing_status: "single",
    primary_tax_state: "NC",
    accounting_method: "cash",
    safe_harbor_method: "current_year_90",
    prior_year_total_tax: 8000,
    prior_year_agi: 100000,
    self_employment_tax_applies: true,
    qbi_eligible: true,
    profile_status: "active",
    reserve_buffer_percent: 0.1,
    metadata: {},
    ...overrides,
  };
}

function bankTxn(overrides = {}) {
  return {
    id: "txn",
    business_id: BUSINESS_ID,
    pending: false,
    date: "2026-06-15",
    name: "Txn",
    merchant_name: "Merchant",
    signed_amount: -100,
    direction: "OUTFLOW",
    is_archived: false,
    created_at: "2026-06-15T00:00:00Z",
    ...overrides,
  };
}

function cat(overrides = {}) {
  return {
    business_id: BUSINESS_ID,
    transaction_id: "txn",
    status: "posted",
    qbo_txn_id: "qbo",
    qbo_txn_type: "Expense",
    posted_at: "2026-06-16T00:00:00Z",
    meta: {},
    ...overrides,
  };
}

function classification(overrides = {}) {
  return {
    id: "classification",
    business_id: BUSINESS_ID,
    transaction_id: "txn",
    tax_year: 2026,
    transaction_date: "2026-06-15",
    tax_category: "office_expense",
    deductibility_status: "fully_deductible",
    deductible_percent: 100,
    book_amount: -100,
    deductible_amount: 100,
    nondeductible_amount: 0,
    capitalizable_amount: 0,
    tax_treatment: { type: "ordinary_expense" },
    classification_status: "auto_classified",
    confidence_score: 90,
    confidence_level: "high",
    requires_review: false,
    metadata: {},
    created_at: "2026-06-15T00:00:00Z",
    updated_at: "2026-06-15T00:00:00Z",
    ...overrides,
  };
}

function payment(overrides = {}) {
  return {
    id: "payment",
    business_id: BUSINESS_ID,
    tax_year: 2026,
    jurisdiction: "federal",
    state_code: null,
    payment_type: "estimated_payment",
    amount: 100,
    payment_date: "2026-04-15",
    status: "posted",
    metadata: {},
    created_at: "2026-04-15T00:00:00Z",
    ...overrides,
  };
}

function reserveAccount(overrides = {}) {
  return {
    id: "reserve-1",
    business_id: BUSINESS_ID,
    tracking_method: "manual",
    display_name: "Tax Reserve",
    account_mask: "1234",
    is_primary: true,
    is_active: true,
    manual_balance: 0,
    last_verified_at: "2026-09-01T00:00:00Z",
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function federalRules() {
  return [
    federalRule({ id: "brackets", rule_type: "federal_income_tax_brackets", config: { brackets: [{ upTo: 10000, rate: 0.1 }, { upTo: 40000, rate: 0.2 }, { upTo: null, rate: 0.3 }], annual: true } }),
    federalRule({ id: "standard", rule_type: "standard_deduction", config: { amount: 10000, amountByFilingStatus: { single: 10000 }, annual: true } }),
    federalRule({ id: "se", rule_type: "self_employment_tax", config: { netEarningsFactor: 0.9235, socialSecurityRate: 0.124, medicareRate: 0.029, socialSecurityWageBase: 160200, deductiblePortionRate: 0.5 } }),
    federalRule({ id: "wage-base", rule_type: "social_security_wage_base", config: { amount: 160200 } }),
    federalRule({ id: "additional-medicare", rule_type: "additional_medicare_tax", config: { rate: 0.009, thresholdsByFilingStatus: { single: 200000 } } }),
    federalRule({ id: "safe-harbor", rule_type: "estimated_tax_safe_harbor", config: { currentYearPercent: 0.9, priorYearPercent: 1, highIncomePriorYearPercent: 1.1, highIncomeAgiThresholdsByFilingStatus: { single: 150000 } } }),
    federalRule({ id: "due-dates", rule_type: "estimated_tax_due_dates", config: { installments: [{ quarter: 1, dueMonth: 4, dueDay: 15 }, { quarter: 2, dueMonth: 6, dueDay: 15 }, { quarter: 3, dueMonth: 9, dueDay: 15 }, { quarter: 4, dueMonth: 1, dueDay: 15, yearOffset: 1 }] } }),
  ];
}

function federalRule(overrides = {}) {
  return {
    id: "rule",
    tax_year: 2026,
    jurisdiction: "federal",
    filing_status: null,
    entity_type: null,
    version: "fixture-v1",
    support_level: "verified",
    source_name: "Fixture",
    source_url: "https://example.test/rule",
    verified_at: "2026-01-01",
    effective_from: "2026-01-01",
    effective_to: null,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function stateRule(overrides = {}) {
  return {
    id: "state-rule",
    tax_year: 2026,
    state_code: "NC",
    rule_type: "individual_income_tax",
    entity_type: null,
    filing_status: null,
    config: { kind: "flat", rate: 0.05, annual: true },
    version: "fixture-state-v1",
    support_level: "verified",
    source_name: "Fixture",
    source_url: "https://example.test/state",
    verified_at: "2026-01-01",
    effective_from: "2026-01-01",
    effective_to: null,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeSupabase(store) {
  return {
    store,
    from(table) {
      store[table] ||= [];
      return new Query(table, store);
    },
  };
}

class Query {
  constructor(table, store) {
    this.table = table;
    this.store = store;
    this.rows = [...(store[table] || [])];
    this.patch = null;
    this.inserted = null;
  }
  select() { return this; }
  eq(field, value) {
    this.rows = this.rows.filter((row) => String(row[field]) === String(value));
    return this;
  }
  in(field, values) {
    const set = new Set(values.map(String));
    this.rows = this.rows.filter((row) => set.has(String(row[field])));
    return this;
  }
  gte(field, value) {
    this.rows = this.rows.filter((row) => String(row[field] || "") >= String(value));
    return this;
  }
  lte(field, value) {
    this.rows = this.rows.filter((row) => String(row[field] || "") <= String(value));
    return this;
  }
  is(field, value) {
    this.rows = this.rows.filter((row) => row[field] === value);
    return this;
  }
  or() { return this; }
  order(field, options = {}) {
    const dir = options.ascending === false ? -1 : 1;
    this.rows = [...this.rows].sort((a, b) => {
      const av = a[field] ?? "";
      const bv = b[field] ?? "";
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return this;
  }
  limit(n) {
    this.rows = this.rows.slice(0, n);
    return this;
  }
  range(start, end) {
    this.rows = this.rows.slice(start, end + 1);
    return this;
  }
  insert(row) {
    const rows = Array.isArray(row) ? row : [row];
    this.inserted = rows.map((item, index) => ({
      id: item.id || `${this.table}-${this.store[this.table].length + index + 1}`,
      ...item,
    }));
    this.store[this.table].push(...this.inserted);
    this.rows = [...this.inserted];
    return this;
  }
  update(patch) {
    this.patch = patch;
    return this;
  }
  maybeSingle() {
    this.applyPatch();
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  single() {
    this.applyPatch();
    return Promise.resolve({ data: this.rows[0] || null, error: null });
  }
  then(resolve) {
    this.applyPatch();
    return Promise.resolve({ data: this.rows, error: null }).then(resolve);
  }
  applyPatch() {
    if (!this.patch) return;
    const ids = new Set(this.rows.map((row) => row.id));
    this.store[this.table] = this.store[this.table].map((row) => ids.has(row.id) ? { ...row, ...this.patch } : row);
    this.rows = this.store[this.table].filter((row) => ids.has(row.id));
    this.patch = null;
  }
}
