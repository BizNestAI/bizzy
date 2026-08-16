import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = readFileSync(join(root, "src/components/Accounting/BookkeepingFeed.jsx"), "utf8");

test("Books Review feed rows can expand to show the full bank memo", () => {
  assert.match(source, /const \[expandedRowId, setExpandedRowId\]/);
  assert.match(source, /function getTransactionMemo/);
  assert.match(source, /role="button"/);
  assert.match(source, /aria-expanded=\{isExpanded\}/);
  assert.match(source, /toggleExpandedRow\(txn\.id\)/);
  assert.match(source, /setExpandedRowId\(\(prev\) => \(prev === txnId \? null : txnId\)\)/);
  assert.match(source, /const isExpanded = expandedRowId === txn\.id/);
  assert.match(source, /Full bank memo/);
  assert.match(source, /whitespace-pre-wrap break-words/);
});

test("Books Review row controls do not trigger row expansion", () => {
  assert.match(source, /onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
  assert.match(source, /CoaDropdown/);
  assert.match(source, /Post to QuickBooks/);
});
