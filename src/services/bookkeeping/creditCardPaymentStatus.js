export function normalizeQboAccountType(value = "") {
  return String(value || "").replace(/[\s_-]+/g, "").toLowerCase();
}

export function isCreditCardPaymentWorkflow(row = {}) {
  const meta = row.meta || {};
  if (row.cc_payment_rejected === true || meta.cc_payment_rejected === true || meta.taxonomy_override === "not_cc_payment") return false;
  return row.taxonomy_type === "cc_payment" || meta.taxonomy_type === "cc_payment" || Boolean(row.cc_payment_pair_id || meta.cc_payment_pair_id);
}

export function deriveCreditCardPaymentStatus(row = {}) {
  if (!isCreditCardPaymentWorkflow(row)) return null;
  const meta = row.meta || {};
  const pairId = row.cc_payment_pair_id || meta.cc_payment_pair_id || null;
  const pairStatus = String(row.cc_payment_pair_status || meta.cc_payment_pair_status || "").toLowerCase();
  const posted = Boolean(row.qbo_txn_id) || pairStatus === "posted";
  const matched = Boolean(pairId) && ["confirmed", "posted", "auto_approved", "matched"].includes(pairStatus || "confirmed");
  if (posted) {
    return {
      key: "cc_payment_posted",
      label: "Credit Card Payment · Posted",
      matched: true,
      postable: true,
      tone: "good",
    };
  }
  if (matched) {
    return {
      key: "cc_payment_matched",
      label: "Credit Card Payment · Matched",
      matched: true,
      postable: true,
      tone: "good",
    };
  }
  return {
    key: "cc_payment_needs_match",
    label: "Credit Card Payment · Needs Match",
    matched: false,
    postable: false,
    tone: "warning",
  };
}

export function isQboCreditCardAccount(account = {}) {
  return normalizeQboAccountType(account.type || account.accountType || account.account_type) === "creditcard";
}

export default {
  deriveCreditCardPaymentStatus,
  isCreditCardPaymentWorkflow,
  isQboCreditCardAccount,
  normalizeQboAccountType,
};
