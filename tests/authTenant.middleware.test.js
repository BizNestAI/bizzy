import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
delete process.env.BIZZY_AUTH_BYPASS;

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
const BUSINESS_B = "22222222-2222-4222-8222-222222222222";
const BUSINESS_SHARED = "33333333-3333-4333-8333-333333333333";
const BUSINESS_MISSING = "44444444-4444-4444-8444-444444444444";

const authMod = await import("../src/api/gpt/middlewares/requireAuth.js");
const tenantMod = await import("../src/api/_shared/tenantAuth.js");

const { requireAuth, __setRequireAuthTestDeps } = authMod;
const {
  getRequestedBusinessId,
  requireBusinessAccess,
  resolveAuthorizedBusiness,
  TENANT_AUTH_CODES,
} = tenantMod;

test.afterEach(() => {
  __setRequireAuthTestDeps(null);
});

test("BIZZY_AUTH_BYPASS cannot load in production", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "await import('./src/api/gpt/middlewares/requireAuth.js')"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "production",
        BIZZY_AUTH_BYPASS: "true",
        SUPABASE_URL: "http://127.0.0.1:54321",
        SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      },
      encoding: "utf8",
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /BIZZY_AUTH_BYPASS cannot be enabled in production/);
});

test("missing Authorization token fails closed with 401", async () => {
  const req = makeReq();
  const res = makeRes();
  let nextCalled = false;

  await requireAuth(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
});

test("invalid Authorization token fails closed with 401", async () => {
  __setRequireAuthTestDeps({
    verifyToken: async () => {
      const err = new Error("bad token");
      err.code = "token-invalid";
      throw err;
    },
  });

  const req = makeReq({ headers: { authorization: "Bearer invalid" } });
  const res = makeRes();
  let nextCalled = false;

  await requireAuth(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "AUTH_INVALID");
});

test("authenticated user identity is canonical and ignores x-user-id", async () => {
  __setRequireAuthTestDeps({
    verifyToken: async () => ({ userId: USER_A, email: "a@example.com", role: "authenticated" }),
  });

  const req = makeReq({
    headers: { authorization: "Bearer valid", "x-user-id": USER_B },
  });
  const res = makeRes();

  await requireAuth(req, res, () => {});

  assert.equal(req.auth.userId, USER_A);
  assert.equal(req.user.id, USER_A);
  assert.equal(req.user.business_id, undefined);
});

test("authenticated user can access their own business", async () => {
  const req = makeReq({
    auth: { userId: USER_A },
    query: { business_id: BUSINESS_A },
  });
  const res = makeRes();
  const supabase = makeTenantSupabase({
    business_profiles: [
      { id: BUSINESS_A, user_id: USER_A, business_name: "A" },
      { id: BUSINESS_B, user_id: USER_B, business_name: "B" },
    ],
    user_business_link: [],
  });
  let nextCalled = false;

  await requireBusinessAccess({ supabase })(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.business.id, BUSINESS_A);
  assert.equal(req.auth.businessId, BUSINESS_A);
  assert.equal(req.user.business_id, BUSINESS_A);
});

test("cross-tenant business_id is denied for authenticated User A", async () => {
  const req = makeReq({
    auth: { userId: USER_A },
    query: { business_id: BUSINESS_B },
  });
  const res = makeRes();
  const supabase = makeTenantSupabase({
    business_profiles: [
      { id: BUSINESS_A, user_id: USER_A },
      { id: BUSINESS_B, user_id: USER_B },
    ],
    user_business_link: [],
  });

  await requireBusinessAccess({ supabase })(req, res, () => {});

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, TENANT_AUTH_CODES.BUSINESS_ACCESS_DENIED);
  assert.equal(req.business, undefined);
});

test("x-business-id for another user's business is denied", async () => {
  const req = makeReq({
    auth: { userId: USER_A },
    headers: { "x-business-id": BUSINESS_B },
  });
  const res = makeRes();
  const supabase = makeTenantSupabase({
    business_profiles: [
      { id: BUSINESS_A, user_id: USER_A },
      { id: BUSINESS_B, user_id: USER_B },
    ],
    user_business_link: [],
  });

  await requireBusinessAccess({ supabase })(req, res, () => {});

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, TENANT_AUTH_CODES.BUSINESS_ACCESS_DENIED);
});

test("x-user-id spoofing does not change authenticated identity or grant business access", async () => {
  __setRequireAuthTestDeps({
    verifyToken: async () => ({ userId: USER_A, email: "a@example.com", role: "authenticated" }),
  });
  const req = makeReq({
    headers: {
      authorization: "Bearer valid",
      "x-user-id": USER_B,
      "x-business-id": BUSINESS_B,
    },
  });
  const authRes = makeRes();
  const tenantRes = makeRes();
  const supabase = makeTenantSupabase({
    business_profiles: [
      { id: BUSINESS_A, user_id: USER_A },
      { id: BUSINESS_B, user_id: USER_B },
    ],
    user_business_link: [],
  });

  await requireAuth(req, authRes, () => {});
  await requireBusinessAccess({ supabase })(req, tenantRes, () => {});

  assert.equal(req.auth.userId, USER_A);
  assert.equal(req.user.id, USER_A);
  assert.equal(tenantRes.statusCode, 403);
});

test("body.business_id and query.business_id for another business are denied", async () => {
  const supabase = makeTenantSupabase({
    business_profiles: [
      { id: BUSINESS_A, user_id: USER_A },
      { id: BUSINESS_B, user_id: USER_B },
    ],
    user_business_link: [],
  });

  for (const req of [
    makeReq({ auth: { userId: USER_A }, body: { business_id: BUSINESS_B } }),
    makeReq({ auth: { userId: USER_A }, query: { business_id: BUSINESS_B } }),
  ]) {
    const res = makeRes();
    await requireBusinessAccess({ supabase })(req, res, () => {});
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, TENANT_AUTH_CODES.BUSINESS_ACCESS_DENIED);
  }
});

test("conflicting business ids fail closed with ambiguous tenant context", () => {
  assert.throws(
    () =>
      getRequestedBusinessId(
        makeReq({
          headers: { "x-business-id": BUSINESS_A },
          query: { business_id: BUSINESS_B },
        })
      ),
    (err) => err.code === TENANT_AUTH_CODES.AMBIGUOUS_BUSINESS_CONTEXT && err.status === 400
  );
});

test("missing requested business where required fails with 400", async () => {
  const req = makeReq({ auth: { userId: USER_A } });
  const res = makeRes();
  await requireBusinessAccess({ supabase: makeTenantSupabase() })(req, res, () => {});

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, TENANT_AUTH_CODES.BUSINESS_REQUIRED);
});

test("deleted or nonexistent business fails with 404", async () => {
  const req = makeReq({
    auth: { userId: USER_A },
    query: { business_id: BUSINESS_MISSING },
  });
  const res = makeRes();
  const supabase = makeTenantSupabase({
    business_profiles: [{ id: BUSINESS_A, user_id: USER_A }],
    user_business_link: [],
  });

  await requireBusinessAccess({ supabase })(req, res, () => {});

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, TENANT_AUTH_CODES.BUSINESS_NOT_FOUND);
});

test("valid multi-business membership authorizes only explicit memberships", async () => {
  const supabase = makeTenantSupabase({
    business_profiles: [
      { id: BUSINESS_A, user_id: USER_A },
      { id: BUSINESS_SHARED, user_id: USER_B },
      { id: BUSINESS_B, user_id: USER_B },
    ],
    user_business_link: [{ user_id: USER_A, business_id: BUSINESS_SHARED }],
  });

  const allowed = await resolveAuthorizedBusiness({
    req: makeReq({ auth: { userId: USER_A } }),
    businessId: BUSINESS_SHARED,
    supabase,
  });
  assert.equal(allowed.id, BUSINESS_SHARED);
  assert.equal(allowed.accessVia, "membership");

  await assert.rejects(
    () =>
      resolveAuthorizedBusiness({
        req: makeReq({ auth: { userId: USER_A } }),
        businessId: BUSINESS_B,
        supabase,
      }),
    (err) => err.code === TENANT_AUTH_CODES.BUSINESS_ACCESS_DENIED && err.status === 403
  );
});

function makeReq(overrides = {}) {
  return {
    method: "GET",
    headers: {},
    params: {},
    query: {},
    body: {},
    ...overrides,
    headers: { ...(overrides.headers || {}) },
    params: { ...(overrides.params || {}) },
    query: { ...(overrides.query || {}) },
    body: { ...(overrides.body || {}) },
    get(name) {
      return this.headers[String(name).toLowerCase()];
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

function makeTenantSupabase(initial = {}) {
  const store = {
    business_profiles: initial.business_profiles || [],
    user_business_link: initial.user_business_link || [],
  };
  return {
    from(table) {
      return new Query(store, table);
    },
  };
}

class Query {
  constructor(store, table) {
    this.store = store;
    this.table = table;
    this.filters = [];
  }

  select() {
    return this;
  }

  eq(field, value) {
    this.filters.push((row) => String(row[field]) === String(value));
    return this;
  }

  limit() {
    return this;
  }

  maybeSingle() {
    const rows = (this.store[this.table] || []).filter((row) =>
      this.filters.every((filter) => filter(row))
    );
    return Promise.resolve({ data: rows[0] || null, error: null });
  }
}
