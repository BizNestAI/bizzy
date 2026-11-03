import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

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

test("mounted dashboard preserves an id-only Gas question while its authoritative preview is pending", async (t) => {
  const container = installDom();
  const transactions = Array.from({ length: 76 }, (_, i) => ({ transactionId: `gas-${i}`, date: "2026-10-01", signedAmount: -25, merchantName: `Gas vendor ${i}`, qboAccountId: "gas", qboAccountName: "Gas", taxCategory: "vehicle_expense" }));
  const group = { id: "decision:gas", decisionType: "vehicle_method", qboAccountId: "gas", qboAccountName: "Gas", actionableTransactionCount: 76, transactionCount: 76, actionableGrossAmountCents: -190000, months: ["2026-10"], state: "needs_input" };
  assert.equal(group.key, undefined, "published projection groups expose id, not the modal's normalized key");
  const snapshot = { projectionId: "P1", sourceFingerprint: "F1", projection: { canonicalBusinessId: "business-1", taxYear: 2026, questionGroups: [group], questionCoveredUniqueCount: 76, questionsForYouGroupCount: 1, matrix: [], treatmentCounts: { needs_input: 76 } } };
  globalThis.__taxP1 = snapshot; globalThis.__taxP2 = snapshot; globalThis.__gasSubmissions = 0;
  const calls = [], aborts = [];
  let refreshes = 0;
  globalThis.__gasRefresh = async () => { refreshes += 1; return { workspaceSnapshot: snapshot }; };
  globalThis.__gasPreview = (input) => {
    const started = performance.now();
    input.signal.addEventListener("abort", () => aborts.push({ elapsedMs: performance.now() - started, reason: input.signal.reason?.name, stack: new Error().stack }), { once: true });
    return new Promise((resolve, reject) => calls.push({ ...input, resolve, reject }));
  };
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { createLogger, createServer } = await import("vite");
  const { default: reactPlugin } = await import("@vitejs/plugin-react");
  const hookId = "\0mounted-tax-hook";
  const routerDomModule = fileURLToPath(new URL("../node_modules/react-router-dom/dist/index.mjs", import.meta.url));
  const routerModule = fileURLToPath(new URL("../node_modules/react-router/dist/development/index.mjs", import.meta.url));
  const routerDomExportModule = fileURLToPath(new URL("../node_modules/react-router/dist/development/dom-export.mjs", import.meta.url));
  const logger = createLogger();
  const vite = await createServer({ configFile: false, customLogger: logger, plugins: [{ name: "mounted-tax-hook", enforce: "pre", resolveId(id) {
    if (id.includes("supabaseClient")) return "\0supabase-stub";
    if (id === "framer-motion") return "\0motion-stub";
    if (id === "react-router-dom") return routerDomModule;
    if (id === "react-router") return routerModule;
    if (id === "react-router/dom") return routerDomExportModule;
    if (id.endsWith("/hooks/tax/useTaxDeductions.js") || id.endsWith("hooks/tax/useTaxDeductions.js")) return hookId;
    return null;
  }, load(id) { if (id === "\0supabase-stub") return "export const supabase = { auth: { getSession: async () => ({ data: { session: null } }) } }; export default supabase;"; if (id === "\0motion-stub") return `
    import React from "react";
    const components = new Map();
    export const motion = new Proxy({}, { get(_target, tag) { if (!components.has(tag)) components.set(tag, React.forwardRef(({ initial, animate, exit, transition, layout, ...props }, ref) => React.createElement(tag, { ...props, ref }))); return components.get(tag); } });
    export const AnimatePresence = ({ children }) => children;
    export const useReducedMotion = () => true;
  `; if (id !== hookId) return null; return `
    import { useState } from "react";
    export function useTaxDeductions() {
      const [snapshot, setSnapshot] = useState(globalThis.__taxP1);
      const [refreshing, setRefreshing] = useState(false);
      const [refreshError, setRefreshError] = useState(null);
      globalThis.__completeTaxRefresh = () => { setSnapshot(globalThis.__taxP2); setRefreshing(false); }; globalThis.__rerenderGas = () => setSnapshot((current) => ({ ...current, projection: { ...current.projection, questionGroups: current.projection.questionGroups.map((group) => ({ ...group })) } }));
      const refresh = () => { setRefreshError(null); setRefreshing(true); return Promise.resolve({ status: "updating" }); };
      const value = { overview: { projection: snapshot.projection, totals: { estimatedDeductibleAmount: 0 } }, workspaceProjection: snapshot.projection, workspaceProjectionId: snapshot.projectionId, workspaceSourceFingerprint: snapshot.sourceFingerprint, workspaceSnapshot: snapshot, allTransactions: [], transactions: [], postedTransactions: [], classificationRows: [], classificationCoverage: {}, classificationJobStatus: null, decisionRules: [], loading: false, error: null, resourceErrors: {}, sectionStatus: { overview: "success", matrix: "success", classification: "success" }, refreshing, rebuildPending: refreshing, refreshError, lastRefreshedAt: snapshot.generatedAt, isDemo: false, refresh, refetch: refresh, retryTransactionDetails: async () => null, retryQuestions: async () => null, previewGroupedDeductionDecision: (input) => globalThis.__gasPreview(input), confirmGroupedDeductionDecision: async () => { globalThis.__gasSubmissions += 1; }, getGroupedDeductionDecisionOperation: async () => null, createVehicle: async () => null, getMatrixCellDetail: async (_scope, options) => { globalThis.__matrixProjectionId = options.projectionId; return { rows: [] }; }, refreshWorkspaceSnapshot: async (options) => { const result = await globalThis.__gasRefresh(options); if (result?.workspaceSnapshot) setSnapshot(result.workspaceSnapshot); return result; }, isCurrentWorkspaceProjection: (id) => id === snapshot.projectionId };
      globalThis.__mountedTaxHook = value;
      return value;
    }`; } }, reactPlugin()], server: { middlewareMode: true, hmr: false }, appType: "custom", ssr: { noExternal: ["react-router-dom", "react-router", "framer-motion"], resolve: { conditions: ["browser", "import", "module"], externalConditions: ["browser", "import", "module"] } } });
  const { TaxDashboardDeductions } = await vite.ssrLoadModule("/src/pages/Tax/TaxDashboard.jsx");
  const React = await import("react");
  const root = createRoot(container);
  const success = { previewId: "gas-preview", actionableCount: 76, totalGroupCount: 76, previouslyReviewedCount: 0, grossAmountCents: -190000, transactions, vehicleContext: { vehicles: [] } };
  const noSubmit = () => {
    assert.equal(globalThis.__gasSubmissions, 0);
    assert.equal(elements(document.body, (node) => node.tagName === "BUTTON" && /^(Save|Apply|Confirm)/.test(node.textContent) && !node.hasAttribute("disabled")).length, 0);
  };
  const close = () => act(async () => elements(document.body, (node) => node.getAttribute("aria-label") === "Close tax review")[0].click());
  const open = () => act(async () => button(container, "Open question").click());
  try {
    await act(async () => root.render(React.createElement(TaxDashboardDeductions, { businessId: "business-1", year: 2026 })));
    await act(async () => button(container, "Questions for you · 1").click());
    await act(async () => button(container, "Open question").click());
    t.diagnostic(JSON.stringify({ phase: "open", calls: calls.length, aborts }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, false, "parent synchronization must not cancel the pending Gas preview");
    assert.equal(calls[0].groupId, group.id); assert.equal(calls[0].projectionId, "P1"); assert.equal(calls[0].sourceFingerprint, "F1");
    noSubmit();
    await act(async () => globalThis.__rerenderGas());
    assert.equal(calls.length, 1, "same semantic question with new object identity must not restart preview");
    assert.equal(calls[0].signal.aborted, false);
    await act(async () => calls[0].reject({ code: "network_error" }));
    assert.match(document.body.textContent, /couldn’t be loaded/); noSubmit();
    await act(async () => button(document.body, "Retry").click());
    assert.equal(calls.length, 2); assert.equal(calls[1].signal.aborted, false);
    assert.notEqual(calls[0].signal, calls[1].signal, "Retry owns a fresh signal");
    await act(async () => globalThis.__rerenderGas());
    assert.equal(calls[1].signal.aborted, false);
    await act(async () => calls[1].resolve(success));
    assert.match(document.body.textContent, /76 transactions/);
    assert.match(document.body.textContent, /\$1,900/);
    const details = elements(document.body, (node) => node.tagName === "BUTTON" && node.textContent.startsWith("View 76 affected transactions"))[0];
    await act(async () => details.click());
    assert.match(document.body.textContent, /Gas vendor 0/);
    assert.match(document.body.textContent, /Standard mileage/);
    assert.match(document.body.textContent, /Actual expenses/);
    for (let i = 0; i < 76; i += 1) assert.match(document.body.textContent, new RegExp(`Gas vendor ${i}`));
    noSubmit();

    await close(); await open();
    const obsolete = calls.at(-1);
    await close(); assert.equal(obsolete.signal.aborted, true);
    await open();
    const reopened = calls.at(-1);
    assert.notEqual(reopened.signal, obsolete.signal);
    await act(async () => obsolete.resolve(success));
    assert.match(document.body.textContent, /Loading this question/); noSubmit();
    await act(async () => reopened.resolve(success));
    assert.match(document.body.textContent, /76 transactions/);

    await close(); await open();
    const stale = calls.at(-1), beforeStale = calls.length;
    const p2 = { ...snapshot, projectionId: "P2", sourceFingerprint: "F2", projection: { ...snapshot.projection, questionGroups: [{ ...group }] } };
    globalThis.__gasRefresh = async () => { refreshes += 1; return { workspaceSnapshot: p2 }; };
    await act(async () => stale.reject({ code: "grouped_decision_projection_stale" }));
    assert.equal(refreshes, 1); assert.equal(calls.length, beforeStale + 1);
    const retried = calls.at(-1);
    assert.equal(retried.projectionId, "P2"); assert.equal(retried.sourceFingerprint, "F2"); assert.equal(retried.groupId, group.id);
    assert.equal(retried.signal.aborted, false, "publishing P2 must retain the normalized modal identity");
    await act(async () => retried.reject({ code: "grouped_decision_projection_stale" }));
    assert.equal(refreshes, 1); assert.equal(calls.length, beforeStale + 1);
    assert.match(document.body.textContent, /question changed/); noSubmit();

    await close(); await open();
    const sameCount = calls.length;
    await act(async () => calls.at(-1).reject({ code: "grouped_decision_projection_stale" }));
    assert.equal(refreshes, 2); assert.equal(calls.length, sameCount);
    assert.match(document.body.textContent, /question changed/); noSubmit();

    await close(); await open();
    const removedCount = calls.length;
    // A replacement semantic question must close this modal, never inherit its answer.
    globalThis.__gasRefresh = async () => { refreshes += 1; return { workspaceSnapshot: { ...p2, projectionId: "P3", sourceFingerprint: "F3", projection: { ...p2.projection, questionGroups: [{ ...group, id: "replacement:gas" }] } } }; };
    await act(async () => calls.at(-1).reject({ code: "grouped_decision_projection_stale" }));
    assert.equal(refreshes, 3); assert.equal(calls.length, removedCount);
    assert.equal(elements(document.body, (node) => node.getAttribute("role") === "dialog").length, 0);
    noSubmit();
  } finally {
    await act(async () => root.unmount()); await vite.close();
    for (const key of ["__taxP1", "__taxP2", "__gasPreview", "__gasSubmissions", "__gasRefresh", "__rerenderGas", "__completeTaxRefresh", "__mountedTaxHook"]) delete globalThis[key];
  }
});
