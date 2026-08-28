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

export function isQboBankAccount(account = {}) {
  return normalizeQboAccountType(account.type || account.accountType || account.account_type) === "bank";
}

export function deriveCreditCardPaymentOrientation(row = {}) {
  const meta = row.meta || {};
  const explicitRole = String(row.cc_payment_pair_role || meta.cc_payment_pair_role || "").toLowerCase();
  if (explicitRole === "checking" || explicitRole === "bank") {
    return {
      side: "bank",
      counterpartAccountType: "CreditCard",
      label: "Paid to",
      placeholder: "Match payment to...",
    };
  }
  if (explicitRole === "credit_card" || explicitRole === "creditcard") {
    return {
      side: "credit_card",
      counterpartAccountType: "Bank",
      label: "Paid from",
      placeholder: "Paid from...",
    };
  }

  const sourceType = normalizeQboAccountType(
    row.source_qbo_account_type ||
      row.qbo_account_type ||
      row.qbo_source_account_type ||
      row.current_qbo_account_type ||
      meta.source_qbo_account_type ||
      meta.qbo_source_account_type ||
      row.account_type ||
      row.type
  );
  const sourceSubtype = normalizeQboAccountType(row.account_subtype || row.subtype || meta.account_subtype || "");
  const direction = String(row.direction || "").toUpperCase();
  const amount = Number(row.signed_amount ?? row.signedAmount ?? row.amount ?? 0);
  const isOutflow = direction === "OUTFLOW" || (!direction && amount < 0);
  const isInflow = direction === "INFLOW" || (!direction && amount > 0);
  const isBankRail =
    sourceType === "bank" ||
    sourceType === "depository" ||
    sourceSubtype === "checking" ||
    sourceSubtype === "savings" ||
    sourceSubtype === "moneymarket";
  const isCardRail = sourceType === "creditcard" || sourceType === "credit" || sourceSubtype.includes("credit");

  if (isBankRail && isOutflow) {
    return {
      side: "bank",
      counterpartAccountType: "CreditCard",
      label: "Paid to",
      placeholder: "Match payment to...",
    };
  }
  if (isCardRail && isInflow) {
    return {
      side: "credit_card",
      counterpartAccountType: "Bank",
      label: "Paid from",
      placeholder: "Paid from...",
    };
  }
  if (isBankRail) {
    return {
      side: "bank",
      counterpartAccountType: "CreditCard",
      label: "Paid to",
      placeholder: "Match payment to...",
    };
  }
  if (isCardRail) {
    return {
      side: "credit_card",
      counterpartAccountType: "Bank",
      label: "Paid from",
      placeholder: "Paid from...",
    };
  }
  return {
    side: "unknown",
    counterpartAccountType: null,
    label: "Match payment",
    placeholder: "Select account...",
  };
}

export default {
  deriveCreditCardPaymentOrientation,
  deriveCreditCardPaymentStatus,
  isCreditCardPaymentWorkflow,
  isQboBankAccount,
  isQboCreditCardAccount,
  normalizeQboAccountType,
};
