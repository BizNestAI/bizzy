const PROCESSING_FEE_INTENT = "payment_processing_fee";
const PROCESSING_FEE_CANONICAL_KEY = "payment_processing_fees";

const PROCESSING_FEE_ACCOUNT_NAMES = Object.freeze([
  "Payment Processing Fees",
  "Merchant Processing Fees",
  "Merchant Fees",
  "Credit Card Processing Fees",
  "Card Processing Fees",
]);

const BANK_FEE_FALLBACK_ACCOUNT_NAMES = Object.freeze([
  "Bank Charges & Fees",
  "Bank Charges and Fees",
  "Bank Charges",
  "Bank Fees",
]);

const DISALLOWED_PROCESSING_FEE_ACCOUNT_NAMES = Object.freeze([
  "CC Fees",
  "Credit Card Fees",
  "Credit Card Interest",
  "Interest Expense",
  "Finance Charges",
]);

function normalizeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isPaymentProcessingFeeIntent(intent = "") {
  const key = String(intent || "").toLowerCase();
  return key === PROCESSING_FEE_INTENT || key === "payment_processing";
}

export function isStrongIntuitPaymentProcessingFeeDescriptor(value = "") {
  const text = normalizeText(value);
  if (!text) return false;
  return (
    /\btran(?:saction)? fee intuit\b/.test(text) ||
    /\bintuit payments? fee\b/.test(text) ||
    /\bquickbooks payments? fee\b/.test(text) ||
    /\bsystem recorded fee for quickbooks payments?\b/.test(text)
  );
}

export function hasIntuitDepositDescriptor(value = "") {
  const text = normalizeText(value);
  return /\bdeposit intuit\b|\bintuit deposit\b|\bquickbooks payments? deposit\b/.test(text);
}

export function isAllowedPaymentProcessingAccountName(value = "") {
  const normalized = normalizeText(value);
  return PROCESSING_FEE_ACCOUNT_NAMES.map(normalizeText).includes(normalized);
}

export function isBankFeeFallbackAccountName(value = "") {
  const normalized = normalizeText(value);
  return BANK_FEE_FALLBACK_ACCOUNT_NAMES.map(normalizeText).includes(normalized);
}

export function isDisallowedPaymentProcessingAccountName(value = "") {
  const normalized = normalizeText(value);
  return DISALLOWED_PROCESSING_FEE_ACCOUNT_NAMES.map(normalizeText).includes(normalized);
}

export function rankPaymentProcessingFeeAccount(account = {}) {
  const name = account.name || account.Name || account.qbo_account_name || "";
  if (isAllowedPaymentProcessingAccountName(name)) return 1;
  if (isBankFeeFallbackAccountName(name)) return 2;
  if (isDisallowedPaymentProcessingAccountName(name)) return -1;
  return 0;
}

export function findPaymentProcessingFeeAccount(accounts = [], { shape = (account) => account, typeCompatible = () => true } = {}) {
  const shaped = (accounts || []).map(shape).filter((account) => account?.active !== false && typeCompatible(account));
  const processing = shaped.find((account) => rankPaymentProcessingFeeAccount(account) === 1);
  if (processing) return processing;
  const bankFallback = shaped.find((account) => rankPaymentProcessingFeeAccount(account) === 2);
  return bankFallback || null;
}

export {
  BANK_FEE_FALLBACK_ACCOUNT_NAMES,
  DISALLOWED_PROCESSING_FEE_ACCOUNT_NAMES,
  PROCESSING_FEE_ACCOUNT_NAMES,
  PROCESSING_FEE_CANONICAL_KEY,
  PROCESSING_FEE_INTENT,
};
