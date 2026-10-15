/* global process */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ui = readFileSync(join(process.cwd(), "src/pages/Admin/MonthlyReviewConsole.jsx"), "utf8");
const css = readFileSync(join(process.cwd(), "src/index.css"), "utf8");

test("Monthly Review stamp confirmation uses a dedicated full-viewport professional scrim", () => {
  assert.match(ui, /data-monthly-review-finalize-dialog/);
  assert.match(ui, /z-\[10000\][\s\S]*min-h-\[100dvh\][\s\S]*overflow-y-auto/);
  assert.match(css, /\[data-monthly-review-finalize-dialog\]\.bizzy-modal-main-backdrop[\s\S]*radial-gradient[\s\S]*linear-gradient[\s\S]*blur\(13px\)[\s\S]*brightness\(62%\)/);
  assert.match(css, /prefers-reduced-transparency[\s\S]*data-monthly-review-finalize-dialog/);
});

test("stamp confirmation preserves accessible modal semantics and strong depth", () => {
  const modal = ui.slice(ui.indexOf("function FinalizeConfirmModal"), ui.indexOf("function SectionCard"));
  assert.match(modal, /role="dialog" aria-modal="true" aria-labelledby="monthly-review-finalize-title"/);
  assert.match(modal, /id="monthly-review-finalize-title"/);
  assert.match(modal, /shadow-\[0_32px_100px/);
});
