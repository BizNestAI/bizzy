// /src/services/tax/taxTransactionEligibility.js

export const TAX_TRANSACTION_ELIGIBILITY_REASONS = Object.freeze({
  ELIGIBLE_POSTED: "eligible_posted",
  PENDING_TRANSACTION: "pending_transaction",
  ARCHIVED_TRANSACTION: "archived_transaction",
  IGNORED_TRANSACTION: "ignored_transaction",
  APPROVED_NOT_POSTED: "approved_not_posted",
  FAILED_POST: "failed_post",
  VOIDED_QBO_TRANSACTION: "voided_qbo_transaction",
  MISSING_QBO_CONFIRMATION: "missing_qbo_confirmation",
  DUPLICATE_OR_REPLACEMENT: "duplicate_or_replacement",
  INVALID_TRANSACTION_DATE: "invalid_transaction_date",
  MISSING_BANK_TRANSACTION: "missing_bank_transaction",
  BUSINESS_MISMATCH: "business_mismatch",
});

export function isPostedForTax({ bankTransaction, categorization, qboPostedTransaction, businessId } = {}) {
  return getTaxEligibilityReason({ bankTransaction, categorization, qboPostedTransaction, businessId }) ===
    TAX_TRANSACTION_ELIGIBILITY_REASONS.ELIGIBLE_POSTED;
}

export function isTaxClassificationCandidate(input = {}) {
  return isPostedForTax(input);
}

export function getTaxEligibilityReason({ bankTransaction, categorization, qboPostedTransaction, businessId } = {}) {
  if (!bankTransaction) return TAX_TRANSACTION_ELIGIBILITY_REASONS.MISSING_BANK_TRANSACTION;
  if (businessId && String(bankTransaction.business_id) !== String(businessId)) {
    return TAX_TRANSACTION_ELIGIBILITY_REASONS.BUSINESS_MISMATCH;
  }
  if (bankTransaction.is_archived || bankTransaction.archived_at) return TAX_TRANSACTION_ELIGIBILITY_REASONS.ARCHIVED_TRANSACTION;
  if (bankTransaction.pending === true) return TAX_TRANSACTION_ELIGIBILITY_REASONS.PENDING_TRANSACTION;
  if (!isValidDateOnly(bankTransaction.date)) return TAX_TRANSACTION_ELIGIBILITY_REASONS.INVALID_TRANSACTION_DATE;
  if (bankTransaction.duplicate_fingerprint && (bankTransaction.is_archived || bankTransaction.archived_at)) {
    return TAX_TRANSACTION_ELIGIBILITY_REASONS.DUPLICATE_OR_REPLACEMENT;
  }

  const catStatus = normalizeStatus(categorization?.status);
  const qboStatus = normalizeStatus(qboPostedTransaction?.status);
  if (catStatus === "ignored") return TAX_TRANSACTION_ELIGIBILITY_REASONS.IGNORED_TRANSACTION;
  if (qboStatus === "voided") return TAX_TRANSACTION_ELIGIBILITY_REASONS.VOIDED_QBO_TRANSACTION;
  if (qboStatus === "failed" && !hasPostedCategorization(categorization)) return TAX_TRANSACTION_ELIGIBILITY_REASONS.FAILED_POST;

  if (hasPostedCategorization(categorization) || hasPostedQboRecord(qboPostedTransaction)) {
    return TAX_TRANSACTION_ELIGIBILITY_REASONS.ELIGIBLE_POSTED;
  }
  if (["approved", "auto_approved", "handled"].includes(catStatus)) return TAX_TRANSACTION_ELIGIBILITY_REASONS.APPROVED_NOT_POSTED;
  if (catStatus === "failed" || categorization?.post_error) return TAX_TRANSACTION_ELIGIBILITY_REASONS.FAILED_POST;
  return TAX_TRANSACTION_ELIGIBILITY_REASONS.MISSING_QBO_CONFIRMATION;
}

export function deriveTaxTransactionStatus(input = {}) {
  const reason = getTaxEligibilityReason(input);
  if (reason === TAX_TRANSACTION_ELIGIBILITY_REASONS.ELIGIBLE_POSTED) return "eligible_posted";
  if ([TAX_TRANSACTION_ELIGIBILITY_REASONS.APPROVED_NOT_POSTED, TAX_TRANSACTION_ELIGIBILITY_REASONS.MISSING_QBO_CONFIRMATION].includes(reason)) {
    return "not_posted";
  }
  return "excluded";
}

export function hasPostedCategorization(categorization) {
  return normalizeStatus(categorization?.status) === "posted" && Boolean(categorization?.qbo_txn_id);
}

export function hasPostedQboRecord(qboPostedTransaction) {
  return normalizeStatus(qboPostedTransaction?.status) === "posted" && Boolean(qboPostedTransaction?.qbo_txn_id);
}

export function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function isValidDateOnly(value) {
  if (!value) return false;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}
