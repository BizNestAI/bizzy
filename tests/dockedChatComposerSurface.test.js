/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const layout = readFileSync(join(root, "src/layout/DashboardLayout.jsx"), "utf8");
const composer = readFileSync(join(root, "src/components/Bizzy/BizzyChatComposer.jsx"), "utf8");
const css = readFileSync(join(root, "src/index.css"), "utf8");

test("docked composer backdrop follows the natural height of the shared dock", () => {
  assert.match(layout, /data-bizzy-curtain[\s\S]*?position: "absolute",[\s\S]*?inset: 0/);
  assert.match(layout, /data-bizzy-curtain[\s\S]*?background: "var\(--bg\)"/);
  assert.match(layout, /bottom: "100%"[\s\S]*?linear-gradient/);
  assert.doesNotMatch(layout, /curtainH|CURTAIN_MIN_H|UNDERLAP|height: `\$\{curtainH\}px`/);
});

test("dock clearance grows and shrinks with ResizeObserver measurements", () => {
  assert.match(layout, /lastBarHeightRef\.current = next;[\s\S]*?setBarHeight/);
  assert.doesNotMatch(layout, /const stable = Math\.max\(lastBarHeightRef\.current \|\| DEFAULT_BAR_HEIGHT, next\)/);
  assert.match(layout, /const MIN_SPACER_PX = 180/);
  assert.match(layout, /const spacerHeight = Math\.max\(MIN_SPACER_PX, stableBarHeight \+ BAR_GAP_PX \+ SPACER_EXTRA\)/);
});

test("prompt content remains mounted, inert when closed, and animates within the shared stack", () => {
  assert.match(composer, /inert=\{!quickPromptsOpen\}/);
  assert.match(composer, /data-state=\{quickPromptsOpen \? "open" : "closed"\}/);
  assert.match(css, /\.bizzy-quick-prompts-panel\{[\s\S]*?grid-template-rows:\s*0fr/);
  assert.match(css, /transform:\s*translateY\(10px\)/);
  assert.match(css, /\.bizzy-quick-prompts-panel\.is-open\{[\s\S]*?grid-template-rows:\s*1fr/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.bizzy-quick-prompts-panel/);
});
