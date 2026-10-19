import {
  deriveCreditCardPaymentStatus,
  isCreditCardPaymentWorkflow,
} from "./creditCardPaymentStatus.js";
import {
  deriveReconciliationEvidence,
  hasProvenPostingFailure,
  isBooksReviewHandled,
  isBooksReviewNeedsReview,
} from "./reconciliationPipelineStatus.js";
import { deriveQboPostingLifecycle } from "./qboPostingLifecycle.js";

const POSTED_RECEIPT_STATUS = "posted";
const EXCLUDED_STATUSES = new Set(["excluded", "ignored"]);

// This is deliberately a monthly read projection, not another transaction state
// machine.  The outcome is assigned from persisted evidence only, so it cannot
// post, classify, match, or otherwise mutate a customer transaction.
export const MONTHLY_RECONCILIATION_OUTCOME = {
  pending: {
    key: "pending",
    label: "Pending in Plaid",
    tone: "neutral",
  },
  needs_review: {
    key: "needs_review",
    label: "Needs review",
    tone: "warning",
  },
  handled_waiting: {
    key: "handled_waiting",
    label: "Handled · waiting to post",
    tone: "neutral",
  },
  scheduled: {
    key: "scheduled",
    label: "Scheduled to post",
    tone: "info",
  },
  posting_in_progress: {
    key: "posting_in_progress",
    label: "Posting in progress",
    tone: "warning",
  },
  posting_failed: {
    key: "posting_failed",
    label: "Posting failed",
    tone: "danger",
  },
  posted_by_bizzi: {
    key: "posted_by_bizzi",
    label: "Posted by Bizzi",
    tone: "good",
  },
  matched_existing_qbo: {
    key: "matched_existing_qbo",
    label: "Matched to existing QuickBooks",
    tone: "good",
  },
  matched_transfer_or_card_payment: {
    key: "matched_transfer_or_card_payment",
    label: "Matched transfer or card payment",
    tone: "good",
  },
  excluded: {
    key: "excluded",
    label: "Excluded",
    tone: "neutral",
  },
  ambiguous: {
    key: "ambiguous",
    label: "Ambiguous · reconciliation required",
    tone: "danger",
  },
};

export const MONTHLY_RECONCILIATION_OUTCOME_KEYS = Object.freeze(Object.keys(MONTHLY_RECONCILIATION_OUTCOME));

function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

function toTimestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function withDetail(outcome, detail, extra = {}) {
  return {
    ...outcome,
    detail: detail || null,
    ...extra,
  };
}

function isPending(bank = {}, cat = {}) {
  return bank.pending === true || cat.pending === true || cat.meta?.pending === true;
}

function isExcluded(cat = {}) {
  const status = normalized(cat.status || cat.categorization_status);
  const meta = cat.meta || cat.details || {};
  return EXCLUDED_STATUSES.has(status) || meta.excluded === true || Boolean(meta.excluded_at);
}

function hasPersistedExistingQboMatch(cat = {}) {
  const status = normalized(cat.status || cat.categorization_status);
  const meta = cat.meta || cat.details || {};
  return status === "matched_existing_qbo" ||
    meta.matched_existing_qbo === true ||
    normalized(meta.incoming_deposit_match_status || cat.incoming_deposit_match_status) === "confirmed";
}

function hasReceiptBackedQboPost(cat = {}, qboPostingReceipt = null) {
  if (normalized(qboPostingReceipt?.status) !== POSTED_RECEIPT_STATUS) return false;
  const receiptQboId = String(qboPostingReceipt?.qbo_txn_id || "").trim();
  if (!receiptQboId) return false;

  // A receipt is the durable source of a Bizzi-created QBO transaction. If the
  // categorization link is present, require that it agrees with the receipt;
  // otherwise a stale link cannot be reported as posted.
  const categorizationQboId = String(cat.qbo_txn_id || "").trim();
  return !categorizationQboId || categorizationQboId === receiptQboId;
}

function hasIncompleteQboPostingLink(cat = {}, qboPostingReceipt = null) {
  if (!cat.qbo_txn_id) return false;
  return !hasReceiptBackedQboPost(cat, qboPostingReceipt);
}

function isPostingInProgress(cat = {}, qboLifecycle = {}) {
  const meta = cat.meta || cat.details || {};
  const job = cat.posting_job || cat.bookkeeping_posting_job || {};
  return isBooksReviewHandled(cat) && (
    meta.posting_in_progress === true ||
    ["posting", "reconciling", "processing"].includes(qboLifecycle?.key) ||
    ["posting", "reconciling", "processing"].includes(normalized(job.state))
  );
}

function isScheduled(cat = {}, qboLifecycle = {}, nowTs = Date.now()) {
  if (!isBooksReviewHandled(cat)) return false;
  const meta = cat.meta || cat.details || {};
  const job = cat.posting_job || cat.bookkeeping_posting_job || {};
  const postAfter = toTimestamp(cat.post_after);
  const nextAttempt = toTimestamp(meta.next_post_attempt_at || job.next_attempt_at || job.scheduled_at);
  return ["queued", "retry_scheduled", "ready_to_post"].includes(qboLifecycle?.key) ||
    ["scheduled", "retry_scheduled"].includes(normalized(job.state)) ||
    (postAfter !== null && postAfter > nowTs) ||
    (nextAttempt !== null && nextAttempt > nowTs);
}

/**
 * Classify one canonical active Plaid transaction into one primary monthly
 * lifecycle outcome. The order is intentional: source pending and explicit
 * exclusion are not posting states; durable posting/match evidence resolves a
 * row without conflating it with statement reconciliation.
 */
export function deriveMonthlyReconciliationLifecycle({
  bank = {},
  cat = {},
  qboPostingReceipt = null,
  reconciliationItem = null,
  nowTs = Date.now(),
} = {}) {
  const reconciliationEvidence = deriveReconciliationEvidence(reconciliationItem);
  if (reconciliationEvidence?.kind === "exception") {
    return withDetail(
      MONTHLY_RECONCILIATION_OUTCOME.ambiguous,
      reconciliationEvidence.reason || "Reconciliation evidence needs review.",
      { reconciliation_evidence: reconciliationEvidence }
    );
  }

  if (isPending(bank, cat)) {
    return withDetail(MONTHLY_RECONCILIATION_OUTCOME.pending, "Plaid has not settled this transaction yet.");
  }

  if (isExcluded(cat)) {
    return withDetail(MONTHLY_RECONCILIATION_OUTCOME.excluded, "Excluded from the Bizzi workflow.");
  }

  if (hasReceiptBackedQboPost(cat, qboPostingReceipt)) {
    return withDetail(
      MONTHLY_RECONCILIATION_OUTCOME.posted_by_bizzi,
      "A durable QuickBooks posting receipt confirms that Bizzi created this transaction.",
      { qbo_posting_receipt_id: qboPostingReceipt?.id || null }
    );
  }

  if (hasPersistedExistingQboMatch(cat)) {
    return withDetail(
      MONTHLY_RECONCILIATION_OUTCOME.matched_existing_qbo,
      "Persisted evidence links this source transaction to existing QuickBooks activity; Bizzi did not create a new transaction.",
      { qbo_link_complete: Boolean(cat.qbo_txn_id || qboPostingReceipt?.qbo_txn_id) }
    );
  }

  const creditCardPayment = deriveCreditCardPaymentStatus({ ...bank, ...cat, meta: cat.meta || bank.meta || {} });
  if (isCreditCardPaymentWorkflow({ ...bank, ...cat, meta: cat.meta || bank.meta || {} })) {
    if (creditCardPayment?.matched) {
      return withDetail(
        MONTHLY_RECONCILIATION_OUTCOME.matched_transfer_or_card_payment,
        "Resolved as a matched internal transfer or credit-card payment; no expense category is required."
      );
    }
    return withDetail(MONTHLY_RECONCILIATION_OUTCOME.needs_review, "This transfer or card payment still needs its matching side.");
  }

  if (hasIncompleteQboPostingLink(cat, qboPostingReceipt)) {
    return withDetail(
      MONTHLY_RECONCILIATION_OUTCOME.ambiguous,
      "A QuickBooks transaction link exists without a matching durable posting receipt.",
      { qbo_link_complete: false }
    );
  }

  if (hasProvenPostingFailure(cat)) {
    return withDetail(MONTHLY_RECONCILIATION_OUTCOME.posting_failed, "A durable QuickBooks posting attempt failed.");
  }

  const qboLifecycle = deriveQboPostingLifecycle(cat, { nowMs: nowTs });
  if (isPostingInProgress(cat, qboLifecycle)) {
    return withDetail(MONTHLY_RECONCILIATION_OUTCOME.posting_in_progress, qboLifecycle.detail || "Bizzi is confirming the QuickBooks posting.");
  }

  if (isScheduled(cat, qboLifecycle, nowTs)) {
    return withDetail(MONTHLY_RECONCILIATION_OUTCOME.scheduled, qboLifecycle.detail || "A controlled QuickBooks posting is scheduled.");
  }

  if (isBooksReviewHandled(cat)) {
    return withDetail(MONTHLY_RECONCILIATION_OUTCOME.handled_waiting, "Handled in Bizzi and waiting for a QuickBooks posting outcome.");
  }

  if (isBooksReviewNeedsReview(cat)) {
    return withDetail(MONTHLY_RECONCILIATION_OUTCOME.needs_review, "Needs a Bizzi workflow decision.");
  }

  return withDetail(MONTHLY_RECONCILIATION_OUTCOME.ambiguous, "The persisted lifecycle evidence is incomplete.");
}

export function summarizeMonthlyReconciliationLifecycle(rows = []) {
  const initial = {
    plaid_transactions_count: 0,
    explained_count: 0,
  };
  for (const key of MONTHLY_RECONCILIATION_OUTCOME_KEYS) {
    initial[`${key}_count`] = 0;
  }

  const totals = (rows || []).reduce((acc, row) => {
    acc.plaid_transactions_count += 1;
    const key = row?.monthly_lifecycle_key || row?.monthly_lifecycle?.key || row?.pipeline_status_key || row?.pipeline_status?.key;
    if (MONTHLY_RECONCILIATION_OUTCOME[key]) {
      acc[`${key}_count`] += 1;
      acc.explained_count += 1;
    }
    return acc;
  }, initial);

  return {
    ...totals,
    conservation_ok: totals.explained_count === totals.plaid_transactions_count,
    // The admin posting-trace reader still consumes these names. They are
    // compatibility aggregates only; the customer Reconciliations API exposes
    // the primary outcome counts above instead of presenting them as one state.
    plaid_count: totals.plaid_transactions_count,
    handled_not_posted_count:
      totals.handled_waiting_count +
      totals.scheduled_count +
      totals.posting_in_progress_count +
      totals.matched_transfer_or_card_payment_count,
    posted_matched_count: totals.posted_by_bizzi_count,
    exceptions_count: totals.ambiguous_count,
  };
}

export function selectLatestQboPostingReceipt(rows = []) {
  return (rows || []).reduce((latest, candidate) => {
    if (!latest) return candidate;
    const latestTime = toTimestamp(latest.updated_at || latest.posted_at || latest.created_at) || 0;
    const candidateTime = toTimestamp(candidate.updated_at || candidate.posted_at || candidate.created_at) || 0;
    return candidateTime > latestTime ? candidate : latest;
  }, null);
}

export default {
  deriveMonthlyReconciliationLifecycle,
  summarizeMonthlyReconciliationLifecycle,
  selectLatestQboPostingReceipt,
};
