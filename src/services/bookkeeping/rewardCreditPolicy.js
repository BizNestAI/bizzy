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
    /^(?:automatic )?statement credit$/.test(text) ||
    /^(?:cash back|cashback) reward$/.test(text) ||
    /^card reward credit$/.test(text) ||
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
  const descriptors = [
    row.name, row.description, row.merchant_name, row.counterparty_name,
    row.original_description, row.meta?.name, row.meta?.description,
  ].filter(Boolean);
  if (!isPositiveInflow(row)) return false;
  if (!isCreditCardAccountContext(row)) return false;
  if (!descriptors.some((value) => hasStrongRewardCreditDescriptor(value))) return false;
  if (hasCreditCardPaymentDescriptor(text)) return false;
  if (hasStrongRefundDescriptor(text)) return false;
  if (hasTransferDescriptor(text)) return false;
  return true;
}

export function rewardCreditIntent(row = {}) {
  return isCashBackRewardCredit(row) ? "credit_card_rewards" : null;
}

export function deterministicStatementCreditDecision(row = {}, categorization = {}, {
  accountId = null,
  accountName = null,
  now = new Date().toISOString(),
  source = "deterministic_statement_credit_policy",
} = {}) {
  const meta = categorization.meta || {};
  const activeOrUnknownProviderOperation =
    meta.provider_write_started_at || meta.qbo_write_started_at ||
    meta.ambiguous_provider_outcome === true || meta.unknown_provider_outcome === true;
  const finalized =
    categorization.qbo_txn_id || categorization.posted_at || categorization.status === "posted" ||
    meta.qbo_receipt_confirmed_at || meta.provider_receipt_confirmed_at;
  const matchedOrDuplicate =
    meta.matched_existing_qbo === true || meta.existing_qbo_match_confirmed === true ||
    meta.incoming_deposit_match_status === "confirmed" ||
    meta.qbo_duplicate_detection_confidence === "DETERMINISTIC_EXISTING" ||
    (Array.isArray(meta.qbo_duplicate_candidates) && meta.qbo_duplicate_candidates.some((candidate) => candidate?.deterministic === true));
  const confirmedPair =
    meta.cc_payment_pair_id || meta.transfer_pair_id || meta.internal_transfer_pair_id ||
    ["confirmed", "posting", "posted"].includes(String(meta.cc_payment_pair_status || meta.transfer_pair_status || "").toLowerCase());
  const destinationId = accountId || categorization.final_qbo_account_id || null;
  if (!destinationId || row.pending === true || activeOrUnknownProviderOperation || finalized || matchedOrDuplicate || confirmedPair) return null;
  if (!isCashBackRewardCredit(row)) return null;
  return {
    decision_version: 3,
    canonical_type: "cash_back_statement_credit",
    resolution_type: "credit_card_statement_credit",
    qbo_disposition: "categorize_as_new",
    destination_qbo_account_id: String(destinationId),
    destination_qbo_account_name: accountName || categorization.final_qbo_account_name || null,
    decision_source: "automated",
    operator_source: source,
    confidence: "deterministic",
    provenance: "normalized_descriptor_mapped_credit_card_no_stronger_contradiction",
    safety_eligible: true,
    decided_by: "bizzi",
    decided_at: now,
  };
}
