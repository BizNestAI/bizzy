function titleCase(label) {
  return String(label || "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isMissingPostSchedule(status, details = {}) {
  return (
    status === "missing_in_qbo" &&
    (details?.reason_code === "missing_post_schedule" || details?.posting_state === "missing_post_schedule")
  );
}

export function getReconciliationIssueCopy(status, details = {}) {
  if (details?.audit_summary) return details.audit_summary;

  if (isMissingPostSchedule(status, details)) {
    return "This transaction was approved but has no posting schedule, so Bizzi does not know when to post it to QuickBooks.";
  }

  switch (status) {
    case "duplicate_internal":
      return "Bizzi detected another active row that appeared to represent the same Plaid transaction, so this row was excluded from active reconciliation totals.";
    case "archived":
      return "This transaction was replaced or removed by Plaid and is not part of active reconciliation.";
    case "matched":
      return "Posted successfully and matched.";
    case "needs_review":
      return "Needs review before Bizzi can post it.";
    case "approved_waiting_post":
      return "Approved and waiting for scheduled posting.";
    case "pending":
      return "Plaid pending transaction not settled yet.";
    case "failed_post":
      return "Posting failed. Bizzi will retry through the posting process.";
    case "missing_in_qbo":
      return "Missing in QuickBooks despite approval.";
    case "duplicate_in_qbo":
      return "Duplicate QuickBooks posting detected in the current reconciliation scope.";
    case "unknown":
    default:
      return "Bizzi is still determining the final outcome.";
  }
}

export function getReconciliationActionLabel(status, details = {}) {
  if (status === "duplicate_internal") return "View dedupe trace";
  if (status === "archived") return "View archived trace";
  if (status === "needs_review") return "Open in Books Review";
  if (status === "approved_waiting_post") return "View scheduled posting";
  if (status === "failed_post") return details?.post_error ? "Review posting failure" : "Open in Books Review";
  if (isMissingPostSchedule(status, details)) return "Review missing schedule";
  if (status === "missing_in_qbo") return "Open in Books Review";
  if (status === "duplicate_in_qbo") return "View duplicate trace";
  if (status === "pending") return "View pending trace";
  if (status === "matched") return "View matched trace";
  return "View trace";
}

export function getReconciliationTone(status, details = {}) {
  if (status === "duplicate_internal") return "amber";
  if (status === "archived") return "slate";
  if (status === "matched") return "green";
  if (status === "needs_review") return "amber";
  if (status === "approved_waiting_post") return "blue";
  if (status === "pending") return "slate";
  if (isMissingPostSchedule(status, details)) return "amber";
  if (status === "failed_post" || status === "missing_in_qbo" || status === "duplicate_in_qbo") return "rose";
  if (details?.reconciliation_confidence === "high") return "green";
  if (details?.reconciliation_confidence === "medium") return "blue";
  if (details?.reconciliation_confidence === "low") return "amber";
  return "slate";
}

export { titleCase };
