/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("tax domain normalizers handle state, year, entity, filing, money, percent, and UUIDs", async () => {
  const domain = await import("../src/services/tax/taxDomain.js");

  assert.equal(domain.normalizeStateCode(" ca "), "CA");
  assert.equal(domain.normalizeStateCode("ZZ"), null);
  assert.equal(domain.normalizeTaxYear("2026"), 2026);
  assert.equal(domain.normalizeTaxYear("1999"), null);
  assert.equal(domain.normalizeEntityType("s-corp"), "s_corp");
  assert.equal(domain.normalizeEntityType("made up"), "unknown");
  assert.equal(domain.normalizeFilingStatus("mfj"), "married_filing_jointly");
  assert.equal(domain.normalizeFilingStatus("bad"), "unknown");
  assert.equal(domain.normalizeMoney("123.456"), 123.46);
  assert.equal(domain.normalizeMoney("Infinity"), null);
  assert.equal(domain.normalizePercent("0.25"), 0.25);
  assert.equal(domain.normalizePercent("NaN"), null);
  assert.equal(domain.isValidUuid(BUSINESS_ID), true);
  assert.equal(domain.isValidUuid("not-a-uuid"), false);
});

test("tax validation accepts legacy and canonical liability payloads", async () => {
  const { validateTaxCalculationRequest } = await import("../src/api/tax/taxValidation.js");

  const legacy = validateTaxCalculationRequest({
    body: { businessId: BUSINESS_ID, year: 2026, projectionOverride: {} },
  });
  assert.equal(legacy.businessId, BUSINESS_ID);
  assert.equal(legacy.taxYear, 2026);
  assert.equal(legacy.calculationType, "full_estimate");
  assert.equal(legacy.triggerSource, "page_refresh");

  const canonical = validateTaxCalculationRequest({
    body: {
      businessId: BUSINESS_ID,
      taxYear: 2027,
      asOfDate: "2027-07-01",
      calculationType: "projection",
      triggerSource: "manual",
      projectionOverride: {
        overrides: {
          "2027-08": { profit: 12000, revenue: 20000, expenses: 8000 },
        },
      },
    },
  });
  assert.equal(canonical.taxYear, 2027);
  assert.equal(canonical.asOfDate, "2027-07-01");
  assert.equal(canonical.calculationType, "projection");
  assert.equal(canonical.triggerSource, "manual");
  assert.equal(canonical.projectionOverride.overrides["2027-08"].profit, 12000);
});

test("tax route validators reject invalid money and percent values", async () => {
  const { optionalMoney, optionalPercent } = await import("../src/api/tax/taxValidation.js");

  assert.throws(() => optionalMoney("Infinity", "amount"), /finite number/);
  assert.throws(() => optionalMoney("NaN", "amount"), /finite number/);
  assert.throws(() => optionalPercent("1.5", "confidence"), /between 0 and 1/);
  assert.throws(() => optionalPercent("-0.1", "confidence"), /between 0 and 1/);
  assert.equal(optionalMoney("12.345", "amount"), 12.35);
  assert.equal(optionalPercent("0.75", "confidence"), 0.75);
});

test("tax validation rejects arrays and oversized/deep projection override shapes", async () => {
  const { validateTaxCalculationRequest } = await import("../src/api/tax/taxValidation.js");

  assert.throws(
    () => validateTaxCalculationRequest({ body: { businessId: BUSINESS_ID, year: 2026, projectionOverride: [] } }),
    /projectionOverride must be an object/
  );
  assert.throws(
    () =>
      validateTaxCalculationRequest({
        body: {
          businessId: BUSINESS_ID,
          year: 2026,
          projectionOverride: { overrides: { "2026-01": { unsupported: 1 } } },
        },
      }),
    /unsupported field/
  );
});

test("tax business access succeeds for owned businesses and denies cross-business access", async () => {
  const { assertTaxBusinessAccess } = await import("../src/api/tax/taxRouteUtils.js");
  const supabase = makeBusinessSupabase([
    { id: BUSINESS_ID, user_id: USER_ID },
    { id: OTHER_BUSINESS_ID, user_id: OTHER_USER_ID },
  ]);

  const req = { user: { id: USER_ID } };
  const context = await assertTaxBusinessAccess({ req, businessId: BUSINESS_ID, supabase });
  assert.deepEqual(context, { businessId: BUSINESS_ID, userId: USER_ID });

  await assert.rejects(
    () => assertTaxBusinessAccess({ req: { user: { id: USER_ID } }, businessId: OTHER_BUSINESS_ID, supabase }),
    (err) => err.code === "business_access_denied" && err.status === 403
  );
});

test("live missing-table liability errors do not return mock data", async () => {
  const mod = await import("../src/api/tax/calculateTaxLiability.js");
  mod.__setTaxCalculateLiabilityTestDeps({
    supabase: makeBusinessSupabase([{ id: BUSINESS_ID, user_id: USER_ID }]),
    calculateTaxLiability: async () => {
      const err = new Error('relation "monthly_metrics" does not exist');
      err.code = "42P01";
      throw err;
    },
    triggerContractorCfoInsightsBestEffort: () => {},
  });

  const previous = process.env.MOCK_TAX_LIABILITY;
  delete process.env.MOCK_TAX_LIABILITY;
  const res = makeRes();
  await mod.default(
    { method: "POST", user: { id: USER_ID }, body: { businessId: BUSINESS_ID, year: 2026 } },
    res
  );
  process.env.MOCK_TAX_LIABILITY = previous;

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, "tax_data_unavailable");
});

test("explicit mock liability mode is labeled as mock", async () => {
  const mod = await import("../src/api/tax/calculateTaxLiability.js");
  mod.__setTaxCalculateLiabilityTestDeps({
    supabase: makeBusinessSupabase([{ id: BUSINESS_ID, user_id: USER_ID }]),
    calculateTaxLiability: async () => {
      throw new Error("mock mode should not call legacy calculator");
    },
    triggerContractorCfoInsightsBestEffort: () => {},
  });

  const previous = process.env.MOCK_TAX_LIABILITY;
  process.env.MOCK_TAX_LIABILITY = "true";
  const res = makeRes();
  await mod.default(
    { method: "POST", user: { id: USER_ID }, body: { businessId: BUSINESS_ID, year: 2026 } },
    res
  );
  if (previous == null) delete process.env.MOCK_TAX_LIABILITY;
  else process.env.MOCK_TAX_LIABILITY = previous;

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.data.meta.source, "mock");
  assert.equal(res.body.data.meta.is_demo, true);
  assert.equal(res.body.meta.source, "mock");
});

test("server mounts the central tax router behind requireAuth only", () => {
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(server, /app\.use\("\/api\/tax", requireAuth, taxRouter\)/);
  assert.doesNotMatch(server, /app\.use\("\/api\/tax", taxRoutes\)/);
  assert.doesNotMatch(server, /app\.use\("\/api\/tax\/deductions", requireAuth, taxDeductionsRouter\)/);
});

function makeBusinessSupabase(rows) {
  return {
    from(table) {
      const query = {
        filters: [],
        select() {
          return this;
        },
        eq(field, value) {
          this.filters.push({ field, value });
          return this;
        },
        limit() {
          return this;
        },
        async maybeSingle() {
          const tableRows = table === "business_profiles" ? rows : [];
          const found = tableRows.find((row) =>
            this.filters.every((filter) => String(row[filter.field]) === String(filter.value))
          );
          return { data: found || null, error: null };
        },
      };
      return query;
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    set(key, value) {
      this.headers[key] = value;
      return this;
    },
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
