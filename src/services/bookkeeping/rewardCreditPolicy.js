function normalizeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function signedAmount(row = {}) {
  const value = Number(row.signed_amount ?? row.signedAmount ?? row.amount);
  return Number.isFinite(value) ? value : 0;
}

export function isCreditCardAccountContext(row = {}) {
  const text = normalizeText([
    row.source_qbo_account_type,
    row.qbo_account_type,
    row.qbo_source_account_type,
    row.current_qbo_account_type,
    row.account_type,
    row.type,
    row.account_subtype,
    row.subtype,
    row.currentAccount,
    row.bank_account,
    row.account_name,
    row.account_official_name,
    row.meta?.source_qbo_account_type,
    row.meta?.qbo_source_account_type,
    row.meta?.account_type,
    row.meta?.account_subtype,
  ].filter(Boolean).join(" "));
  return /\b(?:creditcard|credit card|credit)\b/.test(text);
}

export function hasStrongRewardCreditDescriptor(value = "") {
  const text = normalizeText(value);
  return (
    /\bredeem(?:ed|ing)? cash back\b/.test(text) ||
    /\bcash back redemption\b/.test(text) ||
    /\bcashback redemption\b/.test(text) ||
    /\brewards? redemption\b/.test(text) ||
    /\bredeem(?:ed|ing)? rewards?\b/.test(text) ||
    /\bstatement credit rewards?\b/.test(text) ||
    /\brewards? statement credit\b/.test(text) ||
    /\bcredit card rewards?\b/.test(text) ||
    /\brewards? credit\b/.test(text)
  );
}

export function hasCreditCardPaymentDescriptor(value = "") {
  const text = normalizeText(value);
  return /\b(?:credit card payment|card payment|cc payment|mobile payment thank you|payment thank you|payment thank you mobile|internet payment thank you|e payment|epayment|epay|autopay|auto pay)\b/.test(text);
}

export function hasStrongRefundDescriptor(value = "") {
  const text = normalizeText(value);
  return /\b(?:refund|refunded|return credit|merchant credit|purchase return|chargeback|reversal)\b/.test(text);
}

export function hasTransferDescriptor(value = "") {
  const text = normalizeText(value);
  return /\b(?:transfer|xfer|payment from checking|payment to checking|ach pmt|ach payment)\b/.test(text);
}

export function isPositiveInflow(row = {}) {
  const direction = String(row.direction || "").toUpperCase();
  const amount = signedAmount(row);
  if (direction === "OUTFLOW") return false;
  if (direction === "INFLOW") return amount > 0;
  return amount > 0;
}

export function transactionRewardText(row = {}) {
  return [
    row.name,
    row.description,
    row.merchant_name,
    row.counterparty_name,
    row.payee,
    row.vendor,
    row.original_description,
    row.meta?.name,
    row.meta?.description,
    row.meta?.merchant_name,
    row.meta?.counterparty_name,
  ].filter(Boolean).join(" ");
}

export function isCashBackRewardCredit(row = {}) {
  const text = transactionRewardText(row);
  if (!isPositiveInflow(row)) return false;
  if (!isCreditCardAccountContext(row)) return false;
  if (!hasStrongRewardCreditDescriptor(text)) return false;
  if (hasCreditCardPaymentDescriptor(text)) return false;
  if (hasStrongRefundDescriptor(text)) return false;
  if (hasTransferDescriptor(text)) return false;
  return true;
}

export function rewardCreditIntent(row = {}) {
  return isCashBackRewardCredit(row) ? "credit_card_rewards" : null;
}
