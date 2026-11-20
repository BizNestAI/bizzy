/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { create, act } from "react-test-renderer";
import { build } from "esbuild";

process.env.SUPABASE_URL = "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "local-test-only";
const { createExcludeTransactionHandler } = await import("../src/api/bookkeeping/routes/bookkeeping.exclusions.routes.js");

function db({ staffActive = true } = {}) {
  return { from(table) { const filters = {}; return { select() { return this; }, eq(k, v) { filters[k] = v; return this; }, async maybeSingle() {
    if (table === "internal_staff_users") return { data: filters.user_id === "staff" ? { user_id: "staff", active: staffActive, role: "owner_admin" } : null };
    if (table === "business_profiles") return { data: { id: filters.id, user_id: "customer" } };
    return { data: null };
  } }; } };
}
const customer = () => ({ auth: { userId: "customer", businessId: "11111111-1111-4111-8111-111111111111" }, body: { expected_feed: "handled" }, params: { transactionId: "txn-a" } });
const admin = () => ({ ...customer(), auth: { userId: "staff" }, business: { id: "11111111-1111-4111-8111-111111111111" }, tenantContext: {
  mode: "admin_view", businessId: "11111111-1111-4111-8111-111111111111", staffUserId: "staff", adminViewSessionId: "verified", expiresAt: new Date(Date.now()+60000).toISOString(), capabilities: ["admin_bookkeeping_write"],
} });
async function run(req, options = {}) {
  const calls = [];
  const response = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
  await createExcludeTransactionHandler({ db: db(options), exclude: async args => { calls.push(args); return { ok: true, excluded: true }; } })(req, response);
  return { ...response, calls };
}
test("customer and verified Admin View invoke the same canonical exclusion with server-derived audit identity", async () => {
  const c = await run(customer()); const a = await run(admin());
  for (const r of [c,a]) { assert.equal(r.statusCode, 200); assert.equal(r.calls[0].businessId, "11111111-1111-4111-8111-111111111111"); assert.equal(r.calls[0].transactionId, "txn-a"); assert.equal(r.calls[0].expectedFeed, "handled"); }
  assert.equal(c.calls[0].actorId, "customer"); assert.equal(a.calls[0].actorId, "staff");
  assert.equal(a.calls[0].source, "admin_bookkeeping_access");
});
test("expired, inactive, spoofed customer and read-only sessions cannot exclude", async () => {
  const expired = admin(); expired.tenantContext.expiresAt = "2000-01-01";
  const spoofed = admin(); spoofed.auth.userId = "customer";
  const crossBusiness = admin(); crossBusiness.body.business_id = "22222222-2222-4222-8222-222222222222";
  const readonly = customer(); readonly.tenantContext = { mode: "customer", readOnly: true };
  for (const req of [expired, spoofed, readonly, crossBusiness]) { const result = await run(req); assert.equal(result.statusCode,403); assert.equal(result.calls.length,0); }
  assert.equal((await run(admin(), { staffActive: false })).statusCode,403);
});

const bundled = await build({ entryPoints: ["src/components/Accounting/HandledExcludeAction.jsx"], bundle: true, write: false, platform: "node", format: "esm", external: ["react"], plugins: [{ name: "dialog-test", setup(b) {
  b.onResolve({ filter: /^@headlessui\/react$/ }, () => ({ path: "dialog-test", namespace: "dialog-test" }));
  b.onLoad({ filter: /.*/, namespace: "dialog-test" }, () => ({ contents: `import React from 'react'; export const Dialog=({open,children,...props})=>open?React.createElement('section',props,children):null; export const DialogPanel=({children,...p})=>React.createElement('div',p,children); export const DialogTitle=({children,...p})=>React.createElement('h2',p,children);` }));
} }] });
// Resolve external React through a temporary module inside the workspace.
const file = `tests/.handled-exclude-component-${process.pid}.mjs`;
fs.writeFileSync(file,bundled.outputFiles[0].text);
let Component;
try { Component = (await import(new URL(`../${file}`,import.meta.url))).default; } finally { fs.unlinkSync(file); }

test("Handled exclusion requires confirmation; Cancel and Undo remain independent; repeats submit once", async () => {
  let renderer; const calls = []; let finish;
  await act(async () => { renderer=create(React.createElement(Component, { transactionId: "txn-a", onExclude: (...args)=>{calls.push(args);return new Promise(resolve=>{finish=resolve;});} })); });
  const button = label => renderer.root.findAllByType("button").find(b=>b.children.join("")===label);
  await act(async () => button("Exclude").props.onClick());
  assert.equal(calls.length,0);
  assert.equal(renderer.root.findByType("h2").children.join(""),"Exclude this transaction?");
  assert.match(renderer.root.findByType("p").children.join(""), /does not change any existing transaction in QuickBooks/);
  await act(async () => button("Cancel").props.onClick()); assert.equal(calls.length,0);
  await act(async () => button("Exclude").props.onClick());
  const confirm=button("Exclude transaction").props.onClick;
  await act(async () => { void confirm(); void confirm(); }); assert.equal(calls.length,1);
  assert.deepEqual(calls[0],["txn-a",{expectedFeed:"handled"}]);
  await act(async () => finish(true));
  assert.equal(renderer.root.findAllByType("h2").length,0);
  await act(async () => renderer.unmount());
});
test("Handled action group reserves room for Undo, Exclude and optional Retry without wrapping", () => {
  const source=fs.readFileSync("src/components/Accounting/BookkeepingFeed.jsx","utf8");
  const group=source.slice(source.indexOf('data-customer-handled-actions="simple"'),source.indexOf(') : incomingMatch.active',source.indexOf('data-customer-handled-actions="simple"')));
  assert.match(group,/Undo[\s\S]*HandledExcludeAction[\s\S]*customerCanPost/);
  assert.match(source,/QBO_COL_WIDTH, 240/); assert.match(source,/QBO_MIN_COL_WIDTH, 240/);
  assert.match(source,/gap-1.5 whitespace-nowrap/);
});
