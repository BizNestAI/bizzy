const FAILURE_STATUSES = new Set(["failed", "failed_post", "post_failed", "blocked"]);
const APPROVED_STATUSES = new Set(["approved", "auto_approved", "handled", "failed"]);
const NEEDS_REVIEW_STATUSES = new Set(["", "needs_review", "uncategorized"]);

export const PIPELINE_STATUS = {
  pending_bank_transaction: {
    key: "pending_bank_transaction",
    label: "Pending bank transaction",
    tone: "neutral",
    kpi_group: "needs_review",
  },
  needs_review: {
    key: "needs_review",
    label: "Needs Review",
    tone: "warning",
    kpi_group: "needs_review",
  },
  handled_not_posted: {
    key: "handled_not_posted",
    label: "Handled · Not Posted",
    tone: "neutral",
    kpi_group: "handled_not_posted",
  },
  scheduled_for_qbo: {
    key: "scheduled_for_qbo",
    label: "Scheduled for QBO",
    tone: "info",
    kpi_group: "handled_not_posted",
  },
  posted_matched: {
    key: "posted_matched",
    label: "Posted & Matched",
    tone: "good",
    kpi_group: "posted_matched",
  },
  posting_failed: {
    key: "posting_failed",
    label: "Posting Failed",
    tone: "danger",
    kpi_group: "exceptions",
  },
  reconciliation_exception: {
    key: "reconciliation_exception",
    label: "Reconciliation Exception",
    tone: "danger",
    kpi_group: "exceptions",
  },
};

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function toTime(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function hasDurablePostingAttempt(row = {}) {
  const meta = row.meta || row.details || {};
  return Boolean(
    row.last_post_attempt_at ||
      row.latest_post_attempt_at ||
      row.latest_post_attempt?.attempted_at ||
      row.attempted_at ||
      row.posted_at ||
      meta.last_post_attempt_at ||
      meta.latest_post_attempt_at ||
      meta.latest_post_attempt_status ||
      Number(row.post_attempt_count || meta.post_attempt_count || 0) > 0
  );
}

export function hasProvenPostingFailure(row = {}) {
  const status = normalizeStatus(row.status || row.categorization_status);
  const meta = row.meta || row.details || {};
  const latestAttemptStatus = normalizeStatus(row.latest_post_attempt_status || meta.latest_post_attempt_status);
  const latestAttemptObjectStatus = normalizeStatus(row.latest_post_attempt?.status);
  const failedAttempt =
    latestAttemptStatus.includes("failed") ||
    latestAttemptStatus.includes("error") ||
    latestAttemptStatus.includes("rejected") ||
    latestAttemptObjectStatus.includes("failed") ||
    latestAttemptObjectStatus.includes("error") ||
    latestAttemptObjectStatus.includes("rejected");
  const hasFailureMarker = Boolean(row.post_error || meta.post_error || FAILURE_STATUSES.has(status));
  return !row.qbo_txn_id && hasFailureMarker && (failedAttempt || hasDurablePostingAttempt(row));
}

export function isBooksReviewNeedsReview(row = {}) {
  const status = normalizeStatus(row.status || row.categorization_status);
  const meta = row.meta || row.details || {};
  return NEEDS_REVIEW_STATUSES.has(status) || (status === "auto_approved" && meta.is_check === true);
}

export function isBooksReviewHandled(row = {}) {
  const status = normalizeStatus(row.status || row.categorization_status);
  return APPROVED_STATUSES.has(status);
}

export function deriveReconciliationEvidence(reconciliationItem = null) {
  if (!reconciliationItem) return null;
  const itemStatus = normalizeStatus(reconciliationItem.status);
  const details = reconciliationItem.details || {};
  const marker = [
    itemStatus,
    reconciliationItem.reason,
    reconciliationItem.note,
    details.reason_code,
    details.issue_type,
    details.status,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (itemStatus === "matched" || itemStatus === "reconciled" || reconciliationItem.reconciled_at) {
    return { kind: "matched", label: "Matched", source: "reconciliation_items" };
  }
  if (/duplicate/.test(marker)) {
    return { kind: "exception", reason: "Duplicate", source: "reconciliation_items" };
  }
  if (/missing_in_qbo|missing qbo|posting_gap/.test(marker)) {
    return { kind: "exception", reason: "Missing in QBO", source: "reconciliation_items" };
  }
  if (/mismatch|amount_mismatch|account_mismatch|qbo_id_mismatch/.test(marker)) {
    return { kind: "exception", reason: "Mismatch", source: "reconciliation_items" };
  }
  if (/failed_post|provider_error|reconciliation_error|conflict|unmatched|exception|error/.test(marker)) {
    return { kind: "exception", reason: "Needs investigation", source: "reconciliation_items" };
  }
  return null;
}

function withDetail(base, detail = null, extra = {}) {
  return {
    ...base,
    detail: detail || base.detail || "",
    ...extra,
  };
}

export function derivePipelineStatus({ bank = {}, cat = {}, reconciliationItem = null, nowTs = Date.now() } = {}) {
  const row = { ...(cat || {}) };
  const status = normalizeStatus(row.status);
  const pending = bank.pending === true || row.meta?.pending === true;
  const reconciliation = deriveReconciliationEvidence(reconciliationItem);

  if (reconciliation?.kind === "exception") {
    return withDetail(PIPELINE_STATUS.reconciliation_exception, reconciliation.reason, {
      exception_reason: reconciliation.reason,
      source: reconciliation.source,
      is_pending: pending,
    });
  }

  if (row.qbo_txn_id) {
    return withDetail(PIPELINE_STATUS.posted_matched, `${row.qbo_txn_type || "QBO transaction"} ${row.qbo_txn_id}`, {
      source: reconciliation?.source || "qbo_posting",
      is_pending: pending,
    });
  }

  if (hasProvenPostingFailure(row)) {
    return withDetail(PIPELINE_STATUS.posting_failed, row.post_error || "QBO posting failed.", {
      source: "posting_attempt",
      is_pending: pending,
    });
  }

  const postAfterTs = toTime(row.post_after);
  const nextAttemptTs = toTime(row.meta?.next_post_attempt_at);
  const scheduled = postAfterTs && postAfterTs > nowTs;
  const retryScheduled = nextAttemptTs && nextAttemptTs > nowTs;
  const postingInProgress = row.meta?.posting_in_progress === true;
  if ((scheduled || retryScheduled || postingInProgress) && isBooksReviewHandled(row)) {
    return withDetail(PIPELINE_STATUS.scheduled_for_qbo, scheduled ? `Posts after ${row.post_after}` : "Queued for posting", {
      source: "posting_schedule",
      is_pending: pending,
    });
  }

  if (isBooksReviewHandled(row)) {
    return withDetail(PIPELINE_STATUS.handled_not_posted, "Categorized in Bizzi; not posted to QuickBooks.", {
      source: "books_review",
      is_pending: pending,
    });
  }

  if (pending) {
    return withDetail(PIPELINE_STATUS.needs_review, "Pending bank transaction.", {
      source: "books_review",
      secondary_statuses: [PIPELINE_STATUS.pending_bank_transaction],
      is_pending: true,
    });
  }

  if (isBooksReviewNeedsReview(row)) {
    return withDetail(PIPELINE_STATUS.needs_review, "Needs review before posting.", {
      source: "books_review",
      is_pending: false,
    });
  }

  return withDetail(PIPELINE_STATUS.needs_review, "Needs review before posting.", {
    source: "fallback",
    is_pending: pending,
  });
}

export function summarizePipelineStatuses(rows = []) {
  return rows.reduce(
    (acc, row) => {
      const status = row.pipeline_status || row;
      const key = status.key || "needs_review";
      const group = status.kpi_group || PIPELINE_STATUS[key]?.kpi_group || "needs_review";
      acc.plaid_count += 1;
      acc.status_counts[key] = (acc.status_counts[key] || 0) + 1;
      if (group === "needs_review") acc.needs_review_count += 1;
      if (group === "handled_not_posted") acc.handled_not_posted_count += 1;
      if (group === "posted_matched") acc.posted_matched_count += 1;
      if (group === "exceptions") acc.exceptions_count += 1;
      if (key === "scheduled_for_qbo") acc.scheduled_for_qbo_count += 1;
      if (key === "posting_failed") acc.posting_failed_count += 1;
      if (key === "reconciliation_exception") acc.reconciliation_exception_count += 1;
      return acc;
    },
    {
      plaid_count: 0,
      plaid_transactions_count: 0,
      needs_review_count: 0,
      handled_not_posted_count: 0,
      posted_matched_count: 0,
      exceptions_count: 0,
      scheduled_for_qbo_count: 0,
      posting_failed_count: 0,
      reconciliation_exception_count: 0,
      status_counts: {},
    }
  );
}

export function finalizePipelineTotals(totals = {}) {
  const plaidCount = Number(totals.plaid_count || 0);
  return {
    ...totals,
    plaid_transactions_count: plaidCount,
    explained_count:
      Number(totals.needs_review_count || 0) +
      Number(totals.handled_not_posted_count || 0) +
      Number(totals.posted_matched_count || 0) +
      Number(totals.exceptions_count || 0),
  };
}

export default {
  PIPELINE_STATUS,
  derivePipelineStatus,
  deriveReconciliationEvidence,
  hasDurablePostingAttempt,
  hasProvenPostingFailure,
  isBooksReviewHandled,
  isBooksReviewNeedsReview,
  summarizePipelineStatuses,
  finalizePipelineTotals,
};
