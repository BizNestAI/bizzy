// Read-only population bridge between the Reconciliations receipt-backed
// posting ledger and the Tax deductions workspace. This intentionally keeps
// lifecycle, tax scope, and deduction treatment separate.

export const TAX_RECONCILIATION_BRIDGE_DISPOSITIONS = Object.freeze({
  EXPENSE_COGS_IN_MATRIX: "expense_cogs_in_matrix",
  INCOME_OUTSIDE_DEDUCTIONS: "income_outside_deductions",
  TRANSFER_OR_CARD_PAYMENT_NOT_DEDUCTION: "transfer_or_card_payment_not_deduction",
  OWNER_OR_EQUITY_NOT_DEDUCTION: "owner_or_equity_not_deduction",
  REFUND_CREDIT_OR_ASSET_NOT_DEDUCTION: "refund_credit_or_asset_not_deduction",
  INCOMPLETE_OR_UNRESOLVED: "incomplete_or_unresolved",
});

export const TAX_RECONCILIATION_INCOMPLETE_REASON_CODES = Object.freeze({
  MISSING_POSTED_RECEIPT: "missing_posted_qbo_receipt",
  CONFLICTING_RECEIPT_LINK: "conflicting_qbo_receipt_link",
  MISSING_DESTINATION_GL_ID: "missing_destination_qbo_gl_id",
  MISSING_DESTINATION_GL_NAME: "missing_destination_qbo_gl_name",
  MISSING_DESTINATION_GL_TYPE: "missing_destination_qbo_gl_type",
  UNSUPPORTED_DESTINATION_GL_TYPE: "unsupported_destination_qbo_gl_type",
});

const DISPOSITION_META = Object.freeze({
  [TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.EXPENSE_COGS_IN_MATRIX]: {
    label: "Expense / COGS in deductions",
    matrix: true,
  },
  [TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.INCOME_OUTSIDE_DEDUCTIONS]: {
    label: "Income / other income outside deductions",
    matrix: false,
  },
  [TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.TRANSFER_OR_CARD_PAYMENT_NOT_DEDUCTION]: {
    label: "Transfer / card payment outside deductions",
    matrix: false,
  },
  [TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.OWNER_OR_EQUITY_NOT_DEDUCTION]: {
    label: "Owner / equity activity outside deductions",
    matrix: false,
  },
  [TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.REFUND_CREDIT_OR_ASSET_NOT_DEDUCTION]: {
    label: "Refund, credit, asset, or balance-sheet activity outside deductions",
    matrix: false,
  },
  [TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.INCOMPLETE_OR_UNRESOLVED]: {
    label: "Incomplete or unresolved QBO evidence",
    matrix: false,
  },
});

const EXPENSE_ACCOUNT_TYPES = new Set(["expense", "cost of goods sold", "costofgoodssold", "cogs"]);
const INCOME_ACCOUNT_TYPES = new Set(["income", "other income", "otherincome"]);
const EQUITY_ACCOUNT_TYPES = new Set(["equity"]);
const BALANCE_SHEET_ACCOUNT_TYPES = new Set([
  "bank",
  "credit card",
  "creditcard",
  "accounts receivable",
  "accountsreceivable",
  "other current asset",
  "othercurrentasset",
  "fixed asset",
  "fixedasset",
  "other asset",
  "otherasset",
  "accounts payable",
  "accountspayable",
  "other current liability",
  "othercurrentliability",
  "long term liability",
  "longtermliability",
  "other liability",
  "otherliability",
]);

const TRANSFER_TAXONOMY_TYPES = new Set([
  "transfer",
  "internal transfer",
  "cc payment",
  "credit card payment",
  "card payment",
]);
const TRANSFER_QBO_TYPES = new Set(["transfer", "creditcardpayment", "credit card payment"]);
const CREDIT_QBO_TYPES = new Set(["creditmemo", "credit memo", "refundreceipt", "refund receipt", "vendorcredit", "vendor credit"]);

function normalized(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stableTransactionId(row = {}) {
  return String(row.transactionId || row.transaction_id || row.rawRefs?.bankTransactionId || "").trim() || null;
}

function sortedUniqueRows(rows = []) {
  const byId = new Map();
  const duplicateIds = new Set();
  for (const row of rows || []) {
    const id = stableTransactionId(row);
    if (!id) continue;
    if (byId.has(id)) duplicateIds.add(id);
    else byId.set(id, row);
  }
  return {
    rows: Array.from(byId.values()).sort((left, right) => stableTransactionId(left).localeCompare(stableTransactionId(right))),
    duplicateIds,
  };
}

export function isReceiptBackedBizziPost(row = {}) {
  if (row?.sourceTruth?.receiptBackedBizziPost === true) return true;
  const receiptStatus = normalized(row.qboReceiptStatus || row.qbo_receipt_status);
  const receiptQboId = String(row.qboReceiptTxnId || row.qbo_receipt_txn_id || "").trim();
  if (receiptStatus !== "posted" || !receiptQboId) return false;
  const categorizationQboId = String(row.categorizationQboTxnId || row.categorization_qbo_txn_id || "").trim();
  return !categorizationQboId || categorizationQboId === receiptQboId;
}

export function deriveTaxReconciliationScope(row = {}) {
  // A Tax row without the same durable receipt used by Reconciliations is not
  // safe to place in the deductions matrix, even when a legacy category link
  // exists. Keeping it explicit prevents a display-only count from becoming a
  // tax conclusion.
  if (!isReceiptBackedBizziPost(row)) {
    const receiptQboId = String(row.qboReceiptTxnId || row.qbo_receipt_txn_id || "").trim();
    const categorizationQboId = String(row.categorizationQboTxnId || row.categorization_qbo_txn_id || "").trim();
    return {
      disposition: TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.INCOMPLETE_OR_UNRESOLVED,
      reasonCode: receiptQboId && categorizationQboId
        ? TAX_RECONCILIATION_INCOMPLETE_REASON_CODES.CONFLICTING_RECEIPT_LINK
        : TAX_RECONCILIATION_INCOMPLETE_REASON_CODES.MISSING_POSTED_RECEIPT,
    };
  }

  const taxonomyType = normalized(row.taxonomyType || row.taxonomy_type);
  const qboTxnType = normalized(row.qboTxnType || row.qbo_txn_type || row.qboReceiptTxnType || row.qbo_receipt_txn_type);
  const accountType = normalized(row.qboAccountType || row.qbo_account_type || row.metadata?.qbo_account_type);
  const accountSubtype = normalized(row.qboAccountSubtype || row.qbo_account_subtype || row.metadata?.qbo_account_subtype);
  const accountId = String(row.qboAccountId || row.qbo_account_id || "").trim();
  const accountName = String(row.qboAccountName || row.qbo_account_name || "").trim();
  const signedAmount = Number(row.signedAmount ?? row.signed_amount ?? row.amount ?? 0);

  if (TRANSFER_TAXONOMY_TYPES.has(taxonomyType) || TRANSFER_QBO_TYPES.has(qboTxnType)) {
    return { disposition: TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.TRANSFER_OR_CARD_PAYMENT_NOT_DEDUCTION, reasonCode: null };
  }

  if (CREDIT_QBO_TYPES.has(qboTxnType) || (EXPENSE_ACCOUNT_TYPES.has(accountType) && signedAmount > 0)) {
    return { disposition: TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.REFUND_CREDIT_OR_ASSET_NOT_DEDUCTION, reasonCode: null };
  }

  // Final GL evidence is required before classifying the accounting scope.
  // A name alone can be stale or ambiguous, so it fails closed here.
  if (!accountId || !accountName || !accountType) {
    return {
      disposition: TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.INCOMPLETE_OR_UNRESOLVED,
      reasonCode: !accountId
        ? TAX_RECONCILIATION_INCOMPLETE_REASON_CODES.MISSING_DESTINATION_GL_ID
        : !accountName
          ? TAX_RECONCILIATION_INCOMPLETE_REASON_CODES.MISSING_DESTINATION_GL_NAME
          : TAX_RECONCILIATION_INCOMPLETE_REASON_CODES.MISSING_DESTINATION_GL_TYPE,
    };
  }

  if (INCOME_ACCOUNT_TYPES.has(accountType)) {
    return { disposition: TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.INCOME_OUTSIDE_DEDUCTIONS, reasonCode: null };
  }

  if (EQUITY_ACCOUNT_TYPES.has(accountType) || /\b(owner|member|partner|shareholder|draw|contribution)\b/.test(`${accountName} ${accountSubtype}`.toLowerCase())) {
    return { disposition: TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.OWNER_OR_EQUITY_NOT_DEDUCTION, reasonCode: null };
  }

  if (BALANCE_SHEET_ACCOUNT_TYPES.has(accountType)) {
    return { disposition: TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.REFUND_CREDIT_OR_ASSET_NOT_DEDUCTION, reasonCode: null };
  }

  if (EXPENSE_ACCOUNT_TYPES.has(accountType)) {
    return { disposition: TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.EXPENSE_COGS_IN_MATRIX, reasonCode: null };
  }

  return {
    disposition: TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.INCOMPLETE_OR_UNRESOLVED,
    reasonCode: TAX_RECONCILIATION_INCOMPLETE_REASON_CODES.UNSUPPORTED_DESTINATION_GL_TYPE,
  };
}

export function deriveTaxReconciliationDisposition(row = {}) {
  return deriveTaxReconciliationScope(row).disposition;
}

function monthKey(row = {}) {
  const value = String(row.transactionDate || row.transaction_date || row.date || "").slice(0, 7);
  return /^\d{4}-\d{2}$/.test(value) ? value : null;
}

function emptyCounts() {
  return Object.fromEntries(Object.keys(DISPOSITION_META).map((key) => [key, 0]));
}

function summarizeMonths(rows = []) {
  const months = new Map();
  for (const row of rows) {
    const key = monthKey(row);
    if (!key) continue;
    if (!months.has(key)) {
      months.set(key, {
        month: key,
        tax_evaluated_count: 0,
        deductions_matrix_expense_count: 0,
        posted_non_expense_outside_deductions_count: 0,
      });
    }
    const summary = months.get(key);
    summary.tax_evaluated_count += 1;
    if (deriveTaxReconciliationDisposition(row) === TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.EXPENSE_COGS_IN_MATRIX) {
      summary.deductions_matrix_expense_count += 1;
    } else {
      summary.posted_non_expense_outside_deductions_count += 1;
    }
  }
  return Array.from(months.values()).sort((left, right) => left.month.localeCompare(right.month));
}

/**
 * Builds a non-mutating, identity-based population bridge. Source rows must
 * be tenant-scoped normalized Tax rows. The returned DTO intentionally omits
 * descriptions, account numbers, and row IDs; detailed audit access stays in
 * the existing authenticated drill-down surfaces.
 */
export function buildTaxReconciliationBridge({ sourceRows = [] } = {}) {
  const { rows, duplicateIds } = sortedUniqueRows(sourceRows);
  const reconciliationRows = rows.filter(isReceiptBackedBizziPost);
  const taxEligibleRows = rows.filter((row) => row.isEligible === true);
  const reconciliationIds = new Set(reconciliationRows.map(stableTransactionId));
  const taxEligibleIds = new Set(taxEligibleRows.map(stableTransactionId));
  const onlyReconciliations = [...reconciliationIds].filter((id) => !taxEligibleIds.has(id));
  const onlyTax = [...taxEligibleIds].filter((id) => !reconciliationIds.has(id));
  const counts = emptyCounts();
  const incompleteReasonCounts = {};

  for (const row of taxEligibleRows) {
    const scope = deriveTaxReconciliationScope(row);
    counts[scope.disposition] += 1;
    if (scope.reasonCode) incompleteReasonCounts[scope.reasonCode] = (incompleteReasonCounts[scope.reasonCode] || 0) + 1;
  }

  const matrixCount = counts[TAX_RECONCILIATION_BRIDGE_DISPOSITIONS.EXPENSE_COGS_IN_MATRIX];
  const taxEligibleCount = taxEligibleRows.length;
  const outsideMatrixCount = taxEligibleCount - matrixCount;
  const identityMatch = duplicateIds.size === 0 && onlyReconciliations.length === 0 && onlyTax.length === 0;

  return {
    version: "tax-reconciliation-bridge-v1",
    source_contract: {
      reconciliations_population: "receipt-backed Bizzi posts by stable bank transaction ID",
      tax_population: "Tax-eligible posted rows by stable bank transaction ID",
      deductions_matrix_population: "Tax-evaluated rows whose final QBO GL account type is Expense or Cost of Goods Sold",
      date_basis: "bank transaction date (YYYY-MM-DD); monthly grouping is business-local calendar month",
      safety: "Read-only projection. It does not classify, post, match, or infer tax treatment.",
    },
    identity_comparison: {
      reconciliations_posted_by_bizzi_count: reconciliationRows.length,
      tax_eligible_count: taxEligibleCount,
      intersection_count: taxEligibleCount - onlyTax.length,
      only_reconciliations_count: onlyReconciliations.length,
      only_tax_eligible_count: onlyTax.length,
      duplicate_stable_id_count: duplicateIds.size,
      identity_match: identityMatch,
      status: identityMatch ? "reconciled" : "mismatched",
    },
    tax_scope: {
      posted_transactions_evaluated_count: taxEligibleCount,
      deductions_matrix_expense_count: matrixCount,
      posted_non_expense_outside_deductions_count: outsideMatrixCount,
      conservation_ok: taxEligibleCount === matrixCount + outsideMatrixCount,
      dispositions: counts,
      incomplete_evidence_reasons: incompleteReasonCounts,
      months: summarizeMonths(taxEligibleRows),
    },
  };
}
