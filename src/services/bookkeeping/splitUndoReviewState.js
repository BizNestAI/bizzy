// Optimistic display only. The authenticated Undo operation revokes authority.
export function isReopenedSplitDecision(row = {}) {
  if (!row) return false;
  return ["needs_review", "uncategorized"].includes(String(row.status || row.cat_status || "").toLowerCase()) &&
    !row.qbo_txn_id && !row.posted_at && !row.reconciled_at &&
    (row.meta?.taxonomy_type === "split_transaction" || Boolean(row.meta?.split_transaction_id));
}

// Projection only: reading a feed never changes an old approval or posting claim.
export function reopenedSplitReviewState(row) {
  if (!isReopenedSplitDecision(row)) return row;
  return { ...splitUndoReviewState(row), requires_split_decision_reset: true,
    suggestedAccountId: null, suggestedAccountName: null,
    suggested_qbo_account_id: null, suggested_qbo_account_name: null };
}

export function splitUndoReviewState(row) {
  if (row.meta?.taxonomy_type !== "split_transaction" && !row.meta?.split_transaction_id) {
    return { ...row, status: "needs_review" };
  }
  const meta = { ...row.meta };
  for (const key of ["taxonomy_type", "split_transaction_id", "split_transaction_status", "posting_shape_binding", "posting_shape_expected", "user_selected_resolution"]) delete meta[key];
  if (meta.protected_workflow === "split_transaction") delete meta.protected_workflow;
  return {
    ...row, meta: { ...meta, split_undo_audit: { at: "optimistic" } }, status: "needs_review", review_status: "needs_review",
    taxonomy_type: null,
    split_transaction: null, split_lines: [],
    final_qbo_account_id: null, final_qbo_account_name: null, final_canonical_account_key: null,
    glAccountId: null, glAccountName: null, accountId: null,
    effective_account_id: null, effective_account_name: null,
    post_after: null, post_error: null, posting_status: "not_scheduled",
  };
}
