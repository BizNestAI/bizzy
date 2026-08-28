import { hasProvenPostingFailure } from "./reconciliationPipelineStatus.js";
import { deriveCreditCardPaymentStatus } from "./creditCardPaymentStatus.js";

function formatShortDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function deriveQboPostingLifecycle(row = {}) {
  const status = String(row.status || "").toLowerCase();
  const hasQboTxn = Boolean(row.qbo_txn_id);
  const meta = row.meta || {};
  const ccStatus = deriveCreditCardPaymentStatus(row);

  if (row.pending === true || meta.pending === true) {
    return {
      key: "pending",
      label: "Pending",
      tone: "warning",
      detail: "Plaid transaction is pending and is not ready for approval or QBO posting.",
    };
  }

  if (ccStatus && !hasQboTxn) {
    return {
      key: ccStatus.key,
      label: ccStatus.label,
      tone: ccStatus.tone,
      detail: ccStatus.matched
        ? "Matched as an internal credit-card payment; QBO Transfer posting is separate."
        : "Needs an opposite-side payment match before QBO posting.",
    };
  }

  const unsupportedUnpairedCcPayment =
    meta.taxonomy_type === "cc_payment" &&
    !meta.cc_payment_pair_id &&
    (row.post_error === "cc_payment_post_not_supported" || meta.post_block_reason === "cc_payment_post_not_supported");

  if (hasQboTxn) {
    return {
      key: "posted",
      label: "Posted",
      tone: "good",
      detail: `${row.qbo_txn_type || "QBO transaction"} ${row.qbo_txn_id}`,
    };
  }

  if (!unsupportedUnpairedCcPayment && hasProvenPostingFailure(row)) {
    return {
      key: "failed",
      label: "Failed",
      tone: "danger",
      detail: row.post_error || "QBO posting failed.",
    };
  }

  if (row.post_after && ["approved", "auto_approved", "handled"].includes(status)) {
    return {
      key: "queued",
      label: "Queued",
      tone: "warning",
      detail: `Posts after ${formatShortDateTime(row.post_after)}`,
    };
  }

  if (["approved", "auto_approved", "handled"].includes(status)) {
    return {
      key: "handled_not_posted",
      label: "Handled · Not posted",
      tone: "neutral",
      detail: "Handled in Bizzi; no QBO transaction has been created yet.",
    };
  }

  return {
    key: "needs_review",
    label: "Needs Review",
    tone: "neutral",
    detail: "Needs review before QBO posting.",
  };
}

export default {
  deriveQboPostingLifecycle,
};
