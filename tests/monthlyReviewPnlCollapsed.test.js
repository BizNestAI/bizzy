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
  assert.match(panel, /next\.add\(groupKey\)/);
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
  assert.match(callsite, /snapshot=\{qboPnlSnapshot\}/);
  assert.match(callsite, /accountDetails=\{qboPnlAccountDetails\}/);
});

test("Monthly Review P&L group headers are accessible full-row controls", () => {
  const panel = extractFunction(ui, "SourceLedgerPanel");

  assert.match(panel, /<button[\s\S]*type="button"[\s\S]*onClick=\{\(\) => toggleAccountGroup\(account\)\}/);
  assert.match(panel, /aria-expanded=\{expanded\}/);
  assert.match(panel, /aria-controls=\{`monthly-review-qbo-pnl-\$\{groupKey\}`\}/);
  assert.match(panel, /ChevronRight/);
  assert.match(panel, /ChevronDown/);
  assert.match(panel, /Expand for transactions/);
  assert.match(panel, /formatCurrency\(account\.total_amount\)/);
});

test("Monthly Review P&L transactions load lazily from persisted QBO snapshot detail", () => {
  const panel = extractFunction(ui, "SourceLedgerPanel");
  const transactionMapIndex = panel.indexOf("rows.map((txn)");
  const expandedBlockIndex = panel.indexOf("{expanded ? (");

  assert.notEqual(transactionMapIndex, -1);
  assert.notEqual(expandedBlockIndex, -1);
  assert.ok(transactionMapIndex > expandedBlockIndex, "transaction rows should be nested under expanded conditional");
  assert.match(panel, /id=\{`monthly-review-qbo-pnl-\$\{groupKey\}`\}/);
  assert.match(panel, /onLoadAccountTransactions\?\.\(account, \{ reset: true \}\)/);
  assert.match(ui, /const QBO_PNL_DETAIL_PAGE_SIZE = 25/);
  assert.match(ui, /page_size=\$\{QBO_PNL_DETAIL_PAGE_SIZE\}/);
  assert.match(panel, /Load More/);
});

test("Monthly Review expanded QBO P&L rows separate QBO-only from linked Bizzi reclassification", () => {
  const panel = extractFunction(ui, "SourceLedgerPanel");
  const expandedBlock = panel.slice(panel.indexOf("{expanded ? ("), panel.indexOf(") : null}", panel.indexOf("{expanded ? (")));

  assert.match(expandedBlock, /const linked = Boolean\(txn\.bizzi_transaction_id\)/);
  assert.match(expandedBlock, /Bizzi linked/);
  assert.match(expandedBlock, /QBO only/);
  assert.match(expandedBlock, /Read-only/);
  assert.match(expandedBlock, /<CoaDropdown/);
  assert.match(expandedBlock, /onChange=\{\(accountId\) => onAccountChange\(txn, accountId\)\}/);
  assert.match(expandedBlock, /txn\.entity_name \|\| txn\.payee_name \|\| txn\.vendor_name \|\| txn\.customer_name/);
});

test("Monthly Review P&L source semantics use QBO snapshot instead of source ledger preview", () => {
  const preview = extractFunction(ui, "QboPnlPreview");
  const panel = extractFunction(ui, "SourceLedgerPanel");

  assert.match(preview, /\["Revenue", snapshot\?\.revenue\]/);
  assert.match(preview, /\["COGS", snapshot\?\.cogs\]/);
  assert.match(preview, /\["Expenses", snapshot\?\.expenses\]/);
  assert.match(preview, /\["Net Profit", snapshot\?\.net_profit\]/);
  assert.doesNotMatch(panel, /ledger\?\.pnl_preview/);
  assert.doesNotMatch(panel, /ledger\?\.account_groups/);
  assert.match(panel, /No QuickBooks P&amp;L snapshot has been pulled for \{formatMonth\(month\)\}/);
  assert.match(panel, /Refresh from QuickBooks/);
  assert.match(ui, /Approve \{formatMonthShort\(month\)\} Books/);
  assert.match(ui, /function ReviewedStamp/);
  assert.match(ui, /Reopen Month/);
  assert.match(ui, /Publish Final P&amp;L Report PDF/);
  assert.doesNotMatch(ui, /Month Close Summary/);
  assert.doesNotMatch(ui, /buildAccountingCloseSummary/);
});

test("Monthly Review QBO P&L account keys use snapshot or QBO identity without fabricating Bizzi rows", () => {
  const panel = extractFunction(ui, "SourceLedgerPanel");
  const keyHelper = extractFunction(ui, "getQboPnlAccountKey");
  const endpointHelper = extractFunction(ui, "getQboPnlEndpointAccountId");

  assert.match(panel, /account\.account_path \|\| account\.account_name/);
  assert.match(keyHelper, /snapshot-account/);
  assert.match(keyHelper, /qbo-account/);
  assert.match(endpointHelper, /account\.qbo_account_id \|\| account\.id/);
  assert.doesNotMatch(panel, /bank_transactions|transaction_categorizations/);
});

test("Monthly Review QBO P&L wiring uses persisted GET on load and explicit refresh POST", () => {
  assert.match(ui, /loadQboPnlSnapshot/);
  assert.match(ui, /\/qbo-pnl\?year=\$\{encodeURIComponent\(month\.slice\(0, 4\)\)\}&month=\$\{encodeURIComponent\(Number\(month\.slice\(5, 7\)\)\)\}/);
  assert.match(ui, /\/qbo-pnl\/refresh/);
  assert.match(ui, /method: "POST"/);
  assert.match(ui, /setQboPnlAccountDetails\(\{\}\)/);
  assert.match(ui, /loadQboPnlSnapshot\(\);/);
});

test("Monthly Review QBO P&L detail cache is invalidated when snapshot id changes", () => {
  assert.match(ui, /const qboPnlSnapshotIdRef = useRef\(null\)/);
  assert.match(ui, /const applyQboPnlSnapshot = useCallback\(\(snapshot\) => \{/);
  assert.match(ui, /const incomingSnapshotId = snapshot\?\.id \|\| null/);
  assert.match(ui, /const previousSnapshotId = qboPnlSnapshotIdRef\.current/);
  assert.match(ui, /qboPnlSnapshotIdRef\.current = incomingSnapshotId/);
  assert.match(ui, /String\(previousSnapshotId \|\| ""\) !== String\(incomingSnapshotId \|\| ""\) && previousSnapshotId/);
  assert.match(ui, /setQboPnlAccountDetails\(\{\}\)/);
  assert.match(ui, /applyQboPnlSnapshot\(snapshot\)/);
});

test("Monthly Review QBO P&L detail cache reuse requires matching snapshot id", () => {
  const panel = extractFunction(ui, "SourceLedgerPanel");

  assert.match(panel, /String\(detail\?\.snapshotId \|\| ""\) === String\(snapshot\?\.id \|\| ""\) \? detail : null/);
  assert.match(panel, /String\(cachedDetail\?\.snapshotId \|\| ""\) === String\(snapshot\?\.id \|\| ""\) \? cachedDetail : \{\}/);
  assert.match(panel, /!currentDetail\?\.loaded && !currentDetail\?\.loading/);
  assert.match(panel, /rows = Array\.isArray\(detail\.rows\) \? detail\.rows : \[\]/);
});

test("Monthly Review QBO P&L rejects stale async detail responses", () => {
  assert.match(ui, /const requestSnapshotId = qboPnlSnapshot\.id/);
  assert.match(ui, /snapshotId: requestSnapshotId/);
  assert.match(ui, /const responseSnapshotId = data\?\.snapshot_id \|\| requestSnapshotId/);
  assert.match(ui, /if \(String\(responseSnapshotId \|\| ""\) !== String\(qboPnlSnapshotIdRef\.current \|\| ""\)\) return/);
  assert.match(ui, /\[accountKey\]: String\(responseSnapshotId \|\| ""\) === String\(qboPnlSnapshotIdRef\.current \|\| ""\) \? \{/);
  assert.match(ui, /snapshotId: responseSnapshotId/);
  assert.match(ui, /if \(String\(requestSnapshotId \|\| ""\) !== String\(qboPnlSnapshotIdRef\.current \|\| ""\)\) return/);
});

test("Monthly Review QBO P&L business and month switches reset snapshot-aware cache state", () => {
  assert.match(ui, /applyQboPnlSnapshot\(null\)/);
  assert.match(ui, /setQboPnlAccountDetails\(\{\}\)/);
  assert.match(ui, /useEffect\(\(\) => \{\s*setExpandedAccountKeys\(new Set\(\)\);\s*\}, \[businessId, month\]\)/);
});

test("Monthly Review linked QBO P&L reclassification uses Phase 2B route then authoritative snapshot refresh", () => {
  assert.match(ui, /\/runs\/\$\{encodeURIComponent\(detail\.run\.id\)\}\/transactions\/\$\{encodeURIComponent\(transactionId\)\}\/account/);
  assert.match(ui, /final_qbo_account_id: account\.id/);
  assert.match(ui, /await refreshQboPnlSnapshot\(\{ afterReclassification: true \}\)/);
  assert.doesNotMatch(ui, /setQboPnlSnapshot\(\(current\)/);
});
