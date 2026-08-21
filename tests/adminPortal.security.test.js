import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

const {
  requireInternalRole,
  resolveInternalStaff,
  MONTHLY_REVIEW_STAFF_ROLES,
} = await import("../src/api/_shared/internalStaffAuth.js");
const {
  getAdminRoutePath,
  resolveApplicationSurface,
} = await import("../src/utils/applicationSurface.js");

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("internal staff middleware denies unauthenticated requests with 401", async () => {
  const req = makeReq();
  const res = makeRes();
  let nextCalled = false;

  await requireInternalRole(MONTHLY_REVIEW_STAFF_ROLES, { supabase: makeStaffSupabase([]) })(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
});

test("authenticated ordinary customers and inactive staff receive 403", async () => {
  for (const rows of [
    [],
    [{ user_id: USER_A, role: "owner_admin", active: false }],
  ]) {
    const req = makeReq({ auth: { userId: USER_A } });
    const res = makeRes();
    await requireInternalRole(MONTHLY_REVIEW_STAFF_ROLES, { supabase: makeStaffSupabase(rows) })(req, res, () => {});

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "FORBIDDEN_INTERNAL_STAFF_ONLY");
    assert.equal(req.internalStaff, undefined);
  }
});

test("active owner_admin staff is allowed and attached to request state", async () => {
  const req = makeReq({ auth: { userId: USER_A } });
  const res = makeRes();
  let nextCalled = false;

  await requireInternalRole(MONTHLY_REVIEW_STAFF_ROLES, {
    supabase: makeStaffSupabase([{ user_id: USER_A, role: "owner_admin", active: true }]),
  })(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(req.internalStaff.userId, USER_A);
  assert.equal(req.auth.internalStaffRole, "owner_admin");
});

test("unsupported staff role is denied for monthly review", async () => {
  const req = makeReq({ auth: { userId: USER_A } });
  const res = makeRes();

  await requireInternalRole(MONTHLY_REVIEW_STAFF_ROLES, {
    supabase: makeStaffSupabase([{ user_id: USER_A, role: "viewer", active: true }]),
  })(req, res, () => {});

  assert.equal(res.statusCode, 403);
});

test("client headers and user metadata cannot spoof internal staff authorization", async () => {
  const spoofedReq = makeReq({
    auth: { userId: USER_A },
    user: {
      id: USER_A,
      raw: { user_metadata: { role: "owner_admin", is_admin: true } },
    },
    headers: {
      "x-user-id": USER_B,
      "x-admin-role": "owner_admin",
    },
  });

  await assert.rejects(
    () => resolveInternalStaff({
      req: spoofedReq,
      roles: MONTHLY_REVIEW_STAFF_ROLES,
      supabase: makeStaffSupabase([{ user_id: USER_B, role: "owner_admin", active: true }]),
    }),
    (err) => err.code === "FORBIDDEN_INTERNAL_STAFF_ONLY" && err.status === 403
  );
});

test("internal staff lookup is keyed to authenticated Supabase user id", async () => {
  const staff = await resolveInternalStaff({
    req: makeReq({
      auth: { userId: USER_A },
      headers: { "x-user-id": USER_B },
    }),
    roles: MONTHLY_REVIEW_STAFF_ROLES,
    supabase: makeStaffSupabase([
      { user_id: USER_A, role: "operator", active: true },
      { user_id: USER_B, role: "owner_admin", active: true },
    ]),
  });

  assert.equal(staff.userId, USER_A);
  assert.equal(staff.role, "operator");
});

test("admin portal migration is durable and not customer writable", () => {
  const migration = read("supabase/migrations/20260908_internal_staff_users.sql");

  assert.match(migration, /create table if not exists public\.internal_staff_users/);
  assert.match(migration, /user_id uuid primary key references auth\.users\(id\) on delete cascade/);
  assert.match(migration, /role text not null/);
  assert.match(migration, /active boolean not null default true/);
  assert.match(migration, /check \(role in \('owner_admin', 'accountant', 'operator'\)\)/);
  assert.match(migration, /alter table public\.internal_staff_users enable row level security/);
  assert.match(migration, /revoke all on table public\.internal_staff_users from public, anon, authenticated/);
  assert.match(migration, /grant all on table public\.internal_staff_users to service_role/);
});

test("admin backend routes use staff authorization before service-role monthly review handlers", () => {
  const monthly = read("src/api/admin/monthlyReview.routes.js");
  const authIndex = monthly.indexOf("router.use(requireAuth)");
  const staffIndex = monthly.indexOf("router.use(requireInternalRole(MONTHLY_REVIEW_STAFF_ROLES))");
  const firstHandlerIndex = monthly.indexOf("router.get(\"/me\"");
  const firstBusinessQueryIndex = monthly.indexOf(".from(\"business_profiles\")");

  assert.ok(authIndex > 0);
  assert.ok(staffIndex > authIndex);
  assert.ok(firstHandlerIndex > staffIndex);
  assert.ok(firstBusinessQueryIndex > staffIndex);
  assert.doesNotMatch(monthly.slice(0, staffIndex), /\.from\("/);
});

test("/api/admin/me is server-authorized and mounted before monthly review", () => {
  const adminRoutes = read("src/api/admin/admin.routes.js");
  const server = read("src/server.js");

  assert.match(adminRoutes, /router\.get\("\/me", requireAuth, requireInternalStaff\(\)/);
  assert.match(adminRoutes, /staff:\s*\{[\s\S]*role: req\.internalStaff\.role/);
  assert.ok(server.indexOf("app.use(\"/api/admin\", adminRouter)") < server.indexOf("app.use(\"/api/admin/monthly-review\", monthlyReviewAdminRouter)"));
});

test("CORS allows admin origin without wildcarding random production origins", () => {
  const server = read("src/server.js");
  const allowlistBody = server.slice(server.indexOf("const allowlist ="), server.indexOf("const allowAll"));

  assert.match(allowlistBody, /"https:\/\/app\.bizzios\.com"/);
  assert.match(allowlistBody, /"https:\/\/admin\.bizzios\.com"/);
  assert.doesNotMatch(allowlistBody, /"https:\/\/evil\.example\.com"/);
  assert.doesNotMatch(allowlistBody, /"\*"/);
  assert.match(server, /"Content-Type", "Authorization", "x-data-mode", "x-debug", "x-user-id", "x-business-id"/);
});

test("application surface and admin route targets split production and localhost paths", () => {
  assert.equal(resolveApplicationSurface("admin.bizzios.com"), "admin");
  assert.equal(resolveApplicationSurface("app.bizzios.com"), "customer");
  assert.equal(resolveApplicationSurface("localhost"), "development");
  assert.equal(getAdminRoutePath("login", "admin"), "/login");
  assert.equal(getAdminRoutePath("monthlyReview", "admin"), "/monthly-review");
  assert.equal(getAdminRoutePath("login", "development"), "/admin/login");
  assert.equal(getAdminRoutePath("monthlyReview", "development"), "/admin/monthly-review");
});

test("frontend route tree keeps production customer and admin surfaces separated", () => {
  const main = read("src/main.jsx");

  assert.match(main, /const renderCustomerRoutes = applicationSurface !== "admin"/);
  assert.match(main, /const renderAdminRoutes = applicationSurface === "admin" \|\| applicationSurface === "development"/);
  assert.match(main, /path=\{getAdminRoutePath\("login", applicationSurface\)\} element=\{<AdminLogin \/>}/);
  assert.match(main, /path=\{getAdminRoutePath\("monthlyReview", applicationSurface\)\}/);
  assert.match(main, /renderDevelopmentAdminRoutes && \(/);
  assert.doesNotMatch(main, /<Route path="admin\/monthly-review" element=\{<MonthlyReviewConsole \/>}/);
  assert.match(main, /<MonthlyReviewConsole \/>/);
});

test("admin login and protected route use server-verified staff state and surface-aware redirects", () => {
  const login = read("src/pages/Admin/AdminLogin.jsx");
  const guard = read("src/components/Admin/AdminProtectedRoute.jsx");

  assert.match(login, /login\(\{ email, password \}\)/);
  assert.match(login, /safeFetch\("\/api\/admin\/me"/);
  assert.match(login, /navigate\(getAdminRoutePath\("monthlyReview", applicationSurface\)/);
  assert.match(login, /This account does not have access to the Bizzi internal workspace/);
  assert.match(guard, /safeFetch\("\/api\/admin\/me"/);
  assert.match(guard, /Navigate to=\{getAdminRoutePath\("login", applicationSurface\)\}/);
  assert.match(guard, /logout\(\)/);
});

test("admin confirmation and reset continuations are production-admin surface aware", () => {
  const confirmation = read("src/pages/UserAdmin/EmailConfirmation.jsx");
  const reset = read("src/pages/UserAdmin/ResetPassword.jsx");

  assert.match(confirmation, /isProductionAdminSurface\(applicationSurface\)/);
  assert.match(confirmation, /getAdminRoutePath\("monthlyReview", applicationSurface\)/);
  assert.match(confirmation, /getAdminRoutePath\("login", applicationSurface\)/);
  assert.match(reset, /const loginPath = isProductionAdminSurface\(applicationSurface\) \? getAdminRoutePath\("login", applicationSurface\) : "\/login"/);
  assert.match(reset, /to=\{loginPath\}/);
});

test("MonthlyReviewConsole remains the single reused admin monthly review implementation", () => {
  const main = read("src/main.jsx");
  const monthlyUi = read("src/pages/Admin/MonthlyReviewConsole.jsx");

  assert.equal((main.match(/<MonthlyReviewConsole \/>/g) || []).length, 2);
  assert.match(monthlyUi, /safeFetch\(`\/api\/admin\/monthly-review\/businesses/);
  assert.doesNotMatch(read("src/pages/Admin/AdminLogin.jsx"), /transaction_categorizations|bank_transactions|clarification_requests/);
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

function makeStaffSupabase(rows = []) {
  return {
    from(table) {
      assert.equal(table, "internal_staff_users");
      return new Query(rows);
    },
  };
}

class Query {
  constructor(rows) {
    this.rows = rows;
    this.filters = [];
  }

  select() {
    return this;
  }

  eq(field, value) {
    this.filters.push((row) => String(row[field]) === String(value));
    return this;
  }

  maybeSingle() {
    const row = this.rows.find((candidate) => this.filters.every((filter) => filter(candidate)));
    return Promise.resolve({ data: row ? { ...row } : null, error: null });
  }
}
