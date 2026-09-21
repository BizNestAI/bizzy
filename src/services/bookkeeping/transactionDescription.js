function nonEmptyText(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

/**
 * Builds searchable bank-description evidence from the normalized transaction
 * columns plus the retained upstream payload. Every source is optional because
 * older/imported rows may not contain the same Plaid fields.
 */
export function transactionDescriptionParts(transaction = {}) {
  const raw = transaction?.raw && typeof transaction.raw === "object" ? transaction.raw : {};
  const values = [
    transaction.name,
    transaction.description,
    transaction.bank_memo,
    transaction.memo,
    transaction.merchant_name,
    transaction.original_name,
    transaction.original_description,
    transaction.originalDescription,
    transaction.counterparty_name,
    raw.name,
    raw.description,
    raw.bank_memo,
    raw.memo,
    raw.merchant_name,
    raw.original_name,
    raw.originalName,
    raw.original_description,
    raw.originalDescription,
    raw.authorized_name,
    raw.authorized_merchant_name,
  ];

  const counterparties = [transaction.counterparties, raw.counterparties]
    .flatMap((items) => Array.isArray(items) ? items : [])
    .flatMap((item) => [item?.name, item?.legal_name]);

  return [...new Set([...values, ...counterparties].map(nonEmptyText).filter(Boolean))];
}

export function normalizeTransactionDescription(transaction = {}) {
  return transactionDescriptionParts(transaction).join(" ");
}
