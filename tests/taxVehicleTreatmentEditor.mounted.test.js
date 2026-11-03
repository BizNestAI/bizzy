import assert from "node:assert/strict";
import test from "node:test";
import { installDom, elements, button } from "./fixtures/taxMountedDom.js";

test("mounted vehicle editor previews server totals and reuses the exact confirmation after an unknown outcome", async () => {
  const container = installDom();
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const vite = await createServer({ configFile: false, plugins: [react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: "custom" });
  const { default: Editor } = await vite.ssrLoadModule("/src/components/Tax/VehicleTreatmentEditor.jsx");
  const root = createRoot(container);
  const calls = [], previews = [];
  let completed = 0;
  const preview = { previewId: "server-preview", affectedCount: 1, label: "Estimated deductible gas expense", beforeDeduction: 0, afterDeduction: 54.4, skipped: [], rows: [{ transactionId: "txn-1", date: "2026-06-15", accountName: "Gas", signedAmount: -68, previousDeductibleAmount: 0, deductibleAmount: 54.4, treatment: "Reviewed — actual expenses at 80%" }] };
  const props = { vehicleId: "vehicle-1", vehicles: [{ id: "vehicle-1", displayName: "Primary vehicle" }], transactionIds: ["txn-1"], defaultAction: "amend",
    onPreview: async (choices) => { previews.push(choices); return preview; },
    onApply: async (command) => { calls.push(command); if (calls.length === 1) throw new Error("connection lost after save"); return { appliedCount: 1 }; }, onSaved: () => { completed += 1; } };
  const change = async (label, value) => {
    const node = elements(container, (n) => n.getAttribute("aria-label") === label)[0]; assert.ok(node, label);
    const handlers = node[Object.keys(node).find((key) => key.startsWith("__reactProps$"))];
    await act(async () => handlers.onChange({ target: { type: "text", value } }));
  };
  try {
    await act(async () => root.render(React.createElement(Editor, props)));
    await act(async () => button(container, "Change treatment").click());
    await change("Amended business use percent", "80");
    await change("Vehicle correction reason", "Correct the year-wide business use");
    await act(async () => button(container, "Preview correction").click());
    assert.match(container.textContent, /\$0\.00 → \$54\.40/);
    assert.match(container.textContent, /Reviewed — actual expenses at 80%/);
    assert.equal(previews[0].businessUsePercent, "80");
    assert.equal(previews[0].transactionIds[0], "txn-1");
    assert.equal(previews[0].deductibleAmount, undefined);
    await act(async () => button(container, "Confirm correction").click());
    assert.match(container.textContent, /Retry this same confirmation/);
    await act(async () => root.render(React.createElement(Editor, { ...props, transactionIds: ["txn-2"] })));
    assert.ok(button(container, "Retry same confirmation"), "selection rerenders cannot discard an uncertain operation");
    await act(async () => button(container, "Retry same confirmation").click());
    assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]);
    assert.deepEqual(Object.keys(calls[0]).sort(), ["idempotencyKey", "previewId"]);
    assert.equal(completed, 1);
    assert.match(container.textContent, /Treatment saved with audit history/);
  } finally { await act(async () => root.unmount()); await vite.close(); }
});
