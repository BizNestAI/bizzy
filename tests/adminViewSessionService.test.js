import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const {
  ADMIN_VIEW_HEADER,
  createAdminViewHandoff,
  endAdminViewSession,
  getAdminViewSession,
  hashAdminViewToken,
  redeemAdminViewHandoff,
} = await import("../src/services/adminViewSessionService.js");

const STAFF_ID = "00000000-0000-4000-8000-000000000001";
const CUSTOMER_ID = "00000000-0000-4000-8000-000000000002";
const BUSINESS_ID = "00000000-0000-4000-8000-000000000101";
const OTHER_BUSINESS_ID = "00000000-0000-4000-8000-000000000102";
const NOW = new Date("2026-08-23T12:00:00.000Z");

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeDb(overrides = {}) {
  const tables = {
    internal_staff_users: [
      { user_id: STAFF_ID, role: "owner_admin", active: true },
      { user_id: CUSTOMER_ID, role: "customer", active: false },
    ],
    business_profiles: [
      { id: BUSINESS_ID, business_name: "Pat's Landscaping" },
      { id: OTHER_BUSINESS_ID, business_name: "Other Co" },
    ],
    internal_admin_view_sessions: [],
    ...overrides,
  };
  return {
    tables,
    from(table) {
      return new Query(tables, table);
    },
  };
}

class Query {
  constructor(tables, table) {
    this.tables = tables;
    this.table = table;
    this.filters = [];
    this.pendingInsert = null;
    this.pendingUpdate = null;
    this.limitCount = null;
  }

  select() { return this; }

  eq(column, value) {
    this.filters.push((row) => String(row[column]) === String(value));
    return this;
  }

  is(column, value) {
    this.filters.push((row) => (value === null ? row[column] == null : row[column] === value));
    return this;
  }

  gt(column, value) {
    this.filters.push((row) => String(row[column] || "") > String(value));
    return this;
  }

  lt(column, value) {
    this.filters.push((row) => String(row[column] || "") < String(value));
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  insert(payload) {
    this.pendingInsert = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  update(payload) {
    this.pendingUpdate = payload;
    return this;
  }

  maybeSingle() {
    const rows = this.execute();
    return Promise.resolve({ data: rows[0] ? clone(rows[0]) : null, error: null });
  }

  single() {
    const rows = this.execute();
    return Promise.resolve({ data: rows[0] ? clone(rows[0]) : null, error: rows[0] ? null : new Error("not found") });
  }

  then(resolve) {
    const rows = this.execute();
    return resolve({ data: clone(rows), error: null });
  }

  execute() {
    if (!this.tables[this.table]) this.tables[this.table] = [];
    if (this.pendingInsert) {
      const inserted = this.pendingInsert.map((row) => {
        const copy = { id: row.id || nextId(this.table, this.tables[this.table].length + 1), ...clone(row) };
        this.tables[this.table].push(copy);
        return copy;
      });
      return inserted;
    }

    let rows = this.rows();
    if (this.pendingUpdate) {
      rows.forEach((row) => Object.assign(row, clone(this.pendingUpdate)));
    }
    return rows;
  }

  rows() {
    let rows = this.tables[this.table] || [];
    for (const filter of this.filters) rows = rows.filter(filter);
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    return rows;
  }
}

function nextId(table, offset) {
  if (table === "internal_admin_view_sessions") {
    return `50000000-0000-4000-8000-${String(offset).padStart(12, "0")}`;
  }
  return `90000000-0000-4000-8000-${String(offset).padStart(12, "0")}`;
}

async function createAndRedeem(db = makeDb(), options = {}) {
  const handoff = await createAdminViewHandoff({
    staffUserId: STAFF_ID,
    staffRole: "owner_admin",
    businessId: BUSINESS_ID,
    db,
    now: NOW,
    ...options,
  });
  const redeemed = await redeemAdminViewHandoff({
    token: handoff.handoffToken,
    db,
    now: new Date("2026-08-23T12:01:00.000Z"),
  });
  return { db, handoff, redeemed };
}

test("migration creates service-role-only internal admin view session storage", () => {
  const migration = read("supabase/migrations/20260912_internal_admin_view_sessions.sql");

  assert.match(migration, /create table if not exists public\.internal_admin_view_sessions/i);
  assert.match(migration, /staff_user_id uuid not null references auth\.users\(id\)/i);
  assert.match(migration, /business_id uuid not null references public\.business_profiles\(id\)/i);
  assert.match(migration, /handoff_token_hash text/i);
  assert.match(migration, /session_token_hash text/i);
  assert.match(migration, /read_only boolean not null default true/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table public\.internal_admin_view_sessions from public, anon, authenticated/i);
  assert.match(migration, /grant all on table public\.internal_admin_view_sessions to service_role/i);
  assert.doesNotMatch(migration, /create policy/i);
});

test("active monthly review staff roles can mint hashed one-time handoffs", async () => {
  for (const role of ["owner_admin", "accountant", "operator"]) {
    const db = makeDb({
      internal_staff_users: [{ user_id: STAFF_ID, role, active: true }],
      business_profiles: [{ id: BUSINESS_ID, business_name: "Pat's Landscaping" }],
      internal_admin_view_sessions: [],
    });
    const result = await createAdminViewHandoff({
      staffUserId: STAFF_ID,
      staffRole: role,
      businessId: BUSINESS_ID,
      returnUrl: "/monthly-review",
      ip: "127.0.0.1",
      userAgent: "test",
      db,
      now: NOW,
    });

    const row = db.tables.internal_admin_view_sessions[0];
    assert.equal(result.ok, true);
    assert.equal(row.staff_role, role);
    assert.equal(row.business_id, BUSINESS_ID);
    assert.equal(row.read_only, true);
    assert.notEqual(row.handoff_token_hash, result.handoffToken);
    assert.equal(row.handoff_token_hash, hashAdminViewToken(result.handoffToken));
    assert.equal(row.session_token_hash, undefined);
  }
});

test("ordinary customers, inactive staff, and missing businesses cannot mint handoffs", async () => {
  await assert.rejects(
    () => createAdminViewHandoff({ staffUserId: CUSTOMER_ID, businessId: BUSINESS_ID, db: makeDb(), now: NOW }),
    (err) => err.code === "admin_view_staff_not_allowed"
  );
  await assert.rejects(
    () => createAdminViewHandoff({
      staffUserId: STAFF_ID,
      businessId: BUSINESS_ID,
      db: makeDb({ internal_staff_users: [{ user_id: STAFF_ID, role: "owner_admin", active: false }] }),
      now: NOW,
    }),
    (err) => err.code === "admin_view_staff_not_allowed"
  );
  await assert.rejects(
    () => createAdminViewHandoff({ staffUserId: STAFF_ID, businessId: "00000000-0000-4000-8000-000000000999", db: makeDb(), now: NOW }),
    (err) => err.code === "admin_view_business_not_found"
  );
});

test("handoff redemption is single-use, expiry-bound, and mints a distinct active session token", async () => {
  const db = makeDb();
  const handoff = await createAdminViewHandoff({
    staffUserId: STAFF_ID,
    staffRole: "owner_admin",
    businessId: BUSINESS_ID,
    handoffTtlSeconds: 120,
    db,
    now: NOW,
  });
  const redeemed = await redeemAdminViewHandoff({
    token: handoff.handoffToken,
    db,
    now: new Date("2026-08-23T12:01:00.000Z"),
  });

  const row = db.tables.internal_admin_view_sessions[0];
  assert.equal(redeemed.ok, true);
  assert.notEqual(redeemed.adminViewSessionToken, handoff.handoffToken);
  assert.equal(row.session_token_hash, hashAdminViewToken(redeemed.adminViewSessionToken));
  assert.equal(row.business_id, BUSINESS_ID);
  assert.equal(redeemed.context.business_id, BUSINESS_ID);
  assert.equal(redeemed.context.read_only, true);

  await assert.rejects(
    () => redeemAdminViewHandoff({ token: handoff.handoffToken, db, now: new Date("2026-08-23T12:01:30.000Z") }),
    (err) => err.code === "admin_view_handoff_used"
  );

  const expired = await createAdminViewHandoff({
    staffUserId: STAFF_ID,
    staffRole: "owner_admin",
    businessId: BUSINESS_ID,
    handoffTtlSeconds: 1,
    db,
    now: NOW,
  });
  await assert.rejects(
    () => redeemAdminViewHandoff({ token: expired.handoffToken, db, now: new Date("2026-08-23T12:00:02.000Z") }),
    (err) => err.code === "admin_view_handoff_expired"
  );
});

test("active session context is fixed to one business and invalidates on expiry, end, revoke, or staff deactivation", async () => {
  const { db, redeemed } = await createAndRedeem();

  const active = await getAdminViewSession({
    token: redeemed.adminViewSessionToken,
    db,
    now: new Date("2026-08-23T12:02:00.000Z"),
    touch: true,
  });
  assert.equal(active.context.business_id, BUSINESS_ID);
  assert.equal(active.context.business_name, "Pat's Landscaping");
  assert.equal(active.context.admin_view, true);
  assert.equal(active.context.read_only, true);

  const attemptedSwitch = await getAdminViewSession({
    token: redeemed.adminViewSessionToken,
    businessId: OTHER_BUSINESS_ID,
    db,
    now: new Date("2026-08-23T12:02:30.000Z"),
  });
  assert.equal(attemptedSwitch.context.business_id, BUSINESS_ID);
  assert.equal(attemptedSwitch.context.business_name, "Pat's Landscaping");

  db.tables.internal_admin_view_sessions[0].expires_at = "2026-08-23T12:02:59.000Z";
  await assert.rejects(
    () => getAdminViewSession({ token: redeemed.adminViewSessionToken, db, now: new Date("2026-08-23T12:03:00.000Z") }),
    (err) => err.code === "admin_view_session_expired"
  );
  db.tables.internal_admin_view_sessions[0].expires_at = "2026-08-23T16:01:00.000Z";

  db.tables.internal_admin_view_sessions[0].revoked_at = "2026-08-23T12:03:00.000Z";
  await assert.rejects(
    () => getAdminViewSession({ token: redeemed.adminViewSessionToken, db, now: new Date("2026-08-23T12:03:01.000Z") }),
    (err) => err.code === "admin_view_session_revoked"
  );
  db.tables.internal_admin_view_sessions[0].revoked_at = null;

  db.tables.internal_staff_users[0].active = false;
  await assert.rejects(
    () => getAdminViewSession({ token: redeemed.adminViewSessionToken, db, now: new Date("2026-08-23T12:03:02.000Z") }),
    (err) => err.code === "admin_view_staff_not_allowed"
  );
});

test("end endpoint semantics are idempotent and do not return raw token hashes", async () => {
  const { db, handoff, redeemed } = await createAndRedeem();

  const first = await endAdminViewSession({
    token: redeemed.adminViewSessionToken,
    db,
    now: new Date("2026-08-23T12:05:00.000Z"),
  });
  const second = await endAdminViewSession({
    token: redeemed.adminViewSessionToken,
    db,
    now: new Date("2026-08-23T12:05:01.000Z"),
  });

  assert.equal(first.ended, true);
  assert.equal(second.ended, true);
  assert.equal(db.tables.internal_admin_view_sessions[0].ended_at, "2026-08-23T12:05:00.000Z");
  assert.doesNotMatch(JSON.stringify(handoff.context), /token_hash|session_token_hash|handoff_token_hash/);
  assert.doesNotMatch(JSON.stringify(redeemed.context), /token_hash|session_token_hash|handoff_token_hash/);
});

test("server routes keep mint admin-only, app redeem token-only, and CORS narrowly allows admin-view header", () => {
  const mintRoute = read("src/api/admin/customerView.routes.js");
  const redeemRoute = read("src/api/adminView/adminView.routes.js");
  const server = read("src/server.js");

  assert.match(mintRoute, /router\.use\(requireAuth\)/);
  assert.match(mintRoute, /router\.use\(requireInternalRole\(MONTHLY_REVIEW_STAFF_ROLES\)\)/);
  assert.match(mintRoute, /\/api\/admin\/customer-view\/sessions/);
  assert.match(mintRoute, /createAdminViewHandoff/);
  assert.match(mintRoute, /handoff_url/);
  assert.doesNotMatch(mintRoute, /business_id.*searchParams\.set/);

  assert.match(redeemRoute, /router\.post\("\/redeem"/);
  assert.match(redeemRoute, /router\.get\("\/context"/);
  assert.match(redeemRoute, /router\.post\("\/end"/);
  assert.match(redeemRoute, /extractAdminViewToken/);
  assert.doesNotMatch(redeemRoute, /requireBusinessAccess/);

  assert.match(server, /"https:\/\/app\.bizzios\.com"/);
  assert.match(server, /"https:\/\/admin\.bizzios\.com"/);
  assert.match(server, /x-bizzi-admin-view/);
  assert.match(server, /app\.use\("\/api\/admin\/customer-view", customerViewAdminRouter\)/);
  assert.match(server, /app\.use\("\/api\/admin-view", adminViewRouter\)/);
  assert.equal(ADMIN_VIEW_HEADER, "x-bizzi-admin-view");
});

test("Phase 5C-2 wires Admin View only into verified business-scoped customer route groups", () => {
  const server = read("src/server.js");
  const tenantAuth = read("src/api/_shared/tenantAuth.js");
  const requireAuthSource = read("src/api/gpt/middlewares/requireAuth.js");
  const gptRoutes = read("src/api/gpt/brain/gpt.routes.js");
  const calendarRoutes = read("src/api/calendar/calendar.routes.js");
  const insightsRoutes = read("src/api/insights/insights.routes.js");

  assert.match(tenantAuth, /export function requireAuthOrAdminView/);
  assert.match(tenantAuth, /export function rejectAdminViewWrites/);
  assert.match(tenantAuth, /getAdminViewSession/);
  assert.match(tenantAuth, /ADMIN_VIEW_BUSINESS_MISMATCH/);
  assert.match(tenantAuth, /ADMIN_VIEW_READ_ONLY/);
  assert.match(requireAuthSource, /req\.tenantContext\?\.mode === 'admin_view'/);

  for (const route of [
    "/api/chats",
    "/api/accounting/metrics",
    "/api/accounting/pulse",
    "/api/accounting/forecast",
    "/api/accounting",
    "/api/qbo",
    "/api/ar",
    "/api/bookkeeping",
    "/api/marketing",
    "/api/jobs",
    "/api/job-costing",
    "/api/integrations/plaid",
    "/api/reviews",
    "/api/docs",
    "/api/tax",
  ]) {
    assert.match(server, new RegExp(`app\\.use\\("${route.replaceAll("/", "\\/")}", \\.\\.\\.requireCustomerOrAdminView`));
  }

  assert.match(gptRoutes, /const privateBusinessRoute = \[requireAuthOrAdminView, requireBusinessAccess\(\), rejectAdminViewWrites\(\)\]/);
  assert.match(calendarRoutes, /const privateBusinessRoute = \[requireAuthOrAdminView, requireBusinessAccess\(\), rejectAdminViewWrites\(\)\]/);
  assert.match(insightsRoutes, /const privateBusinessRoute = \[requireAuthOrAdminView, requireBusinessAccess\(\), rejectAdminViewWrites\(\)\]/);
  assert.match(server, /app\.use\("\/api\/admin-view", adminViewRouter\)/);
  assert.doesNotMatch(server, /app\.use\("\/api\/admin-view", \.\.\.requireCustomerOrAdminView/);
});
