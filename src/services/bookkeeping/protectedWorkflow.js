export function isProtectedCreditCardPaymentWorkflow(row = {}) {
  const meta = row.meta || {};
  const taxonomy = String(row.taxonomy_type || meta.taxonomy_type || "").toLowerCase();
  const pairId = row.cc_payment_pair_id || meta.cc_payment_pair_id || null;
  const pairStatus = String(row.cc_payment_pair_status || meta.cc_payment_pair_status || "").toLowerCase();
  const pairConfidence = String(row.cc_payment_pair_confidence || meta.cc_payment_pair_confidence || "").toLowerCase();
  const hasMappedRails = Boolean(
    row.cc_payment_bank_qbo_account_id ||
    meta.cc_payment_bank_qbo_account_id ||
    row.cc_payment_cc_qbo_account_id ||
    meta.cc_payment_cc_qbo_account_id ||
    row.cc_payment_transfer_target_qbo_account_id ||
    meta.cc_payment_transfer_target_qbo_account_id
  );
  const explicitMappingConfidence = String(row.cc_payment_mapping_confidence || meta.cc_payment_mapping_confidence || "").toLowerCase();
  const durablePair = Boolean(pairId) && (
    ["confirmed", "posting", "posted"].includes(pairStatus) ||
    pairConfidence === "high" ||
    hasMappedRails
  );
  const durableTaxonomy = taxonomy === "cc_payment" && (
    durablePair ||
    (hasMappedRails && ["high", "confirmed"].includes(explicitMappingConfidence))
  );
  return durablePair || durableTaxonomy;
}

export function isProtectedLoanPaymentWorkflow(row = {}) {
  const meta = row.meta || {};
  const taxonomy = String(row.taxonomy_type || meta.taxonomy_type || "").toLowerCase();
  return taxonomy === "loan_payment" || taxonomy === "loan_movement" || Boolean(meta.loan_payment_profile_id || meta.loan_payment_split_id);
}

export function getProtectedWorkflowReason(row = {}) {
  const meta = row.meta || {};
  const taxonomy = String(row.taxonomy_type || row.meta?.taxonomy_type || "").toLowerCase();
  const reason = String(row.accounting_review_reason || row.meta?.accounting_review_reason || "").toLowerCase();
  if (row.pending) return { label: "Pending bank transaction", detail: "Wait for the bank to finalize this transaction before accounting changes." };
  const incomingStatus = String(row.incoming_deposit_match_status || meta.incoming_deposit_match_status || "").toLowerCase();
  const incomingBlock = String(row.post_block_reason || meta.post_block_reason || meta.auto_post_block_reason || "").toLowerCase();
  if (["needs_confirmation", "ambiguous", "match_check_unavailable", "unchecked", "superseded"].includes(incomingStatus) || ["possible_existing_qbo_match", "incoming_deposit_needs_match", "match_check_unavailable", "incoming_deposit_bank_account_mapping_unverified", "incoming_deposit_match_rejected_review_required"].includes(incomingBlock)) {
    const unavailable = incomingStatus === "match_check_unavailable" || incomingBlock === "match_check_unavailable";
    return {
      label: unavailable ? "Match check unavailable" : incomingStatus === "ambiguous" ? "Choose QBO match" : "Possible QBO match",
      detail: unavailable ? "Refresh the QuickBooks match check before taking an accounting action." : "Confirm or reject the existing QuickBooks candidate before using the ordinary approval workflow.",
    };
  }
  if (isProtectedCreditCardPaymentWorkflow(row)) {
    return { label: "Credit card payment", detail: "Credit card payment handling uses the protected transfer workflow." };
  }
  if (taxonomy === "cc_payment") {
    return { label: "Credit card payment · Needs match", detail: "Credit card payment handling uses the protected transfer workflow." };
  }
  if (row.is_check && /check/.test(reason)) return { label: row.check_number ? `Check ${row.check_number}` : "Check", detail: "Checks use the protected check workflow." };
  if (["transfer_internal", "bank_transfer"].includes(taxonomy)) return { label: "Transfer", detail: "Transfers use the protected transfer workflow." };
  if (["owner_draw", "owner_contribution", "owner_distribution"].includes(taxonomy)) return { label: "Owner movement", detail: "Owner equity movements use a protected workflow." };
  if (taxonomy === "refund") return { label: "Refund", detail: "Refunds use a protected workflow." };
  if (isProtectedLoanPaymentWorkflow(row)) {
    const splitConfirmed = row.loan_payment_split_status === "confirmed" || row.meta?.loan_payment_split_status === "confirmed";
    return splitConfirmed
      ? { label: "Loan Payment · Ready to post", detail: "Principal, interest, and fees use the protected loan split workflow." }
      : { label: "Loan Payment · Needs Split", detail: "Confirm principal, interest, and fee lines before posting this loan payment." };
  }
  if (taxonomy === "loan_movement") return { label: "Loan movement", detail: "Loan movements use a protected workflow." };
  if (taxonomy === "tax_payment") return { label: "Tax payment", detail: "Tax payments use a protected workflow." };
  if (taxonomy === "payroll") return { label: "Payroll", detail: "Payroll uses a protected workflow." };
  if (taxonomy === "peer_to_peer_transfer") return { label: "Peer-to-peer payment", detail: "Peer-to-peer payments need review before accounting treatment is applied." };
  if (row.accounting_review_required && reason && !/uncategorized|needs review|review required/.test(reason)) {
    return { label: "Other protected workflow", detail: row.accounting_review_reason };
  }
  if (row.accounting_review_required) {
    return { label: "Bank account review", detail: "This bank transaction needs internal account review before accounting changes." };
  }
  return null;
}

export default {
  getProtectedWorkflowReason,
  isProtectedCreditCardPaymentWorkflow,
  isProtectedLoanPaymentWorkflow,
};
