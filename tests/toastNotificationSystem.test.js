/* global process */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TOAST_DEFAULT_TIMEOUT,
  appendUniqueToast,
  createToastCountdown,
  normalizeToast,
  shouldReduceToastMotion,
} from "../src/insights/toastModel.js";

const root = process.cwd();
const portalSource = readFileSync(join(root, "src/insights/ToastPortal.jsx"), "utf8");
const booksSource = readFileSync(join(root, "src/pages/accounting/BookkeepingCleanup.jsx"), "utf8");
const cssSource = readFileSync(join(root, "src/index.css"), "utf8");

test("success match toast has required dynamic copy and matched-feed action", () => {
  assert.match(booksSource, /title: "Match confirmed"/);
  assert.match(booksSource, /description: `\$\{formattedMatchedAmount\} fee linked to an existing QuickBooks expense`/);
  assert.match(booksSource, /label: "View matched"/);
  assert.match(booksSource, /setActiveTab\("matched"\)/);
  assert.match(booksSource, /transactionId: id/);
});

test("normalization preserves actions, uses 4.5 second dismissal, and supports all variants", () => {
  const action = () => {};
  const toast = normalizeToast({ severity: "success", title: "Done", body: "Saved", action: { label: "View", onClick: action } }, "one");
  assert.equal(toast.description, "Saved");
  assert.equal(toast.timeout, TOAST_DEFAULT_TIMEOUT);
  assert.equal(toast.action.onClick, action);
  for (const severity of ["success", "warning", "error", "info"]) assert.equal(normalizeToast({ severity }).severity, severity);
});

test("duplicate completed operations are suppressed", () => {
  const first = normalizeToast({ title: "Done", dedupeKey: "operation:1" }, "one");
  const duplicate = normalizeToast({ title: "Done again", dedupeKey: "operation:1" }, "two");
  const current = appendUniqueToast([], first);
  assert.strictEqual(appendUniqueToast(current, duplicate), current);
});

test("countdown dismisses automatically and pauses while interaction is active", () => {
  let clock = 0;
  let scheduled = null;
  let dismissed = 0;
  const countdown = createToastCountdown({
    timeout: 4500,
    onElapsed: () => { dismissed += 1; },
    now: () => clock,
    setTimer: (callback, delay) => { scheduled = { callback, delay }; return 1; },
    clearTimer: () => { scheduled = null; },
  });
  countdown.resume();
  assert.equal(scheduled.delay, 4500);
  clock = 1200;
  countdown.pause();
  assert.equal(countdown.remaining(), 3300);
  assert.equal(scheduled, null);
  countdown.resume();
  assert.equal(scheduled.delay, 3300);
  scheduled.callback();
  assert.equal(dismissed, 1);
});

test("toast markup provides dismissal, keyboard focus, polite status semantics, stacking, and responsive offsets", () => {
  assert.match(portalSource, /aria-label="Dismiss notification"/);
  assert.match(portalSource, /focus-visible:ring-2/);
  assert.match(portalSource, /role=\{role\}/);
  assert.match(portalSource, /severity === "error" \? "alert" : "status"/);
  assert.match(portalSource, /onMouseEnter=\{pause\}/);
  assert.match(portalSource, /onFocusCapture=\{pause\}/);
  assert.match(portalSource, /flex-col gap-2/);
  assert.match(portalSource, /w-\[min\(370px,calc\(100vw-32px\)\)\]/);
  assert.match(portalSource, /max-sm:left-/);
  assert.match(portalSource, /top-\[84px\]/);
});

test("reduced motion is detected and CSS disables toast animation", () => {
  assert.equal(shouldReduceToastMotion(() => ({ matches: true })), true);
  assert.equal(shouldReduceToastMotion(() => ({ matches: false })), false);
  assert.match(cssSource, /prefers-reduced-motion: reduce/);
  assert.match(cssSource, /data-bizzi-toast-viewport/);
  assert.match(cssSource, /@keyframes bizzi-toast-in/);
});
