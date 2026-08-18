import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Books Review keeps Rules button and removes duplicate Chart of Accounts navigation", () => {
  const source = read("src/pages/accounting/BookkeepingCleanup.jsx");
  assert.match(source, />\s*Rules\s*</);
  assert.doesNotMatch(source, />\s*Chart of Accounts\s*</);
  const navMatches = source.match(/navigate\("\/dashboard\/accounting\/rules"\)/g) || [];
  assert.equal(navMatches.length, 1);
});

test("Books tab remains active on accounting rules route", () => {
  const source = read("src/layout/MainLayout.jsx");
  assert.match(source, /label:\s*"Books"[^}]+activePaths:\s*\["\/dashboard\/accounting\/rules"\]/s);
});

test("Rules page renders aggregated COA decisions and preserves history", () => {
  const source = read("src/pages/accounting/Rules.jsx");
  assert.match(source, /decisions\.map/);
  assert.match(source, /affected_transaction_count/);
  assert.match(source, /Use Existing Account/);
  assert.match(source, /Create Bizzi Preferred Account/);
  assert.match(source, /history\.slice\(0,\s*8\)\.map/);
});

test("Monthly Review exposes the same canonical COA decision actions", () => {
  const source = read("src/pages/Admin/MonthlyReviewConsole.jsx");
  assert.match(source, /resolveCanonicalCoaDecision/);
  assert.match(source, /canonical-coa\/\$\{encodeURIComponent\(decision\.canonical_account_key\)\}\/use-existing/);
  assert.match(source, /canonical-coa\/\$\{encodeURIComponent\(decision\.canonical_account_key\)\}\/create-preferred/);
  assert.match(source, /Use Existing/);
  assert.match(source, /Create Bizzi Preferred/);
});
