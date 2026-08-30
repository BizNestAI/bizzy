import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildAvailableMonthlyReviewPeriods,
  normalizeMonthKey,
} from "../src/services/bookkeeping/monthlyReviewAvailablePeriodsService.js";

const root = process.cwd();

test("earliest partial activity month is available and marked partial", () => {
  const periods = buildAvailableMonthlyReviewPeriods({
    activityDates: ["2026-05-21", "2026-07-03", "2026-08-14"],
    currentMonth: "2026-08",
  });

  assert.deepEqual(periods.map((period) => period.month), ["2026-05", "2026-06", "2026-07", "2026-08"]);
  const may = periods[0];
  assert.equal(may.label, "May 2026");
  assert.equal(may.firstActivityDate, "2026-05-21");
  assert.equal(may.booksStartDate, "2026-05-21");
  assert.equal(may.isPartialStartMonth, true);
  assert.equal(may.hasActivity, true);
});

test("calendar bounds include intervening zero-activity months after bookkeeping starts", () => {
  const periods = buildAvailableMonthlyReviewPeriods({
    activityDates: ["2026-05-21", "2026-08-01"],
    currentMonth: "2026-08",
  });

  assert.deepEqual(periods.map((period) => period.month), ["2026-05", "2026-06", "2026-07", "2026-08"]);
  assert.equal(periods.find((period) => period.month === "2026-06").hasActivity, false);
  assert.equal(periods.find((period) => period.month === "2026-07").hasActivity, false);
});

test("arbitrary future months are excluded unless a review run exists", () => {
  const periods = buildAvailableMonthlyReviewPeriods({
    activityDates: ["2026-05-21", "2026-08-14"],
    runMonths: ["2026-10-01"],
    currentMonth: "2026-08",
  });

  assert.ok(periods.some((period) => period.month === "2026-10" && period.hasRun));
  assert.ok(!periods.some((period) => period.month === "2026-09"));
  assert.ok(!periods.some((period) => period.month === "2027-01"));
});

test("businesses with later onboarding receive later starting months", () => {
  const businessA = buildAvailableMonthlyReviewPeriods({
    activityDates: ["2026-05-21"],
    currentMonth: "2026-08",
  });
  const businessB = buildAvailableMonthlyReviewPeriods({
    activityDates: ["2026-08-02"],
    currentMonth: "2026-08",
  });

  assert.equal(businessA[0].month, "2026-05");
  assert.deepEqual(businessB.map((period) => period.month), ["2026-08"]);
  assert.equal(businessB[0].isPartialStartMonth, true);
});

test("no activity and no run does not synthesize an arbitrary current month", () => {
  const periods = buildAvailableMonthlyReviewPeriods({
    activityDates: [],
    runMonths: [],
    currentMonth: "2026-08",
  });

  assert.deepEqual(periods, []);
});

test("month normalizer accepts dates and rejects invalid month strings", () => {
  assert.equal(normalizeMonthKey("2026-05-21"), "2026-05");
  assert.equal(normalizeMonthKey("2026-05"), "2026-05");
  assert.equal(normalizeMonthKey("2026-13"), null);
});

test("Monthly Review console consumes backend periods instead of generated future options", () => {
  const ui = readFileSync(join(root, "src/pages/Admin/MonthlyReviewConsole.jsx"), "utf8");

  assert.match(ui, /available-periods/);
  assert.match(ui, /buildMonthOptions\(month, availablePeriods\)/);
  assert.match(ui, /Partial month · Books begin/);
  assert.doesNotMatch(ui, /for \(let offset = 2; offset >= -15; offset -= 1\)/);
  assert.doesNotMatch(ui, /value === "2026-05"/);
});

test("Monthly Review backend exposes a business-scoped available-period authority", () => {
  const route = readFileSync(join(root, "src/api/admin/monthlyReview.routes.js"), "utf8");

  assert.match(route, /getAvailableMonthlyReviewPeriods/);
  assert.match(route, /\/businesses\/:businessId\/available-periods/);
  assert.match(route, /assertMonthlyReviewBusinessExists\(businessId\)/);
  assert.match(route, /assertMonthlyReviewPeriodAvailable\(businessId, month\)/);
  assert.match(route, /monthly_review_period_not_available/);
});
