const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function normalizeDateOnly(value) {
  if (!value) return null;
  const text = String(value).trim();
  const exact = text.match(ISO_DATE_RE);
  if (exact) return text;
  const leadingDate = text.match(/^(\d{4})-(\d{2})-(\d{2})[T\s]/);
  if (leadingDate) return leadingDate[0].slice(0, 10);
  return null;
}

export function normalizePlaidPostedDate(value) {
  return normalizeDateOnly(value);
}

export function normalizePlaidAuthorizedDate(value) {
  return normalizeDateOnly(value);
}

export function getAccountingDateFromBankTransaction(bankTxn = {}) {
  const accountingDate = normalizePlaidPostedDate(bankTxn?.date || bankTxn?.posted_date || bankTxn?.transaction_date);
  if (!accountingDate) {
    throw new Error("missing_plaid_posted_date");
  }
  return accountingDate;
}

export function getOptionalAccountingDateFromBankTransaction(bankTxn = {}) {
  return normalizePlaidPostedDate(bankTxn?.date || bankTxn?.posted_date || bankTxn?.transaction_date);
}

export function addCalendarDays(dateOnly, deltaDays) {
  const normalized = normalizeDateOnly(dateOnly);
  if (!normalized) return null;
  const base = new Date(`${normalized}T00:00:00Z`);
  if (!Number.isFinite(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return base.toISOString().slice(0, 10);
}
