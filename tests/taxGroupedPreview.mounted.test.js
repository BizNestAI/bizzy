import test from "node:test";
import assert from "node:assert/strict";

class EventTargetStub {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) { const set = this.listeners.get(type) || new Set(); set.add(listener); this.listeners.set(type, set); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event) { event.target ||= this; event.currentTarget = this; for (const listener of this.listeners.get(event.type) || []) listener.call(this, event); return true; }
}
class NodeStub extends EventTargetStub {
  constructor(type, name, document = null) { super(); this.nodeType = type; this.nodeName = name; this.ownerDocument = document; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes.at(-1) || null; }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, before) { child.parentNode?.removeChild?.(child); const index = before ? this.childNodes.indexOf(before) : -1; if (index < 0) this.childNodes.push(child); else this.childNodes.splice(index, 0, child); child.parentNode = this; return child; }
  removeChild(child) { const index = this.childNodes.indexOf(child); if (index >= 0) this.childNodes.splice(index, 1); child.parentNode = null; return child; }
  get textContent() { return this.nodeType === 3 ? this.nodeValue || "" : this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(value) { this.childNodes = []; if (value && this.ownerDocument) this.appendChild(this.ownerDocument.createTextNode(String(value))); }
  dispatchEvent(event) { super.dispatchEvent(event); if (event.bubbles !== false) this.parentNode?.dispatchEvent?.(event); return true; }
}
class ElementStub extends NodeStub {
  constructor(name, document) { super(1, String(name).toUpperCase(), document); this.tagName = this.nodeName; this.namespaceURI = "http://www.w3.org/1999/xhtml"; this.attributes = new Map(); this.style = { setProperty() {}, removeProperty() {} }; this.dataset = {}; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  contains(node) { return node === this || this.childNodes.some((child) => child.contains?.(node)); }
  focus() {}
  blur() {}
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  click() { this.dispatchEvent({ type: "click", bubbles: true, preventDefault() {}, stopPropagation() { this.bubbles = false; } }); }
}

function installDom() {
  const window = new EventTargetStub();
  const document = new NodeStub(9, "#document");
  document.defaultView = window;
  document.createElement = (name) => new ElementStub(name, document);
  document.createElementNS = (_ns, name) => new ElementStub(name, document);
  document.createTextNode = (value) => Object.assign(new NodeStub(3, "#text", document), { nodeValue: String(value) });
  document.documentElement = document.createElement("html"); document.body = document.createElement("body"); document.appendChild(document.documentElement); document.documentElement.appendChild(document.body);
  const container = document.createElement("div"); document.body.appendChild(container);
  Object.assign(window, { document, location: new URL("https://app.bizzios.com/dashboard/tax"), HTMLElement: ElementStub, HTMLIFrameElement: class extends ElementStub {}, SVGElement: ElementStub, Element: ElementStub, Node: NodeStub, getComputedStyle: () => ({ getPropertyValue: () => "", overflow: "visible" }), requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), setTimeout, clearTimeout, scrollTo() {} });
  Object.assign(globalThis, { window, document, HTMLElement: ElementStub, HTMLIFrameElement: window.HTMLIFrameElement, SVGElement: ElementStub, Element: ElementStub, Node: NodeStub, IS_REACT_ACT_ENVIRONMENT: true, CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; this.bubbles = false; } } });
  return container;
}

function elements(root, predicate, output = []) { for (const child of root.childNodes || []) { if (child.nodeType === 1 && predicate(child)) output.push(child); elements(child, predicate, output); } return output; }
function button(root, label) { return elements(root, (node) => node.tagName === "BUTTON" && node.textContent.trim() === label)[0]; }

test("mounted real Gas modal bounds the complete lifecycle and rejects obsolete results", async (t) => {
  const container = installDom();
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { createServer } = await import("vite");

  const vite = await createServer({ configFile: false, ssr: { noExternal: ["react-router-dom"] }, server: { middlewareMode: true, hmr: false }, appType: "custom", plugins: [{
    name: "mounted-router", enforce: "pre", resolveId(id) { if (id === "react-router-dom") return "\0router-stub"; if (id.includes("supabaseClient")) return "\0supabase-stub"; }, load(id) { if (id === "\0supabase-stub") return "export const supabase = { auth: { getSession: async () => ({ data: { session: null } }) } }; export default supabase;"; if (id === "\0router-stub") return "export function useNavigate() { return () => {}; }"; },
  }] });
  const { __TaxDashboardTestInternals: { ReviewDecisionModal, toDecisionActionGroup } } = await vite.ssrLoadModule("/src/pages/Tax/TaxDashboard.jsx");
  const root = createRoot(container);
  const transactions = Array.from({ length: 76 }, (_, i) => ({ transactionId: `gas-${i}`, date: "2026-10-01", signedAmount: -25, merchantName: `Gas vendor ${i}`, qboAccountId: "gas", qboAccountName: "Gas", taxCategory: "vehicle_expense" }));
  const group = toDecisionActionGroup({ id: "decision:gas", key: "decision:gas", decisionType: "vehicle_method", qboAccountName: "Gas", actionableTransactionCount: 76, categoryTransactionCount: 76, rows: transactions, pendingRows: transactions });
  const success = { previewId: "preview-gas", actionableCount: 76, totalGroupCount: 76, previouslyReviewedCount: 0, grossAmountCents: -190000, transactions };
  let calls = [], refreshes = 0, resolved = 0;
  const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
  let next = deferred();
  const props = { decision: { group }, taxYear: 2026, onClose: () => {}, onResolved: () => { resolved += 1; }, onScopeChanged: async () => { refreshes += 1; }, onPreview: ({ signal }) => { calls.push(signal); return next.promise; } };
  const render = async (value = props) => act(async () => root.render(value ? React.createElement(ReviewDecisionModal, value) : null));
  const text = () => document.body.textContent;
  const noSubmit = () => assert.equal(elements(document.body, (n) => n.tagName === "BUTTON" && /Save|Apply|Confirm/.test(n.textContent) && !n.hasAttribute("disabled")).length, 0);
  try {
    // Only the configured overall deadline is advanced; the production effect runs.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await render();
    assert.match(text(), /Loading this question/);
    assert.equal(calls.length, 1);
    await act(async () => t.mock.timers.tick(12_001));
    assert.doesNotMatch(text(), /Loading this question/);
    assert.match(text(), /couldn’t be loaded/);
    assert.ok(button(document.body, "Retry")); noSubmit();
    assert.equal(calls[0].aborted, true);
    const old = next;
    next = deferred();
    await act(async () => button(document.body, "Retry").click());
    assert.equal(calls.length, 2);
    await act(async () => old.resolve(success));
    assert.match(text(), /Loading this question/);
    await act(async () => next.resolve(success));
    assert.match(text(), /76 transactions/); assert.match(text(), /\$1,900/);
    assert.match(text(), /Standard mileage|standard mileage/); assert.match(text(), /Actual expenses|actual expenses/);
    const view = elements(document.body, n => n.tagName === "BUTTON" && n.textContent.includes("View 76 affected"))[0];
    await act(async () => view.click());
    for (let i = 0; i < 76; i++) assert.match(text(), new RegExp(`Gas vendor ${i}`));

    await render(null); next = deferred(); await render();
    const closing = next; const closingSignal = calls.at(-1);
    await act(async () => button(document.body, "Cancel").click());
    assert.equal(closingSignal.aborted, true, "close aborts before exit animation unmounts");
    await act(async () => t.mock.timers.tick(12_001));
    assert.doesNotMatch(text(), /couldn’t be loaded/);
    await render(null);
    next = deferred(); await render();
    await act(async () => closing.resolve(success)); assert.match(text(), /Loading this question/);
    await act(async () => t.mock.timers.tick(8_000));
    const stale = next; next = deferred();
    await act(async () => stale.reject({ code: "grouped_decision_projection_stale" }));
    assert.equal(refreshes, 1);
    // The retry is pending; it has only the remaining four seconds.
    assert.equal(calls.length, 5);
    await act(async () => t.mock.timers.tick(4_001));
    assert.match(text(), /couldn’t be loaded/); assert.doesNotMatch(text(), /Refreshing this question|Loading this question/); noSubmit();
    const before = calls.length;
    next = deferred(); await act(async () => button(document.body, "Retry").click());
    assert.equal(calls.length, before + 1);
    await act(async () => next.reject(new Error("network")));
    assert.match(text(), /couldn’t be loaded/);
    // Malformed and synchronously throwing adapters must commit an error too.
    next = deferred(); await act(async () => button(document.body, "Retry").click());
    await act(async () => next.resolve({ unexpected: true }));
    assert.match(text(), /couldn’t be loaded/); noSubmit();
    await render(null);
    await render({ ...props, onPreview: () => { throw new Error("sync adapter failure"); } });
    assert.match(text(), /couldn’t be loaded/); noSubmit();
    await render(null); next = deferred();
    await render({ ...props, onScopeChanged: () => new Promise(() => {}) });
    await act(async () => next.reject({ code: "grouped_decision_projection_stale" }));
    assert.match(text(), /Refreshing this question/);
    await act(async () => t.mock.timers.tick(12_001));
    assert.match(text(), /couldn’t be loaded/); noSubmit();
    await render(null); next = deferred(); await render();
    const firstStale = next; next = deferred();
    const callsBeforeStale = calls.length;
    await act(async () => firstStale.reject({ code: "grouped_decision_projection_stale" }));
    await act(async () => next.reject({ code: "grouped_decision_projection_stale" }));
    assert.equal(calls.length, callsBeforeStale + 1);
    assert.match(text(), /question changed/); noSubmit();
    next = deferred(); await act(async () => button(document.body, "Retry").click());
    await act(async () => next.resolve({ ...success, actionableCount: 0, transactions: [] }));
    assert.equal(resolved, 1); assert.equal(refreshes, 3);
  } finally { await act(async () => root.unmount()); t.mock.timers.reset(); await vite.close(); }
});
