const normalized = (value) => String(value || "").trim().toLowerCase();

export function bulkActionForFeed(feed) {
  if (feed === "needs_review") return "approve";
  if (feed === "handled") return "post";
  return null;
}

export function isBulkActionEligible(transaction, feed) {
  if (!transaction?.id || transaction.pending === true) return false;
  const status = normalized(transaction.status);
  const taxonomy = normalized(transaction.taxonomy_type || transaction.meta?.taxonomy_type);
  const resolution = normalized(transaction.meta?.user_selected_resolution || transaction.resolution);
  const hasReceipt = Boolean(transaction.qbo_txn_id || transaction.qboTxnId || transaction.qbo_entity_id || transaction.qboEntityId || transaction.posted_at);
  const protectedWorkflow = Boolean(
    transaction.incoming_deposit_match ||
    transaction.meta?.incoming_deposit_match ||
    transaction.quickbooks_payments_protected ||
    transaction.meta?.quickbooks_payments_protected ||
    ["cc_payment", "loan_payment", "split_transaction"].includes(taxonomy) ||
    ["match_credit_card_payment", "match_incoming_deposit", "split_transaction", "split_loan_payment"].includes(resolution)
  );

  if (protectedWorkflow || hasReceipt || ["posted", "matched", "excluded", "pending"].includes(status)) return false;
  if (feed === "needs_review") return !status || ["needs_review", "uncategorized"].includes(status);
  if (feed === "handled") return ["approved", "auto_approved", "handled", "failed"].includes(status);
  return false;
}

export function summarizeBulkPost(transactions, accountNamesById = new Map()) {
  const rows = Array.isArray(transactions) ? transactions : [];
  const vendors = [...new Set(rows.map((row) => row.vendor || row.payee || row.merchantName || row.counterpartyName).filter(Boolean).map(String))];
  const accounts = [...new Set(rows.map((row) => {
    const id = row.glAccountId || row.final_qbo_account_id || row.suggestedAccountId;
    return row.glAccountName || row.final_qbo_account_name || row.suggestedAccountName || accountNamesById.get(String(id || "")) || id;
  }).filter(Boolean).map(String))];
  return {
    count: rows.length,
    vendor: vendors.length === 1 ? vendors[0] : `${vendors.length || rows.length} vendors`,
    account: accounts.length === 1 ? accounts[0] : `${accounts.length || rows.length} accounts`,
    totalExpenses: rows.reduce((sum, row) => Number(row.amount) < 0 ? sum + Math.abs(Number(row.amount)) : sum, 0),
    totalDeposits: rows.reduce((sum, row) => Number(row.amount) > 0 ? sum + Number(row.amount) : sum, 0),
  };
}
