import { normalizeTransactionDescription } from "./transactionDescription.js";

export const QUICKBOOKS_PAYMENTS_DETECTOR_VERSION = "quickbooks_payments_match_v1";
export const QUICKBOOKS_PAYMENTS_MATCH_REASON = "quickbooks_payments_match_required";

const DEPOSIT_REFERENCE_RE = /(?:^|\s)DEPOSIT\s+INTUIT\s+([0-9]{6,})(?:\s|$)/i;
const FEE_REFERENCE_RE = /(?:^|\s)TRAN(?:SACTION)?\s+FEE\s+INTUIT\s+([0-9]{6,})(?:\s|$)/i;

function transactionDirection(transaction = {}) {
  const direction = String(transaction.direction || "").toUpperCase();
  if (direction === "INFLOW" || direction === "OUTFLOW") return direction;
  const amount = Number(transaction.signed_amount ?? transaction.amount);
  if (!Number.isFinite(amount) || amount === 0) return null;
  return amount > 0 ? "INFLOW" : "OUTFLOW";
}

function structuredProcessorText(transaction = {}) {
  const raw = transaction.raw && typeof transaction.raw === "object" ? transaction.raw : {};
  return [
    transaction.payment_processor,
    transaction.processor,
    transaction.processor_name,
    transaction.counterparty?.name,
    transaction.counterparty_name,
    raw.payment_processor,
    raw.processor,
    raw.processor_name,
  ].filter(Boolean).join(" ").toLowerCase();
}

export function detectQuickBooksPaymentsProtectedWorkflow(transaction = {}) {
  const text = normalizeTransactionDescription(transaction);
  const direction = transactionDirection(transaction);
  const depositMatch = text.match(DEPOSIT_REFERENCE_RE);
  const feeMatch = text.match(FEE_REFERENCE_RE);
  const structuredProcessor = structuredProcessorText(transaction);
  const structuredQuickBooksPayments = /\b(?:quickbooks|qb|intuit)\s+payments?\b/.test(structuredProcessor);
  const structuredKind = String(
    transaction.processor_activity_kind ||
    transaction.settlement_activity_kind ||
    transaction.raw?.processor_activity_kind ||
    ""
  ).toLowerCase();

  if ((depositMatch && direction === "INFLOW") || (structuredQuickBooksPayments && structuredKind === "payout" && direction === "INFLOW")) {
    return {
      protected: true,
      kind: "deposit",
      classification: "quickbooks_payments_deposit_match_required",
      reason: QUICKBOOKS_PAYMENTS_MATCH_REASON,
      detector_version: QUICKBOOKS_PAYMENTS_DETECTOR_VERSION,
      settlement_reference: depositMatch?.[1] || transaction.settlement_reference || transaction.raw?.settlement_reference || null,
      evidence: depositMatch ? "normalized_deposit_intuit_reference" : "structured_quickbooks_payments_payout",
    };
  }
  if ((feeMatch && direction === "OUTFLOW") || (structuredQuickBooksPayments && structuredKind === "fee" && direction === "OUTFLOW")) {
    return {
      protected: true,
      kind: "fee",
      classification: "quickbooks_payments_fee_match_required",
      reason: QUICKBOOKS_PAYMENTS_MATCH_REASON,
      detector_version: QUICKBOOKS_PAYMENTS_DETECTOR_VERSION,
      settlement_reference: feeMatch?.[1] || transaction.settlement_reference || transaction.raw?.settlement_reference || null,
      evidence: feeMatch ? "normalized_tran_fee_intuit_reference" : "structured_quickbooks_payments_fee",
    };
  }
  return null;
}

export function hasAuthoritativeQuickBooksMatch(row = {}) {
  const meta = row.meta || {};
  const status = String(row.status || row.feed_status || "").toLowerCase();
  const matchStatus = String(row.incoming_deposit_match_status || meta.incoming_deposit_match_status || "").toLowerCase();
  const explicitlyReopened = ["unchecked", "superseded", "rejected"].includes(matchStatus) && ["needs_review", "uncategorized", ""].includes(status);
  return (
    ["matched", "matched_existing_qbo"].includes(status) ||
    meta.matched_existing_qbo === true ||
    matchStatus === "confirmed" ||
    (!explicitlyReopened && Boolean(row.matched_at || row.reconciled_at || meta.matched_at || meta.incoming_deposit_matched_at)) ||
    Boolean(meta.confirmed_match_receipt || meta.qbo_match_receipt)
  );
}

export function quickBooksPaymentsProtectedMeta(existingMeta = {}, detection = null) {
  if (!detection) return { ...(existingMeta || {}) };
  return {
    ...(existingMeta || {}),
    protected_workflow: detection.classification,
    protected_workflow_reason: detection.reason,
    protected_workflow_detector_version: detection.detector_version,
    protected_workflow_evidence: detection.evidence,
    quickbooks_payments_activity_kind: detection.kind,
    quickbooks_payments_settlement_reference: detection.settlement_reference,
    safe_to_auto_handle: false,
    safe_to_auto_post: false,
    post_block_reason: QUICKBOOKS_PAYMENTS_MATCH_REASON,
    system_suggested_resolution: "match_existing_qbo",
  };
}

export default {
  detectQuickBooksPaymentsProtectedWorkflow,
  hasAuthoritativeQuickBooksMatch,
  quickBooksPaymentsProtectedMeta,
};
