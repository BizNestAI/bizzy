import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ui = fs.readFileSync(new URL("../src/pages/Admin/MonthlyReviewConsole.jsx", import.meta.url), "utf8");

const extractFunction = (source, name) => {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const next = source.indexOf("\nfunction ", start + 1);
  return next === -1 ? source.slice(start) : source.slice(start, next);
};

test("Monthly Review P&L account groups are collapsed by default with multi-expand state", () => {
  const panel = extractFunction(ui, "SourceLedgerPanel");

  assert.match(panel, /const \[expandedAccountKeys, setExpandedAccountKeys\] = useState\(\(\) => new Set\(\)\)/);
  assert.match(panel, /setExpandedAccountKeys\(\(current\) => \{/);
  assert.match(panel, /const next = new Set\(current\)/);
  assert.match(panel, /if \(next\.has\(groupKey\)\) next\.delete\(groupKey\)/);
  assert.match(panel, /else next\.add\(groupKey\)/);
  assert.doesNotMatch(panel, /new Set\(\[groupKey\]\)/);
});

test("Monthly Review P&L expansion resets when business or month changes", () => {
  const panel = extractFunction(ui, "SourceLedgerPanel");
  const callsite = ui.slice(ui.indexOf("<SourceLedgerPanel"), ui.indexOf("<OperatorResponsesPanel"));

  assert.match(panel, /businessId,/);
  assert.match(panel, /month,/);
  assert.match(panel, /useEffect\(\(\) => \{\s*setExpandedAccountKeys\(new Set\(\)\);\s*\}, \[businessId, month\]\)/);
  assert.match(callsite, /businessId=\{selectedBusinessId\}/);
  assert.match(callsite, /month=\{month\}/);
});

test("Monthly Review P&L group headers are accessible full-row controls", () => {
  const panel = extractFunction(ui, "SourceLedgerPanel");

  assert.match(panel, /<button[\s\S]*type="button"[\s\S]*onClick=\{\(\) => toggleAccountGroup\(groupKey\)\}/);
  assert.match(panel, /aria-expanded=\{expanded\}/);
  assert.match(panel, /aria-controls=\{`monthly-review-gl-\$\{groupKey\}`\}/);
  assert.match(panel, /ChevronRight/);
  assert.match(panel, /ChevronDown/);
  assert.match(panel, /transactionCount\} transaction/);
  assert.match(panel, /formatCurrency\(group\.total_amount\)/);
});

test("Monthly Review P&L transactions render only inside expanded groups", () => {
  const panel = extractFunction(ui, "SourceLedgerPanel");
  const transactionMapIndex = panel.indexOf("(group.transactions || []).map");
  const expandedBlockIndex = panel.indexOf("{expanded ? (");

  assert.notEqual(transactionMapIndex, -1);
  assert.notEqual(expandedBlockIndex, -1);
  assert.ok(transactionMapIndex > expandedBlockIndex, "transaction rows should be nested under expanded conditional");
  assert.match(panel, /id=\{`monthly-review-gl-\$\{groupKey\}`\}/);
});

test("Monthly Review expanded P&L rows preserve reclassification and QBO status controls", () => {
  const panel = extractFunction(ui, "SourceLedgerPanel");
  const expandedBlock = panel.slice(panel.indexOf("{expanded ? ("), panel.indexOf(") : null}", panel.indexOf("{expanded ? (")));

  assert.match(expandedBlock, /QboSyncStatusBadge status=\{txn\.qbo_sync_status\} compact/);
  assert.match(expandedBlock, /<CoaDropdown/);
  assert.match(expandedBlock, /onChange=\{\(accountId\) => onAccountChange\(txn, accountId\)\}/);
  assert.match(expandedBlock, /onClick=\{\(\) => onRetry\(txn\)\}/);
  assert.match(expandedBlock, /txn\.payee \|\| txn\.description \|\| "Transaction"/);
});

test("Monthly Review P&L source semantics and Phase 1 shell remain intact", () => {
  const preview = extractFunction(ui, "PnlPreview");

  assert.match(preview, /\["Revenue", buckets\.revenue\]/);
  assert.match(preview, /\["COGS", buckets\.cogs\]/);
  assert.match(preview, /\["Expenses", buckets\.expenses\]/);
  assert.match(preview, /\["Net Profit", buckets\.net_profit\]/);
  assert.match(ui, /Approve \{formatMonthShort\(month\)\} Books/);
  assert.match(ui, /function ReviewedStamp/);
  assert.match(ui, /Reopen Month/);
  assert.match(ui, /Month Close Summary/);
  assert.match(ui, /buildAccountingCloseSummary/);
});

test("Monthly Review keeps Uncategorized groups expandable instead of hiding them", () => {
  const panel = extractFunction(ui, "SourceLedgerPanel");
  const keyHelper = extractFunction(ui, "getAccountGroupKey");

  assert.match(panel, /group\.account_name \|\| "Uncategorized"/);
  assert.match(keyHelper, /group\.account_name \|\| "Uncategorized"/);
  assert.match(keyHelper, /account-name:\$\{name \|\| "uncategorized"\}/);
});
