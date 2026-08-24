function formatShortDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function deriveQboPostingLifecycle(row = {}) {
  const status = String(row.status || "").toLowerCase();
  const hasQboTxn = Boolean(row.qbo_txn_id);

  if (hasQboTxn) {
    return {
      key: "posted",
      label: "Posted",
      tone: "good",
      detail: `${row.qbo_txn_type || "QBO transaction"} ${row.qbo_txn_id}`,
    };
  }

  if (row.post_error || ["failed", "failed_post", "post_failed", "blocked"].includes(status)) {
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
