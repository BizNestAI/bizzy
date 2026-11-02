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

const p1 = projection("p1", "Lyft/Uber", "lyft-account-a", 2, 2);
const p2 = projection("p2", "Gas", "gas-account-b", 1, 1);
function projection(id, name, accountId, questionCount, uniqueCount) {
  const groupId = `business_use:${accountId}`;
  const questionGroups = Array.from({ length: questionCount }, (_, index) => {
    const rows = index === 0 ? Array.from({ length: uniqueCount }, (_unused, rowIndex) => ({ id: `${id}-txn-${rowIndex + 1}`, transactionId: `${id}-txn-${rowIndex + 1}`, qboAccountId: accountId, qboAccountName: name, taxCategory: accountId === "gas-account-b" ? "vehicle_expense" : "travel_transportation", taxCategoryLabel: name, amount: 10, deductibleAmount: 0, classificationStatus: "needs_review", date: "2026-10-06" })) : [];
    return { id: index ? `${groupId}:${index + 1}` : groupId, key: index ? `${groupId}:${index + 1}` : groupId, qboAccountId: accountId, qboAccountName: name, decisionType: "business_use_confirmation", actionableTransactionCount: rows.length, transactionCount: rows.length, pendingCount: rows.length, reviewedCount: 0, pendingRows: rows, rows, months: ["2026-10"], state: "needs_input" };
  });
  return {
    projectionId: id, projectionVersion: "tax-workspace-v2", formulaVersion: "tax-deductions-v1:identity-contract-v2.4-vehicle-deductions", sourceFingerprint: `${id}-fingerprint`, generatedAt: "2026-11-01T12:00:00.000Z",
    projection: { canonicalBusinessId: "business-1", taxYear: 2026, projectionVersion: "tax-workspace-v2", formulaVersion: "tax-deductions-v1:identity-contract-v2.4-vehicle-deductions", sourceFingerprint: `${id}-fingerprint`, generatedAt: "2026-11-01T12:00:00.000Z", refreshedAt: "2026-11-01T12:00:00.000Z", status: "complete", completeness: "complete", estimatedDeductibleAmount: 0, evaluatedTransactionCount: uniqueCount, matrixIncludedCount: uniqueCount, outsideDeductionsCount: 0, treatmentCounts: { estimated: 0, reviewed: 0, needs_input: uniqueCount }, questionMembershipSum: uniqueCount, questionCoveredUniqueCount: uniqueCount, questionMembershipOverlapCount: 0, questionsForYouGroupCount: questionCount, questionGroups, matrix: [] },
  };
}

test("mounted Tax deductions adopts P2, closes a stale Lyft/Uber modal, and clears updating without reload", async () => {
  const container = installDom();
  const toasts = [];
  window.addEventListener("bizzy:toast", (event) => toasts.push(event.detail));
  globalThis.__taxP1 = p1;
  globalThis.__taxP2 = p2;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { createLogger, createServer } = await import("vite");
  const { default: reactPlugin } = await import("@vitejs/plugin-react");
  const hookId = "\0mounted-tax-hook";
  const routerDomModule = fileURLToPath(new URL("../node_modules/react-router-dom/dist/index.mjs", import.meta.url));
  const routerModule = fileURLToPath(new URL("../node_modules/react-router/dist/development/index.mjs", import.meta.url));
  const routerDomExportModule = fileURLToPath(new URL("../node_modules/react-router/dist/development/dom-export.mjs", import.meta.url));
  const logger = createLogger();
  const originalLoggerError = logger.error.bind(logger);
  logger.error = (message, options) => { if (!String(message).includes("WebSocket server error")) originalLoggerError(message, options); };
  const vite = await createServer({ configFile: false, customLogger: logger, plugins: [{ name: "mounted-tax-hook", enforce: "pre", resolveId(id) {
    if (id === "react-router-dom") return routerDomModule;
    if (id === "react-router") return routerModule;
    if (id === "react-router/dom") return routerDomExportModule;
    if (id.endsWith("/hooks/tax/useTaxDeductions.js") || id.endsWith("hooks/tax/useTaxDeductions.js")) return hookId;
    return null;
  }, load(id) { if (id !== hookId) return null; return `
    import { useState } from "react";
    export function useTaxDeductions() {
      const [snapshot, setSnapshot] = useState(globalThis.__taxP1);
      const [refreshing, setRefreshing] = useState(false);
      const [refreshError, setRefreshError] = useState(null);
      globalThis.__completeTaxRefresh = () => { setSnapshot(globalThis.__taxP2); setRefreshing(false); };
      const refresh = () => { setRefreshError(null); setRefreshing(true); return Promise.resolve({ status: "updating" }); };
      const value = { overview: { projection: snapshot.projection, totals: { estimatedDeductibleAmount: 0 } }, workspaceProjection: snapshot.projection, workspaceProjectionId: snapshot.projectionId, workspaceSnapshot: snapshot, allTransactions: [], transactions: [], postedTransactions: [], classificationRows: [], classificationCoverage: {}, classificationJobStatus: null, decisionRules: [], loading: false, error: null, resourceErrors: {}, sectionStatus: { overview: "success", matrix: "success", classification: "success" }, refreshing, rebuildPending: refreshing, refreshError, lastRefreshedAt: snapshot.generatedAt, isDemo: false, refresh, refetch: refresh, retryTransactionDetails: async () => null, retryQuestions: async () => null, previewGroupedDeductionDecision: async () => ({ status: "ready", previewId: "preview-1", group: snapshot.projection.questionGroups[0], transactions: [] }), confirmGroupedDeductionDecision: async () => null, getGroupedDeductionDecisionOperation: async () => null, createVehicle: async () => null, getMatrixCellDetail: async (_scope, options) => { globalThis.__matrixProjectionId = options.projectionId; return { rows: [] }; }, refreshWorkspaceSnapshot: async () => ({ workspaceSnapshot: snapshot }), isCurrentWorkspaceProjection: (id) => id === snapshot.projectionId };
      globalThis.__mountedTaxHook = value;
      return value;
    }`; } }, reactPlugin()], server: { middlewareMode: true, hmr: false }, appType: "custom", ssr: { noExternal: ["react-router-dom", "react-router"], resolve: { conditions: ["browser", "import", "module"], externalConditions: ["browser", "import", "module"] } } });
  const { TaxDashboardDeductions } = await vite.ssrLoadModule("/src/pages/Tax/TaxDashboard.jsx");
  const React = await import("react");
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(TaxDashboardDeductions, { businessId: "business-1", year: 2026 })));
    await act(async () => button(container, "Questions for you · 2").click());
    assert.match(container.textContent, /Lyft\/Uber/);
    assert.match(container.textContent, /2 unique transactions/);
    await act(async () => button(container, "Open question").click());
    assert.match(document.body.textContent, /Review Lyft\/Uber/);
    await act(async () => button(container, "Refresh").click());
    assert.match(container.textContent, /Updating/);
    await act(async () => globalThis.__completeTaxRefresh());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    assert.doesNotMatch(container.textContent, /Lyft\/Uber/);
    assert.match(container.textContent, /Gas/);
    assert.match(container.textContent, /1 unique transaction/);
    assert.equal(toasts.at(-1)?.severity, "info");
    assert.match(toasts.at(-1)?.title || "", /underlying transactions changed/);
    const openDialogs = elements(document.body, (node) => node.getAttribute("role") === "dialog" && String(node.getAttribute("data-headlessui-state") || "").includes("open"));
    assert.equal(openDialogs.length, 0, "the stale modal must leave the open dialog state even while its exit portal animates");
    assert.doesNotMatch(container.textContent, /Updating/);
    await act(async () => globalThis.__mountedTaxHook.getMatrixCellDetail({}, { projectionId: globalThis.__mountedTaxHook.workspaceProjectionId }));
    assert.equal(globalThis.__matrixProjectionId, "p2");
  } finally { await act(async () => root.unmount()); await vite.close(); }
});
