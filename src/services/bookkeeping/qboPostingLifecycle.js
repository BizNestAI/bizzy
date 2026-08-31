import { hasProvenPostingFailure } from "./reconciliationPipelineStatus.js";
import { deriveCreditCardPaymentStatus } from "./creditCardPaymentStatus.js";

function formatShortDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function toTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function isHandledStatus(status) {
  return ["approved", "auto_approved", "handled"].includes(String(status || "").toLowerCase());
}

function isPostingInProgress(row = {}) {
  const meta = row.meta || {};
  return meta.posting_in_progress === true;
}

export function deriveQboPostingLifecycle(row = {}, { nowMs = Date.now() } = {}) {
  const status = String(row.status || "").toLowerCase();
  const hasQboTxn = Boolean(row.qbo_txn_id);
  const meta = row.meta || {};
  const ccStatus = deriveCreditCardPaymentStatus(row);

  if (hasQboTxn) {
    return {
      key: "posted",
      label: "Posted",
      tone: "good",
      detail: `${row.qbo_txn_type || "QBO transaction"} ${row.qbo_txn_id}`,
    };
  }

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

  if (!unsupportedUnpairedCcPayment && hasProvenPostingFailure(row)) {
    return {
      key: "failed",
      label: "Failed",
      tone: "danger",
      detail: row.post_error || "QBO posting failed.",
    };
  }

  if (isPostingInProgress(row) && isHandledStatus(status)) {
    return {
      key: "posting",
      label: "Posting...",
      tone: "warning",
      detail: "Bizzi is sending this transaction to QuickBooks.",
    };
  }

  const postAfterMs = toTime(row.post_after);
  if (postAfterMs && isHandledStatus(status)) {
    if (postAfterMs <= nowMs) {
      return {
        key: "ready_to_post",
        label: "Ready to post",
        tone: "warning",
        detail: "The review window has ended; the posting worker may pick this up shortly.",
      };
    }
    return {
      key: "queued",
      label: "Queued",
      tone: "warning",
      detail: `Posts after ${formatShortDateTime(row.post_after)}`,
    };
  }

  if (isHandledStatus(status)) {
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

export function formatQboPostingSchedule(row = {}, { nowMs = Date.now() } = {}) {
  const lifecycle = deriveQboPostingLifecycle(row, { nowMs });
  if (lifecycle.key === "posted") {
    return {
      key: "posted",
      label: "Posted",
      tone: "good",
      detail: lifecycle.detail || "Posted to QuickBooks.",
    };
  }
  if (lifecycle.key === "failed") {
    return {
      key: "failed",
      label: "Failed",
      tone: "danger",
      detail: lifecycle.detail || "QuickBooks posting failed.",
    };
  }
  if (lifecycle.key === "posting") {
    return {
      key: "posting",
      label: "Posting...",
      tone: "warning",
      detail: lifecycle.detail || "Bizzi is sending this transaction to QuickBooks.",
    };
  }
  if (lifecycle.key === "ready_to_post") {
    return {
      key: "ready_to_post",
      label: "Ready to post",
      tone: "warning",
      detail: lifecycle.detail || "The posting worker may pick this up shortly.",
    };
  }
  if (lifecycle.key === "queued") {
    return {
      key: "scheduled",
      label: formatShortDateTime(row.post_after),
      tone: "neutral",
      detail: "Scheduled to post to QuickBooks after the review window.",
    };
  }
  if (["pending", "needs_review"].includes(lifecycle.key) || String(row.status || "").toLowerCase() === "uncategorized") {
    return {
      key: "not_eligible",
      label: "Not scheduled",
      tone: "neutral",
      detail: lifecycle.detail || "This transaction is not eligible for QuickBooks posting yet.",
    };
  }
  return {
    key: "not_scheduled",
    label: "Not scheduled",
    tone: "neutral",
    detail: "No QuickBooks posting time is scheduled.",
  };
}

export default {
  deriveQboPostingLifecycle,
  formatQboPostingSchedule,
};
