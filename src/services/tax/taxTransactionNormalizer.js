// /src/services/tax/taxTransactionNormalizer.js
import { hasPostedCategorization, hasPostedQboRecord, normalizeStatus } from "./taxTransactionEligibility.js";

export function normalizePostedTransactionForTax({ bankTransaction, categorization, qboPostedTransaction } = {}) {
  const bank = bankTransaction || {};
  const cat = categorization || {};
  const qbo = qboPostedTransaction || {};
  const amount = finiteNumber(bank.amount);
  const signedAmount = bank.signed_amount == null ? amount : finiteNumber(bank.signed_amount);
  const qboTxnId = cat.qbo_txn_id || qbo.qbo_txn_id || null;
  const qboTxnType = cat.qbo_txn_type || qbo.qbo_txn_type || null;
  const qboIdMismatch = Boolean(cat.qbo_txn_id && qbo.qbo_txn_id && String(cat.qbo_txn_id) !== String(qbo.qbo_txn_id));
  const qboTypeMismatch = Boolean(cat.qbo_txn_type && qbo.qbo_txn_type && String(cat.qbo_txn_type) !== String(qbo.qbo_txn_type));
  const qboStatus = normalizeStatus(qbo.status);
  const catStatus = normalizeStatus(cat.status);
  const sourceWarnings = [];

  if (qboIdMismatch || qboTypeMismatch) sourceWarnings.push("qbo_id_mismatch");
  if (!cat.final_qbo_account_id && !cat.suggested_qbo_account_id) sourceWarnings.push("missing_qbo_account");
  if (!bank.counterparty_name && !bank.merchant_name) sourceWarnings.push("missing_counterparty");
  if (!bank.direction) sourceWarnings.push("missing_direction");
  if (qboStatus && catStatus === "posted" && !["posted", ""].includes(qboStatus)) sourceWarnings.push("conflicting_post_status");
  if (bank.signed_amount == null) sourceWarnings.push("missing_signed_amount");
  if (!cat.meta?.taxonomy_type) sourceWarnings.push("missing_taxonomy_hint");

  return {
    transactionId: bank.id || cat.transaction_id || qbo.transaction_id || null,
    businessId: bank.business_id || cat.business_id || qbo.business_id || null,
    transactionDate: dateOnly(bank.date || cat.txn_date),
    authorizedDate: dateOnly(bank.authorized_date),
    postedAt: cat.posted_at || qbo.posted_at || null,
    reconciledAt: cat.reconciled_at || null,
    description: bank.name || cat.txn_name || "",
    originalName: bank.name || "",
    merchantName: bank.merchant_name || null,
    merchantEntityId: bank.merchant_entity_id || null,
    counterpartyName: bank.counterparty_name || null,
    amount,
    signedAmount,
    absoluteAmount: Math.abs(signedAmount),
    direction: bank.direction || deriveDirection(signedAmount),
    plaidAccountId: bank.plaid_account_id || null,
    plaidTransactionId: bank.plaid_transaction_id || null,
    paymentChannel: bank.payment_channel || null,
    transactionType: bank.transaction_type || null,
    checkNumber: bank.check_number || cat.meta?.check_number || null,
    bookkeepingCategory: cat.final_qbo_account_name || cat.suggested_qbo_account_name || null,
    categoryPrimary: bank.category_primary || null,
    categoryDetailed: bank.category_detailed || null,
    qboTxnId,
    qboTxnType,
    qboPostStatus: qbo.status || cat.status || null,
    qboPostedTransactionId: qbo.id || null,
    qboAccountId: cat.final_qbo_account_id || cat.suggested_qbo_account_id || null,
    qboAccountName: cat.final_qbo_account_name || cat.suggested_qbo_account_name || null,
    qboEntityType: bank.qbo_entity_type || null,
    qboEntityId: bank.qbo_entity_id || null,
    categorizationStatus: cat.status || null,
    categorizationConfidence: cat.confidence ?? null,
    categorizationReason: cat.reason || null,
    decidedBy: cat.decided_by || null,
    decidedAt: cat.decided_at || null,
    taxonomyType: cat.meta?.taxonomy_type || null,
    suggestionSource: cat.meta?.suggestion_source || null,
    location: bank.location || null,
    counterparties: bank.counterparties || null,
    duplicateFingerprint: bank.duplicate_fingerprint || null,
    isArchived: bank.is_archived === true,
    pending: bank.pending === true,
    sourceTruth: {
      bankTransaction: Boolean(bankTransaction),
      categorizationPosted: hasPostedCategorization(categorization),
      qboPostedRecord: hasPostedQboRecord(qboPostedTransaction),
      matchedQboIds: cat.qbo_txn_id && qbo.qbo_txn_id ? !qboIdMismatch : null,
    },
    sourceWarnings,
    rawRefs: {
      bankTransactionId: bank.id || null,
      categorizationId: cat.id || null,
      qboPostedTransactionId: qbo.id || null,
      hasBankRaw: Boolean(bank.raw),
      hasQboPayload: Boolean(qbo.payload),
      hasQboResponse: Boolean(qbo.response),
    },
  };
}

function finiteNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function deriveDirection(signedAmount) {
  if (signedAmount < 0) return "OUTFLOW";
  if (signedAmount > 0) return "INFLOW";
  return "UNKNOWN";
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : null;
}
