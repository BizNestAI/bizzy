const FINAL_SPECIALIZED_RESOLUTIONS = new Set([
  "merchant_refund",
  "credit_card_statement_credit",
  "credit_card_credit_other",
]);

export const CREDIT_CARD_INFLOW_TYPE_REQUIRED_MESSAGE = "Confirm whether this credit-card inflow is a merchant refund, statement credit, or payment before approving it.";

export function normalizeSpecializedInflowResolution(value) {
  const resolution = normalized(value);
  return ["merchant_refund", "credit_card_statement_credit", "match_credit_card_payment", "credit_card_credit_other"].includes(resolution) ? resolution : null;
}

export function buildSpecializedInflowDecision({ resolution, accountId, accountName = null, actor = null, source = "books_review", decidedAt = new Date().toISOString(), statementAuthority = null } = {}) {
  const normalizedResolution = normalizeSpecializedInflowResolution(resolution);
  if (!FINAL_SPECIALIZED_RESOLUTIONS.has(normalizedResolution) || !accountId || !actor) return null;
  return {
    decision_version: 3,
    resolution_type: normalizedResolution,
    qbo_disposition: normalizedResolution === "credit_card_credit_other" ? "needs_review" : "categorize_as_new",
    destination_qbo_account_id: String(accountId),
    destination_qbo_account_name: accountName || null,
    decision_source: "user",
    operator_source: source,
    decided_by: actor,
    decided_at: decidedAt,
    statement_settlement_authority: statementAuthority || null,
  };
}

export function canCompleteSettledAccountingReview({ bankTransaction = {}, decision = null } = {}) {
  return bankTransaction.pending !== true &&
    bankTransaction.pending_resolution_state === "promoted_to_settled" &&
    bankTransaction.accounting_review_required === true &&
    bankTransaction.accounting_review_reason === "operator_confirmed_settlement" &&
    Boolean(bankTransaction.pending_resolution_payload?.confirmed_at) &&
    Boolean(decision && FINAL_SPECIALIZED_RESOLUTIONS.has(normalized(decision.resolution_type)) && decision.destination_qbo_account_id && decision.decided_by && decision.decided_at);
}

const PROVISIONAL_TRANSFER_TYPES = new Set([
  "transfer",
  "transfer_internal",
  "bank_transfer",
  "cc_payment",
]);

const OBSOLETE_PRE_PROVIDER_BLOCKERS = new Set([
  "taxonomy_requires_review",
  "transfer_posting_not_supported",
  "bank_transfer_posting_not_supported",
  "special_workflow_requires_review",
  "credit_card_inflow_resolution_required",
  "credit_card_inflow_requires_review",
  "inflow_resolution_required",
]);

const STRUCTURAL_TRANSFER_KEYS = [
  "bank_transfer_pair_id", "internal_transfer_pair_id", "qbo_transfer_id",
  "transfer_destination_transaction_id", "transfer_match_id", "transfer_pair_id",
  "transfer_source_transaction_id", "cc_payment_pair_id",
];

function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

export function hasFinalSpecializedTypeAuthority(row = {}) {
  const meta = row.meta || {};
  const decision = meta.credit_card_inflow_resolution;
  if (!decision || !FINAL_SPECIALIZED_RESOLUTIONS.has(normalized(decision.resolution_type))) return false;
  return Boolean(
    decision.decided_at &&
    (decision.decided_by || decision.decision_source === "automated") &&
    decision.destination_qbo_account_id
  );
}

export function hasConfirmedTransferOrPaymentPair(row = {}) {
  const meta = row.meta || {};
  const pairStatus = normalized(meta.transfer_pair_status || meta.cc_payment_pair_status);
  if (["confirmed", "posting", "posted"].includes(pairStatus)) return true;
  return STRUCTURAL_TRANSFER_KEYS.some((key) => Boolean(meta[key]));
}

export function hasProviderFinality(row = {}) {
  const meta = row.meta || {};
  return Boolean(
    row.qbo_txn_id || row.posted_at || row.status === "posted" ||
    meta.qbo_receipt_confirmed_at || meta.provider_receipt_confirmed_at ||
    meta.matched_existing_qbo === true || meta.incoming_deposit_match_status === "confirmed"
  );
}

export function supersedeProvisionalClassification(meta = {}, audit = {}) {
  const next = { ...(meta || {}) };
  const priorType = normalized(next.taxonomy_type || next.taxonomy_override);
  if (!PROVISIONAL_TRANSFER_TYPES.has(priorType)) return next;
  if (hasConfirmedTransferOrPaymentPair({ meta: next })) return next;
  for (const key of [
    "taxonomy_type", "taxonomy_subtype", "taxonomy_confidence", "taxonomy_flags",
    "taxonomy_override", "protected_workflow", "protected_review_required",
    "protected_review_reason", "transfer_pair_status", "transfer_pair_confidence",
    "transfer_pair_notes", "transfer_pair_historical_context_only",
    "transfer_target_qbo_account_id", "transfer_target_qbo_account_name",
  ]) delete next[key];
  if (OBSOLETE_PRE_PROVIDER_BLOCKERS.has(normalized(next.post_block_reason))) delete next.post_block_reason;
  if (OBSOLETE_PRE_PROVIDER_BLOCKERS.has(normalized(next.auto_post_block_reason))) delete next.auto_post_block_reason;
  next.superseded_provisional_classification = {
    prior_type: priorType,
    final_type: audit.finalType || "cash_back_statement_credit",
    decided_by: audit.actor || null,
    decided_at: audit.timestamp || new Date().toISOString(),
    source: audit.source || "books_review",
    decision_version: audit.decisionVersion || 2,
  };
  return next;
}

export function applySpecializedTypeAuthority(row = {}) {
  if (hasProviderFinality(row) || !hasFinalSpecializedTypeAuthority(row) || hasConfirmedTransferOrPaymentPair(row)) return row;
  const meta = supersedeProvisionalClassification(row.meta || {}, {
    finalType: row.meta?.credit_card_inflow_resolution?.resolution_type,
    actor: row.meta?.credit_card_inflow_resolution?.decided_by,
    timestamp: row.meta?.credit_card_inflow_resolution?.decided_at,
    source: row.meta?.credit_card_inflow_resolution?.operator_source,
    decisionVersion: row.meta?.credit_card_inflow_resolution?.decision_version,
  });
  const next = { ...row, meta };
  delete next.taxonomy_type;
  delete next.protected_workflow;
  return next;
}

export function isObsoletePreProviderClassificationFailure(row = {}) {
  const meta = row.meta || {};
  return hasFinalSpecializedTypeAuthority(row) &&
    !hasConfirmedTransferOrPaymentPair(row) &&
    !hasProviderFinality(row) &&
    !meta.provider_write_started_at && !meta.qbo_write_started_at &&
    OBSOLETE_PRE_PROVIDER_BLOCKERS.has(normalized(row.post_error || meta.post_block_reason || meta.auto_post_block_reason));
}

export default {
  applySpecializedTypeAuthority,
  buildSpecializedInflowDecision,
  canCompleteSettledAccountingReview,
  hasConfirmedTransferOrPaymentPair,
  hasFinalSpecializedTypeAuthority,
  hasProviderFinality,
  isObsoletePreProviderClassificationFailure,
  supersedeProvisionalClassification,
};
