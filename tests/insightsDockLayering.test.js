/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const layout = readFileSync(join(root, "src/layout/DashboardLayout.jsx"), "utf8");
const css = readFileSync(join(root, "src/index.css"), "utf8");
const rail = readFileSync(join(root, "src/insights/InsightsRail.jsx"), "utf8");

test("layer tokens keep the Insights rail above the complete chat dock", () => {
  assert.match(layout, /CHAT_DOCK: 9500,[\s\S]*?INSIGHTS_RAIL: 9600,[\s\S]*?INSIGHTS_CONTROL: 9610,[\s\S]*?MODAL: 10000,[\s\S]*?TOAST: 11000/);
  assert.match(layout, /zIndex: LAYERS\.CHAT_DOCK/);
  assert.match(layout, /zIndex: LAYERS\.INSIGHTS_RAIL/);
  assert.match(layout, /zIndex: LAYERS\.INSIGHTS_CONTROL/);
  assert.doesNotMatch(layout, /zIndex: 20000/);
});

test("desktop dock ends at the shared Insights rail boundary", () => {
  assert.match(layout, /className="bizzy-dashboard-chat-dock/);
  assert.match(layout, /data-insights-open=\{railOpen && showRail \? "true" : "false"\}/);
  assert.match(layout, /setProperty\("--insights-w", `\$\{RIGHT_RAIL_W\}px`\)/);
  assert.match(css, /\.bizzy-dashboard-chat-dock\{[\s\S]*?right:\s*0/);
  assert.match(css, /@media \(min-width: 1024px\)[\s\S]*?data-insights-open="true"[\s\S]*?right:\s*var\(--insights-w, 0px\)/);
});

test("rail owns pointer events and full-height scrolling above the dock", () => {
  assert.match(layout, /height: "100vh"/);
  assert.match(layout, /pointerEvents: railOpen \? "auto" : "none"/);
  assert.match(rail, /rail-content flex-1 min-h-0[\s\S]*?overflow-y-auto/);
  assert.match(rail, /className=\{\[[\s\S]*?'insights-rail',[\s\S]*?'absolute inset-0 isolate flex flex-col overflow-hidden'/);
});

test("smaller viewports keep the dock full-width for overlay-style rail behavior", () => {
  const desktopRule = css.match(/@media \(min-width: 1024px\)\{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(desktopRule, /data-insights-open="true"/);
  assert.doesNotMatch(css.match(/\.bizzy-dashboard-chat-dock\{[\s\S]*?\}/)?.[0] || "", /--insights-w/);
});
