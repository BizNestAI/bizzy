import test from "node:test";
import assert from "node:assert/strict";
import { resolveTaxWorkspacePrerequisites } from "../src/pages/Tax/taxWorkspacePrerequisites.js";

globalThis.window = globalThis.window || globalThis;
window.HTMLIFrameElement ||= class HTMLIFrameElement {};
window.HTMLElement ||= class HTMLElement {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act, useEffect } = React;
const { createRoot } = await import("react-dom/client");

function PrerequisiteLifecycle({ inputs, onWorkspaceRequest }) {
  const prerequisites = resolveTaxWorkspacePrerequisites(inputs);
  useEffect(() => {
    if (!prerequisites.pending && prerequisites.businessId) {
      onWorkspaceRequest(prerequisites.businessId);
    }
  }, [onWorkspaceRequest, prerequisites.businessId, prerequisites.pending]);
  return null;
}

function createEffectRoot() {
  const document = {
    nodeType: 9,
    addEventListener() {},
    removeEventListener() {},
    defaultView: window,
  };
  const container = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    insertBefore() {},
    removeChild() {},
    firstChild: null,
    lastChild: null,
  };
  document.documentElement = container;
  document.body = container;
  document.activeElement = container;
  return createRoot(container);
}

async function render(root, inputs, onWorkspaceRequest) {
  await act(async () => {
    root.render(React.createElement(PrerequisiteLifecycle, { inputs, onWorkspaceRequest }));
  });
}

test("mounted hard-refresh lifecycle waits for auth and business, then requests once without remounting", async () => {
  const requests = [];
  const onWorkspaceRequest = (businessId) => requests.push(businessId);
  const root = createEffectRoot();
  try {
    await render(root, {
      authLoading: true,
      userId: null,
      businessId: null,
      adminLoading: false,
    }, onWorkspaceRequest);
    assert.deepEqual(requests, []);

    await render(root, {
      authLoading: false,
      userId: "user-1",
      businessId: null,
      adminLoading: false,
    }, onWorkspaceRequest);
    assert.deepEqual(requests, []);

    await render(root, {
      authLoading: false,
      userId: "user-1",
      businessLoading: true,
      businessId: "business-1",
      adminLoading: false,
    }, onWorkspaceRequest);
    assert.deepEqual(requests, ["business-1"]);

    await render(root, {
      authLoading: false,
      userId: "user-1",
      businessId: "business-1",
      currentBusinessId: "business-1",
      adminLoading: false,
    }, onWorkspaceRequest);
    assert.deepEqual(requests, ["business-1"]);
  } finally {
    await act(async () => root.unmount());
  }
});

test("SPA-ready scope and read-only Admin View resolve one authorized business", () => {
  assert.deepEqual(resolveTaxWorkspacePrerequisites({
    authLoading: false,
    userId: "user-1",
    businessId: "business-1",
    adminLoading: false,
  }), { pending: false, businessId: "business-1" });

  assert.deepEqual(resolveTaxWorkspacePrerequisites({
    authLoading: false,
    userId: "support-user",
    businessId: "stale-customer-business",
    adminLoading: false,
    adminActive: true,
    adminBusinessId: "admin-view-business",
  }), { pending: false, businessId: "admin-view-business" });
});

test("missing session or active business remains explicitly pending for the bounded page Retry", () => {
  assert.equal(resolveTaxWorkspacePrerequisites({
    authLoading: false,
    userId: null,
    businessId: "unverified-business",
    adminLoading: false,
  }).pending, true);
  assert.equal(resolveTaxWorkspacePrerequisites({
    authLoading: false,
    userId: "user-1",
    businessId: null,
    adminLoading: false,
  }).pending, true);
});

test("Try again reevaluates a newly populated reactive business scope", async () => {
  const requests = [];
  const onWorkspaceRequest = (businessId) => requests.push(businessId);
  const root = createEffectRoot();
  try {
    await render(root, {
      authLoading: false,
      userId: "user-1",
      businessId: null,
      adminLoading: false,
    }, onWorkspaceRequest);
    assert.deepEqual(requests, []);

    await render(root, {
      authLoading: false,
      userId: "user-1",
      businessId: "business-1",
      adminLoading: false,
    }, onWorkspaceRequest);
    assert.deepEqual(requests, ["business-1"]);
  } finally {
    await act(async () => root.unmount());
  }
});
