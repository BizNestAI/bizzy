/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const entitlementModule = await import("../src/api/_shared/entitlementAuth.js");
const plaidStateModule = await import("../src/services/plaid/plaidLinkStateService.js");
const {
  ENTITLEMENT_CAPABILITIES,
  capabilitiesForEntitlement,
  normalizeEntitlementStatus,
  requireEntitlementCapability,
  resolveBusinessEntitlement,
} = entitlementModule;
const { consumePlaidLinkState, plaidClientUserId } = plaidStateModule;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function billingDb(row, error = null) {
  return {
    from(table) {
      assert.equal(table, "business_billing");
      return {
        select() { return this; },
        eq(column, value) {
          assert.equal(column, "business_id");
          assert.equal(value, "business-a");
          return this;
        },
        async maybeSingle() { return { data: row, error }; },
      };
    },
  };
}

test("entitlement matrix is fail-closed and active/trialing are the only paid states", () => {
  for (const status of ["active", "trialing"]) {
    const caps = capabilitiesForEntitlement({ status, role: "owner" });
    assert.equal(caps.has(ENTITLEMENT_CAPABILITIES.FINANCIAL_WRITE), true);
    assert.equal(caps.has(ENTITLEMENT_CAPABILITIES.INTEGRATION_ADMIN), true);
  }
  for (const status of ["past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "free", "missing", "surprise"]) {
    const caps = capabilitiesForEntitlement({ status, role: "owner" });
    assert.equal(caps.has(ENTITLEMENT_CAPABILITIES.HISTORICAL_READ), true);
    assert.equal(caps.has(ENTITLEMENT_CAPABILITIES.FINANCIAL_WRITE), false);
    assert.equal(caps.has(ENTITLEMENT_CAPABILITIES.PROVIDER_DISCONNECT), true);
  }
  assert.equal(normalizeEntitlementStatus("surprise"), "unknown");
  assert.equal(capabilitiesForEntitlement({ status: "active", role: "staff" }).has(ENTITLEMENT_CAPABILITIES.INTEGRATION_ADMIN), false);
  assert.equal(capabilitiesForEntitlement({ status: "active", role: "admin" }).has(ENTITLEMENT_CAPABILITIES.INTEGRATION_ADMIN), false);
  assert.equal(capabilitiesForEntitlement({ status: "active", role: "admin" }).has(ENTITLEMENT_CAPABILITIES.BILLING_ADMIN), false);
});

test("runtime ignores legacy billing fields after canonical migration", async () => {
  const entitlement = await resolveBusinessEntitlement({
    businessId: "business-a",
    role: "owner",
    mode: "live",
    db: billingDb({
      business_id: "business-a",
      subscription_status: "active",
      stripe_subscription_id: "sub_legacy",
      subscription_status_live: null,
      stripe_subscription_id_live: null,
    }),
  });
  assert.equal(entitlement.status, "missing");
  assert.equal(entitlement.subscriptionId, null);
  assert.equal(entitlement.capabilities.has(ENTITLEMENT_CAPABILITIES.PAID_COMPUTE), false);
});

test("paid middleware authorizes by server-side business entitlement, never request billing fields", async () => {
  const middleware = requireEntitlementCapability(ENTITLEMENT_CAPABILITIES.FINANCIAL_WRITE, {
    mode: "live",
    db: billingDb({ business_id: "business-a", subscription_status_live: "past_due" }),
  });
  const req = {
    headers: { "x-correlation-id": "request-12345678" },
    body: { subscription_status: "active", is_paid: true },
    business: { id: "business-a", membershipRole: "owner" },
    tenantContext: {},
  };
  const res = responseRecorder();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.entitlement_status, "past_due");
  assert.equal(res.body.correlation_id, "request-12345678");
});

test("admin view cannot mutate even when the target business is paid", async () => {
  const middleware = requireEntitlementCapability(ENTITLEMENT_CAPABILITIES.FINANCIAL_WRITE, {
    mode: "live",
    db: billingDb({ subscription_status_live: "active" }),
  });
  const res = responseRecorder();
  await middleware({ headers: {}, tenantContext: { mode: "admin_view", businessId: "business-a" } }, res, () => assert.fail("must not continue"));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "admin_view_read_only");
});

test("Plaid client identity is opaque, business-specific, and link state is bound to business and user", async () => {
  const first = plaidClientUserId({ businessId: "business-a", userId: "user-a" });
  const second = plaidClientUserId({ businessId: "business-b", userId: "user-a" });
  assert.notEqual(first, second);
  assert.equal(first.includes("business-a"), false);

  const calls = [];
  const db = {
    from() {
      return {
        update() { return this; },
        eq(column, value) { calls.push(["eq", column, value]); return this; },
        is(column, value) { calls.push(["is", column, value]); return this; },
        gt(column, value) { calls.push(["gt", column, value]); return this; },
        select() { return this; },
        async maybeSingle() { return { data: { id: "state-row" }, error: null }; },
      };
    },
  };
  await consumePlaidLinkState({ state: "opaque-state", businessId: "business-a", userId: "user-a", db, now: new Date("2026-10-01T12:00:00Z") });
  assert.deepEqual(calls.filter((entry) => entry[0] === "eq").map((entry) => entry[1]), ["provider", "state_hash", "business_id", "user_id"]);
  assert.equal(calls.some((entry) => entry[0] === "is" && entry[1] === "used_at"), true);
  assert.equal(calls.some((entry) => entry[0] === "gt" && entry[1] === "expires_at"), true);
});

test("migrations enforce subscription and provider cardinality and revoke browser billing writes", () => {
  const billing = fs.readFileSync(path.join(root, "supabase/migrations/20261101090000_business_entitlement_authority.sql"), "utf8");
  const providers = fs.readFileSync(path.join(root, "supabase/migrations/20261101091000_provider_business_integrity.sql"), "utf8");
  assert.match(billing, /unique index[\s\S]*stripe_subscription_id_live/i);
  assert.match(billing, /legacy\/live Stripe subscription reused across businesses/i);
  assert.match(billing, /set stripe_customer_id_live = stripe_customer_id/i);
  assert.match(billing, /revoke insert, update, delete/i);
  assert.match(billing, /drop policy if exists business_billing_member_read/i);
  assert.match(billing, /prevent_stale_stripe_entitlement_update/i);
  assert.match(providers, /quickbooks_tokens_active_realm_env_uidx|prevent_uncontrolled_qbo_realm_change/i);
  assert.match(providers, /plaid_items_active_env_item_uidx/i);
  assert.match(providers, /plaid_accounts_business_env_item_fkey/i);
});

test("paid Bizzy Insight mount uses canonical tenant and paid-compute middleware", () => {
  const server = fs.readFileSync(path.join(root, "src/server.js"), "utf8");
  assert.match(server, /\/api\/gpt\/brain\/bizzyInsight[\s\S]{0,300}requireCustomerOrAdminView[\s\S]{0,300}PAID_COMPUTE/);
});

test("Plaid Item upsert uses the migrated business/environment/item key", () => {
  const service = fs.readFileSync(path.join(root, "src/services/plaid/plaidIntegrationService.js"), "utf8");
  assert.match(service, /onConflict:\s*["']business_id,plaid_env,plaid_item_id["']/);
});
