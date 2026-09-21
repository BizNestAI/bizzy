/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "src/pages/Bizzy/ChatHome.jsx"), "utf8");

test("Operator Requests uses restrained directional motion", () => {
  assert.match(source, /OPERATOR_PANEL_OPEN_TRANSITION = \{ duration: 0\.23, ease: \[0\.22, 1, 0\.36, 1\] \}/);
  assert.match(source, /OPERATOR_PANEL_CLOSE_TRANSITION = \{ duration: 0\.17, ease: \[0\.4, 0, 1, 1\] \}/);
  assert.match(source, /initial=\{\{ opacity: 0, y: reduceMotion \? 0 : 36 \}\}/);
  assert.match(source, /y: reduceMotion \? 0 : 24/);
  assert.doesNotMatch(source, /scale:|y: 180|y: 120|type: "spring"|stiffness: 100|duration: 0\.32/);
  assert.match(source, /<Motion\.section[\s\S]*?data-operator-requests-panel/);
});

test("Operator Requests preserves its exit before replacing layout and returning focus", () => {
  assert.match(source, /<AnimatePresence[\s\S]*?onExitComplete=/);
  assert.match(source, /!showStatusCard && !statusCardExiting/);
  assert.match(source, /operatorRequestsTriggerRef\.current\?\.focus\?\.\(\{ preventScroll: true \}\)/);
  assert.match(source, /ref=\{operatorRequestsTriggerRef\}/);
});

test("Operator Requests handles rapid toggles, Hide, Escape, and reduced motion", () => {
  assert.match(source, /showStatusCardRef\.current = true;[\s\S]*?setStatusCardExiting\(false\);[\s\S]*?setShowStatusCard\(true\)/);
  assert.match(source, /showStatusCardRef\.current = false;[\s\S]*?setStatusCardExiting\(true\);[\s\S]*?setShowStatusCard\(false\)/);
  assert.match(source, /event\.key === "Escape"\) hideOperatorRequests\(\)/);
  assert.match(source, /onHide=\{hideOperatorRequests\}/);
  assert.match(source, /useReducedMotion\(\)/);
  assert.match(source, /reduceMotion \? \{ duration: 0\.01 \} : OPERATOR_PANEL_OPEN_TRANSITION/);
  assert.match(source, /reduceMotion \? \{ duration: 0\.01 \} : OPERATOR_PANEL_CLOSE_TRANSITION/);
});
