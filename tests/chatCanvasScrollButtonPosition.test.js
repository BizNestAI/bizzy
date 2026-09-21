/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "src/components/Bizzy/ChatCanvas.jsx"), "utf8");

test("jump-to-bottom button tracks the measured chat bar with a compact gap", () => {
  assert.match(source, /const SCROLL_BUTTON_BAR_GAP = 8/);
  assert.match(source, /window\.innerHeight - barRect\.top \+ SCROLL_BUTTON_BAR_GAP/);
  assert.match(source, /style=\{\{ bottom: `\$\{scrollButtonBottom\}px` \}\}/);
  assert.doesNotMatch(source, /bottom:\$\{CANVAS_BAR_HEIGHT \+ 18\}px/);
});

test("jump-to-bottom button smoothly follows prompt-driven composer height changes", () => {
  assert.match(source, /new ResizeObserver\(measure\)/);
  assert.match(source, /bottom 180ms cubic-bezier\(0\.22,1,0\.36,1\)/);
  assert.match(source, /Math\.max\(48, Math\.round\(window\.innerHeight - barRect\.top \+ SCROLL_BUTTON_BAR_GAP\)\)/);
});
