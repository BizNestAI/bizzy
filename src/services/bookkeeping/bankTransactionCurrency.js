const DEFAULT_BOOKKEEPING_CURRENCY = "USD";

function normalizeCurrencyCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

export function resolveBankTransactionCurrency(transaction = {}, requestedCurrency = null) {
  return (
    normalizeCurrencyCode(requestedCurrency) ||
    normalizeCurrencyCode(transaction.iso_currency_code) ||
    normalizeCurrencyCode(transaction.unofficial_currency_code) ||
    // Split persistence explicitly defines USD as its database default.
    DEFAULT_BOOKKEEPING_CURRENCY
  );
}

