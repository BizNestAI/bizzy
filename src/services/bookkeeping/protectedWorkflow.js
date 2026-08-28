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

export function getProtectedWorkflowReason(row = {}) {
  const taxonomy = String(row.taxonomy_type || row.meta?.taxonomy_type || "").toLowerCase();
  const reason = String(row.accounting_review_reason || row.meta?.accounting_review_reason || "").toLowerCase();
  if (row.pending) return { label: "Pending bank transaction", detail: "Wait for the bank to finalize this transaction before accounting changes." };
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
  if (taxonomy === "loan_movement") return { label: "Loan movement", detail: "Loan movements use a protected workflow." };
  if (taxonomy === "tax_payment") return { label: "Tax payment", detail: "Tax payments use a protected workflow." };
  if (taxonomy === "payroll") return { label: "Payroll", detail: "Payroll uses a protected workflow." };
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
};
