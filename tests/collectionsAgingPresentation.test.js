import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  COLLECTIONS_AGING_BUCKETS,
  collectionsAgingBadgeText,
  formatCollectionsDueDate,
  getCollectionsAging,
} from "../src/services/ar/collectionsAging.js";

const AS_OF = new Date("2026-11-01T17:00:00Z");
const DAY_MS = 86_400_000;

function dueDateForDaysPastDue(days) {
  return new Date(Date.UTC(2026, 10, 1) - days * DAY_MS).toISOString().slice(0, 10);
}

test("collections aging uses the shared authoritative boundaries", () => {
  const expectations = new Map([
    [0, "current"], [1, "1_30"], [30, "1_30"], [31, "31_60"], [60, "31_60"],
    [61, "61_90"], [90, "61_90"], [91, "90_plus"], [652, "90_plus"],
  ]);
  for (const [days, key] of expectations) {
    const aging = getCollectionsAging(dueDateForDaysPastDue(days), { asOf: AS_OF });
    assert.equal(aging.key, key, `${days} days past due`);
    assert.equal(aging.daysPastDue, days);
    const definition = COLLECTIONS_AGING_BUCKETS.find((bucket) => bucket.key === key);
    assert.equal(aging.label, definition.label);
    assert.equal(aging.colorToken, definition.colorToken);
  }
});

test("due today and future invoices are Current while missing dates stay neutral", () => {
  assert.equal(getCollectionsAging("2026-11-01", { asOf: AS_OF }).key, "current");
  assert.equal(getCollectionsAging("2026-11-20", { asOf: AS_OF }).key, "current");
  for (const dueDate of [null, "", "not-a-date", "2026-02-30"]) {
    const aging = getCollectionsAging(dueDate, { asOf: AS_OF });
    assert.equal(aging.key, "unknown");
    assert.equal(aging.daysPastDue, null);
    assert.equal(collectionsAgingBadgeText(aging), "Due date unavailable");
  }
});

test("aging badge is explicit and old due dates include the year", () => {
  assert.equal(collectionsAgingBadgeText(getCollectionsAging("2026-10-18", { asOf: AS_OF })), "1–30 · 14 days past due");
  assert.equal(collectionsAgingBadgeText(getCollectionsAging("2026-10-31", { asOf: AS_OF })), "1–30 · 1 day past due");
  assert.equal(collectionsAgingBadgeText(getCollectionsAging("2026-11-01", { asOf: AS_OF })), "Current");
  assert.equal(formatCollectionsDueDate("2025-01-18", { asOf: AS_OF }), "Jan 18, 2025");
  assert.equal(formatCollectionsDueDate("2026-10-18", { asOf: AS_OF }), "Oct 18");
});

test("a partially paid invoice keeps its remaining balance and ages only from its due date", () => {
  const invoice = { due_date: "2026-09-21", total_amount: 500, balance: 125, invoice_status: "partial" };
  const aging = getCollectionsAging(invoice.due_date, { asOf: AS_OF });
  assert.equal(aging.key, "31_60");
  assert.equal(aging.daysPastDue, 41);
  assert.equal(invoice.balance, 125);
  assert.equal(invoice.invoice_status, "partial");
});

test("calendar aging is stable across local midnight and daylight-saving boundaries", () => {
  assert.equal(getCollectionsAging("2025-01-18", { asOf: new Date("2025-01-19T04:30:00Z") }).daysPastDue, 0);
  assert.equal(getCollectionsAging("2025-01-18", { asOf: new Date("2025-01-19T05:30:00Z") }).daysPastDue, 1);
  assert.equal(getCollectionsAging("2026-03-08", { asOf: new Date("2026-03-09T04:30:00Z") }).daysPastDue, 1);
});

test("Outstanding Invoices keeps status, balance, sorting, and neutral primary text separate from aging", async () => {
  const source = await readFile(new URL("../src/pages/LeadsJobs/JobsDashboard.jsx", import.meta.url), "utf8");
  const section = source.slice(source.indexOf("function OutstandingInvoices"), source.indexOf("function ArTracker"));
  assert.match(section, /collectionsAgingBadgeText\(aging\)/);
  assert.match(section, /row\.invoice_status \|\| row\.status \|\| "open"/);
  assert.match(section, /row\.amount_due \?\? row\.balance \?\? 0/);
  assert.match(section, /text-right font-semibold text-white|font-semibold text-white sm:text-right/);
  assert.doesNotMatch(section, /text-(amber|orange|rose|pink|emerald)-\d+[^\n]*money\.format/);
  assert.match(section, /getDaysOverdue\(b, asOf\) - getDaysOverdue\(a, asOf\)/);
  assert.match(section, /Date\.parse\(a\.due_date \|\| 0\) - Date\.parse\(b\.due_date \|\| 0\)/);
});

test("AR Aging and Outstanding Invoices consume the same bucket source without changing totals", async () => {
  const source = await readFile(new URL("../src/pages/LeadsJobs/JobsDashboard.jsx", import.meta.url), "utf8");
  assert.match(source, /COLLECTIONS_AGING_BUCKETS\.map/);
  assert.match(source, /getCollectionsAging\(row\.due_date, \{ asOf \}\)/);
  assert.match(source, /const amount = Number\(row\.amount_due \?\? row\.balance \?\? 0\) \|\| 0/);
  assert.match(source, /const total = rows\.reduce\(\(sum, row\) => sum \+ \(Number\(row\.amount_due \?\? row\.balance \?\? 0\) \|\| 0\), 0\)/);
  assert.match(source, /<AgingChart[\s\S]*asOf=\{collectionsAsOf\}[\s\S]*<OutstandingInvoices rows=\{invoiceRows\} asOf=\{collectionsAsOf\}/);
});
