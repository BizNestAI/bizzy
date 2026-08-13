import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runTaxProductionAudit, TAX_SECURITY_TABLES } from "../src/services/tax/security/taxProductionAudit.js";
import { taxSecurityMiddleware, resetTaxRateLimits } from "../src/api/tax/taxSecurity.js";
import { assertInternalSchedulerAccess } from "../src/api/tax/taxSchedulerAuth.js";

test("production audit passes static Tax security checks with safe test environment", () => {
  const report = runTaxProductionAudit({
    root: process.cwd(),
    env: {
      NODE_ENV: "test",
      TAX_SCHEDULER_ENABLED: "true",
      TAX_SCHEDULER_INTERNAL_SECRET: "secret",
    },
  });
  assert.notEqual(report.status, "fail", report.checks.filter((check) => check.status === "fail").map((check) => check.code).join(", "));
  assert.ok(report.checks.some((check) => check.code === "tax_router_security_middleware" && check.status === "pass"));
  assert.ok(report.checks.some((check) => check.code === "frontend_service_role_import" && check.status === "pass"));
});

test("production audit fails dangerous production Tax mock flags and missing scheduler secret", () => {
  const report = runTaxProductionAudit({
    root: process.cwd(),
    env: {
      NODE_ENV: "production",
      MOCK_TAX: "true",
      TAX_SCHEDULER_ENABLED: "true",
    },
  });
  assert.equal(report.status, "fail");
  assert.ok(report.checks.some((check) => check.code === "environment_safety" && check.status === "fail"));
  assert.ok(report.checks.some((check) => check.code === "scheduler_internal_secret_missing" && check.status === "fail"));
});

test("RLS hardening migration covers every Tax security table and business ownership function", () => {
  const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/20260714_tax_security_rls_hardening.sql"), "utf8");
  assert.match(sql, /tax_user_owns_business/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /force row level security/);
  for (const table of TAX_SECURITY_TABLES) {
    assert.match(sql, new RegExp(table), table);
  }
});

test("Tax router mounts no-store/rate-limit middleware before route mounts", () => {
  const router = readFileSync(resolve(process.cwd(), "src/api/tax/index.js"), "utf8");
  assert.match(router, /router\.use\(taxSecurityMiddleware\)/);
  assert.ok(router.indexOf("router.use(taxSecurityMiddleware)") < router.indexOf("router.post(\"/calculate-tax-liability\""));
});

test("Tax security middleware rate-limits repeated mutation requests safely", async () => {
  resetTaxRateLimits();
  const previousSecret = process.env.TAX_SCHEDULER_INTERNAL_SECRET;
  delete process.env.TAX_SCHEDULER_INTERNAL_SECRET;
  try {
    let statusCode = 200;
    for (let i = 0; i < 65; i += 1) {
      const req = {
        method: "POST",
        path: "/payments",
        user: { id: "user-a" },
        body: { businessId: "11111111-1111-4111-8111-111111111111" },
        headers: {},
        ip: "127.0.0.1",
      };
      const res = mockRes();
      let nextCalled = false;
      taxSecurityMiddleware(req, res, () => { nextCalled = true; });
      statusCode = res.statusCode;
      if (i < 60) assert.equal(nextCalled, true);
    }
    assert.equal(statusCode, 429);
  } finally {
    if (previousSecret == null) delete process.env.TAX_SCHEDULER_INTERNAL_SECRET;
    else process.env.TAX_SCHEDULER_INTERNAL_SECRET = previousSecret;
    resetTaxRateLimits();
  }
});

test("internal scheduler route helper denies ordinary users and accepts only configured secret", () => {
  const previous = process.env.TAX_SCHEDULER_INTERNAL_SECRET;
  process.env.TAX_SCHEDULER_INTERNAL_SECRET = "secret";
  try {
    assert.throws(() => assertInternalSchedulerAccess({ headers: {} }), /Internal scheduler access required/);
    assert.throws(() => assertInternalSchedulerAccess({ headers: { "x-internal-cron-secret": "wrong" } }), /Internal scheduler access required/);
    assert.equal(assertInternalSchedulerAccess({ headers: { "x-internal-cron-secret": "secret" } }), true);
  } finally {
    if (previous == null) delete process.env.TAX_SCHEDULER_INTERNAL_SECRET;
    else process.env.TAX_SCHEDULER_INTERNAL_SECRET = previous;
  }
});

test("shared Tax business authorization denies cross-business access", async () => {
  process.env.SUPABASE_URL ||= "http://localhost:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
  const { assertTaxBusinessAccess } = await import("../src/api/tax/taxRouteUtils.js");
  const businessA = "11111111-1111-4111-8111-111111111111";
  const businessB = "22222222-2222-4222-8222-222222222222";
  const sharedBusiness = "33333333-3333-4333-8333-333333333333";
  const supabase = makeBusinessSupabase({
    business_profiles: [
      { id: businessA, user_id: "user-a" },
      { id: businessB, user_id: "user-b" },
      { id: sharedBusiness, user_id: "user-b" },
    ],
    user_business_link: [
      { user_id: "user-a", business_id: sharedBusiness },
    ],
  });
  await assert.doesNotReject(() => assertTaxBusinessAccess({
    req: { user: { id: "user-a" } },
    businessId: businessA,
    supabase,
  }));
  await assert.doesNotReject(() => assertTaxBusinessAccess({
    req: { user: { id: "user-a" } },
    businessId: sharedBusiness,
    supabase,
  }));
  await assert.rejects(
    () => assertTaxBusinessAccess({
      req: { user: { id: "user-a" } },
      businessId: businessB,
      supabase,
    }),
    (err) => err.status === 403 && err.code === "business_access_denied"
  );
});

test("security and readiness docs disclose unresolved production blockers", () => {
  const inventory = readFileSync(resolve(process.cwd(), "docs/tax-security-inventory.md"), "utf8");
  const readiness = readFileSync(resolve(process.cwd(), "docs/tax-production-readiness.md"), "utf8");
  assert.match(inventory, /tax_profiles/);
  assert.match(inventory, /assertTaxBusinessAccess/);
  assert.match(readiness, /Not ready for broad real-user launch/);
  assert.match(readiness, /Run `npm run tax:validate-rules/);
});

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) {
      this.headers[key] = value;
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

function makeBusinessSupabase(seed) {
  const rowsByTable = Array.isArray(seed) ? { business_profiles: seed, user_business_link: [] } : seed;
  return {
    from(table) {
      const filters = [];
      return {
        select() { return this; },
        eq(column, value) {
          filters.push([column, value]);
          return this;
        },
        limit() { return this; },
        async maybeSingle() {
          const rows = rowsByTable[table] || [];
          const row = rows.find((item) => filters.every(([column, value]) => item[column] === value)) || null;
          return { data: row, error: null };
        },
      };
    },
  };
}
