import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import process from "node:process";

import { formatShortCalendarDate, parseCalendarDateOnly } from "../src/utils/dateUtils.js";

test("parseCalendarDateOnly preserves the calendar day", () => {
  const date = parseCalendarDateOnly("2026-09-09");
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 8);
  assert.equal(date.getDate(), 9);
});

test("formatShortCalendarDate does not shift date-only strings in process timezone", () => {
  assert.equal(formatShortCalendarDate("2026-09-09", { locale: "en-US" }), "Sep 9");
  assert.equal(formatShortCalendarDate("2026-03-08", { locale: "en-US" }), "Mar 8");
  assert.equal(formatShortCalendarDate("2026-11-01", { locale: "en-US" }), "Nov 1");
});

test("formatShortCalendarDate does not shift date-only strings in America/New_York", () => {
  const script = `
    import assert from "node:assert/strict";
    import { formatShortCalendarDate } from "./src/utils/dateUtils.js";
    assert.equal(formatShortCalendarDate("2026-09-09", { locale: "en-US" }), "Sep 9");
    assert.equal(formatShortCalendarDate("2026-03-08", { locale: "en-US" }), "Mar 8");
    assert.equal(formatShortCalendarDate("2026-11-01", { locale: "en-US" }), "Nov 1");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, TZ: "America/New_York" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
