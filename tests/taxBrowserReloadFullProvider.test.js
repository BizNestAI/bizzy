import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event) {
    event.target ||= this;
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
    return true;
  }
}

class FakeNode extends FakeEventTarget {
  constructor(nodeType, nodeName, ownerDocument = null) {
    super();
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes.at(-1) || null; }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, before) {
    child.parentNode?.removeChild?.(child);
    const index = before ? this.childNodes.indexOf(before) : -1;
    if (index < 0) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  get textContent() {
    if (this.nodeType === 3) return this.nodeValue || "";
    return this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    this.childNodes = [];
    if (value && this.ownerDocument) this.appendChild(this.ownerDocument.createTextNode(String(value)));
  }
}

class FakeElement extends FakeNode {
  constructor(name, ownerDocument) {
    super(1, String(name).toUpperCase(), ownerDocument);
    this.tagName = this.nodeName;
    this.namespaceURI = "http://www.w3.org/1999/xhtml";
    this.attributes = new Map();
    this.style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
    this.dataset = {};
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  contains(node) { return node === this || this.childNodes.some((child) => child.contains?.(node)); }
  focus() {}
  blur() {}
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

class FakeStorage {
  constructor(entries = {}) { this.entries = new Map(Object.entries(entries)); }
  get length() { return this.entries.size; }
  key(index) { return [...this.entries.keys()][index] ?? null; }
  getItem(key) { return this.entries.get(String(key)) ?? null; }
  setItem(key, value) { this.entries.set(String(key), String(value)); }
  removeItem(key) { this.entries.delete(String(key)); }
  clear() { this.entries.clear(); }
}

function installBrowser() {
  const windowTarget = new FakeEventTarget();
  const document = new FakeNode(9, "#document");
  document.defaultView = windowTarget;
  document.createElement = (name) => new FakeElement(name, document);
  document.createElementNS = (_namespace, name) => new FakeElement(name, document);
  document.createTextNode = (value) => Object.assign(new FakeNode(3, "#text", document), { nodeValue: String(value) });
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  document.activeElement = document.body;
  document.appendChild(document.documentElement);
  document.documentElement.appendChild(document.body);
  const container = document.createElement("div");
  document.body.appendChild(container);

  const location = new URL("https://app.bizzios.com/dashboard/tax?year=2026&month=10");
  Object.assign(windowTarget, {
    document,
    location,
    localStorage: new FakeStorage({
      "bizzy:session-user": "user-1",
      currentBusinessId: "business-1",
      business_id: "business-1",
    }),
    sessionStorage: new FakeStorage(),
    history: { pushState() {}, replaceState() {}, go() {}, back() {}, forward() {} },
    navigator: { userAgent: "node" },
    HTMLElement: FakeElement,
    HTMLIFrameElement: class HTMLIFrameElement extends FakeElement {},
    SVGElement: FakeElement,
    Element: FakeElement,
    Node: FakeNode,
    getComputedStyle: () => ({ getPropertyValue: () => "", overflow: "visible" }),
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    scrollTo() {},
    confirm: () => false,
    __VITE: { VITE_SUPABASE_URL: "https://example.supabase.co", VITE_SUPABASE_ANON_KEY: "test-anon-key" },
  });
  globalThis.window = windowTarget;
  globalThis.document = document;
  globalThis.localStorage = windowTarget.localStorage;
  globalThis.sessionStorage = windowTarget.sessionStorage;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: windowTarget.navigator });
  globalThis.HTMLElement = FakeElement;
  globalThis.HTMLIFrameElement = windowTarget.HTMLIFrameElement;
  globalThis.SVGElement = FakeElement;
  globalThis.Element = FakeElement;
  globalThis.Node = FakeNode;
  globalThis.CustomEvent = class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return { container, window: windowTarget };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test("browser reload restores scope and starts one v2 workspace request without remounting", async () => {
  const browser = installBrowser();
  const React = await import("react");
  const { act } = React;
  const runAct = async (callback) => {
    try {
      await act(callback);
    } catch (error) {
      throw new Error((error.errors || [error]).map((item) => item?.stack || String(item)).join("\n---\n"));
    }
  };
  const { createRoot } = await import("react-dom/client");
  const { createLogger, createServer } = await import("vite");
  const { default: reactPlugin } = await import("@vitejs/plugin-react");
  const routerDomModule = fileURLToPath(new URL("../node_modules/react-router-dom/dist/index.mjs", import.meta.url));
  const routerModule = fileURLToPath(new URL("../node_modules/react-router/dist/development/index.mjs", import.meta.url));
  const routerDomExportModule = fileURLToPath(new URL("../node_modules/react-router/dist/development/dom-export.mjs", import.meta.url));
  const viteLogger = createLogger();
  const logViteError = viteLogger.error.bind(viteLogger);
  viteLogger.error = (message, options) => {
    if (String(message).includes("WebSocket server error") && String(message).includes("listen EPERM")) return;
    logViteError(message, options);
  };
  const vite = await createServer({
    configFile: false,
    customLogger: viteLogger,
    define: { "import.meta.env.VITE_BIZZY_DEMO": "\"\"" },
    plugins: [{
      name: "test-router-esm",
      enforce: "pre",
      resolveId(id) {
        if (id === "react-router-dom") return routerDomModule;
        if (id === "react-router") return routerModule;
        if (id === "react-router/dom") return routerDomExportModule;
        return null;
      },
      transform(code, id) {
        if (id.endsWith("/src/services/demo/demoClient.js")) {
          return code.replace(
            "(typeof import.meta !== 'undefined' && import.meta?.env?.VITE_BIZZY_DEMO) || ''",
            "''"
          );
        }
        if (id.endsWith("/src/pages/Tax/TaxDashboard.jsx")) {
          return code.replace("const TAX_BOOTSTRAP_TIMEOUT_MS = 20_000;", "const TAX_BOOTSTRAP_TIMEOUT_MS = 20;");
        }
        return null;
      },
    }, reactPlugin()],
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    ssr: {
      noExternal: ["react-router-dom", "react-router"],
      resolve: {
        conditions: ["browser", "import", "module"],
        externalConditions: ["browser", "import", "module"],
      },
    },
  });
  const { MemoryRouter } = await vite.ssrLoadModule(routerDomModule);
  const { supabase } = await vite.ssrLoadModule("/src/services/supabaseClient.js");
  const { AuthProvider } = await vite.ssrLoadModule("/src/context/AuthContext.jsx");
  const { AdminViewProvider } = await vite.ssrLoadModule("/src/context/AdminViewContext.jsx");
  const { BusinessProvider } = await vite.ssrLoadModule("/src/context/BusinessContext.jsx");
  const { default: ProtectedRoute } = await vite.ssrLoadModule("/src/components/UserAdmin/ProtectedRoute.jsx");
  const { default: TaxDashboard } = await vite.ssrLoadModule("/src/pages/Tax/TaxDashboard.jsx");

  const session = { user: { id: "user-1", email: "owner@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" } };
  const restoredSession = deferred();
  let authListener;
  supabase.auth.getSession = () => restoredSession.promise;
  supabase.auth.onAuthStateChange = (listener) => {
    authListener = listener;
    return { data: { subscription: { unsubscribe() {} } } };
  };
  const queriedTables = [];
  supabase.from = (table) => {
    queriedTables.push(table);
    const result = table === "user_profiles"
      ? { data: { id: "user-1", email: "owner@example.com" }, error: null }
      : { data: { id: "business-1", user_id: "user-1", business_name: "Test Business" }, error: null };
    const chain = {
      select: () => chain,
      eq: () => chain,
      limit: () => chain,
      order: () => chain,
      maybeSingle: async () => result,
    };
    return chain;
  };

  const workspaceRequests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/tax/workspace?")) {
      workspaceRequests.push(url);
      return new Promise(() => {});
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const root = createRoot(browser.container);
  try {
    await runAct(async () => {
      root.render(
        React.createElement(MemoryRouter, { initialEntries: ["/dashboard/tax?year=2026&month=10"] },
          React.createElement(AuthProvider, null,
            React.createElement(AdminViewProvider, null,
              React.createElement(ProtectedRoute, null,
                React.createElement(BusinessProvider, null,
                  React.createElement(TaxDashboard)
                )
              )
            )
          )
        )
      );
    });

    // Supabase can publish INITIAL_SESSION before getSession resolves. This is
    // the production reload ordering that must preserve the same user's scope.
    await runAct(async () => authListener("INITIAL_SESSION", session));
    await runAct(async () => restoredSession.resolve({ data: { session } }));
    await runAct(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

    assert.deepEqual({
      persistedBusinessId: browser.window.localStorage.getItem("currentBusinessId"),
      workspaceRequestCount: workspaceRequests.length,
      timedOut: browser.container.textContent.includes("Tax workspace setup timed out"),
      userProfileLoaded: queriedTables.includes("user_profiles"),
      businessProfileLoaded: queriedTables.includes("business_profiles"),
    }, {
      persistedBusinessId: "business-1",
      workspaceRequestCount: 1,
      timedOut: false,
      userProfileLoaded: true,
      businessProfileLoaded: true,
    });
    assert.match(workspaceRequests[0], /businessId=business-1/);
    assert.match(workspaceRequests[0], /year=2026/);
    assert.match(workspaceRequests[0], /projectionVersion=tax-workspace-v2/);
  } finally {
    globalThis.fetch = originalFetch;
    await runAct(async () => root.unmount());
    await vite.close();
  }
});
