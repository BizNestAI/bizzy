import test from "node:test";
/* global process */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const {
  ADMIN_BOOKKEEPING_WRITE_CAPABILITY,
  ADMIN_BOOKKEEPING_WRITE_INVENTORY,
  hasAdminBookkeepingWriteCapability,
  matchAdminBookkeepingWrite,
} = await import("../src/services/adminBookkeepingAccess.js");
const { rejectAdminViewWrites, TENANT_AUTH_CODES } = await import("../src/api/_shared/tenantAuth.js");
const {
  ENTITLEMENT_CAPABILITIES,
  requireEntitlementCapability,
} = await import("../src/api/_shared/entitlementAuth.js");

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

function request(method, originalUrl, capabilities = [ADMIN_BOOKKEEPING_WRITE_CAPABILITY]) {
  return {
    method,
    originalUrl,
    headers: {},
    body: { business_id: BUSINESS_ID },
    tenantContext: {
      mode: "admin_view",
      businessId: BUSINESS_ID,
      staffUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      adminViewSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      capabilities,
    },
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader() {},
  };
}

test("capability allowlist permits only explicit Books Review workflow mutations", () => {
  const permitted = [
    ["POST", "/api/bookkeeping/approve"],
    ["POST", "/api/bookkeeping/undo"],
    ["PUT", "/api/bookkeeping/transactions/txn-1/resolution"],
    ["POST", "/api/bookkeeping/credit-card-payments/txn-1/confirm-match"],
    ["POST", "/api/bookkeeping/incoming-deposit-matches/txn-1/match-1/confirm"],
    ["POST", "/api/bookkeeping/transactions/txn-1/exclude"],
    ["POST", "/api/bookkeeping/processing/retry"],
  ];
  for (const [method, path] of permitted) assert.ok(matchAdminBookkeepingWrite(request(method, path)), `${method} ${path}`);

  const prohibited = [
    ["POST", "/api/gpt/chat"],
    ["POST", "/api/billing/checkout"],
    ["POST", "/api/integrations/plaid/disconnect"],
    ["POST", "/api/bookkeeping/qbo/accounts"],
    ["PATCH", "/api/bookkeeping/posting/auto-post"],
    ["POST", "/api/bookkeeping/posting/run"],
    ["POST", "/api/bookkeeping/suggest"],
  ];
  for (const [method, path] of prohibited) assert.equal(matchAdminBookkeepingWrite(request(method, path)), null, `${method} ${path}`);
  assert.ok(ADMIN_BOOKKEEPING_WRITE_INVENTORY.prohibited.includes("chat_and_ai"));
});

test("global Admin View guard grants allowlisted bookkeeping writes only with the server capability", () => {
  const guard = rejectAdminViewWrites();
  for (const capabilities of [[], ["fabricated"], [ADMIN_BOOKKEEPING_WRITE_CAPABILITY]]) {
    const req = request("POST", "/api/bookkeeping/approve", capabilities);
    const res = response();
    let continued = false;
    guard(req, res, () => { continued = true; });
    assert.equal(continued, capabilities.includes(ADMIN_BOOKKEEPING_WRITE_CAPABILITY));
    if (!continued) assert.equal(res.body.code, TENANT_AUTH_CODES.ADMIN_VIEW_READ_ONLY);
  }

  const forbidden = request("POST", "/api/integrations/plaid/disconnect");
  const forbiddenRes = response();
  guard(forbidden, forbiddenRes, () => assert.fail("provider disconnect must stay blocked"));
  assert.equal(forbiddenRes.statusCode, 403);
});

test("paid entitlement is still required for capability-authorized bookkeeping writes", async () => {
  const db = (status) => ({
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: { subscription_status_live: status }, error: null }; },
      };
    },
  });
  for (const [status, expected] of [["active", true], ["trialing", true], ["past_due", false]]) {
    const middleware = requireEntitlementCapability(ENTITLEMENT_CAPABILITIES.FINANCIAL_WRITE, { mode: "live", db: db(status) });
    const req = request("POST", "/api/bookkeeping/approve");
    req.adminBookkeepingAccess = matchAdminBookkeepingWrite(req);
    const res = response();
    let continued = false;
    await middleware(req, res, () => { continued = true; });
    assert.equal(continued, expected, status);
  }
});

test("migration and UI expose bounded bookkeeping access while retaining the read-only base session", () => {
  const migration = read("supabase/migrations/20261003150000_admin_bookkeeping_access.sql");
  const service = read("src/services/adminViewSessionService.js");
  const route = read("src/api/admin/customerView.routes.js");
  const layout = read("src/layout/MainLayout.jsx");
  const chat = read("src/context/BizzyChatContext.jsx");
  assert.match(migration, /capabilities text\[\] not null default/);
  assert.match(migration, /capabilities <@ array\['admin_bookkeeping_write'\]/);
  assert.match(migration, /internal_admin_bookkeeping_audit_events/);
  assert.match(migration, /previous_state jsonb/);
  assert.match(migration, /resulting_state jsonb/);
  assert.match(service, /ADMIN_BOOKKEEPING_SESSION_TTL_SECONDS/);
  assert.match(route, /capabilities: \[ADMIN_BOOKKEEPING_WRITE_CAPABILITY\]/);
  assert.match(layout, /Admin View · Bookkeeping Access/);
  assert.match(layout, /Chat, billing, integrations, memberships, and security settings remain unavailable/);
  assert.match(chat, /admin_view_read_only/);
});

test("capability checks do not trust scalar or unknown client-like values", () => {
  assert.equal(hasAdminBookkeepingWriteCapability({ capabilities: ADMIN_BOOKKEEPING_WRITE_CAPABILITY }), false);
  assert.equal(hasAdminBookkeepingWriteCapability({ capabilities: ["admin"] }), false);
  assert.equal(hasAdminBookkeepingWriteCapability({ capabilities: [ADMIN_BOOKKEEPING_WRITE_CAPABILITY] }), true);
});
