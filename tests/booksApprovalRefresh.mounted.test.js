import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "vite";
import React, { act } from "react";
import TestRenderer from "react-test-renderer";

const source = readFileSync(new URL("../src/pages/accounting/BookkeepingCleanup.jsx", import.meta.url), "utf8");
const clientImports = source.match(/import \{([^}]+)\} from "\.\.\/\.\.\/services\/bookkeeping\/bookkeepingClient\.js"/)[1]
  .split(",").map(value => value.trim().split(/\s+as\s+/)[0]).filter(Boolean);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const storage = () => { const values = new Map(); return { get length() { return values.size; }, key: i => [...values.keys()][i], getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key), clear: () => values.clear() }; };
const text = node => typeof node === "string" || typeof node === "number" ? String(node) : (node?.children || []).map(text).join(" ");

async function setup(t, admin) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Network access is disabled in the mounted Books test"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const h = { rows: [], approvals: [], calls: [], events: [], mounts: 0, unmounts: 0, progressReads: 0, failCounts: false, failProgress: false,
    counts: { needs_review: 2, handled: 0, posted: 0, matched: 0, pending: 0, excluded: 0 },
    business: { id: "business-a", business_name: "Test business" }, accounts: [{ id: "card", plaid_account_id: "card", name: "Selected card", type: "credit", connection_state: "connected" }],
    chart: [{ id: "expense", name: "Meals", type: "Expense", active: true }, { id: "other", name: "Travel", type: "Expense", active: true }],
    admin: { active: admin, businessId: admin ? "business-a" : null, bookkeepingAccess: admin, readOnly: false },
  };
  const local = storage(), session = storage();
  local.setItem("user_id", "customer"); local.setItem("currentBusinessId", "business-a");
  if (admin) session.setItem("bizzi:admin_view_session", "test-session");
  Object.assign(globalThis, { __booksHarness: h, localStorage: local, IS_REACT_ACT_ENVIRONMENT: true,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    document: { visibilityState: "visible", body: { style: {} }, addEventListener() {}, removeEventListener() {}, querySelector: () => null },
    window: { localStorage: local, sessionStorage: session, location: new URL("http://localhost/dashboard/accounting"), addEventListener() {}, removeEventListener() {},
      dispatchEvent: event => h.events.push(event), setTimeout, clearTimeout, scrollY: 600, scrollTo: () => { throw new Error("Unexpected scroll reset"); } },
  });
  h.call = (name, ...args) => {
    h.calls.push({ name, args });
    if (name === "getTransactions") { const request = { ...deferred(), args }; h.rows.push(request); return request.promise; }
    if (name === "approveTransactions") { const request = { ...deferred(), args }; h.approvals.push(request); return request.promise; }
    if (name === "getAccounts") return Promise.resolve({ accounts: h.accounts });
    if (name === "getTransactionCounts") return h.failCounts ? Promise.reject(new Error("counts unavailable")) : Promise.resolve(h.counts);
    if (name === "getBookkeepingRunProgress") { h.progressReads++; return h.failProgress ? Promise.reject(new Error("progress unavailable")) : Promise.resolve({ run: null }); }
    if (name === "getAutoPostStatus") return Promise.resolve({ enabled: false });
    if (["getAccountMappings", "getQboCoa"].includes(name)) return Promise.resolve({ accounts: [] });
    if (["getQboAccountTypes", "getClarificationRequests"].includes(name)) return Promise.resolve([]);
    if (name === "getMappingStatus") return Promise.resolve({});
    throw new Error(`Unexpected API call ${name}`);
  };
  const stubs = new Map([
    ["BusinessContext.jsx", 'export const useBusiness=()=>({businessId:globalThis.__booksHarness.business.id,currentBusiness:globalThis.__booksHarness.business});'],
    ["AdminViewContext.jsx", 'export const useAdminView=()=>globalThis.__booksHarness.admin;'],
    ["useBillingStatus.js", 'export default ()=>({status:"active",loading:false});'],
    ["useOnboardingStatus.js", 'export default ()=>({plaidConnected:true});'],
    ["useBookkeepingChartOfAccounts.js", 'const noop=()=>{};export const useBookkeepingChartOfAccounts=()=>({accounts:globalThis.__booksHarness.chart,setAccounts:noop,ready:true,reload:noop});export default useBookkeepingChartOfAccounts;'],
    ["demoClient.js", 'export const shouldUseDemoData=()=>false;export const getDemoData=()=>({});'],
    ["BillingGate.jsx", 'export default ({children})=>typeof children==="function"?children({gateBanner:null}):children;export const resolveStatusValue=x=>x;export const getBillingAccess=()=>({canRunAI:true});'],
    ["ModuleHeader.jsx", 'export default ()=>null;'],
    ["OperatorRequestsPanel.jsx", 'export const ClarificationModal=()=>null;'],
    ["supabaseClient.js", 'export const supabase={auth:{getSession:async()=>({data:{session:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})}};export default supabase;'],
    ["BookkeepingFeed.jsx", `import React,{useEffect} from "react";
      export const CoaDropdown=()=>null;
      export default function Feed(props){globalThis.__booksHarness.feed=props;
        useEffect(()=>{globalThis.__booksHarness.mounts++;return()=>{globalThis.__booksHarness.unmounts++;};},[]);
        return React.createElement("table",null,React.createElement("tbody",null,props.transactions.map(row=>React.createElement("tr",{key:row.id},
          React.createElement("td",null,row.id),React.createElement("td",null,React.createElement("button",{disabled:props.approvingTransactionIds.has(row.id),onClick:()=>props.onApprove(row.id,row.glAccountId)},"Approve "+row.id))))));}`],
    ["bookkeepingClient.js", `import {invalidateModuleSnapshots} from "/src/services/modules/moduleSessionCache.js";
      ${clientImports.map(name => name === "approveTransactions"
        ? `export const ${name}=async(...args)=>{const result=await globalThis.__booksHarness.call("${name}",...args);invalidateModuleSnapshots("financials",args[0]);return result;};`
        : `export const ${name}=(...args)=>globalThis.__booksHarness.call("${name}",...args);`).join("\n")}
      export const getBookkeepingRunProgress=(...args)=>globalThis.__booksHarness.call("getBookkeepingRunProgress",...args);`],
  ]);
  const motion = `import React from "react";const tags=new Map();export const motion=new Proxy({},{get(_,tag){if(!tags.has(tag))tags.set(tag,React.forwardRef(({initial,animate,exit,transition,layout,...p},ref)=>React.createElement(tag,{...p,ref})));return tags.get(tag);}});export const AnimatePresence=({children})=>children;`;
  const vite = await createServer({ configFile: false, ssr: { noExternal: ["react-router-dom", "framer-motion", "react-dom"] }, server: { middlewareMode: true, watch: null, hmr: false }, appType: "custom", logLevel: "silent",
    plugins: [{ name: "books-mounted-stubs", enforce: "pre", resolveId(id) {
      if (id === "framer-motion") return "\0books-motion";
      if (id === "react-router-dom") return "\0books-router";
      if (id === "react-dom") return "\0books-portal";
      for (const name of stubs.keys()) if (id.endsWith(name) || id.endsWith(name.replace(/\.js$/, ""))) return `\0books-${name}`;
      return null;
    }, load(id) {
      if (id === "\0books-motion") return motion;
      if (id === "\0books-router") return "const navigate=()=>{};export const useNavigate=()=>navigate;";
      if (id === "\0books-portal") return "export const createPortal=children=>children;";
      return id.startsWith("\0books-") ? stubs.get(id.slice(7)) : null;
    } }],
  });
  let renderer;
  t.after(async () => { if (renderer) await act(async () => renderer.unmount()); await vite.close(); delete globalThis.__booksHarness; });
  const cache = await vite.ssrLoadModule("/src/services/modules/moduleSessionCache.js");
  cache.writeModuleSnapshot("financials-view", { businessId: "business-a" }, { accountFilter: "card", activeTab: "needs_review", dateRange: "last_90", rowsPerPage: 10, page: 1 });
  const { default: Books } = await vite.ssrLoadModule("/src/pages/accounting/BookkeepingCleanup.jsx");
  await act(async () => { renderer = TestRenderer.create(React.createElement(Books)); });
  const row = id => ({ id, accountId: "card", plaid_account_id: "card", date: new Date().toISOString().slice(0,10), amount: -5, direction: "OUTFLOW", pending: false, status: "needs_review", suggested_qbo_account_id: "expense", suggested_qbo_account_name: "Meals" });
  const resolveRows = async (rows, total = rows.length) => { const pending = h.rows.at(-1); await act(async () => pending.resolve({ rows, totalCount: total })); };
  return { h, cache, row, renderer, resolveRows, rerender: () => renderer.update(React.createElement(Books)), text: () => text(renderer.toJSON()) };
}

for (const admin of [false, true]) {
  test(`${admin ? "Admin View" : "customer"}: approval keeps the feed mounted across cache invalidation and failed background refresh`, async t => {
    const { h, cache, renderer, row, resolveRows, text: content } = await setup(t, admin);
    assert.match(content(), /Loading transactions/);
    assert.equal(renderer.root.findAllByType("table").length, 0);
    await resolveRows([row("one"), row("two")]);
    assert.equal(renderer.root.findAllByType("table").length, 1);
    const mounted = h.mounts, initialRequest = h.rows.at(-1).args[1], progressReads = h.progressReads;
    const version = cache.moduleCacheVersion("financials", "business-a");
    await act(async () => { void h.feed.onApprove("one", "expense"); void h.feed.onApprove("one", "expense"); });
    assert.equal(h.approvals.length, 1, "duplicate clicks issue one mutation");
    assert.deepEqual([...h.feed.approvingTransactionIds], ["one"]);
    assert.deepEqual(h.feed.transactions.map(row => row.id), ["one", "two"]);
    assert.equal(renderer.root.findByProps({ children: "Approve one" }).props.disabled, true);
    assert.equal(renderer.root.findByProps({ children: "Approve two" }).props.disabled, false);
    h.failCounts = true; h.failProgress = true;
    await act(async () => h.approvals[0].resolve({ rows: [{ transaction_id: "one", status: "approved", final_qbo_account_id: "expense", final_qbo_account_name: "Meals" }] }));
    assert.equal(cache.moduleCacheVersion("financials", "business-a"), version + 1, "exercise real mutation cache invalidation");
    assert.equal(h.mounts, mounted); assert.equal(h.unmounts, 0);
    assert.doesNotMatch(content(), /Loading transactions/);
    assert.deepEqual(h.feed.transactions.map(row => row.id), ["two"]);
    assert.equal(h.feed.totalCount, 1);
    assert.match(content(), /1 Needs Review/); assert.match(content(), /1 Handled/);
    assert.ok(h.rows.length >= 2, "authoritative rows revalidate");
    assert.ok(h.progressReads > progressReads, "progress revalidates separately");
    assert.deepEqual(h.rows.at(-1).args[1], initialRequest, "account/feed/date/page/page-size are unchanged");
    await act(async () => h.rows.at(-1).reject(new Error("network offline")));
    assert.doesNotMatch(content(), /Loading transactions/);
    assert.deepEqual(h.feed.transactions.map(row => row.id), ["two"]);
    assert.match(content(), /Showing saved data/);
    assert.match(content(), /1 Needs Review/); assert.match(content(), /1 Handled/);
    assert.equal(h.events.some(event => event.detail?.title === "Approval failed"), false);
    assert.equal(globalThis.window.scrollY, 600);
  });

  test(`${admin ? "Admin View" : "customer"}: approval failure retains rows and selected category and re-enables the action`, async t => {
    const { h, row, resolveRows, text: content } = await setup(t, admin);
    await resolveRows([row("one"), row("two")]);
    await act(async () => h.feed.onAccountChange("one", "other"));
    assert.equal(h.feed.transactions[0].glAccountId, "other");
    await act(async () => { void h.feed.onApprove("one", "other"); });
    await act(async () => h.approvals[0].reject(new Error("Approval denied")));
    assert.deepEqual(h.feed.transactions.map(row => row.id), ["one", "two"]);
    assert.equal(h.feed.transactions[0].glAccountId, "other");
    assert.equal(h.feed.approvingTransactionIds.size, 0);
    assert.equal(h.events.at(-1).detail.title, "Approval failed");
    assert.equal(h.rows.length, 1, "a failed mutation does not refetch or clear the feed");
    assert.doesNotMatch(content(), /Loading transactions/);
  });

  test(`${admin ? "Admin View" : "customer"}: approving the final row clamps pagination without a loader or remount`, async t => {
    const { h, row, resolveRows, text: content } = await setup(t, admin);
    await resolveRows([row("one"), row("two")], 11);
    await act(async () => h.feed.onPageChange(2));
    assert.match(content(), /Loading transactions/, "uncached navigation still loads normally");
    await resolveRows([row("last")], 11);
    const mounted = h.mounts;
    await act(async () => { void h.feed.onApprove("last", "expense"); });
    await act(async () => h.approvals[0].resolve({ rows: [{ transaction_id: "last", status: "approved" }] }));
    assert.doesNotMatch(content(), /Loading transactions/);
    assert.equal(h.feed.page, 1); assert.equal(h.feed.pageSize, 10);
    assert.equal(h.mounts, mounted);
    assert.equal(h.rows.at(-1).args[1].page, 1);
    await resolveRows([row("one"), row("two")], 10);
    assert.deepEqual(h.feed.transactions.map(row => row.id), ["one", "two"]);
  });

  test(`${admin ? "Admin View" : "customer"}: successful background revalidation fills the page without reordering existing rows`, async t => {
    const { h, row, resolveRows, text: content } = await setup(t, admin);
    await resolveRows([row("one"), row("two")], 3);
    const mounted = h.mounts;
    await act(async () => { void h.feed.onApprove("one", "expense"); });
    h.counts = { ...h.counts, needs_review: 2, handled: 1 };
    await act(async () => h.approvals[0].resolve({ rows: [{ transaction_id: "one", status: "approved" }] }));
    await resolveRows([row("two"), row("three")], 2);
    assert.deepEqual(h.feed.transactions.map(row => row.id), ["two", "three"]);
    assert.equal(h.mounts, mounted);
    assert.match(content(), /2 Needs Review/); assert.match(content(), /1 Handled/);
    assert.doesNotMatch(content(), /Loading transactions/);
  });

  test(`${admin ? "Admin View" : "customer"}: concurrent approvals do not restore each other's rows`, async t => {
    const { h, row, resolveRows, text: content } = await setup(t, admin);
    await resolveRows([row("one"), row("two"), row("three")]);
    await act(async () => { void h.feed.onApprove("one", "expense"); void h.feed.onApprove("two", "expense"); });
    h.failCounts = true;
    await act(async () => {
      h.approvals[0].resolve({ rows: [{ transaction_id: "one", status: "approved" }] });
      h.approvals[1].resolve({ rows: [{ transaction_id: "two", status: "approved" }] });
    });
    assert.deepEqual(h.feed.transactions.map(row => row.id), ["three"]);
    assert.equal(h.feed.totalCount, 1);
    assert.doesNotMatch(content(), /Loading transactions/);
  });

  test(`${admin ? "Admin View" : "customer"}: mounted rows never carry into a different business`, async t => {
    const { h, row, resolveRows, renderer, rerender, text: content } = await setup(t, admin);
    await resolveRows([row("private-a")]);
    await act(async () => {
      h.business = { id: "business-b", business_name: "Another business" };
      if (admin) h.admin = { ...h.admin, businessId: "business-b" };
      rerender();
    });
    assert.match(content(), /Loading transactions/);
    assert.equal(renderer.root.findAllByType("table").length, 0);
    assert.doesNotMatch(content(), /private-a/);
    assert.equal(h.rows.at(-1).args[0], "business-b");
    await resolveRows([row("private-b")]);
    assert.deepEqual(h.feed.transactions.map(row => row.id), ["private-b"]);
  });
}
