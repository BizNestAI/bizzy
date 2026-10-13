import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Books Review date control combines presets, named months, and an inclusive custom range", () => {
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  assert.match(page, /function DateRangeFilter/);
  assert.match(page, /Choose a month/);
  assert.match(page, /Custom range/);
  assert.match(page, /type="date"/);
  assert.match(page, /Array\.from\(\{ length: 12 \}/);
  assert.match(page, /addCalendarDaysIso\(endInclusive\)/);
  assert.match(page, /<DateRangeFilter value=\{dateRange\} onChange=\{setDateRange\}/);
});

test("rows and all six feed counts use the same bounded server date range", () => {
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  const route = read("src/api/bookkeeping/routes/bookkeeping.transactions.routes.js");
  assert.match(page, /range_start: dateFilter\.rangeStart/);
  assert.match(page, /range_end: dateFilter\.rangeEnd/);
  for (const status of ["needs_review", "handled", "posted", "matched", "pending", "excluded"]) {
    assert.match(route, new RegExp(`statusFilter: "${status}"[\\s\\S]{0,100}rangeStart, rangeEnd`));
  }
  assert.match(route, /invalid_date_range/);
  assert.match(route, /fetchBookkeepingTransactions\(\{[\s\S]*?rangeStart,[\s\S]*?rangeEnd,/);
});

test("changing the date scope resets pagination instead of mutating feed rows", () => {
  const page = read("src/pages/accounting/BookkeepingCleanup.jsx");
  assert.match(page, /setPage\(1\);\s*\}, \[accountFilter, activeTab, dateRange, rowsPerPage, showCategorized\]\)/);
  assert.doesNotMatch(page, /DateRangeFilter[\s\S]{0,500}approveTransactions/);
});
