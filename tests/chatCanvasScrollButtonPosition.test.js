/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "src/components/Bizzy/ChatCanvas.jsx"), "utf8");

test("jump-to-bottom button tracks the measured chat bar with a compact gap", () => {
  assert.match(source, /const SCROLL_BUTTON_BAR_GAP = 16/);
  assert.match(source, /window\.innerHeight - barRect\.top \+ SCROLL_BUTTON_BAR_GAP/);
  assert.match(source, /--bizzy-scroll-button-bottom/);
  assert.doesNotMatch(source, /bottom:\$\{CANVAS_BAR_HEIGHT \+ 18\}px/);
});

test("jump-to-bottom button follows prompt layout frames without a trailing transition", () => {
  assert.match(source, /new ResizeObserver\(updateShell\)/);
  assert.match(source, /portal\?\.style\.setProperty\([\s\S]*?"--bizzy-scroll-button-bottom"/);
  assert.doesNotMatch(source, /transition:[^\n]*bottom/);
  assert.match(source, /Math\.max\(48, Math\.round\(window\.innerHeight - barRect\.top \+ SCROLL_BUTTON_BAR_GAP\)\)/);
});
