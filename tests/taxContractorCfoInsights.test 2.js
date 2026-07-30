import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000321";
const TAX_YEAR = 2026;

test("tax Contractor CFO insights use canonical tax runs and material liability changes", async () => {
  const { runContractorCfoInsightsForBusiness, __setContractorCfoEngineTestDeps } = await import("../src/services/insights/contractorCfoEngine.js");
  const { __setInsightDedupeServiceTestDeps } = await import("../src/services/insights/insightDedupeService.js");
  const supabase = makeSupabaseStub({
    tax_calculation_runs: [
      taxRun({ id: "run-current", estimated_total_tax: 14200, completed_at: "2026-07-14T12:00:00Z", confidence: { level: "medium", score: 82, estimateReady: true, reserveReady: true } }),
      taxRun({ id: "run-prior", estimated_total_tax: 10000, completed_at: "2026-07-01T12:00:00Z", confidence: { level: "medium", score: 82, estimateReady: true, reserveReady: true } }),
    ],
  });
  __setContractorCfoEngineTestDeps({ supabase });
  __setInsightDedupeServiceTestDeps({ supabase });

  const result = await runContractorCfoInsightsForBusiness(BUSINESS_ID, { trigger: "tax_calculation_materially_changed", limit: 10, now: "2026-07-14T12:00:00Z" });

  assert.equal(result.ok, true);
  const liability = supabase.tables.insights.find((row) => row.category === "tax_liability_change");
  assert.ok(liability);
  assert.match(liability.body, /increased by \$4,200/);
  assert.equal(liability.primary_cta_payload.route, "/dashboard/tax?drawer=changes");
  assert.equal(liability.source_refs.some((ref) => ref.type === "tax_calculation_run" && ref.id === "run-current"), true);
});

test("immaterial tax run change creates no liability insight", async () => {
  const { runContractorCfoInsightsForBusiness, __setContractorCfoEngineTestDeps } = await import("../src/services/insights/contractorCfoEngine.js");
  const { __setInsightDedupeServiceTestDeps } = await import("../src/services/insights/insightDedupeService.js");
  const supabase = makeSupabaseStub({
    tax_calculation_runs: [
      taxRun({ id: "run-current", estimated_total_tax: 10500, completed_at: "2026-07-14T12:00:00Z" }),
      taxRun({ id: "run-prior", estimated_total_tax: 10000, completed_at: "2026-07-01T12:00:00Z" }),
    ],
  });
  __setContractorCfoEngineTestDeps({ supabase });
  __setInsightDedupeServiceTestDeps({ supabase });

  await runContractorCfoInsightsForBusiness(BUSINESS_ID, { trigger: "weekly_cron", limit: 10, now: "2026-07-14T12:00:00Z" });
  assert.equal(supabase.tables.insights.some((row) => row.category === "tax_liability_change"), false);
});

test("reserve gap, missing reserve account, safe harbor, deadline, and review exposure are distinct actionable insights", async () => {
  const { runContractorCfoInsightsForBusiness, __setContractorCfoEngineTestDeps } = await import("../src/services/insights/contractorCfoEngine.js");
  const { __setInsightDedupeServiceTestDeps } = await import("../src/services/insights/insightDedupeService.js");
  const supabase = makeSupabaseStub({
    tax_calculation_runs: [
      taxRun({
        id: "run-current",
        estimated_total_tax: 32000,
        completed_at: "2026-07-14T12:00:00Z",
        reserve: { reserveGap: 7800, currentReserve: 9000 },
        safeHarbor: { status: "available", remainingAmount: 4600 },
        deadlines: [{ id: "deadline-q3", name: "Federal estimated tax", dueDate: "2026-07-21", amount: null }],
        confidence: { level: "medium", score: 82, estimateReady: true, reserveReady: true },
      }),
    ],
    transaction_tax_classifications: [
      { business_id: BUSINESS_ID, tax_year: TAX_YEAR, status: "needs_review", amount: 12000 },
      { business_id: BUSINESS_ID, tax_year: TAX_YEAR, status: "needs_review", amount: 6400 },
    ],
  });
  __setContractorCfoEngineTestDeps({ supabase });
  __setInsightDedupeServiceTestDeps({ supabase });

  await runContractorCfoInsightsForBusiness(BUSINESS_ID, { trigger: "daily_cron", limit: 10, now: "2026-07-14T12:00:00Z" });
  const categories = new Set(supabase.tables.insights.map((row) => row.category));

  assert.equal(categories.has("tax_reserve_gap"), true);
  assert.equal(categories.has("tax_safe_harbor_gap"), true);
  assert.equal(categories.has("tax_payment_due"), true);
  assert.equal(categories.has("tax_classification_review"), true);
  assert.match(supabase.tables.insights.find((row) => row.category === "tax_payment_due").body, /amount is not available/i);
  assert.equal(supabase.tables.insights.find((row) => row.category === "tax_classification_review").primary_cta_payload.route, "/dashboard/tax");
});

test("confidence, state unavailable, source stale, and setup blocker wording is cautious", async () => {
  const { runContractorCfoInsightsForBusiness, __setContractorCfoEngineTestDeps } = await import("../src/services/insights/contractorCfoEngine.js");
  const { __setInsightDedupeServiceTestDeps } = await import("../src/services/insights/insightDedupeService.js");
  const supabase = makeSupabaseStub({
    tax_calculation_runs: [
      taxRun({
        id: "run-low",
        estimated_total_tax: 18000,
        completed_at: "2026-07-14T12:00:00Z",
        confidence: { level: "low", score: 54, estimateReady: true, reserveReady: false, topImprovementAction: "Review transaction classifications" },
        readiness: { estimateReady: true, reserveReady: false, blockers: [{ code: "entity_unknown" }] },
        warnings: [{ code: "state_rule_missing", severity: "medium" }],
        source_freshness: { lastQboSyncAt: "2026-07-01T12:00:00Z" },
      }),
    ],
  });
  __setContractorCfoEngineTestDeps({ supabase });
  __setInsightDedupeServiceTestDeps({ supabase });

  await runContractorCfoInsightsForBusiness(BUSINESS_ID, { trigger: "weekly_cron", limit: 10, now: "2026-07-14T12:00:00Z" });
  const low = supabase.tables.insights.find((row) => row.category === "tax_confidence_low");
  const state = supabase.tables.insights.find((row) => row.category === "tax_state_unavailable");
  const stale = supabase.tables.insights.find((row) => row.category === "tax_source_stale");
  const setup = supabase.tables.insights.find((row) => row.category === "tax_entity_unknown");

  assert.match(low.body, /Based on incomplete information/);
  assert.match(state.body, /federal estimate is available/i);
  assert.match(stale.body, /last updated 13 days ago/);
  assert.match(setup.body, /confirm how the LLC is taxed/i);
});

test("tax insight dedupe suppresses repeated cron alerts and resolved conditions are hidden from rail", async () => {
  const { runContractorCfoInsightsForBusiness, __setContractorCfoEngineTestDeps } = await import("../src/services/insights/contractorCfoEngine.js");
  const { __setInsightDedupeServiceTestDeps } = await import("../src/services/insights/insightDedupeService.js");
  const listModule = await import("../src/api/insights/list.js");
  const { __setInsightsListTestDeps } = listModule;
  const supabase = makeSupabaseStub({
    tax_calculation_runs: [
      taxRun({ id: "run-gap", estimated_total_tax: 30000, completed_at: "2026-07-14T12:00:00Z", reserve: { reserveGap: 5000, currentReserve: 1000 } }),
    ],
  });
  __setContractorCfoEngineTestDeps({ supabase });
  __setInsightDedupeServiceTestDeps({ supabase });
  __setInsightsListTestDeps({ supabase });

  await runContractorCfoInsightsForBusiness(BUSINESS_ID, { trigger: "daily_cron", limit: 10, now: "2026-07-14T12:00:00Z" });
  await runContractorCfoInsightsForBusiness(BUSINESS_ID, { trigger: "daily_cron", limit: 10, now: "2026-07-14T12:00:00Z" });
  assert.equal(supabase.tables.insights.filter((row) => row.category === "tax_reserve_gap").length, 1);

  supabase.tables.tax_calculation_runs.unshift(taxRun({
    id: "run-fixed",
    estimated_total_tax: 30000,
    completed_at: "2026-07-15T12:00:00Z",
    reserve: { reserveGap: 0, currentReserve: 30000 },
  }));
  await runContractorCfoInsightsForBusiness(BUSINESS_ID, { trigger: "tax_calculation_materially_changed", limit: 10, now: "2026-07-15T12:00:00Z" });
  const oldGap = supabase.tables.insights.find((row) => row.category === "tax_reserve_gap");
  assert.equal(oldGap.status, "resolved");

  const res = makeRes();
  await listModule.default(makeReq({ businessId: BUSINESS_ID, module: "contractor_cfo", voice: "none", limit: "20" }), res);
  assert.equal(res.body.items.some((row) => row.category === "tax_reserve_gap"), false);
  assert.equal(res.body.items.some((row) => row.category === "tax_positive_progress"), true);
});

test("active tax insight path does not use legacy snapshots or monthly metrics", () => {
  const engine = fs.readFileSync("src/services/insights/contractorCfoEngine.js", "utf8");
  const rules = fs.readFileSync("src/services/insights/rules/taxInsightRules.js", "utf8");
  const context = fs.readFileSync("src/services/insights/context/buildTaxInsightContext.js", "utf8");
  for (const source of [engine, rules, context]) {
    assert.doesNotMatch(source, /tax_snapshots|monthly_metrics|legacy tax_config|generateTaxInsights/);
    assert.doesNotMatch(source, /runCanonicalTaxCalculation|calculateTaxLiability/);
  }
});

function taxRun(overrides = {}) {
  return {
    id: overrides.id || "run",
    business_id: BUSINESS_ID,
    tax_year: TAX_YEAR,
    status: "completed",
    completed_at: overrides.completed_at || "2026-07-14T12:00:00Z",
    created_at: overrides.completed_at || "2026-07-14T12:00:00Z",
    estimated_total_tax: overrides.estimated_total_tax ?? 30000,
    remaining_projected_liability: overrides.remaining_projected_liability ?? 20000,
    recommended_reserve: overrides.recommended_reserve ?? 18000,
    taxable_income_ytd: overrides.taxable_income_ytd ?? 100000,
    summary: {
      projectedTotalTax: overrides.estimated_total_tax ?? 30000,
      taxableIncomeYtd: overrides.taxable_income_ytd ?? 100000,
    },
    reserve: overrides.reserve || { reserveGap: null, currentReserve: null },
    safeHarbor: overrides.safeHarbor || { status: "unavailable" },
    deadlines: overrides.deadlines || [],
    confidence: overrides.confidence || { level: "medium", score: 82, estimateReady: true, reserveReady: true },
    readiness: overrides.readiness || { estimateReady: true, reserveReady: true, blockers: [] },
    warnings: overrides.warnings || [],
    source_freshness: overrides.source_freshness || {},
  };
}

function makeReq(query = {}, headers = {}) {
  return {
    query,
    header(name) {
      return headers[name.toLowerCase()] || headers[name] || null;
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function makeSupabaseStub(seed = {}) {
  const tables = {
    insights: [],
    insight_feedback: [],
    financial_metrics: [],
    tax_calculation_runs: [],
    tax_profiles: [],
    tax_payments: [],
    transaction_tax_classifications: [],
    ...seed,
  };
  let idCounter = 1;

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this._limit = null;
      this._orders = [];
      this._mutation = null;
    }
    select() { return this; }
    limit(n) { this._limit = n; return this; }
    order(column, options = {}) { this._orders.push({ column, ascending: options.ascending !== false }); return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
    in(column, values = []) { const set = new Set(values); this.filters.push((row) => set.has(row[column])); return this; }
    gte(column, value) { this.filters.push((row) => String(row[column] || "") >= String(value)); return this; }
    lt(column, value) { this.filters.push((row) => String(row[column] || "") < String(value)); return this; }
    is(column, value) { this.filters.push((row) => row[column] === value); return this; }
    insert(payload) { this._mutation = { type: "insert", payload }; return this; }
    update(payload) { this._mutation = { type: "update", payload }; return this; }
    then(resolve) { return Promise.resolve(this.exec()).then(resolve); }
    exec() {
      if (!Object.hasOwn(tables, this.table)) {
        return { data: null, error: { code: "42P01", message: `relation ${this.table} does not exist` } };
      }
      if (this._mutation?.type === "insert") {
        const rows = (Array.isArray(this._mutation.payload) ? this._mutation.payload : [this._mutation.payload])
          .map((row) => ({ id: row.id || `insight-${idCounter++}`, created_at: row.created_at || new Date().toISOString(), ...row }));
        tables[this.table].push(...rows);
        return { data: rows, error: null };
      }
      let rows = tables[this.table].filter((row) => this.filters.every((fn) => fn(row)));
      if (this._mutation?.type === "update") {
        rows.forEach((row) => Object.assign(row, this._mutation.payload));
        return { data: rows, error: null };
      }
      for (const { column, ascending } of this._orders) {
        rows = [...rows].sort((a, b) => {
          const av = a[column] || "";
          const bv = b[column] || "";
          return ascending ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
        });
      }
      if (this._limit != null) rows = rows.slice(0, this._limit);
      return { data: rows, error: null };
    }
  }

  return {
    tables,
    from(table) {
      return new Query(table);
    },
  };
}
