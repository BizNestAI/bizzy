export function describeMonthlyReviewRecovery(result = {}) {
  const reasons = Object.entries(result.reasons || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([reason]) => reason.replaceAll("_", " "));
  const why = reasons.length ? `: ${reasons.join(", ")}` : "";
  if (result.outcome === "rescheduled" || Number(result.scheduled) > 0) return `Recovery complete: transaction rescheduled${why}.`;
  if (result.outcome === "returned_to_needs_review" || Number(result.review_required) > 0) return `Recovery complete: returned to Needs Review${why}.`;
  if (result.outcome === "still_blocked" || Number(result.skipped) > 0) return `Recovery complete: transaction is still blocked${why}.`;
  if (Number(result.conflicted) > 0) return `Recovery unchanged because the transaction changed concurrently${why}.`;
  return `Recovery complete: transaction was unchanged${why || ": no eligible state change"}.`;
}

export async function runMonthlyReviewTransactionRecovery({ request, runId, businessId, transactionId, refreshPersistedFeeds } = {}) {
  if (typeof request !== "function") throw new Error("recovery_request_required");
  if (!runId || !businessId || !transactionId) throw new Error("recovery_scope_required");
  const url = `/api/admin/monthly-review/runs/${encodeURIComponent(runId)}/bookkeeping/recover-handled-posting-dispositions`;
  const result = await request(url, {
    method: "POST",
    body: { business_id: businessId, transaction_ids: [transactionId] },
  });
  if (!result?.ok) throw new Error(result?.message || result?.error || "bookkeeping_recovery_failed");
  await refreshPersistedFeeds?.();
  return { result, message: describeMonthlyReviewRecovery(result) };
}

export default { describeMonthlyReviewRecovery, runMonthlyReviewTransactionRecovery };
