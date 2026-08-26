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
  assert.match(panel, /useEffect\(\(\) => \{\s*setExpandedAccountKeys\(new Set\(\)\);\s*setPnlAccountDrafts\(\{\}\);\s*setPnlReclassErrors\(\{\}\);\s*setPnlReclassSuccesses\(\{\}\);\s*\}, \[businessId, month\]\)/);
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

  assert.match(panel, /const linked = Boolean\(txn\.bizzi_transaction_id\)/);
  assert.match(panel, /Bizzi linked/);
  assert.match(panel, /QBO only/);
  assert.match(panel, /QBO detail/);
  assert.match(panel, /identityComplete/);
  assert.match(panel, /qbo_doc_number/);
  assert.match(panel, /qbo_split_account/);
  assert.match(panel, /lacks mutation-grade transaction identity and is read-only/);
  assert.match(panel, /Read-only/);
  assert.match(panel, /<CoaDropdown/);
  assert.match(panel, /const editable = linked && identityComplete && supportedTxnType/);
  assert.match(panel, /editable \? \(/);
  assert.match(panel, /onChange=\{\(accountId\) => handlePnlAccountDraftChange\(txn, accountId\)\}/);
  assert.match(panel, /txn\.entity_name \|\| txn\.payee_name \|\| txn\.vendor_name \|\| txn\.customer_name/);
  assert.match(ui, /QuickBooks detail could not be loaded for this account/);
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
  assert.match(ui, /const proof = data\?\.refresh_proof \|\| \{\}/);
  assert.match(ui, /proof\.created_new_current_snapshot !== true/);
  assert.match(ui, /proof\.association_version !== "pnl_group_context_v2"/);
  assert.match(ui, /QuickBooks refresh did not produce a verified pnl_group_context_v2 snapshot/);
  assert.match(ui, /const snapshot = await loadQboPnlSnapshot\(\{ silent, apply: false \}\) \|\| data\?\.snapshot \|\| null/);
  assert.match(ui, /applyQboPnlSnapshot\(snapshot\)/);
  assert.doesNotMatch(ui, /const snapshot = data\?\.snapshot \|\| await loadQboPnlSnapshot\(\)/);
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
  assert.match(panel, /account\.metadata\?\.transaction_count/);
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
  assert.match(ui, /useEffect\(\(\) => \{\s*setExpandedAccountKeys\(new Set\(\)\);\s*setPnlAccountDrafts\(\{\}\);\s*setPnlReclassErrors\(\{\}\);\s*setPnlReclassSuccesses\(\{\}\);\s*\}, \[businessId, month\]\)/);
});

test("Monthly Review linked QBO P&L reclassification uses Phase 2B route then authoritative snapshot refresh", () => {
  const panel = extractFunction(ui, "SourceLedgerPanel");
  const accountUpdaterStart = ui.indexOf("const updateTransactionAccount = async");
  const accountUpdaterEnd = ui.indexOf("const retryQboSync = async", accountUpdaterStart);
  const accountUpdater = ui.slice(accountUpdaterStart, accountUpdaterEnd);

  assert.match(ui, /\/runs\/\$\{encodeURIComponent\(detail\.run\.id\)\}\/transactions\/\$\{encodeURIComponent\(transactionId\)\}\/account/);
  assert.match(ui, /final_qbo_account_id: account\.id/);
  assert.match(ui, /void refreshQboPnlSnapshot\(\{ afterReclassification: true, silent: true, expectedReclass \}\)/);
  assert.match(ui, /const transactionId = options\.transactionId \|\| \(options\.requireBizziLinked \? transaction\?\.bizzi_transaction_id : transaction\?\.id \|\| transaction\?\.bizzi_transaction_id\)/);
  assert.match(panel, /transactionId: txn\.bizzi_transaction_id/);
  assert.match(panel, /requireBizziLinked: true/);
  assert.match(panel, /pnlOnly: true/);
  assert.match(accountUpdater, /if \(options\.pnlOnly\) \{/);
  assert.match(accountUpdater, /patchQboPnlReclassPresentation\(\{ transaction, targetAccount: account \}\)/);
  assert.doesNotMatch(accountUpdater, /await loadSourceLedger\(\)[\s\S]*options\.pnlOnly/);
});

test("Monthly Review QBO P&L reclassification stages GL selection before explicit confirmation", () => {
  const panel = extractFunction(ui, "SourceLedgerPanel");

  assert.match(panel, /const \[pnlAccountDrafts, setPnlAccountDrafts\] = useState\(\{\}\)/);
  assert.match(panel, /const \[pnlReclassErrors, setPnlReclassErrors\] = useState\(\{\}\)/);
  assert.match(panel, /const \[pnlReclassSuccesses, setPnlReclassSuccesses\] = useState\(\{\}\)/);
  assert.match(panel, /const draftAccountId = rowKey \? pnlAccountDrafts\[rowKey\] : ""/);
  assert.match(panel, /const selectedAccountId = draftAccountId \|\| currentAccountId/);
  assert.match(panel, /value=\{selectedAccountId\}/);
  assert.match(panel, /handlePnlAccountDraftChange\(txn, accountId\)/);
  assert.match(panel, /if \(!nextAccountId \|\| nextAccountId === currentAccountId\) delete next\[rowKey\]/);
  assert.doesNotMatch(panel, /onChange=\{\(accountId\) => onAccountChange\(txn, accountId\)\}/);
});

test("Monthly Review QBO P&L reclassification shows confirm and cancel only for changed drafts", () => {
  const panel = extractFunction(ui, "SourceLedgerPanel");

  assert.match(panel, /const hasDraft = Boolean\(draftAccountId && draftAccountId !== currentAccountId\)/);
  assert.match(panel, /hasDraft \? \(/);
  assert.match(panel, /Confirm Reclass/);
  assert.match(panel, /handlePnlConfirmReclass\(txn\)/);
  assert.match(panel, /handlePnlAccountDraftCancel\(txn\)/);
  assert.match(panel, /Cancel/);
});

test("Monthly Review QBO P&L reclassification eligibility is limited to linked supported QBO identities", () => {
  const panel = extractFunction(ui, "SourceLedgerPanel");

  assert.match(ui, /const QBO_PNL_RECLASSIFIABLE_TYPES = new Set\(\["Purchase", "Deposit", "CreditCardCharge"\]\)/);
  assert.match(panel, /const linked = Boolean\(txn\.bizzi_transaction_id\)/);
  assert.match(panel, /const identityComplete = Boolean\(txn\.qbo_txn_id && txn\.qbo_txn_type\)/);
  assert.match(panel, /const supportedTxnType = QBO_PNL_RECLASSIFIABLE_TYPES\.has\(String\(txn\.qbo_txn_type \|\| ""\)\)/);
  assert.match(panel, /const editable = linked && identityComplete && supportedTxnType/);
  assert.match(panel, /editable \? \(/);
  assert.match(panel, /Read-only/);
});

test("Monthly Review QBO P&L failed reclassification keeps draft selection and row error", () => {
  const panel = extractFunction(ui, "SourceLedgerPanel");

  assert.match(panel, /throwOnError: true/);
  assert.match(panel, /setPnlReclassErrors\(\(current\) => \(\{/);
  assert.match(panel, /\[rowKey\]: friendlyReclassificationError\(e\)/);
  assert.match(panel, /rowError \? <div className="text-\[11px\] text-amber-100">\{rowError\}<\/div> : null/);
  assert.doesNotMatch(panel, /catch[\s\S]*delete next\[rowKey\]/);
});

test("Monthly Review QBO P&L successful reclassification patches presentation and silently refreshes QBO authority", () => {
  const panel = extractFunction(ui, "SourceLedgerPanel");
  const patchSnapshot = extractFunction(ui, "patchQboPnlSnapshotForReclass");
  const patchCaches = extractFunction(ui, "patchQboPnlDetailCachesForReclass");
  const refreshFnStart = ui.indexOf("const refreshQboPnlSnapshot = useCallback");
  const refreshFnEnd = ui.indexOf("const loadQboPnlAccountTransactions", refreshFnStart);
  const refreshFn = ui.slice(refreshFnStart, refreshFnEnd);

  assert.match(panel, /if \(result\?\.ok\) \{/);
  assert.match(panel, /delete next\[rowKey\]/);
  assert.match(panel, /Reclassified in QuickBooks/);
  assert.match(panel, /next\.add\(getQboPnlAccountKey\(\{ qbo_account_id: draftAccountId, id: draftAccountId \}\)\)/);
  assert.match(ui, /patchQboPnlReclassPresentation/);
  assert.match(patchSnapshot, /patchQboPnlAccountTotals\(account, -amount, -1\)/);
  assert.match(patchSnapshot, /patchQboPnlAccountTotals\(account, amount, 1\)/);
  assert.match(patchSnapshot, /buildTemporaryQboPnlAccount\(targetAccount, nextTransaction, amount\)/);
  assert.match(ui, /buildExpectedPnlReclassState\(qboPnlSnapshot, transaction, account\)/);
  assert.match(ui, /qboPnlSnapshotReflectsReclass\(snapshot, expectedReclass\)/);
  assert.match(patchCaches, /oldKey = getQboPnlAccountKey\(\{ qbo_account_id: oldAccountId \}\)/);
  assert.match(patchCaches, /targetKey = getQboPnlAccountKey\(targetAccountForKey\)/);
  assert.match(patchCaches, /rows: \[movedRow, \.\.\.existingRows\.filter/);
  assert.match(ui, /void refreshQboPnlSnapshot\(\{ afterReclassification: true, silent: true, expectedReclass \}\)/);
  assert.match(refreshFn, /const snapshot = await loadQboPnlSnapshot\(\{ silent, apply: false \}\) \|\| data\?\.snapshot \|\| null/);
  assert.match(refreshFn, /if \(!silent\) setQboPnlRefreshMessage\(""\)/);
  assert.doesNotMatch(refreshFn, /QuickBooks update succeeded\. P&L refreshed from QuickBooks/);
  assert.doesNotMatch(ui, /createQbo|postSingleBookkeepingTransactionNow|approveBookkeepingTransactions/);
});

test("Monthly Review fast P&L reclassification does not trigger full workspace reload", () => {
  const accountUpdaterStart = ui.indexOf("const updateTransactionAccount = async");
  const accountUpdaterEnd = ui.indexOf("const retryQboSync = async", accountUpdaterStart);
  const accountUpdater = ui.slice(accountUpdaterStart, accountUpdaterEnd);
  const pnlOnlyStart = accountUpdater.indexOf("if (options.pnlOnly)");
  const pnlOnlyBlock = accountUpdater.slice(pnlOnlyStart, accountUpdater.indexOf("await loadSourceLedger", pnlOnlyStart));

  assert.match(pnlOnlyBlock, /setQboPnlRefreshMessage\(""\)/);
  assert.match(pnlOnlyBlock, /patchQboPnlReclassPresentation/);
  assert.match(pnlOnlyBlock, /void refreshQboPnlSnapshot\(\{ afterReclassification: true, silent: true, expectedReclass \}\)/);
  assert.doesNotMatch(pnlOnlyBlock, /loadSourceLedger|loadDetail|loadBusinesses|refreshBookkeepingFeeds|loadConnectedAccounts/);
  assert.match(accountUpdater, /await loadSourceLedger\(\)/);
  assert.match(accountUpdater, /await loadDetail\(\)/);
  assert.match(accountUpdater, /await loadBusinesses\(\)/);
});

test("Monthly Review QBO P&L dropdown filters invalid target account classes by transaction type", () => {
  const panel = extractFunction(ui, "SourceLedgerPanel");
  const filterHelper = extractFunction(ui, "filterPnlReclassTargetAccounts");

  assert.match(ui, /const EXPENSE_SIDE_RECLASS_ACCOUNT_TYPES = new Set\(\["expense", "costofgoodssold", "otherexpense"\]\)/);
  assert.match(ui, /const DEPOSIT_RECLASS_ACCOUNT_TYPES = new Set\(\["income", "revenue", "otherincome"\]\)/);
  assert.match(panel, /const rowDropdownAccounts = filterPnlReclassTargetAccounts\(dropdownAccounts, txn\.qbo_txn_type, currentAccountId\)/);
  assert.match(panel, /accounts=\{rowDropdownAccounts\}/);
  assert.match(panel, /disabled=\{busy \|\| !rowDropdownAccounts\.length\}/);
  assert.match(filterHelper, /if \(currentAccountId && String\(account\.id \|\| ""\) === String\(currentAccountId\)\) return true/);
  assert.match(filterHelper, /txnType === "Purchase" \|\| txnType === "CreditCardCharge"/);
  assert.match(filterHelper, /EXPENSE_SIDE_RECLASS_ACCOUNT_TYPES\.has\(typeKey\)/);
  assert.match(filterHelper, /txnType === "Deposit"/);
  assert.match(filterHelper, /DEPOSIT_RECLASS_ACCOUNT_TYPES\.has\(typeKey\)/);
  assert.match(ui, /qboAccountType: rawType/);
});

test("Monthly Review QBO P&L reclassification maps stable backend validation errors to friendly copy", () => {
  const helper = extractFunction(ui, "friendlyReclassificationError");

  assert.match(helper, /target_account_not_valid_for_purchase_reclassification/);
  assert.match(helper, /Choose an expense or cost-of-goods-sold account for this purchase\./);
  assert.match(helper, /target_account_not_valid_for_credit_card_charge_reclassification/);
  assert.match(helper, /Choose an expense or cost-of-goods-sold account for this credit card charge\./);
  assert.match(helper, /target_account_not_valid_for_deposit_reclassification/);
  assert.match(helper, /Choose an income account for this deposit\./);
});
