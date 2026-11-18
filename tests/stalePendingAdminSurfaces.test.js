/* global process, global */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import React from "react";
import { create, act } from "react-test-renderer";
import express from "express";
import { invalidatePendingResolutionCaches, refreshPendingResolutionFeeds } from "../src/services/bookkeeping/pendingResolutionFeedRefresh.js";

process.env.SUPABASE_URL = "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "local-test-only";
process.env.QB_PROD_CLIENT_ID = "local-test-only";
process.env.QB_PROD_CLIENT_SECRET = "local-test-only";
process.env.QB_PROD_REDIRECT_URI = "http://127.0.0.1/test";
const { pendingBooksAdminScope, createPendingResolutionRouter, rejectCustomerPendingResolutionRequest } = await import("../src/api/bookkeeping/routes/bookkeeping.pendingResolution.routes.js");
const { requireStatementPendingAdministrator } = await import("../src/api/_shared/statementPendingAdmin.js");
const { confirmPendingSettled, getPendingResolutionContext } = await import("../src/services/bookkeeping/pendingTransactionResolutionService.js");
const { matchAdminBookkeepingWrite } = await import("../src/services/adminBookkeepingAccess.js");
const { __setRequireAuthTestDeps } = await import("../src/api/gpt/middlewares/requireAuth.js");
const STAFF = "00000000-0000-4000-8000-000000000001";
const CUSTOMER = "00000000-0000-4000-8000-000000000002";
const BIZ = "00000000-0000-4000-8000-000000000101";
const OTHER = "00000000-0000-4000-8000-000000000102";
const NEW = "00000000-0000-4000-8000-000000000103";
const TX = "00000000-0000-4000-8000-000000000201";
const row = { id: TX, date: "2026-01-01", pending: true, amount: -10 };
const eligible = { promotion_eligible: true, transaction: { ...row, pending_age_days: 30 } };
const payload = { attested: true, statement_date: row.date, statement_amount: row.amount, idempotency_key: "persistent-operation" };

function fakeDb({ bank = row, category = {}, candidates = [], candidateError = null, block = null, staffActive = true, staffRole = "owner_admin" } = {}) {
  const calls = [], events = new Map();
  return { calls, events,
    from(table) {
      const filters = {};
      const q = { select() { return q; }, eq(k, v) { filters[k] = v; return q; }, neq() { return q; }, order() { return q; }, limit() { return q; },
        async maybeSingle() {
          if (table === "internal_staff_users") return { data: filters.user_id === STAFF ? { user_id: STAFF, role: staffRole, active: staffActive } : null };
          if (table === "pending_transaction_resolution_events") return { data: events.get(filters.idempotency_key) || null };
          if (table === "bank_transactions") return { data: filters.pending === false ? null : bank };
          if (table === "transaction_categorizations") return { data: category };
          return { data: null };
        } };
      return q;
    },
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === "pending_resolution_candidates") return { data: candidates, error: candidateError };
      if (name === "pending_accounting_block") return { data: block };
      assert.equal(name, "resolve_stale_pending_admin");
      // Model the existing guarded operation's actor and durable result contract.
      assert.equal(args.p_actor_user_id, STAFF);
      assert.equal(args.p_attested, true);
      const data = { state: "statement_review_override", transaction_id: args.p_transaction_id, business_id: args.p_business_id, actor_user_id: args.p_actor_user_id, provider_pending: true, status: "needs_review" };
      events.set(args.p_idempotency_key, { id: "event", evidence: { request: { review_month: args.p_review_month }, result: data } });
      return { data };
    },
  };
}
function adminReq(businessId = BIZ) {
  return { auth: { userId: STAFF }, user: { id: CUSTOMER }, params: { transactionId: TX },
    tenantContext: { mode: "admin_view", businessId, staffUserId: STAFF, adminViewSessionId: "verified-opaque-session", capabilities: ["admin_bookkeeping_write"] } };
}

test("verified internal admin covers two unrelated businesses and a future business without business enablement", async () => {
  const db = fakeDb();
  delete process.env.STALE_PENDING_RESOLUTION_ENABLED;
  delete process.env.STALE_PENDING_RESOLUTION_BUSINESS_IDS;
  for (const businessId of [BIZ, OTHER, NEW]) {
    const scope = await pendingBooksAdminScope(adminReq(businessId), db);
    assert.equal(scope.businessId, businessId);
    assert.equal(scope.actor.id, STAFF);
    const evidence = await getPendingResolutionContext({ ...scope, db });
    assert.equal(evidence.promotion_eligible, true);
    assert.equal("feature_enabled" in evidence, false);
    const result = await confirmPendingSettled({ ...scope, db, statementDate: row.date, statementAmount: row.amount,
      attested: true, idempotencyKey: `operation-${businessId}`, month: "2026-01-01" });
    assert.equal(result.business_id, businessId); assert.equal(result.status, "needs_review");
  }
  const authority = fs.readFileSync("src/services/bookkeeping/statementPendingAuthority.js", "utf8");
  assert.doesNotMatch(authority, /process.env|statementPendingAppEnabled|statementPendingActionAllowed/);

});

test("customer owner/admin roles, supplied actors and forged view flags never grant authority", async () => {
  const db = fakeDb();
  for (const role of ["owner", "admin", "owner_admin"]) {
    const req = { ...adminReq(), auth: { userId: CUSTOMER, role }, user: { id: CUSTOMER, role }, body: { actor_id: STAFF }, internalStaff: { userId: STAFF, role: "owner_admin" } };
    await assert.rejects(requireStatementPendingAdministrator(req, db), e => e.status === 403);
    await assert.rejects(pendingBooksAdminScope(req, db), e => e.status === 403);
    let status; let proceeded = false;
    rejectCustomerPendingResolutionRequest({ auth: { userId: CUSTOMER, role } }, { status(code) { status = code; return this; }, json() {} }, () => { proceeded = true; });
    assert.equal(status, 403); assert.equal(proceeded, false);
  }
  await assert.rejects(pendingBooksAdminScope({ ...adminReq(), tenantContext: { mode: "customer", capabilities: ["admin_bookkeeping_write"] } }, db), e => e.status === 403);
  await assert.rejects(pendingBooksAdminScope({ ...adminReq(), tenantContext: { ...adminReq().tenantContext, capabilities: [] } }, db), e => e.status === 403);
  await assert.rejects(pendingBooksAdminScope({ ...adminReq(), auth: { userId: CUSTOMER },
    tenantContext: { ...adminReq().tenantContext, staffUserId: CUSTOMER, staffRole: "owner_admin" } }, db), e => e.status === 403);
  await assert.rejects(pendingBooksAdminScope(adminReq(), fakeDb({ staffActive: false })), e => e.status === 403);
  for (const staffRole of ["operator", "accountant"]) await assert.rejects(pendingBooksAdminScope(adminReq(), fakeDb({ staffRole })), e => e.status === 403);
});

test("Books direct customer tokens return HTTP 403; verified access records the internal actor through the same service", async () => {
  const source = { ...row };
  const db = fakeDb({ bank: source }); const app = express(); app.use(express.json());
  __setRequireAuthTestDeps({ verifyToken: async () => ({ userId: CUSTOMER, role: "owner_admin" }) });
  // Only this synthetic opaque handoff creates server tenant context. A real
  // deployment uses requireAuthOrAdminView + requireBusinessAccess before router.
  app.use((req, res, next) => { if (req.headers["x-test-verified-session"] === "yes") Object.assign(req, adminReq()); next(); });
  app.use("/api/bookkeeping", createPendingResolutionRouter({ db }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/bookkeeping/transactions/${TX}/pending-resolution`;
  try {
    for (const method of ["GET", "POST"]) {
      const result = await fetch(base + (method === "POST" ? "/confirm-settled" : ""), { method, headers: { Authorization: "Bearer ordinary-customer", "Content-Type": "application/json", "x-bizzi-admin-view": "forged", "x-business-id": BIZ }, ...(method === "POST" ? { body: JSON.stringify(payload) } : {}) });
      assert.equal(result.status, 403);
    }
    const direct = await confirmPendingSettled({ businessId: BIZ, transactionId: TX, actor: await requireStatementPendingAdministrator(adminReq(), db), statementDate: row.date, statementAmount: row.amount, attested: true, idempotencyKey: payload.idempotency_key, month: "2026-01-01", db });
    source.date = "2026-02-01"; // Completed replay retains its original month.
    const response = await fetch(base + "/confirm-settled", { method: "POST", headers: { "x-test-verified-session": "yes", "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, actor_id: CUSTOMER }) });
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).result, direct);
    assert.equal(db.events.get(payload.idempotency_key).evidence.result.actor_user_id, STAFF);
    assert.equal(db.calls.filter(c => c.name === "resolve_stale_pending_admin").length, 2);
    assert.equal(db.calls.at(-1).args.p_review_month, "2026-01-01");
    assert.equal(matchAdminBookkeepingWrite({ method: "POST", originalUrl: `/api/bookkeeping/transactions/${TX}/pending-resolution/confirm-settled` }).action, "confirm_stale_pending_statement");
  } finally { await new Promise(resolve => server.close(resolve)); __setRequireAuthTestDeps(null); }
});

test("eligibility hides recent, conflict, removal, replacement, accounting and unknown evidence", async () => {
    assert.equal((await getPendingResolutionContext({ businessId: BIZ, transactionId: TX, db: fakeDb() })).promotion_eligible, true);
    for (const overrides of [
      { bank: { ...row, date: new Date().toISOString().slice(0, 10) } },
      { bank: { ...row, pending_resolution_state: "statement_review_conflict" } },
      { bank: { ...row, is_archived: true } }, { bank: { ...row, archived_reason: "plaid_removed" } },
      { candidates: [{ id: "probable-replacement" }] }, { candidates: [{ id: "one" }, { id: "two" }] },
      { candidateError: { code: "PGRST202" } },
      ...["matched", "excluded", "reconciled", "receipt", "intent", "attempt"].map(block => ({ block })),
    ]) assert.equal((await getPendingResolutionContext({ businessId: BIZ, transactionId: TX, db: fakeDb(overrides) })).promotion_eligible, false);
});

test("Monthly Review and Books render the shared admin action; ordinary sessions never request eligibility", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stale-pending-ui-"));
  fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(temp, "node_modules"), "dir");
  const built = await build({ entryPoints: ["src/components/Accounting/StalePendingAction.jsx"], bundle: true, format: "esm", platform: "node", packages: "external", write: false,
    plugins: [{ name: "inline-test-portal", setup(b) { b.onResolve({ filter: /^react-dom$/ }, () => ({ path: "portal", namespace: "test" })); b.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export const createPortal = children => children;" })); } }] });
  const file = path.join(temp, "action.mjs"); fs.writeFileSync(file, built.outputFiles[0].text);
  const Action = (await import(pathToFileURL(file))).default;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const priorDocument = global.document; global.document = { body: {} };
  try {
    for (const surface of ["monthly-review", "open-bookkeeping-access"]) {
      const calls = []; let component;
      const resolver = async (...args) => { calls.push(args); return args[1] === "load" ? eligible : { state: "statement_review_override" }; };
      await act(async () => { component = create(React.createElement(Action, { row, onResolve: resolver })); });
      const button = component.root.findByType("button"); assert.equal(button.props.children, "Move to Needs Review", surface);
      await act(async () => button.props.onClick());
      const submit = component.root.findAllByType("button").at(-1); assert.equal(submit.props.disabled, true);
      await act(async () => component.root.findAllByType("input").find(x => x.props.type === "checkbox").props.onChange({ target: { checked: true } }));
      await act(async () => component.root.findAllByType("button").at(-1).props.onClick());
      assert.deepEqual(calls.at(-1).slice(1), ["confirm-settled", { attested: true, statement_date: row.date, statement_amount: row.amount }]);
      await act(async () => component.unmount());
    }
    for (const context of [null, { ...eligible, promotion_eligible: false, transaction: { ...row, pending_age_days: 1 } }, { ...eligible, promotion_eligible: false, replacement_found: true }]) {
      let component;
      await act(async () => { component = create(React.createElement(Action, { row, ...(context ? { onResolve: async () => context } : {}) })); });
      assert.equal(component.root.findAllByType("button").length, 0);
      if (context?.transaction?.pending_age_days === 1) assert.equal(component.root.findByType("span").props.title, "Available after seven days");
      await act(async () => component.unmount());
    }
    let replacementComponent; let reviewed = false;
    await act(async () => { replacementComponent = create(React.createElement(Action, { row,
      onResolve: async () => ({ ...eligible, promotion_eligible: false, replacement_found: true }),
      onReviewReplacement: () => { reviewed = true; } })); });
    assert.equal(replacementComponent.root.findByType("button").props.children, "Review replacement");
    await act(async () => replacementComponent.root.findByType("button").props.onClick()); assert.equal(reviewed, true);
    await act(async () => replacementComponent.unmount());
    const mirror = fs.readFileSync("src/components/Accounting/BookkeepingTransactionMirrorTable.jsx", "utf8");
    const feed = fs.readFileSync("src/components/Accounting/BookkeepingFeed.jsx", "utf8");
    const books = fs.readFileSync("src/pages/accounting/BookkeepingCleanup.jsx", "utf8");
    assert.match(mirror, /<StalePendingAction row=\{row\}/);
    assert.match(feed, /<StalePendingAction row=\{txn\} onResolve=\{adminBookkeepingAccess \? onResolvePending : undefined\}/);
    assert.match(books, /onResolvePending=\{adminView.active && adminView.bookkeepingAccess && adminView.staffRole === "owner_admin"/);
    assert.match(books, /invalidatePendingResolutionCaches\(businessId/);
    assert.match(books, /refreshCounts: true/);
    const monthly = fs.readFileSync("src/pages/Admin/MonthlyReviewConsole.jsx", "utf8");
    assert.match(monthly, /refreshPendingResolutionFeeds\(\{ counts: loadBookkeepingFeedCounts/);
    assert.match(monthly, /onResolvePending=\{pendingResolutionAdmin \? handlePendingResolution : undefined\}/);
    assert.doesNotMatch(monthly, /resolutionEnabled|pending_resolution_enabled/);
    assert.doesNotMatch(fs.readFileSync("src/api/admin/monthlyReview.routes.js", "utf8"), /pendingResolutionCapability|pending_resolution_enabled/);
  } finally { if (priorDocument === undefined) delete global.document; else global.document = priorDocument; }
});

test("success refreshes both Monthly feeds/counts and invalidates all scoped Books pages", async () => {
  const calls = []; await refreshPendingResolutionFeeds({ counts: async () => calls.push("counts"), pending: async () => calls.push("pending"), needsReview: async () => calls.push("needs_review") });
  assert.deepEqual(calls, ["counts", "pending", "needs_review"]);
  const data = new Map([`pending`, `needs_review`, `handled`].map(feed => [`bizzi:books-review:transactions:${BIZ}:account:${feed}`, "stale"]));
  const otherKey = `bizzi:books-review:transactions:${OTHER}:account:pending`; data.set(otherKey, "other");
  const storage = { get length() { return data.size; }, key: i => [...data.keys()][i], removeItem: key => data.delete(key) };
  invalidatePendingResolutionCaches(BIZ, storage); assert.deepEqual([...data.keys()], [otherKey]);
});
